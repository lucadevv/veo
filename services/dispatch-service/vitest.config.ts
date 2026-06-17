import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Unit (src/**/*.spec.ts) + e2e con Postgres real (testcontainers, test/**/*.e2e.spec.ts).
    include: ['src/**/*.spec.ts', 'test/**/*.e2e.spec.ts'],
    // Los tests unitarios construyen las clases directamente (sin Nest DI). La integración con
    // Redis real (vivo, REDIS_URL) está en *.int.spec.ts y se activa con RUN_INTEGRATION=1.
    exclude: [
      'node_modules',
      'dist',
      process.env.RUN_INTEGRATION ? '' : 'src/**/*.int.spec.ts',
    ].filter(Boolean),
    testTimeout: process.env.RUN_INTEGRATION ? 120_000 : 30_000,
    // Los e2e levantan Postgres efímero (testcontainers) en beforeAll: hook holgado para el arranque.
    hookTimeout: 180_000,
  },
});
