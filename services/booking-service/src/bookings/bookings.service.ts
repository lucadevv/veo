/**
 * BookingsService — orquesta la RESERVA de un asiento por el pasajero (ADR-014 §2.2, §4.2, §8).
 *
 * F0 (este lote): create (reservar) + read por id. El estado inicial depende del `modoReserva` de la
 * oferta y se calcula SIEMPRE por la máquina de estados TIPADA (CERO strings mágicos):
 *  - REVISION_CADA_SOLICITUD → SOLICITADO ──assertTransition──► PENDIENTE_APROBACION (espera al conductor).
 *  - INSTANT_BOOKING         → SOLICITADO ──assertTransition──► APROBADO (salta PENDIENTE_APROBACION, §4.2).
 * El evento emitido refleja el estado REAL (ADR-014 §7.1, semántica alineada):
 *  - REVISION → `booking.requested` (Booking → PENDIENTE_APROBACION).
 *  - INSTANT  → `booking.approved`  (Booking nace APROBADO; emitir `booking.requested`, que el ADR mapea a
 *               "→ PENDIENTE_APROBACION", sería semánticamente FALSO). La mutación + el evento van en la
 *               MISMA transacción (outbox, §7).
 *
 * IDEMPOTENCIA DE REQUEST (§5.3 + FOUNDATION idempotencia): se dedupea por el header `Idempotency-Key` que
 * el cliente manda (UUID por INTENTO de submit), NO por la identidad eterna `passenger × trip`. Un REINTENTO
 * del mismo submit manda la MISMA key → P2002 → se devuelve el Booking existente (idempotente, corta el
 * doble-tap / retry de red). Un intento NUEVO (tras un terminal alcanzable: RECHAZADO/EXPIRADO/CANCELADO)
 * manda una key NUEVA → crea una reserva nueva. SIN lockout: la key de request NUNCA es un lock de identidad
 * de negocio.
 *
 * SCOPE POR-TENANT (anti-IDOR cross-tenant, NO negociable): el `Idempotency-Key` es 100% controlado por el
 * cliente. Si la `dedupKey` derivara SOLO de él y el UNIQUE fuese GLOBAL, dos pasajeros DISTINTOS que mandan
 * el MISMO Idempotency-Key colisionarían en la MISMA fila — el 2º (atacante) chocaría P2002 y la recovery le
 * devolvería la reserva del 1º (PII ajena: bookingId/passengerId/precioAcordado/coords). Por eso la `dedupKey`
 * se namespacea por el `passengerId` server-truth: `booking:req:${passengerId}:${idempotencyKey}`. Dos
 * pasajeros con el mismo header derivan dedupKeys DISTINTAS → NUNCA colisionan → B jamás toca la fila de A.
 * Regla de causa raíz: toda recuperación keyed por un valor controlable por el cliente va scopeada por tenant.
 *
 * Si el cliente NO manda el header: se genera una key única server-side (uuidv7) por request — NO bloquea por
 * `passenger × trip` (no hay lockout), pero TAMPOCO dedupea reintentos (el retry-safe real EXIGE que el
 * cliente mande el header con la misma key entre reintentos del MISMO submit).
 *
 * CHARGE (F3) — separado: la idempotencia FINANCIERA del cobro se deriva en F3 del `bookingId` (per-booking),
 * NO de esta key de request. Son dos cosas distintas: acá cortamos el doble-submit; allá, el doble-cobro.
 *
 * ANTI-IDOR (read path): `getById` recibe el `passengerId` server-truth del llamante y devuelve la reserva
 * SOLO si es del dueño; si no, 404 tipado (NO 403: no se filtra la EXISTENCIA de una reserva ajena). Espeja
 * el write path, que ya toma `passengerId` de la identidad firmada (nunca del body).
 *
 * F3b (este lote): aprobar/rechazar (driver-rail) + el CHARGE charge-on-approval. `approve` aplica el gate
 * server-side (dueño del PublishedTrip + driver activo · §8) y dispara el CHARGE async vía `triggerCharge`
 * (APROBADO → REST charge fuera de tx → COBRO_PENDIENTE). `reject` transiciona a RECHAZADO sin cobrar.
 * INSTANT_BOOKING también dispara `triggerCharge` al reservar (mismo método, DRY). El método de pago lo
 * ELIGE el pasajero al reservar (persistido en el Booking, §5.5) y el CHARGE lo usa.
 *
 * AS-BUILT (F3c · CONSTRUIDO en ESTE servicio):
 *  - El handler de `payment.captured` / `payment.failed` (`confirmCapture` / `handlePaymentFailed`:
 *    COBRO_PENDIENTE → CONFIRMADO/CANCELADO) + el LOCK ATÓMICO de asientos (§6, decremento en CONFIRMADO,
 *    `confirmAndLockSeats`) + BR-P02 (reacción a payment.failed) YA existen acá. La garantía dura del cupo
 *    vive en ese seat-lock; el chequeo NO transaccional al reservar es solo un anti-overbooking barato previo.
 *
 * PENDIENTE (lo que SIGUE, no construido acá):
 *  - El **Refund** del asiento-lleno es F3c-payment (payment-service consume `booking.cancelled` y reembolsa).
 *  - La transición a EN_RUTA es F4.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  isUuid,
  uuidv7,
} from '@veo/utils';
import {
  BookingState,
  ModoReserva,
  PublishedTripState,
  type Booking,
  type PaymentMethod,
} from '../generated/prisma';
import { BookingApprovedOrigen, BookingCancelledRazon } from '@veo/events';
import { bookingMachine } from '../domain/booking-state';
import {
  ChargePermanentlyRejectedError,
  PassengerHasDebtError,
  isSyncDeclineStatus,
} from '../domain/payment-charge';
import { isDriverActive, isDriverEligible, isVehicleOperable } from '../domain/driver-eligibility';
import { BookingEventType } from '../events/booking-events';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../ports/payment/payment-gateway.port';
import { CostCapService } from '../cost-cap/cost-cap.service';
import { IDENTITY_CLIENT, type IdentityClient } from '../identity/identity-client.port';
import { FLEET_CLIENT, type FleetClient } from '../fleet/fleet-client.port';
import { BookingsRepository, type CreateBookingData } from './bookings.repository';
import type { CreateBookingDto } from './dto/create-booking.dto';
import type { ListTripBookingsPageDto } from './dto/list-trip-bookings-page.dto';

/**
 * Prefijo de la dedupKey de REQUEST (idempotencia del POST /bookings). Aísla este espacio de claves del
 * resto (p.ej. la idempotencia del CHARGE de F3, que es per-booking y vive en otra fase). Constante tipada,
 * cero strings mágicos sueltos: un único punto define el namespace.
 */
const REQUEST_DEDUP_NAMESPACE = 'booking:req:' as const;

