import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Unit en src/, e2e (testcontainers) en test/. Resolución de @veo/* vía node_modules (dist).
    include: ['src/**/*.spec.ts', 'test/**/*.e2e.spec.ts'],
    // testcontainers (pull de imagen Postgres + migraciones) puede tardar la primera vez.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
