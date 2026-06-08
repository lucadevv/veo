/**
 * Seed de desarrollo: crea un snapshot de viaje en curso, un contacto de confianza verificado y un
 * enlace de seguimiento firmado. Imprime la URL pública lista para abrir la "página familia".
 *
 * Uso:
 *   DATABASE_URL=postgresql://veo:veo_dev@localhost:5433/veo \
 *   SHARE_LINK_SECRET=dev-share-link-secret-change-me \
 *   pnpm --filter @veo/share-service db:seed
 */
import { uuidv7 } from '@veo/utils';
import { PrismaClient } from '../src/generated/prisma';
import { signShareToken } from '../src/share/share-link';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const secret = process.env.SHARE_LINK_SECRET ?? 'dev-share-link-secret-change-me';
  const baseUrl = (process.env.SHARE_PUBLIC_BASE_URL ?? 'http://localhost:3011/api/v1/public/share').replace(/\/$/, '');

  const passengerId = uuidv7();
  const tripId = uuidv7();
  const driverId = uuidv7();
  const shareId = uuidv7();

  await prisma.tripSnapshot.upsert({
    where: { tripId },
    create: { tripId, status: 'IN_PROGRESS', passengerId, driverId, startedAt: new Date() },
    update: {},
  });

  const contact = await prisma.trustedContact.create({
    data: {
      id: uuidv7(),
      userId: passengerId,
      phone: '+51987654321',
      name: 'María (demo)',
      relationship: 'madre',
      otpVerifiedAt: new Date(),
    },
  });

  const expiresAt = new Date(Date.now() + 2 * 3_600_000);
  const { token, tokenHash } = signShareToken(shareId, expiresAt.getTime(), secret);
  await prisma.shareLink.create({
    data: { id: shareId, tripId, contactId: contact.id, tokenHash, expiresAt, maxUses: 500 },
  });

  console.warn('Seed share-service listo:');
  console.warn(`  passengerId: ${passengerId}`);
  console.warn(`  tripId:      ${tripId}`);
  console.warn(`  contacto:    ${contact.name} (${contact.phone}) verificado`);
  console.warn(`  URL familia: ${baseUrl}/${token}`);
}

main()
  .catch((err) => {
    console.error('Seed falló', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
