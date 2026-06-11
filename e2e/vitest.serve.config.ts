import { defineConfig } from 'vitest/config';

// Config EXCLUSIVA de la utilidad serve-stack (sostener el stack vivo para probar en
// dispositivo). Está excluida del run normal (vitest.config.ts) porque su test nunca
// resuelve. Uso: `pnpm run e2e:serve` · para bajarlo: Ctrl-C (o pkill -f "node dist/main").
export default defineConfig({
  test: {
    environment: 'node',
    include: ['golden-path/serve-stack.e2e.spec.ts'],
    hookTimeout: 600_000,
    testTimeout: 86_400_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    retry: 0,
  },
});
