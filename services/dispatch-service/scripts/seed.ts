/**
 * Seed de zonas de surge de ejemplo (Lima). Crea una zona activa sobre Miraflores compuesta por
 * celdas H3 (res 9). Uso: DATABASE_URL=... pnpm db:seed
 */
import { uuidv7, toH3, neighbors, DISPATCH_H3_RESOLUTION } from '@veo/utils';
import { PrismaClient } from '../src/generated/prisma';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const center = { lat: -12.1211, lon: -77.0297 }; // Miraflores
  const centerCell = toH3(center, DISPATCH_H3_RESOLUTION);
  const cells = neighbors(centerCell, 3); // ~zona compacta alrededor del centro

  const existing = await prisma.surgeZone.findFirst({ where: { name: 'Miraflores Centro' } });
  if (existing) {
    console.warn(`Zona de surge ya existe (${existing.id}). Nada que hacer.`);
    return;
  }

  const zone = await prisma.surgeZone.create({
    data: {
      id: uuidv7(),
      name: 'Miraflores Centro',
      cells,
      demandSupplyThreshold: 1.5,
      multiplier: 1.5,
      active: true,
    },
  });
  console.warn(`Zona de surge creada: ${zone.name} (${zone.id}) con ${cells.length} celdas H3.`);
}

main()
  .catch((err) => {
    console.error('Seed falló', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
