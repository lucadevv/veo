import { describe, it, expect, vi } from 'vitest';
import {
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
  ValidationError,
  isUuidV7,
  uuidv7,
} from '@veo/utils';
import { DriverStatus, KycStatus } from '@veo/shared-types';
import { PaymentMethod, PaymentStatus } from '@veo/shared-types';
import { schemaForEvent } from '@veo/events';
import { BookingState, ModoReserva, PublishedTripState } from '../generated/prisma';
import { BookingsService } from './bookings.service';
import type { BookingsRepository, CreateBookingData, OutboxIntent } from './bookings.repository';
import type { CreateBookingDto } from './dto/create-booking.dto';
import { FakePaymentGateway, type FakePaymentGatewayOptions } from '../ports/payment/fake-payment-gateway';
import { ChargePermanentlyRejectedError } from '../domain/payment-charge';
import { BACKGROUND_CHECK_CLEARED } from '../domain/driver-eligibility';
import type { IdentityClient, IdentityDriver } from '../identity/identity-client.port';

/** Conductor ACTIVO/no-suspendido por default (gate approve/reject · F3b); los tests negativos sobrescriben. */
function makeDriver(over: Partial<IdentityDriver> = {}): IdentityDriver {
  return {
    id: '00000000-0000-0000-0000-0000000000d1',
    userId: '00000000-0000-0000-0000-0000000000u1',
    currentStatus: DriverStatus.AVAILABLE,
    backgroundCheckStatus: BACKGROUND_CHECK_CLEARED,
    kycStatus: KycStatus.VERIFIED,
    suspendedAt: null,
    found: true,
    name: 'Conductor Demo',
    averageRating: 4.8,
    ...over,
  };
}

/** IdentityClient fake (gate de driver activo en approve/reject). Por default devuelve un conductor activo. */
function makeIdentity(driver: IdentityDriver | (() => Promise<IdentityDriver>) = makeDriver()): IdentityClient {
  const getDriver = vi.fn(typeof driver === 'function' ? driver : async () => driver);
  return { getDriver };
}

/**
 * Construye el service con el repo fake + un PaymentGateway fake (gate de deuda · §5.4; charge · F3b) + un
 * IdentityClient fake (gate de driver activo · F3b). Por default el gateway NO reporta deuda y el conductor
 * está activo: los smoke/idempotencia no se ven afectados. Los tests del gate pasan opciones.
 */
function makeService(
  repo: BookingsRepository,
  gatewayOpts?: FakePaymentGatewayOptions,
  identity?: IdentityClient,
): BookingsService {
  return new BookingsService(repo, new FakePaymentGateway(gatewayOpts), identity ?? makeIdentity());
}

/**
 * Smoke del create/read del BookingsService (sin Nest DI ni DB — repo fake). Verifica que el estado
 * inicial lo decide el modoReserva de la oferta vía la máquina de estados (REVISION → PENDIENTE_APROBACION,
 * INSTANT → APROBADO salta), el precio acordado (base + specialRequest), el dedupKey de REQUEST anclado en el
 * Idempotency-Key del cliente (NO en passenger × trip → sin lockout), el evento booking.requested, y los
 * gates de cupo/disponibilidad.
 */
const PASSENGER_ID = '00000000-0000-0000-0000-0000000000c1';
// Idempotency-Key = UUID válido por intento de submit (el cliente lo genera). Lo derivamos con uuidv7() en
// vez de hardcodear un literal, para no meter strings mágicos y respetar el contrato de UUID que el service valida.
const IDEMPOTENCY_KEY = uuidv7();
// La dedupKey va SCOPEADA por passengerId (anti-IDOR cross-tenant): `booking:req:{passengerId}:{key}`.
const REQUEST_DEDUP_PREFIX = 'booking:req:';
const tenantDedupPrefix = (passengerId: string) => `${REQUEST_DEDUP_PREFIX}${passengerId}:`;

function makeDto(over: Partial<CreateBookingDto> = {}): CreateBookingDto {
  return {
    publishedTripId: '00000000-0000-0000-0000-0000000000a1',
    asientos: 2,
    // Método de pago elegido por el pasajero al reservar (ADR-014 §5.5). YAPE por default; los tests del
    // charge verifican que viaja al gateway.
    paymentMethod: PaymentMethod.YAPE,
    pickupLat: -12.05,
    pickupLon: -77.04,
    dropoffLat: -13.52,
    dropoffLon: -71.97,
    ...over,
  };
}

function makeTrip(over: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-0000000000a1',
    driverId: '00000000-0000-0000-0000-0000000000d1',
    estado: PublishedTripState.PUBLICADO,
    asientosDisponibles: 3,
    precioBase: 4500,
    modoReserva: ModoReserva.REVISION_CADA_SOLICITUD,
    ...over,
  };
}

