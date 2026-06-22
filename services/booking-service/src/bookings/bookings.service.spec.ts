import { describe, it, expect, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError, isUuidV7, uuidv7 } from '@veo/utils';
import { BookingState, ModoReserva, PublishedTripState } from '../generated/prisma';
import { BookingsService } from './bookings.service';
import type { BookingsRepository, CreateBookingData, OutboxIntent } from './bookings.repository';
import type { CreateBookingDto } from './dto/create-booking.dto';

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
  const repo = {
    findPublishedTrip,
    createWithEventIdempotent,
    findById,
  } as unknown as BookingsRepository;
  return { repo, findPublishedTrip, createWithEventIdempotent, findById };
}

describe('BookingsService · smoke create/read', () => {
  it('REVISION: la reserva nace PENDIENTE_APROBACION, precioAcordado = base + specialRequest, evento booking.requested', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip());
    const service = new BookingsService(repo);

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
    const service = new BookingsService(repo);

    await service.reserve(PASSENGER_ID, makeDto());

    const call = createWithEventIdempotent.mock.calls[0];
    if (!call) throw new Error('createWithEventIdempotent no fue llamado');
    const [, , data, intent] = call;
    expect(data.estado).toBe(BookingState.APROBADO);
    // El evento refleja el ESTADO REAL: APROBADO → booking.approved (emitir booking.requested mentiría).
    expect(intent.eventType).toBe('booking.approved');
    expect(intent.payload).toMatchObject({ estado: BookingState.APROBADO, origen: 'INSTANT_BOOKING' });
  });

  it('idempotencia de request: MISMO Idempotency-Key (reintento del mismo submit) → MISMA dedupKey', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip());
    const service = new BookingsService(repo);

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
    const service = new BookingsService(repo);
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
    const service = new BookingsService(repo);
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
    const service = new BookingsService(repo);

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
    const service = new BookingsService(repo);
    await expect(service.reserve(PASSENGER_ID, makeDto(), 'no-es-uuid')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('rechaza reservar más asientos que los disponibles (409)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip({ asientosDisponibles: 1 }));
    const service = new BookingsService(repo);
    await expect(service.reserve(PASSENGER_ID, makeDto({ asientos: 2 }))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('rechaza reservar sobre una oferta no abierta (LLENO → 409)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo(makeTrip({ estado: PublishedTripState.LLENO }));
    const service = new BookingsService(repo);
    await expect(service.reserve(PASSENGER_ID, makeDto())).rejects.toBeInstanceOf(ConflictError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('404 tipado si la oferta no existe', async () => {
    const { repo } = makeRepo(null);
    const service = new BookingsService(repo);
    await expect(service.reserve(PASSENGER_ID, makeDto())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('anti-IDOR: el DUEÑO lee su reserva; un NO-DUEÑO → NotFoundError (no se filtra existencia)', async () => {
    const { repo, findById } = makeRepo(makeTrip());
    const service = new BookingsService(repo);
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
