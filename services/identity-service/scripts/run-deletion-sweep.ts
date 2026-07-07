/**
 * One-off DEV/ops: ejecuta el tombstone de erasure (Ley 29733) de UN usuario, replicando EXACTO la lógica
 * de `DeletionSweeper.tombstoneUser` (mismos helpers/efectos) pero con `PrismaClient` directo — sin bootear
 * el contexto Nest. Sirve para acelerar el grace+@Cron al limpiar data de prueba. Idempotente.
 *
 * Hace, en UNA tx: tombstone del User (deletedAt + scrub PII: phone→placeholder, email/dni/photo/embedding),
 * scrub del Driver y de los BiometricCheck, y encola `user.deleted` al outbox → el relay vivo del servicio
 * lo publica → cascada (fleet/media/chat/audit purgan su PII).
 *
 * Uso (con el env del servicio cargado): pnpm exec tsx scripts/run-deletion-sweep.ts <userId>
 */
import { PrismaClient } from '../src/generated/prisma';
import { deletedPlaceholder, enqueueOutbox } from '@veo/database';
import { createEnvelope } from '@veo/events';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const userId = process.argv[2];
  if (!userId) throw new Error('uso: tsx scripts/run-deletion-sweep.ts <userId>');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, deletedAt: true, driver: { select: { id: true } } },
  });
  if (!user) throw new Error(`user ${userId} no encontrado`);
  if (user.deletedAt) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ skipped: 'ya tombstoneado', userId }));
    return;
  }

  const driverId = user.driver?.id;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        deletedAt: now,
        phone: deletedPlaceholder(userId, 'phone'),
        email: null,
        dniHash: null,
        photoUrl: null,
        faceEmbedding: [],
      },
    });
    if (driverId) {
      await tx.driver.update({
        where: { id: driverId },
        data: {
          faceEmbedding: [],
          dniFaceMatched: null,
          dniFaceMatchScore: null,
          dniFaceMatchedAt: null,
        },
      });
    }
    await tx.biometricCheck.updateMany({
      where: { userId },
      data: { score: 0, geoLat: null, geoLon: null, captureRef: null },
    });
    const envelope = createEnvelope({
      eventType: 'user.deleted',
      producer: 'identity-service',
      payload: { userId, driverId, at: now.toISOString() },
    });
    await enqueueOutbox(tx, envelope, userId);
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({ tombstoned: userId, driverId: driverId ?? null, emitted: 'user.deleted' }),
  );
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (e) => {
    await prisma.$disconnect().catch(() => {});
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
