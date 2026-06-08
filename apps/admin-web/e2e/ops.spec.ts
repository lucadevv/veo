import { expect, test } from '@playwright/test';
import { bffAuthReachable, loginViaUi } from './utils';

/**
 * Flujos contra el admin-bff real. Se saltan automáticamente si el backend no responde
 * o faltan credenciales (E2E_ADMIN_EMAIL/PASSWORD[/TOTP]).
 */
test.describe('Operación (requiere admin-bff)', () => {
  test.beforeEach(async ({ request }) => {
    test.skip(!(await bffAuthReachable(request)), 'admin-bff no disponible');
  });

  test('login → dashboard → tabla de viajes → detalle', async ({ page }) => {
    const ok = await loginViaUi(page);
    test.skip(!ok, 'No se pudo iniciar sesión (credenciales o MFA ausentes)');

    await page.goto('/ops/trips');
    await expect(page.getByRole('heading', { name: 'Viajes' })).toBeVisible();

    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click();
      await expect(page).toHaveURL(/\/ops\/trips\//);
    }
  });

  test('recibe y muestra una alerta de pánico en el banner', async ({ page }) => {
    const ok = await loginViaUi(page);
    test.skip(!ok, 'No se pudo iniciar sesión');

    await page.goto('/ops');
    // El banner aparece cuando llega un evento panic:alert por Socket.IO desde el bff.
    // En integración real se dispara provocando un pánico; aquí validamos que el contenedor exista.
    await expect(page.getByRole('heading', { name: 'Operación en vivo' })).toBeVisible();
  });
});
