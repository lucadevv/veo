import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Los tests unitarios construyen las clases directamente (sin Nest DI). La integración con
    // Redis real (testcontainers) está en *.int.spec.ts y se activa con RUN_INTEGRATION=1.
    exclude: ['node_modules', 'dist', process.env.RUN_INTEGRATION ? '' : 'src/**/*.int.spec.ts'].filter(Boolean),
    testTimeout: process.env.RUN_INTEGRATION ? 120_000 : 10_000,
  },
});
