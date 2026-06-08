/**
 * Helper de testcontainers para tests críticos (payments, panic, audit) que NO se mockean (CLAUDE).
 * Levanta un Postgres+PostGIS efímero, aplica migraciones y entrega la URL de conexión.
 * `@testcontainers/postgresql` se carga por dynamic import → no penaliza el bundle de producción.
 *
 * Uso en un test de servicio:
 *   const db = await createTestDatabase({
 *     schema: 'payment',
 *     applyMigrations: (url) => runPrismaMigrateDeploy(url, import.meta.dirname + '/..'),
 *   });
 *   const prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
 *   ...
 *   await db.teardown();
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CreateTestDatabaseOptions {
  /** Schema lógico del servicio (informativo; las migraciones lo crean). */
  schema?: string;
  /** Imagen Postgres. Default PostGIS (algunos servicios usan tipos geography). */
  image?: string;
  /** Callback para aplicar migraciones contra la URL del contenedor. */
  applyMigrations?: (databaseUrl: string) => Promise<void>;
}

export interface TestDatabase {
  databaseUrl: string;
  teardown: () => Promise<void>;
}

export async function createTestDatabase(opts: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer(opts.image ?? 'postgis/postgis:16-3.4-alpine')
    .withDatabase('veo_test')
    .withUsername('veo')
    .withPassword('veo_test')
    .start();

  const databaseUrl = container.getConnectionUri();
  if (opts.applyMigrations) {
    await opts.applyMigrations(databaseUrl);
  }

  return {
    databaseUrl,
    teardown: async () => {
      await container.stop();
    },
  };
}

/** Ejecuta `prisma migrate deploy` contra una URL, desde el directorio del servicio (donde vive prisma/). */
export async function runPrismaMigrateDeploy(databaseUrl: string, cwd: string): Promise<void> {
  await execFileAsync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}
