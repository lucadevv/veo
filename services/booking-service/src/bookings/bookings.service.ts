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
 * DIFERIDO (degradación honesta, ADR-014):
 *  - La VALIDACIÓN del método de pago al reservar (gRPC `payment.GetPayment`, §5.2 paso 1) es F1/F3: F0 NO
 *    consulta payment. El gate "pasajero con deuda no puede reservar" (PaymentStatus.DEBT derivado) es F3.
 *  - El gate gRPC `identity.GetDriver` y el cobro (CHARGE async → COBRO_PENDIENTE → CONFIRMADO) son F1/F3.
 *  - El lock atómico de asientos (§6) SE CONSTRUIRÁ en el handler de payment.captured (F3b · PENDIENTE, aún
 *    no existe): hoy F0 valida cupo de forma NO transaccional (chequeo barato anti-overbooking obvio); la
 *    garantía dura del cupo llegará con ese lock en F3b. NO describir el handler como si ya corriera.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError, NotFoundError, ValidationError, isUuid, uuidv7 } from '@veo/utils';
import {
  BookingState,
  ModoReserva,
  PublishedTripState,
  type Booking,
} from '../generated/prisma';
import { bookingMachine } from '../domain/booking-state';
import { PassengerHasDebtError } from '../domain/payment-charge';
import { BookingEventType } from '../events/booking-events';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../ports/payment/payment-gateway.port';
import { BookingsRepository, type CreateBookingData } from './bookings.repository';
import type { CreateBookingDto } from './dto/create-booking.dto';

/**
 * Prefijo de la dedupKey de REQUEST (idempotencia del POST /bookings). Aísla este espacio de claves del
 * resto (p.ej. la idempotencia del CHARGE de F3, que es per-booking y vive en otra fase). Constante tipada,
 * cero strings mágicos sueltos: un único punto define el namespace.
 */
const REQUEST_DEDUP_NAMESPACE = 'booking:req:' as const;

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly repo: BookingsRepository,
    @Inject(PAYMENT_GATEWAY) private readonly payment: PaymentGateway,
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
   * ⚠️ RED DE SEGURIDAD PENDIENTE: la justificación del fail-open se apoya en "el cobro real RE-VALIDA la
   * deuda en la aprobación". Ese re-check (CHARGE / handler de aprobación) es F3b y AÚN NO EXISTE. Hasta que
   * F3b se construya, NO hay segunda barrera: un deudor que se cuela por un fail-open transitorio NO es
   * re-validado aguas abajo. Tener presente al evaluar el riesgo del fail-open hoy.
   */
  private async assertNoDebt(passengerId: string): Promise<void> {
    let summary;
    try {
      summary = await this.payment.getDebt(passengerId);
    } catch (err) {
      // FAIL-OPEN: payment caído/timeout no bloquea la reserva (no mueve plata). El re-check del cobro que
      // sería la segunda barrera es F3b y AÚN NO EXISTE (pendiente). Se loguea para observabilidad/auditoría
      // del bypass — nunca se traga en silencio.
      this.logger.warn({
        msg: 'Gate de deuda DEGRADADO (payment-service inaccesible): se permite reservar (fail-open). El re-check del cobro (segunda barrera) es F3b · PENDIENTE',
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
    // overbooking concurrente SE CONSTRUIRÁ en el lock atómico del handler de payment.captured (§6, F3b ·
    // PENDIENTE, aún no existe). Hoy solo este chequeo barato cubre el overbooking obvio.
    if (dto.asientos > trip.asientosDisponibles) {
      throw new ConflictError('No hay asientos suficientes disponibles', {
        pedidos: dto.asientos,
        disponibles: trip.asientosDisponibles,
      });
    }

    // GATE DE DEUDA (ADR-014 §5.2 paso 1 · §5.4): un pasajero con deuda pendiente (DEBT derivado de payment)
    // NO puede reservar. Va DESPUÉS de los chequeos locales baratos (existe/disponible/cupo) — no consultamos
    // payment por una oferta inexistente. Fail-OPEN con observabilidad si payment no responde (ver assertNoDebt).
    await this.assertNoDebt(passengerId);

    // Precio acordado = base + specialRequest (céntimos PEN, Int). F0 usa el precio full-route; el pricing
    // por TRAMO (precioPorTramo según pickup/dropoff) es F1.
    const specialRequest = dto.specialRequest ?? 0;
    const precioAcordado = trip.precioBase + specialRequest;
    if (precioAcordado < 0) {
      throw new ValidationError('precioAcordado no puede ser negativo', { precioAcordado });
    }

    // ESTADO INICIAL POR LA MÁQUINA (cero strings mágicos): SOLICITADO → (REVISION) PENDIENTE_APROBACION
    // o (INSTANT) APROBADO. assertTransition VALIDA la transición desde SOLICITADO antes de persistir.
    const isInstant = trip.modoReserva === ModoReserva.INSTANT_BOOKING;
    const estadoInicial = isInstant
      ? BookingState.APROBADO
      : BookingState.PENDIENTE_APROBACION;
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
      paymentId: null, // se setea en el CHARGE (F3)
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
          origen: 'INSTANT_BOOKING',
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
    return this.repo.createWithEventIdempotent(dedupKey, passengerId, data, {
      eventType,
      aggregateId: id,
      payload,
    });
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
