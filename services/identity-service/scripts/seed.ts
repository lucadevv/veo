/**
 * Seed mínimo: crea el operador SUPERADMIN inicial (ACTIVE). Enrola TOTP en su primer login.
 * Uso: DATABASE_URL=... SEED_SUPERADMIN_EMAIL=... SEED_SUPERADMIN_PASSWORD=... pnpm db:seed
 */
import argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.SEED_SUPERADMIN_EMAIL ?? 'admin@veo.pe';
  const password = process.env.SEED_SUPERADMIN_PASSWORD ?? 'ChangeMe_VEO_2026!';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const admin = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', roles: ['SUPERADMIN'] },
    create: { email, passwordHash, roles: ['SUPERADMIN'], status: 'ACTIVE' },
  });

  console.warn(`SUPERADMIN listo: ${admin.email} (${admin.status}). Enrola TOTP en el primer login.`);
}

main()
  .catch((err) => {
    console.error('Seed falló', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
