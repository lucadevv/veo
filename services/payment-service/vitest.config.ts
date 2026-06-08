import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Unit (src/**/*.spec.ts) + e2e con testcontainers (test/**/*.e2e.spec.ts).
    include: ['src/**/*.spec.ts', 'test/**/*.e2e.spec.ts'],
    // testcontainers levanta Postgres real (pull + arranque): timeout holgado.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Las suites e2e comparten contenedor/DB por archivo; sin paralelismo entre archivos e2e.
    fileParallelism: false,
  },
});
