import { defineConfig, devices } from '@playwright/test';

/**
 * Config de e2e. baseURL configurable por env para correr contra dev local o un entorno real.
 * Los tests que dependen del admin-bff se auto-saltan si el backend no responde (ver e2e/utils.ts).
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5001';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    locale: 'es-PE',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
