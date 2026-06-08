/* E2E manual de humo (no es parte de la suite vitest). Requiere el servicio arriba + DB/Kafka. */
import { signInternalIdentity } from '@veo/auth';
import { uuidv7 } from '@veo/utils';
import { PrismaClient } from '../src/generated/prisma';

const BASE = 'http://localhost:3010/api/v1';
const SECRET = 'dev-internal-secret-change-me';
const prisma = new PrismaClient();

function authHeaders(userId: string): Record<string, string> {
  const { header, signature } = signInternalIdentity(
    { userId, type: 'passenger', roles: [], sessionId: 's1' },
    SECRET,
  );
  return { 'content-type': 'application/json', 'x-veo-identity': header, 'x-veo-identity-sig': signature };
}

async function post(path: string, userId: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(BASE + path, { method: 'POST', headers: authHeaders(userId), body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function get(path: string, userId: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(BASE + path, { headers: authHeaders(userId) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main(): Promise<void> {
  const driverId = uuidv7();
  const raterBase = uuidv7();

  // 4 ratings que llevan al conductor a avg 4.25 → flag "review"
  const stars = [4, 4, 4, 5];
  for (let i = 0; i < stars.length; i++) {
    const tripId = uuidv7();
    const raterId = uuidv7();
    const r = await post('/ratings', raterId, { tripId, ratedId: driverId, ratedRole: 'DRIVER', stars: stars[i] });
    console.log(`POST rating ${i + 1} (stars=${stars[i]}) → ${r.status}`);
    if (r.status !== 201) console.log('  body:', JSON.stringify(r.json));
  }

  // Duplicado por viaje
  const dupTrip = uuidv7();
  const r1 = await post('/ratings', uuidv7(), { tripId: dupTrip, ratedId: driverId, ratedRole: 'DRIVER', stars: 5 });
  const r2 = await post('/ratings', uuidv7(), { tripId: dupTrip, ratedId: driverId, ratedRole: 'DRIVER', stars: 1 });
  console.log(`Duplicado mismo trip → primero ${r1.status}, segundo ${r2.status} (esperado 409)`);

  // Agregado vía REST
  const agg = await get(`/ratings/aggregate/${driverId}`, raterBase);
  console.log('GET aggregate →', JSON.stringify(agg.json));

  // Outbox en DB
  const outbox = await prisma.outboxEvent.findMany({
    where: { aggregateId: driverId },
    select: { eventType: true, publishedAt: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log('Outbox eventos del conductor:', JSON.stringify(outbox));
  const published = outbox.filter((e) => e.publishedAt !== null).length;
  console.log(`Outbox publicados a Kafka: ${published}/${outbox.length}`);
}

main()
  .catch((err) => {
    console.error('E2E falló', err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
