import { expect, test } from '@playwright/test';

test.describe('Autenticación y protección de rutas', () => {
  test('redirige a /login cuando no hay sesión', async ({ page }) => {
    await page.goto('/ops');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Inicia sesión' })).toBeVisible();
  });

  test('el formulario de login muestra los campos requeridos', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Correo corporativo')).toBeVisible();
    await expect(page.getByLabel('Contraseña')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continuar' })).toBeDisabled();
  });
});