function makeRepo(trip: Record<string, unknown> | null) {
  const findPublishedTrip = vi.fn(async () => trip);
  const createWithEventIdempotent = vi.fn(
    async (
      _dedupKey: string,
      _expectedPassengerId: string,
      data: CreateBookingData,
      _intent: OutboxIntent,
    ) => ({ ...data }),
  );
  const findById = vi.fn();
  // F3b: el read crítico del gate approve/reject va al PRIMARY. Por default no devuelve nada (los tests del
  // gate lo sobrescriben con la reserva concreta).
  const findByIdFromPrimary = vi.fn();
  // F3b: transición de estado + outbox (approve/reject). Devuelve un booking con el estado nuevo aplicado.
  const transitionWithEvent = vi.fn(
    async (
      id: string,
      _allowed: BookingState[],
      data: { estado?: BookingState },
      _intent: OutboxIntent,
    ) => ({ id, ...data }),
  );
  // F3b: tx2 del charge (APROBADO → COBRO_PENDIENTE + paymentId). Devuelve el booking con el estado nuevo.
  const markChargePending = vi.fn(async (id: string, paymentId: string) => ({
    id,
    paymentId,
    estado: BookingState.COBRO_PENDIENTE,
  }));
  // F3b: listado de solicitudes de un viaje (driver-rail). Por default vacío; los tests lo sobrescriben.
  const findByPublishedTripId = vi.fn(async () => [] as unknown[]);
  const repo = {
    findPublishedTrip,
    createWithEventIdempotent,
    findById,
    findByIdFromPrimary,
    transitionWithEvent,
    markChargePending,
    findByPublishedTripId,
  } as unknown as BookingsRepository;
  return {
    repo,
    findPublishedTrip,
    createWithEventIdempotent,
    findById,
    findByIdFromPrimary,
    transitionWithEvent,
    markChargePending,
    findByPublishedTripId,
  };
}

