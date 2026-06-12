/**
 * E2E con Postgres REAL (testcontainers) — sin mocks de DB (CLAUDE regla: panic/share = testcontainers).
 *
 * Fix B1: share YA NO manda SMS inline. Cubre el INVARIANTE crítico del fan-out de pánico (BR-S05)
 * bajo la entrega at-least-once de Kafka, con el NUEVO contrato (delegación durable a notification):
 *   1) panic.triggered → crea EL enlace de seguimiento del viaje y encola `panic.fanout_requested` en
 *      el OUTBOX (misma tx) con los IDs de contacto verificados + el deep-link. CERO PII en el evento.
 *   2) REDELIVERY del MISMO panic.triggered → reutiliza el enlace por dedupKey y NO re-emite el evento
 *      de fan-out (notification tiene su propia idempotencia). La familia no recibe pánico duplicado.
 *   3) Pasajero sin contactos verificados → no crashea, no crea enlace ni emite fan-out.
 *   4) trip.started → el read-model del viaje pasa a IN_PROGRESS.
 *
 * Espiamos SOLO el KafkaEventConsumer real (start/stop anulados) para capturar los handlers que el
 * bootstrap promovido (@veo/events/nest) registra en onModuleInit y dispararlos a mano (sin Kafka
 * real); el resto del grafo (ShareService/ContactsService/TripSnapshot) es REAL contra el contenedor.
 * El envío real de SMS ahora vive en notification-service (otro servicio): acá verificamos el OUTBOX.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { createTestDatabase, runPrismaMigrateDeploy, type TestDatabase } from '@veo/database/testing';
import { uuidv7 } from '@veo/utils';
import { createEnvelope, KafkaEventConsumer, type EventEnvelope } from '@veo/events';
import type Redis from 'ioredis';
import { PrismaClient } from '../src/generated/prisma';
import { ShareService } from '../src/share/share.service';
import { ContactsService } from '../src/contacts/contacts.service';
import { ContactOtpService } from '../src/contacts/contact-otp.service';
import { TripSnapshotService } from '../src/read-model/trip-snapshot.service';
import { EventsConsumer } from '../src/consumers/events.consumer';
import type { PrismaService } from '../src/infra/prisma.service';
import type { SmsSender } from '../src/ports/sms/sms.port';
import type { Env } from '../src/config/env.schema';

// Captura los handlers que EventsConsumer registra con .on() — los disparamos como una entrega (y RE-entrega)
// de Kafka, sin broker real. createEnvelope/el resto de @veo/events se preservan (espía, no mock).
type Handler = (env: EventEnvelope<unknown>) => Promise<void>;
const handlers = new Map<string, Handler>();
vi.spyOn(KafkaEventConsumer.prototype, 'on').mockImplementation(function (
  this: KafkaEventConsumer,
  type: string,
  handler: Handler,
) {
  handlers.set(type, handler);
  return this;
});
vi.spyOn(KafkaEventConsumer.prototype, 'start').mockResolvedValue(undefined);
vi.spyOn(KafkaEventConsumer.prototype, 'stop').mockResolvedValue(undefined);

const serviceDir = fileURLToPath(new URL('..', import.meta.url));

let db: TestDatabase;
let prisma: PrismaClient;
let prismaService: PrismaService;

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'share',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  // prisma real (NO mock): read y write apuntan al mismo cliente del contenedor.
  prismaService = { read: prisma, write: prisma } as unknown as PrismaService;

  const config = new ConfigService<Env, true>({
    SHARE_LINK_SECRET: 'test-share-secret-no-dev-default',
    SHARE_LINK_TTL_SECONDS: 3600,
    SHARE_LINK_MAX_USES: 50,
    SHARE_PUBLIC_BASE_URL: 'https://veo.test/s',
    MAX_TRUSTED_CONTACTS: 5,
    CONTACT_MODIFY_COOLDOWN_HOURS: 24,
    KAFKA_BROKERS: 'localhost:9094',
    KAFKA_CONSUMER_GROUP: 'share-service-test',
  } as Record<string, unknown>);

  const share = new ShareService(prismaService, config);
  // ContactsService: en el fan-out de pánico SOLO se invoca listVerified (lectura prisma real). Redis/OTP/SMS
  // no se tocan en ese camino → dobles inertes alcanzan (no mockeamos la DB, que es lo crítico).
  const contacts = new ContactsService(
    prismaService,
    {} as unknown as Redis,
    {} as unknown as ContactOtpService,
    { send: async () => {} } as SmsSender,
    config,
  );
  const snapshots = new TripSnapshotService(prismaService);
  // onModuleInit registra sus handlers en el `handlers` map (vía el espía) y "arranca" el consumer anulado.
  // El consumer YA NO recibe SmsSender (fix B1: el envío se delega a notification por evento).
  await new EventsConsumer(share, contacts, snapshots, config).onModuleInit();
}, 180_000);

/** Lee del outbox los eventos panic.fanout_requested emitidos para un panicId. */
async function fanoutEventsFor(panicId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await prisma.outboxEvent.findMany({ where: { eventType: 'panic.fanout_requested' } });
  return rows
    .map((r) => (r.envelope as { payload: Record<string, unknown> }).payload)
    .filter((p) => p.panicId === panicId);
}

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

