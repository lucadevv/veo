/**
 * Seed de rating-service. El servicio no tiene datos de referencia (catálogos): los agregados
 * se derivan de las calificaciones reales. Este script verifica conectividad y deja la base lista.
 * Uso: DATABASE_URL=... pnpm db:seed
 */
import { PrismaClient } from '../src/generated/prisma';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
  const ratings = await prisma.rating.count();
  const aggregates = await prisma.ratingAggregate.count();
  console.warn(
    `rating-service listo: ${ratings} calificaciones, ${aggregates} agregados. Sin datos de referencia que sembrar.`,
  );
}

main()
  .catch((err) => {
    console.error('Seed falló', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