describe('BookingsService · smoke create/read', () => {
  it('REVISION: la reserva nace PENDIENTE_APROBACION, precioAcordado = base + specialRequest, evento booking.requested', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip());
    const service = makeService(repo);

    await service.reserve(PASSENGER_ID, makeDto({ specialRequest: 500 }), IDEMPOTENCY_KEY);

    expect(createWithEventIdempotent).toHaveBeenCalledOnce();
    const call = createWithEventIdempotent.mock.calls[0];
    if (!call) throw new Error('createWithEventIdempotent no fue llamado');
    const [dedupKey, expectedPassengerId, data, intent] = call;
    expect(data.passengerId).toBe(PASSENGER_ID); // server-truth, no del body
    expect(expectedPassengerId).toBe(PASSENGER_ID); // se pasa al repo para el chequeo de ownership en recovery
    expect(data.estado).toBe(BookingState.PENDIENTE_APROBACION);
    expect(data.precioAcordado).toBe(5000); // 4500 base + 500 specialRequest (céntimos)
    // dedupKey de REQUEST anclada en el Idempotency-Key del cliente Y scopeada por passengerId (anti-IDOR
    // cross-tenant) — NO en passenger × trip (sin lockout).
    expect(dedupKey).toBe(`${tenantDedupPrefix(PASSENGER_ID)}${IDEMPOTENCY_KEY}`);
    expect(data.dedupKey).toBe(dedupKey);
    expect(intent.eventType).toBe('booking.requested'); // REVISION → PENDIENTE_APROBACION (§7.1)
  });

  it('INSTANT: la reserva SALTA a APROBADO y emite booking.approved (no booking.requested · §7.1)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(
      makeTrip({ modoReserva: ModoReserva.INSTANT_BOOKING }),
    );
    const service = makeService(repo);

    await service.reserve(PASSENGER_ID, makeDto());

    const call = createWithEventIdempotent.mock.calls[0];
    if (!call) throw new Error('createWithEventIdempotent no fue llamado');
    const [, , data, intent] = call;
    expect(data.estado).toBe(BookingState.APROBADO);
    // El evento refleja el ESTADO REAL: APROBADO → booking.approved (emitir booking.requested mentiría).
    expect(intent.eventType).toBe('booking.approved');
    expect(intent.payload).toMatchObject({ estado: BookingState.APROBADO, origen: 'INSTANT_BOOKING' });
    // FIX 1 — el payload EMITIDO valida contra el SCHEMA PUBLICADO de booking.approved (@veo/events). Un test
    // que hubiera cazado el poison message: si `origen` no estuviera en el z.enum del schema, esto fallaría.
    const schema = schemaForEvent('booking.approved');
    expect(schema).toBeDefined();
    expect(schema!.safeParse(intent.payload).success).toBe(true);
  });

  it('idempotencia de request: MISMO Idempotency-Key (reintento del mismo submit) → MISMA dedupKey', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip());
    const service = makeService(repo);

    // Mismo submit reintentado: el cliente reusa la misma Idempotency-Key entre reintentos.
    await service.reserve(PASSENGER_ID, makeDto(), IDEMPOTENCY_KEY);
    await service.reserve(PASSENGER_ID, makeDto(), IDEMPOTENCY_KEY);

    const k1 = createWithEventIdempotent.mock.calls[0]?.[0];
    const k2 = createWithEventIdempotent.mock.calls[1]?.[0];
    expect(k1).toBe(`${tenantDedupPrefix(PASSENGER_ID)}${IDEMPOTENCY_KEY}`);
    expect(k2).toBe(k1); // misma key + mismo pasajero → el UNIQUE corta el duplicado en el repo (P2002 → existente)
  });

  it('ANTI-LOCKOUT: el MISMO passenger × trip con Idempotency-Keys DISTINTAS → dedupKeys DISTINTAS (re-booking)', async () => {
    // Reproduce el lockout: con el modelo viejo (key = passenger × trip) un re-booking tras un terminal
    // alcanzable (RECHAZADO/EXPIRADO/CANCELADO) re-derivaba la MISMA key → P2002 → devolvía la reserva muerta.
    // Con el modelo correcto, un submit NUEVO trae una key NUEVA → dedupKey distinta → crea una reserva nueva.
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip());
    const service = makeService(repo);
    const KEY_INTENTO_1 = uuidv7();
    const KEY_INTENTO_2 = uuidv7();

    await service.reserve(PASSENGER_ID, makeDto(), KEY_INTENTO_1); // 1ª reserva (luego va a un terminal)
    await service.reserve(PASSENGER_ID, makeDto(), KEY_INTENTO_2); // re-booking, MISMO viaje, key NUEVA

    const k1 = createWithEventIdempotent.mock.calls[0]?.[0];
    const k2 = createWithEventIdempotent.mock.calls[1]?.[0];
    expect(k1).toBe(`${tenantDedupPrefix(PASSENGER_ID)}${KEY_INTENTO_1}`);
    expect(k2).toBe(`${tenantDedupPrefix(PASSENGER_ID)}${KEY_INTENTO_2}`);
    expect(k2).not.toBe(k1); // NO hay lock eterno passenger × trip → el re-booking deriva otra key
  });

  it('ANTI-IDOR CROSS-TENANT: dos pasajeros DISTINTOS con el MISMO Idempotency-Key → dedupKeys DISTINTAS (no colisionan)', async () => {
    // Reproduce el ataque: el pasajero B manda un POST con el MISMO Idempotency-Key que el pasajero A ya usó.
    // Con el modelo VIEJO (dedupKey GLOBAL = `booking:req:{key}`) ambos derivaban la MISMA dedupKey → el insert
    // de B chocaba P2002 → la recovery devolvía la reserva de A (PII ajena). Con el namespace por passengerId,
    // A y B derivan dedupKeys DISTINTAS → NUNCA colisionan → B jamás toca la fila de A.
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip());
    const service = makeService(repo);
    const PASSENGER_A = '00000000-0000-0000-0000-00000000000a';
    const PASSENGER_B = '00000000-0000-0000-0000-00000000000b';
    const SHARED_KEY = uuidv7(); // el MISMO header que A usó, reusado por el atacante B

    await service.reserve(PASSENGER_A, makeDto(), SHARED_KEY);
    await service.reserve(PASSENGER_B, makeDto(), SHARED_KEY);

    const callA = createWithEventIdempotent.mock.calls[0];
    const callB = createWithEventIdempotent.mock.calls[1];
    if (!callA || !callB) throw new Error('createWithEventIdempotent no fue llamado dos veces');
    const [dedupA, expectedA] = callA;
    const [dedupB, expectedB] = callB;

    // Cada dedupKey va scopeada por SU dueño server-truth → distintas aunque el header sea idéntico.
    expect(dedupA).toBe(`${tenantDedupPrefix(PASSENGER_A)}${SHARED_KEY}`);
    expect(dedupB).toBe(`${tenantDedupPrefix(PASSENGER_B)}${SHARED_KEY}`);
    expect(dedupB).not.toBe(dedupA); // NO colisionan → el UNIQUE global se comporta como UNIQUE por-pasajero
    // El passengerId esperado que se pasa al repo (para el chequeo de ownership en recovery) es el de cada uno.
    expect(expectedA).toBe(PASSENGER_A);
    expect(expectedB).toBe(PASSENGER_B);
  });

  it('sin Idempotency-Key: NO bloquea por passenger × trip — genera una key única server-side (uuidv7), sin lockout', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip());
    const service = makeService(repo);

    await service.reserve(PASSENGER_ID, makeDto()); // sin header
    await service.reserve(PASSENGER_ID, makeDto()); // sin header, mismo passenger × trip

    const k1 = createWithEventIdempotent.mock.calls[0]?.[0];
    const k2 = createWithEventIdempotent.mock.calls[1]?.[0];
    expect(k1).toBeDefined();
    expect(k2).toBeDefined();
    expect(k2).not.toBe(k1); // keys distintas → no lockea (pero tampoco dedupea: el retry-safe exige el header)
    // Ambas keys van scopeadas por el passengerId server-truth (anti-IDOR cross-tenant) aun sin header.
    expect(k1).toContain(tenantDedupPrefix(PASSENGER_ID));
    // La parte aleatoria es un uuidv7 válido (no un string mágico): el namespace por pasajero + uuid server-side.
    expect(isUuidV7(k1!.slice(tenantDedupPrefix(PASSENGER_ID).length))).toBe(true);
  });

  it('Idempotency-Key malformado (no UUID) → ValidationError (no se degrada en silencio a "sin header")', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip());
    const service = makeService(repo);
    await expect(service.reserve(PASSENGER_ID, makeDto(), 'no-es-uuid')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('rechaza reservar más asientos que los disponibles (409)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip({ asientosDisponibles: 1 }));
    const service = makeService(repo);
    await expect(service.reserve(PASSENGER_ID, makeDto({ asientos: 2 }))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('rechaza reservar sobre una oferta no abierta (LLENO → 409)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip({ estado: PublishedTripState.LLENO }));
    const service = makeService(repo);
    await expect(service.reserve(PASSENGER_ID, makeDto())).rejects.toBeInstanceOf(ConflictError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('404 tipado si la oferta no existe', async () => {
    const { repo } = makeRepo(null);
    const service = makeService(repo);
    await expect(service.reserve(PASSENGER_ID, makeDto())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('anti-IDOR: el DUEÑO lee su reserva; un NO-DUEÑO → NotFoundError (no se filtra existencia)', async () => {
    const { repo, findById } = makeRepo(makeTrip());
    const service = makeService(repo);
    const OTHER_PASSENGER = '00000000-0000-0000-0000-0000000000c2';

    // Dueño: lee OK.
    findById.mockResolvedValueOnce({
      id: 'b1',
      passengerId: PASSENGER_ID,
      estado: BookingState.PENDIENTE_APROBACION,
    });
    await expect(service.getById('b1', PASSENGER_ID)).resolves.toMatchObject({ id: 'b1' });

    // No-dueño: la MISMA reserva existe pero es ajena → 404 (NO 403, no se filtra existencia).
    findById.mockResolvedValueOnce({
      id: 'b1',
      passengerId: PASSENGER_ID,
      estado: BookingState.PENDIENTE_APROBACION,
    });
    await expect(service.getById('b1', OTHER_PASSENGER)).rejects.toBeInstanceOf(NotFoundError);

    // Inexistente: 404 (mismo error que el ajeno, indistinguible).
    findById.mockResolvedValueOnce(null);
    await expect(service.getById('missing', PASSENGER_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

/**
 * GATE DE DEUDA al reservar (ADR-014 §5.2 paso 1 · §5.4). Caminos felices E INFELICES:
 *  - pasajero CON deuda → rechazado (PassengerHasDebtError · 422), NO se crea la reserva.
 *  - pasajero sin deuda → reserva OK (smoke arriba ya lo cubre; acá verificamos que se CONSULTÓ payment).
 *  - payment CAÍDO/timeout → DEGRADACIÓN fail-OPEN (deja reservar + loguea), decisión explícita §5.4.
 */
describe('BookingsService · gate de deuda al reservar (§5.4)', () => {
  it('pasajero CON deuda → PassengerHasDebtError (422) y NO se crea la reserva', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip());
    const service = makeService(repo, {
      debt: {
        hasDebt: true,
        totalCents: 1500,
        items: [
          {
            paymentId: '00000000-0000-0000-0000-0000000000e1',
            tripId: '00000000-0000-0000-0000-0000000000b9',
            amountCents: 1500,
            reason: 'declined',
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });

    await expect(service.reserve(PASSENGER_ID, makeDto())).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
    // El gate corta ANTES de persistir: el deudor no entra a la reserva.
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('pasajero SIN deuda → reserva OK y consultó la deuda con el passengerId server-truth', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip());
    const gateway = new FakePaymentGateway(); // sin deuda por default
    const service = new BookingsService(repo, gateway, makeIdentity());

    await service.reserve(PASSENGER_ID, makeDto());

    expect(createWithEventIdempotent).toHaveBeenCalledOnce();
    // El gate consultó payment con el passengerId server-truth (anti-IDOR: nunca un valor del body).
    expect(gateway.debtCalls).toEqual([PASSENGER_ID]);
  });

  it('DEGRADACIÓN fail-OPEN: payment caído/timeout NO bloquea la reserva (reservar no mueve plata)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip());
    const service = makeService(repo, {
      debtError: new ExternalServiceError('payment-service inaccesible para el gate de deuda al reservar'),
    });

    // payment está caído, pero la reserva PROCEDE (fail-open): el cobro real re-valida en F3b.
    await service.reserve(PASSENGER_ID, makeDto());
    expect(createWithEventIdempotent).toHaveBeenCalledOnce();
  });
});

// ── F3b ─────────────────────────────────────────────────────────────────────────────────────────────────
const DRIVER_ID = '00000000-0000-0000-0000-0000000000d1';
const BOOKING_ID = '00000000-0000-0000-0000-0000000000b1';
const TRIP_ID = '00000000-0000-0000-0000-0000000000a1';

/** Fila Booking fake (forma mínima que el service toca). Override por test. */
function makeBooking(over: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    publishedTripId: TRIP_ID,
    passengerId: PASSENGER_ID,
    asientos: 2,
    precioAcordado: 5000,
    paymentMethod: PaymentMethod.YAPE,
    paymentId: null,
    estado: BookingState.PENDIENTE_APROBACION,
    ...over,
  };
}

/**
 * INSTANT_BOOKING dispara el CHARGE al reservar (ADR-014 §4.2/§5.2): nace APROBADO → triggerCharge →
 * COBRO_PENDIENTE. Antes quedaba en APROBADO sin cobrar (hueco F3b). Verifica que el charge viaja con el
 * método elegido + precio + passenger y que se registra COBRO_PENDIENTE.
 */
describe('BookingsService · INSTANT dispara el CHARGE al reservar (§4.2/§5.2)', () => {
  it('INSTANT: tras crear APROBADO, dispara el charge (método/precio/passenger) y marca COBRO_PENDIENTE', async () => {
    const { repo, markChargePending } = makeRepo(makeTrip({ modoReserva: ModoReserva.INSTANT_BOOKING }));
    const gateway = new FakePaymentGateway();
    const service = new BookingsService(repo, gateway, makeIdentity());

    const result = await service.reserve(PASSENGER_ID, makeDto({ paymentMethod: PaymentMethod.PLIN }));

    // El charge se disparó UNA vez con el método elegido (PLIN), el precio acordado y el passenger server-truth.
    expect(gateway.chargeCalls).toHaveLength(1);
    expect(gateway.chargeCalls[0]).toMatchObject({
      method: PaymentMethod.PLIN,
      passengerId: PASSENGER_ID,
    });
    // grossCents = precioBase(4500) + sin specialRequest. bookingId viaja como tripId opaco (el port lo nombra bookingId).
    expect(gateway.chargeCalls[0]!.grossCents).toBe(4500);
    // tx2: APROBADO → COBRO_PENDIENTE + paymentId del charge.
    expect(markChargePending).toHaveBeenCalledOnce();
    expect(result.estado).toBe(BookingState.COBRO_PENDIENTE);
  });
});

/**
 * RESULTADO SÍNCRONO del CHARGE (FIX 2/3 · ADR-014 §5.4) — el disparo del cobro NO siempre devuelve PENDING ni
 * lanza: payment puede declinar SÍNCRONO (200 + status DEBT/FAILED) o lanzar un rechazo PERMANENTE (4xx). En
 * ambos el booking NO debe quedar COLGADO en COBRO_PENDIENTE (el handler F3c que reconciliaría no existe) ni en
 * un LOOP APROBADO re-disparable: va a CANCELADO (terminal) + booking.cancelled. Un transitorio (5xx/timeout) SÍ
 * queda APROBADO re-ejecutable. Se ejercita vía approve() (mismo triggerCharge que INSTANT).
 */
describe('BookingsService · resultado del CHARGE al disparar (FIX 2/3, §5.4)', () => {
  function approveSetup(chargeOpts: FakePaymentGatewayOptions) {
    const harness = makeRepo(makeTrip({ id: TRIP_ID, driverId: DRIVER_ID }));
    harness.findByIdFromPrimary.mockResolvedValueOnce(makeBooking());
    // tx1 aprueba OK → devuelve el booking APROBADO (el estado real que triggerCharge inspecciona).
    harness.transitionWithEvent.mockResolvedValueOnce(makeBooking({ estado: BookingState.APROBADO }));
    const gateway = new FakePaymentGateway(chargeOpts);
    const service = new BookingsService(harness.repo, gateway, makeIdentity());
    return { ...harness, gateway, service };
  }

  it('decline SÍNCRONO status=DEBT → booking CANCELADO (NO COBRO_PENDIENTE) + booking.cancelled (razon=COBRO_RECHAZADO)', async () => {
    const { service, markChargePending, transitionWithEvent } = approveSetup({
      chargeResult: { paymentId: '00000000-0000-0000-0000-0000000000f1', status: PaymentStatus.DEBT },
    });

    const result = await service.approve(BOOKING_ID, DRIVER_ID);

    // NO marca COBRO_PENDIENTE (no queda colgado esperando una captura que no llega).
    expect(markChargePending).not.toHaveBeenCalled();
    expect(result.estado).toBe(BookingState.CANCELADO);
    // La 2da llamada a transitionWithEvent es la cancelación (la 1ra fue la aprobación tx1).
    const cancelCall = transitionWithEvent.mock.calls[1];
    if (!cancelCall) throw new Error('no se llamó la transición de cancelación');
    const [, allowed, data, intent] = cancelCall;
    expect(allowed).toEqual([BookingState.APROBADO]); // where atómico: solo cancela desde APROBADO
    expect(data).toMatchObject({ estado: BookingState.CANCELADO });
    expect(intent.eventType).toBe('booking.cancelled');
    expect(intent.payload).toMatchObject({
      bookingId: BOOKING_ID,
      razon: 'COBRO_RECHAZADO',
      estado: BookingState.CANCELADO,
      estadoAnterior: BookingState.APROBADO,
    });
    // El payload del booking individual valida contra el schema PUBLICADO booking.cancelled (forma B, aditiva).
    const schema = schemaForEvent('booking.cancelled');
    expect(schema!.safeParse(intent.payload).success).toBe(true);
  });

  it('decline SÍNCRONO status=FAILED → booking CANCELADO', async () => {
    const { service, markChargePending } = approveSetup({
      chargeResult: { paymentId: '00000000-0000-0000-0000-0000000000f1', status: PaymentStatus.FAILED },
    });

    const result = await service.approve(BOOKING_ID, DRIVER_ID);

    expect(result.estado).toBe(BookingState.CANCELADO);
    expect(markChargePending).not.toHaveBeenCalled();
  });

  it('charge THROW PERMANENTE (4xx) → booking CANCELADO (NO loop, NO COBRO_PENDIENTE)', async () => {
    const { service, markChargePending, transitionWithEvent } = approveSetup({
      chargeError: new ChargePermanentlyRejectedError({ upstreamStatus: 422, code: 'PAYMENT_METHOD_INVALID' }),
    });

    const result = await service.approve(BOOKING_ID, DRIVER_ID);

    expect(result.estado).toBe(BookingState.CANCELADO);
    expect(markChargePending).not.toHaveBeenCalled();
    const cancelCall = transitionWithEvent.mock.calls[1];
    if (!cancelCall) throw new Error('no se llamó la transición de cancelación');
    expect(cancelCall[3].eventType).toBe('booking.cancelled');
  });

  it('charge THROW TRANSITORIO (5xx/timeout) → booking APROBADO re-ejecutable + se PROPAGA ExternalServiceError (502)', async () => {
    const { service, markChargePending, transitionWithEvent } = approveSetup({
      chargeError: new ExternalServiceError('payment-service inaccesible (timeout)'),
    });

    await expect(service.approve(BOOKING_ID, DRIVER_ID)).rejects.toBeInstanceOf(ExternalServiceError);
    // tx1 corrió (aprobó); NO se canceló (la 2da transición no se llama) ni se marcó COBRO_PENDIENTE.
    expect(transitionWithEvent).toHaveBeenCalledOnce();
    expect(markChargePending).not.toHaveBeenCalled();
  });

  it('charge PENDING (camino normal) → COBRO_PENDIENTE, no cancela', async () => {
    const { service, markChargePending, transitionWithEvent } = approveSetup({
      chargeResult: { paymentId: '00000000-0000-0000-0000-0000000000f1', status: PaymentStatus.PENDING },
    });

    const result = await service.approve(BOOKING_ID, DRIVER_ID);

    expect(result.estado).toBe(BookingState.COBRO_PENDIENTE);
    expect(markChargePending).toHaveBeenCalledOnce();
    // Solo la tx1 (aprobación); NO hubo 2da transición de cancelación.
    expect(transitionWithEvent).toHaveBeenCalledOnce();
  });

  it('charge CAPTURED síncrono → tratado IGUAL que PENDING (COBRO_PENDIENTE, NO confirma/decrementa acá: eso es F3c)', async () => {
    const { service, markChargePending } = approveSetup({
      chargeResult: { paymentId: '00000000-0000-0000-0000-0000000000f1', status: PaymentStatus.CAPTURED },
    });

    const result = await service.approve(BOOKING_ID, DRIVER_ID);

    // CAPTURED síncrono NO confirma acá (saltearía el seat-lock §6 → oversold): va a COBRO_PENDIENTE.
    expect(result.estado).toBe(BookingState.COBRO_PENDIENTE);
    expect(markChargePending).toHaveBeenCalledOnce();
  });
});

/**
 * APROBAR/RECHAZAR (driver-rail · ADR-014 §8/§10) — caminos felices E INFELICES:
 * gate de ownership (dueño del PublishedTrip), gate de driver activo (fail-closed), doble-tap (ConflictError),
 * charge fallido (queda APROBADO, re-ejecutable), reject idempotente.
 */
describe('BookingsService · approve (driver-rail, §8/§10)', () => {
  it('happy path: PENDIENTE_APROBACION → APROBADO (booking.approved) → dispara CHARGE → COBRO_PENDIENTE', async () => {
    const { repo, transitionWithEvent, markChargePending, findByIdFromPrimary } = makeRepo(
      makeTrip({ id: TRIP_ID, driverId: DRIVER_ID }),
    );
    findByIdFromPrimary.mockResolvedValueOnce(makeBooking());
    const gateway = new FakePaymentGateway();
    const service = new BookingsService(repo, gateway, makeIdentity());

    const result = await service.approve(BOOKING_ID, DRIVER_ID);

    // tx1: transición condicionada por PENDIENTE_APROBACION + outbox booking.approved.
    expect(transitionWithEvent).toHaveBeenCalledOnce();
    const [, allowed, data, intent] = transitionWithEvent.mock.calls[0]!;
    expect(allowed).toEqual([BookingState.PENDIENTE_APROBACION]);
    expect(data).toMatchObject({ estado: BookingState.APROBADO });
    expect(intent.eventType).toBe('booking.approved');
    // FIX 1 — el payload de approve() (origen=APROBACION_CONDUCTOR) valida contra el schema PUBLICADO. Antes
    // emitía el literal mágico 'DRIVER_APPROVAL' (NO en el z.enum) → schema.parse() lanzaba → poison message.
    expect(intent.payload).toMatchObject({ origen: 'APROBACION_CONDUCTOR' });
    const approvedSchema = schemaForEvent('booking.approved');
    expect(approvedSchema!.safeParse(intent.payload).success).toBe(true);
    // charge disparado FUERA de tx + tx2 COBRO_PENDIENTE.
    expect(gateway.chargeCalls).toHaveLength(1);
    expect(markChargePending).toHaveBeenCalledOnce();
    expect(result.estado).toBe(BookingState.COBRO_PENDIENTE);
  });

  it('anti-IDOR: NO-DUEÑO del PublishedTrip → NotFoundError (no dispara transición ni charge)', async () => {
    const { repo, transitionWithEvent, findByIdFromPrimary } = makeRepo(
      makeTrip({ id: TRIP_ID, driverId: '00000000-0000-0000-0000-0000000000d9' }), // viaje de OTRO conductor
    );
    findByIdFromPrimary.mockResolvedValueOnce(makeBooking());
    const gateway = new FakePaymentGateway();
    const service = new BookingsService(repo, gateway, makeIdentity());

    await expect(service.approve(BOOKING_ID, DRIVER_ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(transitionWithEvent).not.toHaveBeenCalled();
    expect(gateway.chargeCalls).toHaveLength(0);
  });

  it('fail-closed: conductor SUSPENDIDO → ForbiddenError (403), no aprueba ni cobra', async () => {
    const { repo, transitionWithEvent, findByIdFromPrimary } = makeRepo(
      makeTrip({ id: TRIP_ID, driverId: DRIVER_ID }),
    );
    findByIdFromPrimary.mockResolvedValueOnce(makeBooking());
    const gateway = new FakePaymentGateway();
    const suspended = makeIdentity(makeDriver({ suspendedAt: new Date().toISOString() }));
    const service = new BookingsService(repo, gateway, suspended);

    await expect(service.approve(BOOKING_ID, DRIVER_ID)).rejects.toBeInstanceOf(ForbiddenError);
    expect(transitionWithEvent).not.toHaveBeenCalled();
    expect(gateway.chargeCalls).toHaveLength(0);
  });

  it('fail-closed: identity caída → ForbiddenError (403), no aprueba (nunca un suspendido por error de red)', async () => {
    const { repo, transitionWithEvent, findByIdFromPrimary } = makeRepo(
      makeTrip({ id: TRIP_ID, driverId: DRIVER_ID }),
    );
    findByIdFromPrimary.mockResolvedValueOnce(makeBooking());
    const identity = makeIdentity(async () => {
      throw new ExternalServiceError('identity caída');
    });
    const service = new BookingsService(repo, new FakePaymentGateway(), identity);

    await expect(service.approve(BOOKING_ID, DRIVER_ID)).rejects.toBeInstanceOf(ForbiddenError);
    expect(transitionWithEvent).not.toHaveBeenCalled();
  });

  it('doble-tap: el 2º approve no matchea PENDIENTE_APROBACION en el where atómico → ConflictError', async () => {
    const { repo, transitionWithEvent, findByIdFromPrimary } = makeRepo(
      makeTrip({ id: TRIP_ID, driverId: DRIVER_ID }),
    );
    findByIdFromPrimary.mockResolvedValueOnce(makeBooking());
    // El repo simula el UPDATE atómico: 0 filas (estado ya cambió) → ConflictError (P2025 traducido).
    transitionWithEvent.mockRejectedValueOnce(new ConflictError('La reserva cambió de estado', { id: BOOKING_ID }));
    const service = new BookingsService(repo, new FakePaymentGateway(), makeIdentity());

    await expect(service.approve(BOOKING_ID, DRIVER_ID)).rejects.toBeInstanceOf(ConflictError);
  });

  it('charge FALLA: queda APROBADO (la tx2 no corre), el error se PROPAGA (re-ejecutable)', async () => {
    const { repo, transitionWithEvent, markChargePending, findByIdFromPrimary } = makeRepo(
      makeTrip({ id: TRIP_ID, driverId: DRIVER_ID }),
    );
    findByIdFromPrimary.mockResolvedValueOnce(makeBooking());
    // tx1 aprueba OK (devuelve APROBADO); el charge falla.
    transitionWithEvent.mockResolvedValueOnce(makeBooking({ estado: BookingState.APROBADO }));
    const gateway = new FakePaymentGateway({ chargeError: new ExternalServiceError('payment rechazó el charge') });
    const service = new BookingsService(repo, gateway, makeIdentity());

    await expect(service.approve(BOOKING_ID, DRIVER_ID)).rejects.toBeInstanceOf(ExternalServiceError);
    // tx1 corrió (se aprobó + emitió booking.approved), pero la tx2 (COBRO_PENDIENTE) NO: el booking queda APROBADO.
    expect(transitionWithEvent).toHaveBeenCalledOnce();
    expect(markChargePending).not.toHaveBeenCalled();
  });

  it('RE-EJECUTABLE: approve sobre un booking YA APROBADO re-dispara el charge SIN re-emitir booking.approved', async () => {
    const { repo, transitionWithEvent, markChargePending, findByIdFromPrimary } = makeRepo(
      makeTrip({ id: TRIP_ID, driverId: DRIVER_ID }),
    );
    // El booking ya está APROBADO (un approve previo aprobó pero el charge había fallado).
    findByIdFromPrimary.mockResolvedValueOnce(makeBooking({ estado: BookingState.APROBADO }));
    const gateway = new FakePaymentGateway();
    const service = new BookingsService(repo, gateway, makeIdentity());

    const result = await service.approve(BOOKING_ID, DRIVER_ID);

    // NO se re-emite booking.approved (la tx1 se saltea): solo se re-dispara el charge (idempotente por dedupKey).
    expect(transitionWithEvent).not.toHaveBeenCalled();
    expect(gateway.chargeCalls).toHaveLength(1);
    expect(markChargePending).toHaveBeenCalledOnce();
    expect(result.estado).toBe(BookingState.COBRO_PENDIENTE);
  });
});

describe('BookingsService · reject (driver-rail, §4.2/§8)', () => {
  it('happy path: PENDIENTE_APROBACION → RECHAZADO (booking.rejected), NO cobra', async () => {
    const { repo, transitionWithEvent, findByIdFromPrimary } = makeRepo(
      makeTrip({ id: TRIP_ID, driverId: DRIVER_ID }),
    );
    findByIdFromPrimary.mockResolvedValueOnce(makeBooking());
    const gateway = new FakePaymentGateway();
    const service = new BookingsService(repo, gateway, makeIdentity());

    await service.reject(BOOKING_ID, DRIVER_ID);

    const [, allowed, data, intent] = transitionWithEvent.mock.calls[0]!;
    expect(allowed).toEqual([BookingState.PENDIENTE_APROBACION]);
    expect(data).toMatchObject({ estado: BookingState.RECHAZADO });
    expect(intent.eventType).toBe('booking.rejected');
    // reject NO cobra (terminal sin movimiento de plata).
    expect(gateway.chargeCalls).toHaveLength(0);
  });

  it('idempotente: reject sobre un booking YA RECHAZADO → ConflictError (where atómico no matchea PENDIENTE)', async () => {
    const { repo, transitionWithEvent, findByIdFromPrimary } = makeRepo(
      makeTrip({ id: TRIP_ID, driverId: DRIVER_ID }),
    );
    // El booking ya está RECHAZADO: el assertTransition de PENDIENTE_APROBACION→RECHAZADO pasa (se evalúa el
    // `from` esperado), pero el where atómico no matchea → ConflictError. Simulamos el 0-filas del repo.
    findByIdFromPrimary.mockResolvedValueOnce(makeBooking({ estado: BookingState.RECHAZADO }));
    transitionWithEvent.mockRejectedValueOnce(new ConflictError('La reserva cambió de estado', { id: BOOKING_ID }));
    const service = new BookingsService(repo, new FakePaymentGateway(), makeIdentity());

    await expect(service.reject(BOOKING_ID, DRIVER_ID)).rejects.toBeInstanceOf(ConflictError);
  });

  it('anti-IDOR: NO-DUEÑO → NotFoundError (no transiciona)', async () => {
    const { repo, transitionWithEvent, findByIdFromPrimary } = makeRepo(
      makeTrip({ id: TRIP_ID, driverId: '00000000-0000-0000-0000-0000000000d9' }),
    );
    findByIdFromPrimary.mockResolvedValueOnce(makeBooking());
    const service = new BookingsService(repo, new FakePaymentGateway(), makeIdentity());

    await expect(service.reject(BOOKING_ID, DRIVER_ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(transitionWithEvent).not.toHaveBeenCalled();
  });
});

describe('BookingsService · listRequestsForTrip (driver-rail, ownership)', () => {
  it('DUEÑO: lista las solicitudes del viaje (keyset paginado)', async () => {
    const { repo, findByPublishedTripId } = makeRepo(makeTrip({ id: TRIP_ID, driverId: DRIVER_ID }));
    findByPublishedTripId.mockResolvedValueOnce([makeBooking()]);
    const service = new BookingsService(repo, new FakePaymentGateway(), makeIdentity());

    const result = await service.listRequestsForTrip(TRIP_ID, DRIVER_ID, { limit: 10 });

    expect(result).toHaveLength(1);
    expect(findByPublishedTripId).toHaveBeenCalledWith(TRIP_ID, 10, undefined);
  });

  it('anti-IDOR: NO-DUEÑO del viaje → NotFoundError (no lista)', async () => {
    const { repo, findByPublishedTripId } = makeRepo(
      makeTrip({ id: TRIP_ID, driverId: '00000000-0000-0000-0000-0000000000d9' }),
    );
    const service = new BookingsService(repo, new FakePaymentGateway(), makeIdentity());

    await expect(service.listRequestsForTrip(TRIP_ID, DRIVER_ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(findByPublishedTripId).not.toHaveBeenCalled();
  });

  it('viaje inexistente → NotFoundError', async () => {
    const { repo } = makeRepo(null);
    const service = new BookingsService(repo, new FakePaymentGateway(), makeIdentity());
    await expect(service.listRequestsForTrip(TRIP_ID, DRIVER_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});
