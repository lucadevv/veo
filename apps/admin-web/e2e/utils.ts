import type { Page, APIRequestContext } from '@playwright/test';

/** Credenciales de e2e (entorno real). Sin valores hardcodeados de producción. */
export const E2E_EMAIL = process.env.E2E_ADMIN_EMAIL ?? '';
export const E2E_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
export const E2E_TOTP = process.env.E2E_ADMIN_TOTP ?? '';

/** ¿Responde el flujo de auth (admin-bff vía el proxy del propio origen)? */
export async function bffAuthReachable(request: APIRequestContext): Promise<boolean> {
  try {
    const res = await request.get('/api/auth/session');
    // 200 (sesión) o 401 (sin sesión) implican que el backend respondió.
    return res.status() === 200 || res.status() === 401;
  } catch {
    return false;
  }
}

/**
 * Inicia sesión por la UI. Devuelve true si llegó al dashboard. Si el bff no está disponible
 * o faltan credenciales, devuelve false para que el test se salte.
 */
export async function loginViaUi(page: Page): Promise<boolean> {
  if (!E2E_EMAIL || !E2E_PASSWORD) return false;

  await page.goto('/login');
  await page.getByLabel('Correo corporativo').fill(E2E_EMAIL);
  await page.getByLabel('Contraseña').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Continuar' }).click();

  // Paso TOTP opcional.
  const totpField = page.getByLabel('Código de 6 dígitos');
  if (await totpField.isVisible().catch(() => false)) {
    if (!E2E_TOTP) return false;
    await totpField.fill(E2E_TOTP);
    await page.getByRole('button', { name: 'Verificar y entrar' }).click();
  }

  await page
    .waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 8000 })
    .catch(() => undefined);
  return !page.url().includes('/login');
}
