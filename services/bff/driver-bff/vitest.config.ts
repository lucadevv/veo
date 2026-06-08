import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Los tests construyen las clases directamente (sin Nest DI), por lo que no requieren
    // metadata de decoradores. Resolución de @veo/* vía node_modules (dist ESM; @veo/rpc desde source).
  },
});
