import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['golden-path/**/*.e2e.spec.ts'],
    // Arrancar el stack mínimo (compilar deps + spawnear 5 servicios + 2 BFFs + esperar health)
    // puede tardar la primera vez (build de @veo/* a dist). Damos margen amplio.
    hookTimeout: 600_000,
    testTimeout: 120_000,
    // El golden path es UNA secuencia con estado compartido: NO paralelizar.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    retry: 0,
  },
});
