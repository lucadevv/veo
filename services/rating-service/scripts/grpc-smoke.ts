/* Humo gRPC: llama veo.rating.v1.RatingService/GetAggregate contra el servicio local. */
import { credentials, loadPackageDefinition } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { join } from 'node:path';
import { PrismaClient } from '../src/generated/prisma';

const prisma = new PrismaClient();

interface AggregateReply {
  subjectId: string;
  role: string;
  rollingAvg30d: number;
  count30d: number;
  flagged: boolean;
  found: boolean;
}

async function main(): Promise<void> {
  const agg = await prisma.ratingAggregate.findFirst();
  if (!agg) throw new Error('no hay agregados; corre primero e2e-smoke.ts');

  const def = loadSync(join(__dirname, '../proto/rating.proto'), { keepCase: false, longs: String, defaults: true });
  const pkg = loadPackageDefinition(def) as unknown as {
    veo: { rating: { v1: { RatingService: new (addr: string, creds: ReturnType<typeof credentials.createInsecure>) => {
      GetAggregate: (req: { subjectId: string }, cb: (err: Error | null, res: AggregateReply) => void) => void;
    } } } };
  };
  const client = new pkg.veo.rating.v1.RatingService('localhost:50060', credentials.createInsecure());

  await new Promise<void>((resolve, reject) => {
    client.GetAggregate({ subjectId: agg.subjectId }, (err, res) => {
      if (err) return reject(err);
      console.log('gRPC GetAggregate →', JSON.stringify(res));
      resolve();
    });
  });

  await new Promise<void>((resolve, reject) => {
    client.GetAggregate({ subjectId: '00000000-0000-0000-0000-000000000000' }, (err, res) => {
      if (err) return reject(err);
      console.log('gRPC GetAggregate (inexistente) → found =', res.found);
      resolve();
    });
  });
}

main()
  .catch((err) => {
    console.error('gRPC smoke falló', err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
