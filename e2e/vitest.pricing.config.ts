import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['pricing-switch/**/*.e2e.spec.ts'],
    // Igual que el golden path: el beforeAll compila @veo/* a dist + spawnea 7 procesos + espera health.
    hookTimeout: 600_000,
    testTimeout: 120_000,
    // Secuencia única con estado compartido (un mismo conductor/pasajero a lo largo de A→C→B): NO paralelizar.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    retry: 0,
  },
});