beforeEach(async () => {
  // Aislamiento entre tests: limpiamos el estado por viaje (FK share_links→trusted_contacts: orden importa).
  await prisma.shareView.deleteMany();
  await prisma.shareLink.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.trustedContact.deleteMany();
  await prisma.tripSnapshot.deleteMany();
});

/** Seedea un contacto de confianza; `verified=false` deja otpVerifiedAt en null (no recibe pánico). */
async function seedContact(userId: string, name: string, phone: string, verified: boolean): Promise<string> {
  const id = uuidv7();
  await prisma.trustedContact.create({
    data: {
      id,
      userId,
      phone,
      name,
      relationship: 'family',
      otpVerifiedAt: verified ? new Date() : null,
    },
  });
  return id;
}

function panicEnvelope(panicId: string, tripId: string, passengerId: string): EventEnvelope<unknown> {
  return createEnvelope({
    eventType: 'panic.triggered',
    producer: 'panic-service',
    payload: {
      panicId,
      tripId,
      passengerId,
      geo: { lat: -12.0464, lon: -77.0428 },
      dedupKey: `panic:${panicId}`,
      triggeredAt: new Date().toISOString(),
    },
  });
}

describe('Fan-out de pánico idempotente con Postgres real (BR-S05 + redelivery at-least-once)', () => {
  it('panic.triggered crea EL enlace del viaje y encola panic.fanout_requested con los IDs verificados (sin PII)', async () => {
    const passengerId = uuidv7();
    const tripId = uuidv7();
    const panicId = uuidv7();
    const c1 = await seedContact(passengerId, 'Mamá', '+51999000001', true);
    const c2 = await seedContact(passengerId, 'Hermano', '+51999000002', true);
    await seedContact(passengerId, 'No verificado', '+51999000003', false); // NO debe entrar al fan-out

    await handlers.get('panic.triggered')!(panicEnvelope(panicId, tripId, passengerId));

    // UN enlace del viaje (no uno por contacto): el deep-link compartido.
    const links = await prisma.shareLink.findMany({ where: { tripId } });
    expect(links).toHaveLength(1);

    // Se encoló EXACTAMENTE un panic.fanout_requested con los 2 IDs verificados y CERO PII.
    const fanouts = await fanoutEventsFor(panicId);
    expect(fanouts).toHaveLength(1);
    const payload = fanouts[0]!;
    expect((payload.contactIds as string[]).sort()).toEqual([c1, c2].sort());
    expect(typeof payload.shareLink).toBe('string');
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/\+5199900000|Mamá|Hermano/); // ningún teléfono/nombre

    // El read-model del viaje quedó en PANIC.
    const snap = await prisma.tripSnapshot.findUnique({ where: { tripId } });
    expect(snap?.status).toBe('PANIC');
  });

  it('REDELIVERY del mismo panic.triggered NO duplica enlace ni re-emite el fan-out (idempotencia por dedupKey)', async () => {
    const passengerId = uuidv7();
    const tripId = uuidv7();
    const panicId = uuidv7();
    await seedContact(passengerId, 'Mamá', '+51999000001', true);
    await seedContact(passengerId, 'Hermano', '+51999000002', true);

    const env = panicEnvelope(panicId, tripId, passengerId);
    await handlers.get('panic.triggered')!(env); // entrega 1
    await handlers.get('panic.triggered')!(env); // RE-entrega (Kafka at-least-once)

    const links = await prisma.shareLink.findMany({ where: { tripId } });
    expect(links).toHaveLength(1); // sigue 1, no 2
    const fanouts = await fanoutEventsFor(panicId);
    expect(fanouts).toHaveLength(1); // un solo evento — notification no recibe pánico duplicado
  });

  it('pasajero sin contactos verificados: no crashea, no crea enlace ni emite fan-out', async () => {
    const passengerId = uuidv7();
    const tripId = uuidv7();
    const panicId = uuidv7();
    await seedContact(passengerId, 'Sin verificar', '+51999000009', false);

    await expect(
      handlers.get('panic.triggered')!(panicEnvelope(panicId, tripId, passengerId)),
    ).resolves.not.toThrow();

    expect(await prisma.shareLink.count({ where: { tripId } })).toBe(0);
    expect(await fanoutEventsFor(panicId)).toHaveLength(0);
    // Aun sin contactos, el snapshot de pánico se registra (la página pública lo refleja).
    const snap = await prisma.tripSnapshot.findUnique({ where: { tripId } });
    expect(snap?.status).toBe('PANIC');
  });

  it('trip.started lleva el read-model del viaje a IN_PROGRESS', async () => {
    const tripId = uuidv7();
    const driverId = uuidv7();
    const env = createEnvelope({
      eventType: 'trip.started',
      producer: 'trip-service',
      payload: { tripId, driverId, startedAt: new Date().toISOString() },
    });
    await handlers.get('trip.started')!(env);

    const snap = await prisma.tripSnapshot.findUnique({ where: { tripId } });
    expect(snap?.status).toBe('IN_PROGRESS');
    expect(snap?.driverId).toBe(driverId);
  });
});
