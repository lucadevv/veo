/**
 * Seed de desarrollo: crea un viaje de ejemplo en estado REQUESTED usando el motor de mapas
 * local (sin OSRM) y la regla de tarifa real (BR-T05). Uso:
 *   DATABASE_URL=postgresql://veo:veo_dev@localhost:5433/veo pnpm --filter @veo/trip-service db:seed
 */
import { createMapsClient } from '@veo/maps';
import { uuidv7, formatPEN } from '@veo/utils';
import { PrismaClient } from '../src/generated/prisma';
import { calculateFare } from '../src/trips/domain/fare';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const maps = createMapsClient({ mode: 'local' });
  const origin = { lat: -12.0464, lon: -77.0428 }; // Plaza de Armas, Lima
  const destination = { lat: -12.1219, lon: -77.0297 }; // Miraflores

  const route = await maps.route(origin, destination);
  const fare = calculateFare({
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    surgeMultiplier: 1.0,
    childMode: false,
  });

  const trip = await prisma.trip.create({
    data: {
      id: uuidv7(),
      passengerId: uuidv7(),
      originLat: origin.lat,
      originLon: origin.lon,
      destLat: destination.lat,
      destLon: destination.lon,
      fareCents: fare.cents,
      currency: fare.currency,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      paymentMethod: 'YAPE',
      status: 'REQUESTED',
      routePolyline: route.polyline || null,
    },
  });

  console.warn(
    `Viaje de ejemplo creado: ${trip.id} · tarifa ${formatPEN(trip.fareCents)} · ${trip.status}`,
  );
}

main()
  .catch((err) => {
    console.error('Seed falló', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
