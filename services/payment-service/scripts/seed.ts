/**
 * Seed demo de payment-service.
 *  - Promociones (Ola 2A): PRIMERVIAJE (-50%, tope S/15) y BIENVENIDO (S/5 fijo).
 *  - Incentivos al conductor (Ola 2C): META_VIAJES "10 viajes hoy → S/20" y HORA_PICO "6-9pm → +20%".
 * Idempotente. Uso: DATABASE_URL=... pnpm --filter @veo/payment-service db:seed
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../src/generated/prisma';

const prisma = new PrismaClient();

/** Inicio (00:00 hora local) y fin (24:00) del día de HOY, para la ventana de los incentivos demo. */
function todayWindow(): { startsAt: Date; endsAt: Date } {
  const startsAt = new Date();
  startsAt.setHours(0, 0, 0, 0);
  const endsAt = new Date(startsAt);
  endsAt.setDate(endsAt.getDate() + 1);
  return { startsAt, endsAt };
}

/** IDs deterministas para que el seed sea idempotente (upsert por id). */
const INCENTIVE_META_ID = '00000000-0000-7000-8000-0000000c2c01';
const INCENTIVE_PEAK_ID = '00000000-0000-7000-8000-0000000c2c02';

async function seedIncentives(): Promise<void> {
  const { startsAt, endsAt } = todayWindow();

  // META_VIAJES: 10 viajes hoy → bono S/20 (2000 céntimos).
  await prisma.incentive.upsert({
    where: { id: INCENTIVE_META_ID },
    update: { targetTrips: 10, rewardCents: 2000, startsAt, endsAt, active: true },
    create: {
      id: INCENTIVE_META_ID,
      type: 'META_VIAJES',
      title: '10 viajes hoy → S/20',
      description: 'Completa 10 viajes hoy y gana un bono de S/20.',
      targetTrips: 10,
      rewardCents: 2000,
      startsAt,
      endsAt,
      active: true,
    },
  });

  // HORA_PICO: 6-9pm → +20% (multiplierBps 12000 = 1.20 · 10000). 18:00=1080min, 21:00=1260min.
  await prisma.incentive.upsert({
    where: { id: INCENTIVE_PEAK_ID },
    update: {
      multiplierBps: 12000,
      peakStartMinute: 18 * 60,
      peakEndMinute: 21 * 60,
      startsAt,
      endsAt,
      active: true,
    },
    create: {
      id: INCENTIVE_PEAK_ID,
      type: 'HORA_PICO',
      title: 'Hora pico 6-9pm → +20%',
      description: 'Gana 20% extra en tus viajes entre las 6:00pm y las 9:00pm.',
      multiplierBps: 12000,
      peakStartMinute: 18 * 60,
      peakEndMinute: 21 * 60,
      startsAt,
      endsAt,
      active: true,
    },
  });

  console.warn('Incentivos demo listos: META_VIAJES (10 viajes → S/20), HORA_PICO (6-9pm → +20%).');
}

async function main(): Promise<void> {
  // PRIMERVIAJE: 50% de descuento en el primer viaje, topado a S/15 (1500 céntimos), 1 uso por usuario.
  await prisma.promotion.upsert({
    where: { code: 'PRIMERVIAJE' },
    update: { kind: 'PERCENTAGE', value: 50, maxDiscountCents: 1500, maxUsesPerUser: 1, active: true },
    create: {
      id: randomUUID(),
      code: 'PRIMERVIAJE',
      kind: 'PERCENTAGE',
      value: 50,
      maxDiscountCents: 1500,
      minFareCents: 0,
      maxTotalUses: 0,
      maxUsesPerUser: 1,
      active: true,
    },
  });

  // BIENVENIDO: S/5 (500 céntimos) de descuento fijo, 1 uso por usuario.
  await prisma.promotion.upsert({
    where: { code: 'BIENVENIDO' },
    update: { kind: 'FIXED', value: 500, maxUsesPerUser: 1, active: true },
    create: {
      id: randomUUID(),
      code: 'BIENVENIDO',
      kind: 'FIXED',
      value: 500,
      minFareCents: 0,
      maxTotalUses: 0,
      maxUsesPerUser: 1,
      active: true,
    },
  });

  console.warn('Promos demo listas: PRIMERVIAJE (-50%, tope S/15), BIENVENIDO (S/5 fijo).');

  await seedIncentives();
}

main()
  .catch((err) => {
    console.error('Seed de promos falló', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
