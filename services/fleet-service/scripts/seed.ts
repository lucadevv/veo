/**
 * Seed mínimo e idempotente: un vehículo de demo (placa única) con su SOAT e ITV vigentes.
 * Uso: DATABASE_URL=... pnpm db:seed
 */
import { uuidv7 } from '@veo/utils';
import {
  PrismaClient,
  FleetOwnerType,
  FleetDocumentType,
  FleetDocumentStatus,
} from '../src/generated/prisma';

const prisma = new PrismaClient();

function inDays(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

async function main(): Promise<void> {
  const plate = process.env.SEED_PLATE ?? 'VEO-001';

  const vehicle = await prisma.vehicle.upsert({
    where: { plate },
    update: {},
    create: {
      id: uuidv7(),
      plate,
      make: 'Toyota',
      model: 'Yaris',
      year: 2020,
      color: 'Plata',
      insuranceExpiresAt: inDays(120),
      docStatus: 'VALID',
    },
  });

  const existing = await prisma.fleetDocument.findFirst({
    where: { ownerType: FleetOwnerType.VEHICLE, ownerId: vehicle.id, type: FleetDocumentType.SOAT },
  });
  if (!existing) {
    await prisma.fleetDocument.createMany({
      data: [
        {
          id: uuidv7(),
          ownerType: FleetOwnerType.VEHICLE,
          ownerId: vehicle.id,
          type: FleetDocumentType.SOAT,
          documentNumber: 'SOAT-DEMO-0001',
          expiresAt: inDays(90),
          status: FleetDocumentStatus.VALID,
          verifiedAt: new Date(),
        },
        {
          id: uuidv7(),
          ownerType: FleetOwnerType.VEHICLE,
          ownerId: vehicle.id,
          type: FleetDocumentType.ITV,
          documentNumber: 'ITV-DEMO-0001',
          expiresAt: inDays(200),
          status: FleetDocumentStatus.VALID,
          verifiedAt: new Date(),
        },
      ],
    });
  }

  console.warn(`Vehículo de demo listo: ${vehicle.plate} (${vehicle.id}) con SOAT + ITV vigentes.`);
}

main()
  .catch((err) => {
    console.error('Seed falló', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
