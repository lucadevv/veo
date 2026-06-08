import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Los e2e con testcontainers (Postgres real) y MinIO requieren timeouts amplios:
    // levantar contenedores + aplicar migraciones puede tardar > 60s en frío.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Sin paralelizar suites para no saturar Docker con varios contenedores a la vez.
    fileParallelism: false,
  },
});
