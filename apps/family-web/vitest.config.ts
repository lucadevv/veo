import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    // Solo unidad en src. Los specs de e2e/ corren con Playwright (test:e2e), no con vitest.
    include: ['src/**/*.test.ts'],
  },
});
