import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Los tests construyen las clases directamente (sin Nest DI), por lo que no requieren
    // metadata de decoradores. Resolución de @veo/* vía node_modules (dist ESM).
    //
    // La integración con Redis REAL (CAS Lua de upsertDriver) vive en *.int.spec.ts y se activa con
    // RUN_INTEGRATION=1 (requiere Docker / testcontainers). Excluida por defecto para mantener
    // `pnpm test` verde sin dependencias externas (igual que el patrón de dispatch-service).
    exclude: [
      'node_modules',
      'dist',
      process.env.RUN_INTEGRATION ? '' : 'src/**/*.int.spec.ts',
    ].filter(Boolean),
    testTimeout: process.env.RUN_INTEGRATION ? 120_000 : 15_000,
    hookTimeout: 180_000,
  },
});