/** Default de tamaño de página de GET /published-trips/:id/bookings si el cliente no pide `limit`. Acotado por @Max en el DTO. */
const DEFAULT_TRIP_BOOKINGS_PAGE_SIZE = 20;

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly repo: BookingsRepository,
    @Inject(PAYMENT_GATEWAY) private readonly payment: PaymentGateway,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityClient,
    private readonly costCap: CostCapService,
    @Inject(FLEET_CLIENT) private readonly fleet: FleetClient,
  ) {}

  /**
   * Gate de DEUDA al reservar (ADR-014 §5.2 paso 1 · §5.4): un pasajero con deuda pendiente (cobros en
   * PaymentStatus.DEBT) NO puede reservar. La deuda es DERIVADA de payment-service (getDebt vía REST firmado
   * service-rail) — booking NO tiene un flag DEBT propio (sería una segunda fuente de verdad).
   *
   * DEGRADACIÓN HONESTA — decisión EXPLÍCITA y documentada: si payment NO responde (timeout/caído), este gate
   * hace **FAIL-OPEN con observabilidad** (deja reservar + loguea warn estructurado). Por qué fail-OPEN y no
   * fail-closed: RESERVAR no mueve plata (charge-on-approval · §5.1) — y un deudor que se cuela en la reserva
   * igual no captura asiento hasta `payment.captured`. Bloquear TODAS las reservas porque payment tose sería
   * peor (caída de payment = caída del producto) que el riesgo acotado de que un deudor reserve sin que aún se
   * le cobre. El log deja rastro para auditar el bypass. CONTRASTE con el gate de PUBLICAR (identity/fleet ·
   * F1a), que SÍ es fail-closed: ahí dejar pasar a un conductor no elegible es un riesgo de SEGURIDAD, no un
   * cobro diferido recuperable.
   *
   * RED DE SEGURIDAD: el fail-open se apoya en que el CHARGE re-valida el método/saldo al dispararlo. Ese
   * DISPARO del CHARGE (approve() / reserve()-INSTANT → triggerCharge) es F3b y YA EXISTE (construido): un
   * deudor que se cuela por un fail-open transitorio igual choca con el cobro server-side de payment como
   * segunda barrera real, y un decline SÍNCRONO (DEBT/FAILED) o un rechazo PERMANENTE ya CANCELA el booking en
   * triggerCharge (no queda colgado). Lo que AÚN NO existe es el RE-CHECK ASÍNCRONO de la deuda: el handler de
   * `payment.captured`/`payment.failed` que CONFIRMA o cancela cuando la captura resuelve por webhook/poll
   * minutos después — eso es F3c · PENDIENTE; hasta entonces un cobro que arrancó PENDING queda en COBRO_PENDIENTE.
   */
  private async assertNoDebt(passengerId: string): Promise<void> {
    let summary;
    try {
      summary = await this.payment.getDebt(passengerId);
    } catch (err) {
      // FAIL-OPEN: payment caído/timeout no bloquea la reserva (no mueve plata). La segunda barrera real es el
      // DISPARO del CHARGE al aprobar (F3b · CONSTRUIDO), que ya cancela el booking ante un decline síncrono o
      // un rechazo permanente; el RE-CHECK ASÍNCRONO de la deuda (handler payment.captured/failed) es F3c ·
      // PENDIENTE. Se loguea para observabilidad/auditoría del bypass — nunca se traga en silencio.
      this.logger.warn({
        msg: 'Gate de deuda DEGRADADO (payment-service inaccesible): se permite reservar (fail-open). La 2da barrera es el CHARGE al aprobar (F3b · construido); el re-check async de la deuda es F3c · PENDIENTE',
        passengerId,
        cause: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (summary.hasDebt) {
      throw new PassengerHasDebtError(summary.totalCents);
    }
  }

  /**
   * Gate de OPERABILIDAD del vehículo AL RESERVAR (Lote 3 · ADR-014 §8). Re-valida contra fleet (server-truth)
   * que el vehículo de la oferta SIGUE operable — su operabilidad es DERIVADA (docs SOAT/ITV + ficha linkeada,
   * ver fleet `deriveVehicleReviewStatus`) y FLIPEA después de publicar; el gate de publish (`assertVehicleUsable`)
   * es one-shot, así que la RESERVA (el momento del compromiso del asiento) debe re-evaluarlo. Predicado ÚNICO
   * `isVehicleOperable` (MISMO criterio que publish/detalle/búsqueda — fuente única, imposible que diverjan).
   *
   * FAIL-CLOSED (contraste deliberado con el gate de DEUDA, que es fail-OPEN): la operabilidad es un eje
   * legal/seguridad (seguro SOAT + ITV obligatorios) y NO es recuperable como la deuda (que el charge re-valida).
   * Por eso, si fleet no responde, NO se reserva → ExternalServiceError (502 reintentable: no pudimos verificar,
   * reintentá), espejando el fail-closed del gate del conductor. Vehículo encontrado pero NO operable → la oferta
   * dejó de ser reservable → ConflictError (409, mismo trato que una oferta en estado no-reservable).
   */
  /**
   * Gate de ELEGIBILIDAD del conductor de la oferta AL RESERVAR (Lote 3 · ADR-014 §8). Re-valida contra identity
   * que el conductor de la oferta SIGUE elegible — con el predicado ÚNICO `isDriverEligible` (el MISMO que el
   * detalle y la búsqueda usan para decidir si la oferta es VISIBLE). Una reserva POR ID saltea ese filtro de
   * visibilidad, así que sin este gate un pasajero podría reservar (y en INSTANT, COBRAR) una oferta cuyo
   * conductor se SUSPENDIÓ / perdió KYC / antecedentes entre la visibilidad y la reserva.
   *
   * FAIL-CLOSED + semántica PASSENGER-FACING (simétrica con `assertVehicleOperable`): conductor no elegible → la
   * oferta dejó de ser reservable → ConflictError (409). identity caída → ExternalServiceError (502 reintentable):
   * no comprometemos un asiento contra un conductor cuya elegibilidad no pudimos verificar. (Distinto de
   * `assertDriverActive`, que es el gate DRIVER-FACING de approve/reject y lanza ForbiddenError sobre la suspensión.)
   */
  private async assertOfferDriverEligible(driverId: string): Promise<void> {
    let driver;
    try {
      driver = await this.identity.getDriver(driverId);
    } catch (err) {
      // fail-closed: identity caída / timeout → no se reserva sin verificar la elegibilidad del conductor.
      throw new ExternalServiceError(
        'No se pudo verificar al conductor de la oferta (identity no disponible)',
        { driverId, cause: err instanceof Error ? err.message : String(err) },
      );
    }
    if (isDriverEligible(driver)) return;
    // No elegible (no encontrado / suspendido / KYC no verificado / antecedentes no aprobados): oferta no reservable.
    throw new ConflictError('El viaje no está disponible para reservar (conductor no elegible)', {
      driverId,
    });
  }

  private async assertVehicleOperable(vehicleId: string): Promise<void> {
    let vehicle;
    try {
      vehicle = await this.fleet.getVehicle(vehicleId);
    } catch (err) {
      // fail-closed: fleet caída / timeout → no se reserva sin verificar la operabilidad del vehículo.
      throw new ExternalServiceError(
        'No se pudo verificar el vehículo de la oferta (fleet no disponible)',
        { vehicleId, cause: err instanceof Error ? err.message : String(err) },
      );
    }
    if (isVehicleOperable(vehicle)) return;
    // No operable (no encontrado / inactivo / revisión pendiente / docs no vigentes): la oferta ya no puede
    // comprometerse. Mensaje NEUTRO de actor — el gate lo comparten reserve (pasajero) y approve (conductor).
    throw new ConflictError('El vehículo de la oferta no está operable', {
      vehicleId,
    });
  }

  /**
   * Reserva un asiento. `passengerId` viene de la identidad firmada del pasajero (server-truth, NO del
   * body): anti-IDOR por construcción. `idempotencyKey` es el header `Idempotency-Key` del cliente (UUID por
   * intento de submit): la idempotencia de REQUEST se ancla en ÉL, no en `passenger × trip` (sin lockout).
   */
  async reserve(
    passengerId: string,
    dto: CreateBookingDto,
    idempotencyKey?: string,
  ): Promise<Booking> {
    const trip = await this.repo.findPublishedTrip(dto.publishedTripId);
    if (!trip) {
      throw new NotFoundError('Viaje publicado no encontrado', {
        publishedTripId: dto.publishedTripId,
      });
    }
    // Solo se reserva sobre ofertas ABIERTAS (PUBLICADO / PARCIALMENTE_RESERVADO). Una oferta LLENA,
    // EN_RUTA, COMPLETADA o CANCELADA no acepta reservas (ADR-014 §8 "solo PUBLICADO/PARCIALMENTE_RESERVADO").
    if (
      trip.estado !== PublishedTripState.PUBLICADO &&
      trip.estado !== PublishedTripState.PARCIALMENTE_RESERVADO
    ) {
      throw new ConflictError('El viaje no está disponible para reservar', {
        estado: trip.estado,
      });
    }
    // Cupo: asientos pedidos ≤ disponibles. Chequeo BARATO (no transaccional) — la garantía dura contra
    // overbooking concurrente SE CONSTRUIRÁ en el lock atómico del handler de payment.captured (§6, F3c ·
    // PENDIENTE, aún no existe). Hoy solo este chequeo barato cubre el overbooking obvio.
    if (dto.asientos > trip.asientosDisponibles) {
      throw new ConflictError('No hay asientos suficientes disponibles', {
        pedidos: dto.asientos,
        disponibles: trip.asientosDisponibles,
      });
    }

    // GATE DEL MATCH AL RESERVAR (Lote 3 · ADR-014 §8) — re-valida el MATCH COMPLETO (conductor + vehículo) en
    // el momento del compromiso del asiento. El gate de publish/visibilidad (detalle/búsqueda) es one-shot, y
    // una reserva POR ID saltea el filtro de visibilidad: entre que la oferta se hizo visible y el pasajero
    // reserva, el conductor pudo SUSPENDERSE / perder KYC y el vehículo pudo perder SOAT/ITV. Ambos ejes se
    // re-validan acá con los MISMOS predicados ÚNICOS que detalle/búsqueda (isDriverEligible / isVehicleOperable).
    // CRÍTICO en INSTANT_BOOKING: la reserva nace APROBADA y dispara el CHARGE de inmediato (abajo) — sin este
    // gate se cobraría a un conductor suspendido / en un vehículo no operable. FAIL-CLOSED (contraste con el gate
    // de deuda, fail-open): elegibilidad/operabilidad son legal/seguridad y NO recuperables como la deuda.
    await this.assertOfferDriverEligible(trip.driverId);
    await this.assertVehicleOperable(trip.vehicleId);

    // GATE DE DEUDA (ADR-014 §5.2 paso 1 · §5.4): un pasajero con deuda pendiente (DEBT derivado de payment)
    // NO puede reservar. Va DESPUÉS de los chequeos locales baratos (existe/disponible/cupo) — no consultamos
    // payment por una oferta inexistente. Fail-OPEN con observabilidad si payment no responde (ver assertNoDebt).
    await this.assertNoDebt(passengerId);

    // Precio acordado = base + specialRequest (céntimos PEN, Int) — el monto POR ASIENTO que el conductor
    // recibe. F0 usa el precio full-route; el pricing por TRAMO (precioPorTramo según pickup/dropoff) es F1.
    const specialRequest = dto.specialRequest ?? 0;
    const precioAcordado = trip.precioBase + specialRequest;
    if (precioAcordado < 0) {
      throw new ValidationError('precioAcordado no puede ser negativo', { precioAcordado });
    }

    // ESCUDO ANTI-LUCRO F1b AL RESERVAR (ADR-014 §8 · Ley de carpooling): el `specialRequest` que el pasajero
    // suma a la base NO existe al PUBLICAR, así que el tope de cost-sharing (validado allí sobre `precioBase`)
    // NO lo cubre. Sin re-topar acá, el conductor recibiría por asiento MÁS que el costo compartido topado vía
    // specialRequest = LUCRO (escudo legal roto). Se re-valida que `precioAcordado` (= base + specialRequest,
    // POR ASIENTO) ≤ el tope full-route VIGENTE del viaje (mismo costo/km del admin + peaje + asientosTotales
    // que el publish). SOLO si specialRequest > 0: si es 0, precioAcordado == precioBase, que YA fue topado al
    // publicar (invariante) → no re-pegamos a mapas (espejo de editTouchesPriceCap). Excede → ValidationError
    // tipado (400). FAIL-CLOSED (motor de rutas caído → ExternalServiceError) igual que el publish: el tope
    // legal no se salta por infraestructura. El cobro TOTAL (precioAcordado × asientos) se arma en triggerCharge.
    if (specialRequest > 0) {
      await this.costCap.assertAgreedPriceWithinCap({
        pais: trip.pais,
        asientosTotales: trip.asientosTotales,
        precioAcordadoCentimos: precioAcordado,
        tollsCents: trip.tollsCents,
        origenLat: trip.origenLat,
        origenLon: trip.origenLon,
        destinoLat: trip.destinoLat,
        destinoLon: trip.destinoLon,
        stopovers: trip.stopovers,
      });
    }

    // ESTADO INICIAL POR LA MÁQUINA (cero strings mágicos): SOLICITADO → (REVISION) PENDIENTE_APROBACION
    // o (INSTANT) APROBADO. assertTransition VALIDA la transición desde SOLICITADO antes de persistir.
    const isInstant = trip.modoReserva === ModoReserva.INSTANT_BOOKING;
    const estadoInicial = isInstant ? BookingState.APROBADO : BookingState.PENDIENTE_APROBACION;
    bookingMachine.assertTransition(BookingState.SOLICITADO, estadoInicial);

    // EVENTO alineado al estado REAL (ADR-014 §7.1): INSTANT nace APROBADO → `booking.approved`; REVISION
    // queda PENDIENTE_APROBACION → `booking.requested`. Emitir `booking.requested` en INSTANT mentiría
    // sobre el estado. CERO strings mágicos: se elige el miembro tipado del enum BookingEventType.
    const eventType = isInstant ? BookingEventType.APPROVED : BookingEventType.REQUESTED;

    const id = uuidv7();
    // dedupKey de REQUEST anclada en el `Idempotency-Key` del cliente (NO en passenger × trip → sin lockout)
    // y SCOPEADA por el `passengerId` server-truth (anti-IDOR cross-tenant): reintento del MISMO submit del
    // MISMO pasajero (misma key) → P2002 → existente; submit NUEVO (key nueva) → fila nueva. Dos pasajeros
    // con el MISMO header derivan dedupKeys distintas → no colisionan. Sin header: key única server-side (no
    // dedupea, no lockea), igual namespaceada por passengerId. La idempotencia del CHARGE es de F3, aparte.
    const dedupKey = this.deriveRequestDedupKey(passengerId, idempotencyKey);

    const data: CreateBookingData = {
      id,
      publishedTripId: trip.id,
      passengerId,
      asientos: dto.asientos,
      pickupLat: dto.pickupLat,
      pickupLon: dto.pickupLon,
      dropoffLat: dto.dropoffLat,
      dropoffLon: dto.dropoffLon,
      precioAcordado,
      mensajeIntro: dto.mensajeIntro ?? null,
      specialRequest: dto.specialRequest ?? null,
      // MÉTODO DE PAGO elegido por el pasajero al reservar (ADR-014 §5.5 · decisión del dueño 2026-06-22). Se
      // PERSISTE acá y el CHARGE al aprobar (o al reservar si INSTANT) lo usa: `charge({ method: ... })`. El DTO
      // ya lo validó con @IsEnum (tipado, cero strings mágicos); va server-truth tal cual al Booking.
      paymentMethod: dto.paymentMethod,
      paymentId: null, // se setea en el CHARGE (al aprobar / al reservar si INSTANT, abajo)
      dedupKey,
      estado: estadoInicial,
    };

    // Payload del evento: el `origen` de un booking.approved en F0 es SIEMPRE INSTANT_BOOKING (la aprobación
    // del conductor es F1). booking.requested no lleva `origen` (su único origen es REVISION).
    const payload = isInstant
      ? {
          bookingId: id,
          publishedTripId: trip.id,
          passengerId,
          driverId: trip.driverId,
          asientos: dto.asientos,
          precioAcordado,
          modoReserva: trip.modoReserva,
          estado: estadoInicial,
          // origen TIPADO desde @veo/events (fuente única del schema bookingApproved): NUNCA un literal suelto.
          // Un string mágico que no matchee el z.enum del schema → poison message en el relay (lo que cazó el gate).
          origen: BookingApprovedOrigen.INSTANT_BOOKING,
        }
      : {
          bookingId: id,
          publishedTripId: trip.id,
          passengerId,
          driverId: trip.driverId,
          asientos: dto.asientos,
          precioAcordado,
          modoReserva: trip.modoReserva,
          estado: estadoInicial,
        };

    // Idempotencia de request: dos POST con el MISMO Idempotency-Key (reintento del mismo submit) comparten
    // la dedupKey → el UNIQUE hace fallar el 2º con P2002 → devolvemos el Booking ya creado (no fila nueva,
    // no 500). Keys distintas (submits distintos) → reservas distintas, sin lockout.
    const booking = await this.repo.createWithEventIdempotent(dedupKey, passengerId, data, {
      eventType,
      aggregateId: id,
      payload,
    });

    // INSTANT_BOOKING (ADR-014 §4.2 · §7.1): el Booking nace APROBADO sin pasar por el conductor → el CHARGE
    // se dispara YA (mismo `triggerCharge` que usa approve(), DRY). Lo lleva a COBRO_PENDIENTE. Antes de F3b
    // un INSTANT quedaba en APROBADO sin cobrar (hueco); ahora cobra al reservar. La idempotencia de REQUEST
    // (P2002 → existente) puede devolver un booking que ya pasó de APROBADO: `triggerCharge` es tolerante a
    // un estado ya avanzado (no re-dispara si no está APROBADO) — un reintento del mismo submit no doble-cobra.
    if (booking.estado === BookingState.APROBADO) {
      // ADR-015 D4 / hueco 1: el CHARGE del carpooling DEBE portar el driverId del dueño del PublishedTrip
      // (`trip.driverId`, server-truth, ya validado al publicar) — si no, el Payment nace driverId=null y el
      // cron de payout (filtro `driverId: { not: null }`) lo EXCLUYE → el conductor cobra al pasajero pero
      // NUNCA recibe su liquidación. El driverId NO vive en el Booking; el dueño es el del PublishedTrip.
      return this.triggerCharge(booking, trip.driverId);
    }
    return booking;
  }

  /**
   * Lee una reserva por id (GET /bookings/:id) APLICANDO OWNERSHIP server-side (anti-IDOR): solo la devuelve
   * si el `passengerId` del llamante (server-truth, de la identidad firmada) es el dueño. Si no existe O es
   * de otro pasajero → MISMO 404 tipado: no se filtra la EXISTENCIA de una reserva ajena (NO 403).
   */
  async getById(id: string, passengerId: string): Promise<Booking> {
    const booking = await this.repo.findById(id);
    // Existencia y ownership colapsan al MISMO 404: un no-dueño no puede distinguir "no existe" de "no es
    // tuya" (anti-enumeración). El gate vive en el service (capa 2), no solo en el guard.
    if (booking?.passengerId !== passengerId) {
      throw new NotFoundError('Reserva no encontrada', { id });
    }
    return booking;
  }

  /**
   * APRUEBA una solicitud (POST /bookings/:id/approve · driver-rail · ADR-014 §8). Gate server-side (capa
   * 2/3, no solo el guard): el conductor debe ser DUEÑO del PublishedTrip de la reserva (server-truth) Y estar
   * ACTIVO/no-suspendido (gRPC GetDriver, fail-closed). No-dueño → NotFoundError (anti-IDOR: no se filtra la
   * existencia de una reserva ajena).
   *
   * ATOMICIDAD CROSS-SERVICE (§5.2 · el punto delicado) — el CHARGE es REST (I/O externa) → NUNCA dentro de
   * una $transaction Prisma. El patrón es DOS transacciones con el charge EN MEDIO:
   *   1. Gate (dueño + driver activo).
   *   2. tx1 (`transitionWithEvent`): PENDIENTE_APROBACION → APROBADO + outbox `booking.approved`. COMMIT.
   *   3. CHARGE REST (`triggerCharge`): fuera de toda tx. dedupKey determinista → idempotente.
   *   4. charge OK → tx2 (`markChargePending`): APROBADO → COBRO_PENDIENTE + guarda paymentId. COMMIT.
   *   5. charge FALLA (ExternalServiceError) → el booking queda en APROBADO; approve es RE-EJECUTABLE: re-llamar
   *      approve sobre un booking YA APROBADO RE-DISPARA el charge (idempotente por dedupKey) sin re-emitir el
   *      evento (tx1 ya no aplica: APROBADO no está en el `from` permitido para `booking.approved`). Ver abajo.
   *
   * RE-EJECUCIÓN (charge fallido) — POR QUÉ así: si el charge cae tras aprobar, el dinero NO se movió y el
   * booking quedó en APROBADO (el evento `booking.approved` ya se emitió, idempotente). Un retry del conductor
   * NO debe re-emitir `booking.approved` (la máquina rechaza APROBADO→APROBADO) ni crear un cobro nuevo (la
   * dedupKey lo dedupea). Por eso, si el booking YA está APROBADO al entrar, se SALTEA la tx1 y se va directo
   * a `triggerCharge` → COBRO_PENDIENTE. Así la operación es re-ejecutable hasta que el charge prenda, sin
   * romper la máquina de estados ni doble-cobrar. Doble-tap del happy-path: el 2º intento no matchea
   * PENDIENTE_APROBACION en el where atómico → ConflictError (la 1ª aprobación ya ganó).
   */
  async approve(bookingId: string, driverId: string): Promise<Booking> {
    const { booking, trip } = await this.assertDriverOwnsBookingTrip(bookingId, driverId);

    // GATE DEL MATCH EN EL MOMENTO DEL CHARGE (Lote 3 · cierre de la asimetría que cazó el gate adversarial). En
    // REVISION_CADA_SOLICITUD el COMPROMISO DE DINERO ocurre ACÁ (approve → triggerCharge), NO en reserve(); los
    // gates de reserve son one-shot y el match puede ROMPERSE entre reservar y aprobar. Se re-valida el match
    // COMPLETO, SIMÉTRICO con reserve (ambas superficies de compromiso re-validan conductor + vehículo):
    //  · CONDUCTOR: elegibilidad FULL (`isDriverEligible`: suspensión + KYC + antecedentes), NO solo suspensión.
    //    Verificado contra identity: kycStatus y backgroundCheckStatus PUEDEN flipear a REJECTED en un conductor
    //    NO suspendido (kyc-status-machine + background-check CLEARED→REJECTED), así que chequear solo suspensión
    //    dejaba cobrar a un conductor con KYC/antecedentes revocados (la ALTA del re-gate).
    //  · VEHÍCULO: operabilidad (`isVehicleOperable`): docs SOAT/ITV pueden VENCER entre reservar y aprobar.
    // Ambos ANTES de los DOS caminos de charge (re-ejecución APROBADO + happy-path) → cubren la re-ejecución.
    // fail-closed (identity/fleet caída → 403/502): no se cobra contra un match que no pudimos verificar.
    await this.assertDriverEligibleToCharge(driverId);
    await this.assertVehicleOperable(trip.vehicleId);

    // RE-EJECUCIÓN: si el booking YA está APROBADO (un approve previo aprobó pero el charge falló), NO se
    // re-emite booking.approved — se va directo a re-disparar el charge (idempotente por dedupKey). Esto vuelve
    // approve seguro de reintentar tras un charge fallido sin romper la máquina ni doble-cobrar.
    if (booking.estado === BookingState.APROBADO) {
      // ADR-015 D4 / hueco 1: el re-disparo del CHARGE también porta el driverId (el `driverId` server-truth
      // del caller approve, = dueño del PublishedTrip ya validado en el gate). Sin él, el carpooling queda
      // fuera de la liquidación. Idempotente por dedupKey (derivada del bookingId): no doble-cobra.
      return this.triggerCharge(booking, driverId);
    }

    // LA REGLA, NO EL IF: validar contra el estado REAL del agregado (FIX 6: `booking.estado`, NO el literal
    // PENDIENTE_APROBACION hardcodeado — eso era teatro, validaba un from fijo aunque el booking estuviera en
    // otro estado). A esta altura ya pasó el early-return de APROBADO, así que en el happy path es
    // PENDIENTE_APROBACION; si llegara en otro estado (EXPIRADO/RECHAZADO/COBRO_PENDIENTE/...), la máquina lanza
    // ANTES del where atómico (mejor mensaje). El where condicionado del UPDATE sigue como defensa en profundidad.
    bookingMachine.assertTransition(booking.estado, BookingState.APROBADO);

    // tx1 — APROBADO + outbox booking.approved, atómico y condicionado por estado (doble-tap → ConflictError).
    const approved = await this.repo.transitionWithEvent(
      bookingId,
      [BookingState.PENDIENTE_APROBACION],
      { estado: BookingState.APROBADO },
      {
        eventType: BookingEventType.APPROVED,
        aggregateId: bookingId,
        payload: {
          bookingId,
          publishedTripId: booking.publishedTripId,
          passengerId: booking.passengerId,
          driverId,
          asientos: booking.asientos,
          precioAcordado: booking.precioAcordado,
          // El schema bookingApproved EXIGE `modoReserva` (z.enum, NO opcional). El conductor solo aprueba
          // solicitudes en REVISION (INSTANT se auto-aprueba al reservar y NUNCA pasa por approve()), así que
          // acá es definicionalmente REVISION_CADA_SOLICITUD (tipado, cero strings mágicos). Sin esto el payload
          // tampoco parseaba contra el schema publicado → habría sido un SEGUNDO poison message (lo cazó el test).
          modoReserva: ModoReserva.REVISION_CADA_SOLICITUD,
          estado: BookingState.APROBADO,
          // FIX 1 — origen TIPADO del schema publicado: APROBACION_CONDUCTOR (el conductor aprobó). Antes era el
          // literal mágico 'DRIVER_APPROVAL', que NO está en el z.enum de bookingApproved → schema.parse() en el
          // relay LANZABA → poison message reintentado para siempre, el evento NUNCA llegaba a Kafka.
          origen: BookingApprovedOrigen.APROBACION_CONDUCTOR,
        },
      },
    );

    // tx1 commiteó (booking.approved emitido). AHORA el CHARGE REST, fuera de toda tx → tx2 COBRO_PENDIENTE.
    // ADR-015 D4 / hueco 1: el CHARGE porta el driverId (= dueño del PublishedTrip, server-truth ya validado
    // en el gate de approve) → el Payment nace con driverId → el cobro ENTRA a la liquidación por el mismo
    // carril que el on-demand (sin él, el cron de payout lo excluiría y el conductor no cobraría su neto).
    return this.triggerCharge(approved, driverId);
  }

  /**
   * RECHAZA una solicitud (POST /bookings/:id/reject · driver-rail · ADR-014 §4.2/§8). Mismo gate que approve
   * (dueño del PublishedTrip + driver activo). Transición PENDIENTE_APROBACION → RECHAZADO + outbox
   * `booking.rejected` en UNA $transaction (outbox-in-transaction). NO cobra (terminal sin movimiento de
   * plata). Idempotente: re-rechazar un booking ya RECHAZADO → el where atómico no matchea PENDIENTE_APROBACION
   * → 0 filas → ConflictError, sin re-emitir el evento.
   */
  async reject(bookingId: string, driverId: string): Promise<Booking> {
    // reject NO mueve plata (terminal sin charge): gate de ownership + SUSPENSIÓN sobreviniente del conductor
    // (laxo, `assertDriverActive`) — NO re-valida operabilidad del vehículo ni elegibilidad FULL (KYC/antecedentes):
    // rechazar es declinar trabajo, no operar, y un conductor con docs/antecedentes flipeados igual puede limpiar
    // su cola. El criterio FULL solo aplica donde se COMPROMETE dinero (reserve/approve).
    const { booking } = await this.assertDriverOwnsBookingTrip(bookingId, driverId);
    await this.assertDriverActive(driverId);

    // LA REGLA, NO EL IF: validar contra el estado REAL del agregado (FIX 6: `booking.estado`, NO el literal
    // hardcodeado). Si el booking ya no es rechazable (APROBADO/COBRO_PENDIENTE/terminal), la máquina lanza
    // ANTES del where con un mensaje claro. El where atómico del UPDATE sigue sellando la idempotencia (doble-rechazo).
    bookingMachine.assertTransition(booking.estado, BookingState.RECHAZADO);

    return this.repo.transitionWithEvent(
      bookingId,
      [BookingState.PENDIENTE_APROBACION],
      { estado: BookingState.RECHAZADO },
      {
        eventType: BookingEventType.REJECTED,
        aggregateId: bookingId,
        payload: {
          bookingId,
          publishedTripId: booking.publishedTripId,
          passengerId: booking.passengerId,
          driverId,
          estado: BookingState.RECHAZADO,
        },
      },
    );
  }

  /**
   * CANCELA la propia solicitud del PASAJERO (POST /bookings/:id/cancel · public-rail · ADR-014 §4.2). Es la
   * cara del PASAJERO (dueño de la reserva), simétrica a reject() (que es la del CONDUCTOR): transición
   * PENDIENTE_APROBACION → CANCELADO + outbox `booking.cancelled` (razon=CANCELADO_PASAJERO) en UNA
   * $transaction (outbox-en-transacción). NO cobra ni reembolsa (terminal sin movimiento de plata: el CHARGE
   * solo se dispara al APROBAR — charge-on-approval · §5.1 — y acá nunca se aprobó, así que nada se capturó).
   *
   * ANTI-IDOR (capa 2/3, no solo el guard): el `passengerId` viene de la identidad firmada del pasajero
   * (server-truth, NUNCA del path/body). Solo el DUEÑO puede cancelar SU reserva; una reserva inexistente O de
   * otro pasajero colapsa al MISMO NotFoundError (no se filtra la existencia de una reserva ajena — espeja
   * getById/assertDriverOwnsBookingTrip). El read va al PRIMARY (estado fresco): la decisión no se apoya en una
   * réplica stale.
   *
   * REGLA DE NEGOCIO (más ESTRECHA que la máquina): el pasajero solo cancela una solicitud AÚN NO resuelta
   * (PENDIENTE_APROBACION). La máquina permite CANCELADO desde varios estados (SOLICITADO/APROBADO/
   * COBRO_PENDIENTE/CONFIRMADO — es del EJE, no de este endpoint), así que el subset se enforce ACÁ con un
   * ConflictError (409) explícito: una reserva ya APROBADA/COBRO_PENDIENTE/CONFIRMADO no se cancela por este
   * camino (una cancelación con-tier tras el cobro/confirmación es OTRO flujo · F3/F5). Idempotente: re-cancelar
   * una reserva ya no-PENDIENTE → el where atómico no matchea PENDIENTE_APROBACION → 0 filas → ConflictError,
   * sin re-emitir el evento (mismo sellado que reject).
   */
  async cancel(bookingId: string, passengerId: string): Promise<Booking> {
    // Read CRÍTICO desde el PRIMARY: la decisión (estado + ownership) no puede apoyarse en una réplica stale.
    const booking = await this.repo.findByIdFromPrimary(bookingId);
    // Existencia y ownership colapsan al MISMO 404 (anti-IDOR, NO 403): un no-dueño no distingue "no existe" de
    // "no es tuya". El gate vive en el service (capa 2), no solo en el guard.
    if (booking?.passengerId !== passengerId) {
      throw new NotFoundError('Reserva no encontrada', { id: bookingId });
    }
    // REGLA DE NEGOCIO: solo una solicitud PENDIENTE de aprobación es cancelable por el pasajero. Estados
    // avanzados (APROBADO/COBRO_PENDIENTE/CONFIRMADO/terminal) NO se cancelan por acá (charge en vuelo / con-tier
    // → F3/F5). Se rechaza ANTES del where atómico con un mensaje claro (la máquina no basta: CANCELADO es
    // alcanzable desde varios estados del eje, este endpoint es un subconjunto).
    if (booking.estado !== BookingState.PENDIENTE_APROBACION) {
      throw new ConflictError('Solo se puede cancelar una solicitud pendiente de aprobación', {
        estado: booking.estado,
      });
    }
    // LA REGLA, NO EL IF: valida la legalidad del eje contra el estado REAL antes del where atómico (espeja
    // approve/reject). A esta altura es PENDIENTE_APROBACION (chequeado arriba) → PENDIENTE_APROBACION → CANCELADO.
    bookingMachine.assertTransition(booking.estado, BookingState.CANCELADO);

    // OBSERVABILIDAD (regla #6): log estructurado del hecho de negocio (el pasajero cancela su solicitud). El
    // tracing/metrics de request los aporta el interceptor global del servicio (mismo que approve/reject).
    this.logger.log({
      msg: 'El pasajero CANCELA su solicitud PENDIENTE_APROBACION (booking.cancelled razon=CANCELADO_PASAJERO). Sin cobro ni Refund (charge-on-approval: nunca se aprobó)',
      bookingId,
      passengerId,
    });

    return this.repo.transitionWithEvent(
      bookingId,
      [BookingState.PENDIENTE_APROBACION],
      { estado: BookingState.CANCELADO },
      {
        eventType: BookingEventType.CANCELLED,
        aggregateId: bookingId,
        payload: {
          bookingId,
          razon: BookingCancelledRazon.CANCELADO_PASAJERO,
          estado: BookingState.CANCELADO,
          estadoAnterior: BookingState.PENDIENTE_APROBACION,
        },
      },
    );
  }

  /**
   * Lista las solicitudes de un viaje del conductor (GET /published-trips/:id/bookings · driver-rail). SOLO el
   * DUEÑO del PublishedTrip (server-truth); no-dueño / inexistente → NotFoundError (anti-IDOR, no filtra
   * existencia). Keyset paginado (mismo patrón que las otras listas). Devuelve los Bookings del viaje.
   */
  async listRequestsForTrip(
    publishedTripId: string,
    driverId: string,
    page: ListTripBookingsPageDto = {},
  ): Promise<Booking[]> {
    const trip = await this.repo.findPublishedTrip(publishedTripId);
    // Ownership server-truth: el viaje debe existir Y ser de ESTE conductor. Miss → 404 (no revela que existe
    // pero es de otro: mismo patrón anti-IDOR que getById). El Booking no porta driverId; el dueño es el del
    // PublishedTrip, así que la autorización se ancla acá, no en un filtro por driverId de la query de bookings.
    if (trip?.driverId !== driverId) {
      throw new NotFoundError('Viaje publicado no encontrado', { id: publishedTripId });
    }
    const take = page.limit ?? DEFAULT_TRIP_BOOKINGS_PAGE_SIZE;
    return this.repo.findByPublishedTripId(publishedTripId, take, page.cursor);
  }

  /**
   * F3c · CONSUMIR `payment.captured` → SEAT-LOCK ATÓMICO (ADR-014 §6 · §5.2 paso 3 · §7.1.bis). Es la
   * reacción al evento que payment-service emite cuando el webhook/poll resuelve la CAPTURA (minutos después
   * del CHARGE). CORRELACIÓN: el evento trae `tripId = bookingId` (opaco · §5.5) → se ubica el Booking por id.
   *
   * El método NO hace el check-cupo acá (sería la grieta de carrera): delega TODO a `confirmAndLockSeats`, que
   * corre chequear-cupo + decrementar + transición + outbox en UNA txn ACID con `FOR UPDATE` (§6). Acá solo:
   *  - early-return barato si el booking no existe o ya no está en COBRO_PENDIENTE (idempotencia/reorden) — la
   *    GARANTÍA dura igual la da el where atómico dentro de la txn, esto solo evita abrir la txn al pedo.
   *  - traducir el outcome a logs (CONFIRMADO / asiento-lleno → Refund en F3c-payment).
   *
   * IDEMPOTENCIA DOBLE (tolera duplicado Y reorden de Kafka): el dedup por eventId (en el consumer) + el where
   * atómico `estado: COBRO_PENDIENTE` del UPDATE dentro de la txn. Un payment.captured DUPLICADO sobre un
   * booking YA CONFIRMADO → 0 filas → NOOP → NUNCA doble-decremento (no oversold por reproceso).
   */
  async confirmCapture(bookingId: string, paymentId: string): Promise<void> {
    const booking = await this.repo.findByIdForCaptureHandler(bookingId);
    if (!booking) {
      // El tripId del evento de payment NO matchea ningún Booking (opaco · §5.5). No es nuestro: ignorar.
      this.logger.warn({
        msg: 'payment.captured sin Booking correlacionado (tripId opaco no es un bookingId de carpooling): ignorado',
        bookingId,
        paymentId,
      });
      return;
    }
    if (booking.estado !== BookingState.COBRO_PENDIENTE) {
      // Ya confirmado/cancelado (duplicado o reorden de Kafka). El where atómico igual lo blindaría; cortamos antes.
      this.logger.log({
        msg: 'payment.captured sobre un booking que ya no está en COBRO_PENDIENTE (duplicado/reorden): no-op idempotente',
        bookingId,
        estado: booking.estado,
      });
      return;
    }

    // EL SEAT-LOCK (§6): toda la decisión (cupo + decremento + transición + outbox) en UNA txn con FOR UPDATE.
    const outcome = await this.repo.confirmAndLockSeats(booking, paymentId);
    switch (outcome.kind) {
      case 'CONFIRMED':
        this.logger.log({
          msg: 'Booking CONFIRMADO bajo seat-lock atómico (asiento decrementado, booking.confirmed emitido)',
          bookingId,
          paymentId,
          tripQuedoLleno: outcome.tripQuedoLleno,
        });
        return;
      case 'SEAT_FULL':
        // CAMINO INFELIZ (§6): cobré pero otro se llevó el último asiento. booking.cancelled(ASIENTO_LLENO)
        // emitido → el Refund lo hará payment-service. F3c-payment · PENDIENTE (el consumer de booking.cancelled
        // → refund automático SOLO para ASIENTO_LLENO es el lote SIGUIENTE; F3c-booking solo EMITE el evento).
        this.logger.warn({
          msg: 'Booking CANCELADO por asiento-lleno bajo seat-lock (cobré pero otro confirmó el último asiento). booking.cancelled(ASIENTO_LLENO) emitido → Refund en F3c-payment · PENDIENTE',
          bookingId,
          paymentId,
        });
        return;
      case 'OFFER_UNAVAILABLE':
        // GUARD DEFENSIVO (§6 · F3c): el cobro capturó pero la oferta ya NO está en un estado reservable
        // (anómalo / futuro EN_RUTA-COMPLETADO-CANCELADO de F4). Se canceló limpio en vez de envenenar la
        // partición. booking.cancelled(OFERTA_NO_DISPONIBLE) emitido → Refund en F3c-payment (hubo captura,
        // igual que ASIENTO_LLENO). El camino EN_RUTA real (clock-driven) es F4.
        this.logger.warn({
          msg: 'Booking CANCELADO por oferta no-reservable bajo seat-lock (cobré pero la oferta ya no admite la reserva). booking.cancelled(OFERTA_NO_DISPONIBLE) emitido → Refund en F3c-payment · PENDIENTE',
          bookingId,
          paymentId,
        });
        return;
      case 'NOOP':
        // Carrera con el where atómico: el booking cambió de estado entre el precheck y la txn. Sin efecto.
        this.logger.log({
          msg: 'payment.captured: el booking cambió de estado entre el precheck y el seat-lock (carrera/duplicado): no-op idempotente',
          bookingId,
        });
        return;
    }
  }

  /**
   * F3c · CONSUMIR `payment.failed` → CANCELADO (ADR-014 §5.4 / §7.1.bis · BR-P02). IMPORTANTE: los 3
   * reintentos del riel (BR-P02) los hace payment-service INTERNAMENTE; booking solo REACCIONA al evento:
   *  - `willRetry === true`  → payment va a reintentar → NO-OP (el booking espera, sigue COBRO_PENDIENTE).
   *  - `willRetry === false` → DEBT permanente, riel agotado → COBRO_PENDIENTE → CANCELADO + outbox
   *    `booking.cancelled` (razon=COBRO_FALLIDO). NO hay Refund (no se capturó nada). La deuda se DERIVA de
   *    payment-service (PaymentStatus.DEBT); booking NO crea un flag DEBT propio (segunda fuente de verdad).
   *
   * El asiento NO se decrementó (solo decrementa al CAPTURAR, en confirmCapture), así que la oferta queda
   * intacta — el viaje no perdió cupo por un cobro fallido. Where atómico por estado (idempotente ante duplicado).
   */
  async handlePaymentFailed(bookingId: string, willRetry: boolean): Promise<void> {
    if (willRetry) {
      // El riel reintentará (BR-P02 interno de payment). booking ESPERA: no muta nada (sigue COBRO_PENDIENTE).
      this.logger.log({
        msg: 'payment.failed con willRetry=true: payment reintentará (BR-P02); el booking sigue COBRO_PENDIENTE (no-op)',
        bookingId,
      });
      return;
    }

    // FALLA PERMANENTE (riel agotado): COBRO_PENDIENTE → CANCELADO (razon=COBRO_FALLIDO). Sin Refund, sin tocar
    // el asiento. El where atómico vuelve la operación idempotente (duplicado/reorden → null → no-op).
    const cancelled = await this.repo.cancelForPaymentFailed(bookingId);
    if (!cancelled) {
      this.logger.log({
        msg: 'payment.failed (permanente) sobre un booking que ya no estaba en COBRO_PENDIENTE (duplicado/reorden): no-op idempotente',
        bookingId,
      });
      return;
    }
    this.logger.warn({
      msg: 'Booking CANCELADO por cobro fallido permanente (riel agotado, BR-P02). booking.cancelled(COBRO_FALLIDO) emitido. SIN Refund (no se capturó). El asiento no se tocó. Deuda derivada de PaymentStatus.DEBT (sin flag propio)',
      bookingId,
    });
  }

  /**
   * triggerCharge — ÚNICO punto que dispara el CHARGE del carpooling y registra COBRO_PENDIENTE (DRY: lo usan
   * approve() Y reserve()-INSTANT · ADR-014 §5.2 paso 2). El charge es REST (I/O externa) → corre FUERA de toda
   * $transaction Prisma; recién su resultado se persiste en una tx propia (`markChargePending`).
   *
   * Precondición: `booking` está en APROBADO. (approve/reserve garantizan esto antes de llamar.)
   *
   * `driverId` (ADR-015 D4 / hueco 1): el dueño del PublishedTrip (server-truth — `trip.driverId`, NO un campo
   * del Booking). Viaja AL CHARGE para que el Payment nazca CON conductor; sin él, el Payment quedaría
   * driverId=null y el cron de payout (`driverId: { not: null }`) excluiría el cobro → el conductor de
   * carpooling cobraría al pasajero pero NUNCA recibiría su liquidación. Ambos callers lo tienen en el scope
   * (approve: su parámetro; reserve-INSTANT: `trip.driverId`) → cero lookups extra.
   *
   * Idempotencia financiera: el adapter deriva `dedupKey = booking-charge:{bookingId}` (determinista, del
   * bookingId — el driverId NO entra en la dedupKey) → un reintento (mismo booking) NO duplica el cobro. Por
   * eso re-ejecutar approve tras un charge fallido es seguro.
   *
   * RESULTADO del charge (FIX 2/3 · ADR-014 §5.4 "falla permanente → CANCELADO") — el disparo NO siempre lanza
   * ni devuelve PENDING; se INSPECCIONA `charge.status` (PaymentStatus tipado, cero strings mágicos):
   *   · PENDING                 → markChargePending (APROBADO → COBRO_PENDIENTE). Camino async normal.
   *   · CAPTURED (raro síncrono) → SE TRATA IGUAL QUE PENDING → COBRO_PENDIENTE. NO se decrementa el asiento ni
   *                                se confirma acá: eso es F3c (el handler de payment.captured corre la txn
   *                                atómica del §6 con el seat-lock). Confirmar acá saltearía el lock → oversold.
   *   · DEBT / FAILED           → decline SÍNCRONO (el cobro falló al iniciar) → APROBADO → CANCELADO + outbox
   *                                booking.cancelled (razon=COBRO_RECHAZADO). Sin Refund (no se capturó nada).
   *
   * CATCH (el charge LANZA) — permanente vs transitorio (la causa raíz del loop):
   *   · ChargePermanentlyRejectedError (4xx no-reintentable) → APROBADO → CANCELADO (terminal, NO loop).
   *   · ExternalServiceError (5xx/408/429/timeout/red, TRANSITORIO) → se PROPAGA: el booking queda en APROBADO
   *     RE-EJECUTABLE (re-llamar approve re-entra acá, idempotente por dedupKey). El asiento NO se toca (F3c).
   *
   * NINGÚN camino deja el booking colgado: o COBRO_PENDIENTE (async sigue), o CANCELADO (terminal), o APROBADO
   * re-ejecutable (transitorio, con salida). El doble-cobro lo corta la dedupKey determinista (§5.3).
   */
  private async triggerCharge(booking: Booking, driverId: string): Promise<Booking> {
    // El método de pago lo eligió el pasajero al reservar y vive en el Booking (server-truth). El tipo Prisma
    // PaymentMethod es la cara LOCAL del contrato compartido y es ESTRUCTURALMENTE el mismo set que el
    // PaymentMethod de @veo/shared-types que espera el puerto (mismos miembros) → asignable directo, sin cast.
    const method: PaymentMethod = booking.paymentMethod;
    // CONTRIBUCIÓN TOTAL del pasajero = precioAcordado (POR ASIENTO) × asientos reservados. `precioAcordado`
    // es el precio de UN asiento (= precioBase full-route + specialRequest, ambos por-asiento), y un Booking
    // puede tomar 1..N asientos (validado contra asientosDisponibles). Cobrar `precioAcordado` a secas
    // SUB-COBRARÍA una reserva multi-asiento (3 asientos pagarían 1). El tope de cost-sharing es POR ASIENTO,
    // así que × asientos sigue siendo legal (≤ tope × asientos). Esto es la CONTRIBUCIÓN que va a payment; el
    // service fee al pasajero lo SUMA payment-service ENCIMA de esta contribución (F2.7) — NO se calcula acá.
    // Sin overflow: precioAcordado ≤ tope de cost-sharing (céntimos realistas) y asientos ≤ 8 (@Max DTO) →
    // el producto entra holgado en el Int32 de Postgres (céntimos PEN), muy por debajo de 2^31.
    const grossCents = booking.precioAcordado * booking.asientos;
    let charge;
    try {
      charge = await this.payment.charge({
        bookingId: booking.id, // = tripId opaco para payment (§5.5); el adapter deriva la dedupKey financiera.
        grossCents,
        method,
        passengerId: booking.passengerId,
        // ADR-015 D4 / hueco 1: el dueño del PublishedTrip va al Payment → el cobro del carpooling ENTRA a la
        // liquidación (el cron de payout filtra `driverId: { not: null }`). El puerto ya acepta driverId (opt).
        driverId,
      });
    } catch (err) {
      // RECHAZO PERMANENTE (4xx no-reintentable): el booking NO puede prosperar — reintentar daría el mismo
      // rechazo (misma dedupKey) → LOOP. Salida TERMINAL: APROBADO → CANCELADO (razon=COBRO_RECHAZADO).
      if (err instanceof ChargePermanentlyRejectedError) {
        this.logger.warn({
          msg: 'CHARGE del carpooling RECHAZADO PERMANENTEMENTE al disparar: el booking se CANCELA (terminal, NO loop). El dinero NO se movió (sin Refund)',
          bookingId: booking.id,
          cause: err.message,
        });
        return this.cancelForChargeRejected(booking, { upstream: err.details });
      }
      // TRANSITORIO: el booking queda en APROBADO (la tx2 no corre). Se PROPAGA un ExternalServiceError para
      // que el caller reintente — re-llamar approve re-dispara el charge (idempotente por dedupKey). NO se traga.
      this.logger.warn({
        msg: 'CHARGE del carpooling FALLÓ (TRANSITORIO) tras aprobar: el booking queda en APROBADO (re-ejecutable vía approve). El dinero NO se movió; el re-disparo es idempotente por dedupKey',
        bookingId: booking.id,
        cause: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof ExternalServiceError) throw err;
      throw new ExternalServiceError('Falló el CHARGE del carpooling al aprobar', {
        bookingId: booking.id,
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    // DECLINE SÍNCRONO (payment respondió 200 con status DEBT/FAILED): el cobro falló al iniciar → el booking
    // NO debe quedar en COBRO_PENDIENTE esperando una captura que nunca llegará (quedaría COLGADO: el handler
    // F3c que reconciliaría no existe). Salida TERMINAL: APROBADO → CANCELADO (razon=COBRO_RECHAZADO). Sin Refund.
    if (isSyncDeclineStatus(charge.status)) {
      this.logger.warn({
        msg: 'CHARGE del carpooling DECLINADO SÍNCRONAMENTE (DEBT/FAILED) al disparar: el booking se CANCELA (terminal). El dinero NO se capturó (sin Refund)',
        bookingId: booking.id,
        status: charge.status,
      });
      return this.cancelForChargeRejected(booking, {
        status: charge.status,
        paymentId: charge.paymentId,
      });
    }

    // charge OK (PENDING — o un CAPTURED síncrono, tratado IGUAL): tx2 atómica → APROBADO → COBRO_PENDIENTE +
    // guarda el paymentId. La CONFIRMACIÓN (decremento de asiento bajo seat-lock §6) la corre el handler de
    // payment.captured de F3c (PENDIENTE) — NO acá: confirmar/decrementar acá saltearía el lock → oversold.
    return this.repo.markChargePending(booking.id, charge.paymentId);
  }

  /**
   * Transición TERMINAL del booking por cobro rechazado (decline síncrono DEBT/FAILED, o 4xx permanente ·
   * ADR-014 §5.4): APROBADO → CANCELADO + outbox `booking.cancelled` (razon=COBRO_RECHAZADO, estadoAnterior=
   * APROBADO) en UNA tx (outbox-en-transacción). REUSA `transitionWithEvent` (allowedStates=[APROBADO], where
   * atómico): si dos disparos compiten, solo uno matchea APROBADO → el 2º choca 0 filas → ConflictError, sin
   * doble-cancelar ni doble-evento. La REGLA primero (assertTransition contra el estado real) por consistencia
   * con approve/reject. El payload del booking individual valida contra el schema bookingCancelled (forma B,
   * aditiva). NO hay Refund: charge-on-approval sin hold → no se capturó nada que devolver.
   */
  private async cancelForChargeRejected(
    booking: Booking,
    details: Record<string, unknown>,
  ): Promise<Booking> {
    // La REGLA contra el estado REAL (FIX 6): precondición de triggerCharge → booking.estado === APROBADO.
    bookingMachine.assertTransition(booking.estado, BookingState.CANCELADO);
    return this.repo.transitionWithEvent(
      booking.id,
      [BookingState.APROBADO],
      { estado: BookingState.CANCELADO },
      {
        eventType: BookingEventType.CANCELLED,
        aggregateId: booking.id,
        payload: {
          bookingId: booking.id,
          razon: BookingCancelledRazon.COBRO_RECHAZADO,
          estado: BookingState.CANCELADO,
          estadoAnterior: BookingState.APROBADO,
          ...details,
        },
      },
    );
  }

  /**
   * Gate de OWNERSHIP del driver-rail (capa 2/3) para approve/reject (ADR-014 §8 · §10): DUEÑO del PublishedTrip
   * de la reserva (server-truth). Lee el Booking desde el PRIMARY (estado fresco), resuelve su PublishedTrip y
   * exige `trip.driverId === driverId`. Booking inexistente, o de un viaje ajeno → NotFoundError (anti-IDOR: el
   * conductor no-dueño no distingue "no existe" de "no es tuyo"). Devuelve el Booking + el PublishedTrip resuelto
   * para que el caller opere sin re-leerlos (approve necesita `trip.vehicleId` para re-validar la operabilidad).
   *
   * SOLO ownership: la re-validación del CONDUCTOR la hace CADA caller según su riesgo — approve (mueve plata)
   * exige elegibilidad FULL (`assertDriverEligibleToCharge`); reject (no mueve plata) solo suspensión sobreviniente
   * (`assertDriverActive`). Mezclar ambos acá forzaría a reject a un criterio que no necesita, o a approve a uno
   * insuficiente (la asimetría de elegibilidad que cazó el gate adversarial).
   */
  private async assertDriverOwnsBookingTrip(
    bookingId: string,
    driverId: string,
  ): Promise<{ booking: Booking; trip: { vehicleId: string } }> {
    // Read CRÍTICO desde el PRIMARY: la decisión (estado + ownership) no puede apoyarse en una réplica stale.
    const booking = await this.repo.findByIdFromPrimary(bookingId);
    if (!booking) {
      throw new NotFoundError('Reserva no encontrada', { id: bookingId });
    }
    // Ownership: el dueño es el conductor del PublishedTrip de la reserva (el Booking no porta driverId).
    const trip = await this.repo.findPublishedTrip(booking.publishedTripId);
    if (trip?.driverId !== driverId) {
      // No-dueño → 404 (anti-IDOR, NO 403: no se filtra la existencia de una reserva de un viaje ajeno).
      throw new NotFoundError('Reserva no encontrada', { id: bookingId });
    }
    return { booking, trip };
  }

  /**
   * Gate de SUSPENSIÓN SOBREVINIENTE del conductor (approve/reject · ADR-014 §8/§10). Re-valida contra identity
   * (server-truth) que el conductor sigue ACTIVO. FALLA-CERRADO: si identity no responde → ForbiddenError (403)
   * — nunca un conductor suspendido operando por un error de red (espeja el gate de publish de F1a). Predicado
   * ÚNICO `isDriverActive` (más laxo que el de publish: acá solo importa la suspensión, no KYC/antecedentes —
   * esos se validaron al publicar; ver DriverActiveView en domain/driver-eligibility).
   */
  private async assertDriverActive(driverId: string): Promise<void> {
    let driver;
    try {
      driver = await this.identity.getDriver(driverId);
    } catch (err) {
      // fail-closed: identity caída / timeout → no se permite aprobar/rechazar.
      throw new ForbiddenError(
        'No se pudo verificar el estado del conductor (identity no disponible)',
        {
          driverId,
          cause: err instanceof Error ? err.message : String(err),
        },
      );
    }
    if (isDriverActive(driver)) return;
    if (!driver.found) {
      throw new ForbiddenError('Conductor no encontrado', { driverId });
    }
    throw new ForbiddenError('Conductor suspendido: no puede operar sus solicitudes', {
      driverId,
      suspendedAt: driver.suspendedAt,
      currentStatus: driver.currentStatus,
    });
  }

  /**
   * Gate de ELEGIBILIDAD FULL del conductor en el MOMENTO DEL CHARGE (approve · Lote 3 · cierre del re-gate).
   * Re-valida contra identity (server-truth) que el conductor sigue PLENAMENTE elegible para COBRAR — con el
   * predicado ÚNICO `isDriverEligible` (found + no-suspendido + KYC VERIFIED + antecedentes CLEARED), el MISMO
   * que el publish y el gate de reserva (`assertOfferDriverEligible`). MÁS ESTRICTO que `assertDriverActive`
   * (suspensión-only) a propósito: kycStatus/backgroundCheckStatus PUEDEN flipear a REJECTED en un conductor NO
   * suspendido (verificado en identity: kyc-status-machine + background-check CLEARED→REJECTED), y approve mueve
   * plata — chequear solo suspensión dejaba cobrar a un conductor con KYC/antecedentes revocados (la ALTA del
   * re-gate). DRIVER-FACING (es el conductor quien aprueba): ForbiddenError (403), no ConflictError. FAIL-CLOSED:
   * identity caída → 403 (nunca un conductor no elegible cobrando por un error de red; espeja publish/approve).
   */
  private async assertDriverEligibleToCharge(driverId: string): Promise<void> {
    let driver;
    try {
      driver = await this.identity.getDriver(driverId);
    } catch (err) {
      // fail-closed: identity caída / timeout → no se cobra sin verificar la elegibilidad plena del conductor.
      throw new ForbiddenError(
        'No se pudo verificar la elegibilidad del conductor (identity no disponible)',
        {
          driverId,
          cause: err instanceof Error ? err.message : String(err),
        },
      );
    }
    if (isDriverEligible(driver)) return;
    // No elegible: un único 403 con los ejes diagnósticos (suspensión / KYC / antecedentes) para el conductor/soporte.
    throw new ForbiddenError(
      'Conductor no elegible para cobrar (suspensión / KYC / antecedentes)',
      {
        driverId,
        found: driver.found,
        currentStatus: driver.currentStatus,
        suspendedAt: driver.suspendedAt,
        kycStatus: driver.kycStatus,
        backgroundCheckStatus: driver.backgroundCheckStatus,
      },
    );
  }

  /**
   * dedupKey de REQUEST: namespaceada por el `passengerId` server-truth Y por el `Idempotency-Key` del
   * cliente — `booking:req:{passengerId}:{idempotencyKey}`. El `passengerId` va PRIMERO (es server-truth, de
   * la identidad firmada — NUNCA del body): por construcción, dos pasajeros distintos NO pueden derivar la
   * misma dedupKey aunque manden el MISMO header (anti-IDOR cross-tenant). El UNIQUE global pasa a ser, de
   * facto, UNIQUE POR-PASAJERO.
   *  - CON header (UUID válido por intento de submit): la key encarna ESE intento de ESE pasajero. Un
   *    reintento del mismo submit reusa la misma key → P2002 → existente (idempotente). Un submit NUEVO trae
   *    una key nueva → fila nueva. NUNCA es un lock de `passenger × trip`: tras un terminal el re-booking va.
   *  - SIN header: key única server-side (uuidv7) → NO dedupea reintentos (el cliente DEBE mandar el header
   *    para retry-safety) pero TAMPOCO lockea. Igual va scopeada por passengerId. Un header presente pero
   *    malformado se rechaza tipado (no se degrada en silencio a "sin header", que perdería la garantía).
   *
   * NO confundir con la idempotencia del CHARGE (F3): esa se deriva del `bookingId` al cobrar (per-booking),
   * es OTRA key y vive en otra fase. Acá solo cortamos el doble-submit del POST /bookings.
   */
  private deriveRequestDedupKey(passengerId: string, idempotencyKey?: string): string {
    const tenantNamespace = `${REQUEST_DEDUP_NAMESPACE}${passengerId}:` as const;
    if (idempotencyKey === undefined) {
      return `${tenantNamespace}${uuidv7()}`;
    }
    if (!isUuid(idempotencyKey)) {
      throw new ValidationError('Idempotency-Key debe ser un UUID', { idempotencyKey });
    }
    return `${tenantNamespace}${idempotencyKey}`;
  }
}
