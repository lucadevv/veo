import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Los tests construyen las clases directamente (sin Nest DI), por lo que no requieren
    // metadata de decoradores. LiveKit/S3 van detrás de puertos con adapters sandbox deterministas.
  },
});
