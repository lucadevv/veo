import { test, expect, type APIRequestContext } from '@playwright/test';

const BFF_URL = process.env.NEXT_PUBLIC_BFF_URL ?? 'http://localhost:4001/api/v1';

/** Comprueba si el public-bff responde (health). Los tests de integración se omiten si no. */
async function bffReachable(request: APIRequestContext): Promise<boolean> {
  const candidates = [`${BFF_URL}/health`, `${BFF_URL.replace(/\/api\/v1$/, '')}/health`];
  for (const url of candidates) {
    try {
      const res = await request.get(url, { timeout: 2000 });
      if (res.ok()) return true;
    } catch {
      // siguiente candidato
    }
  }
  return false;
}

test.describe('Seguimiento /t/[token]', () => {
  test('estado tranquilo cuando el bff no responde', async ({ page, request }) => {
    test.skip(await bffReachable(request), 'El bff responde: el estado depende del token real.');
    await page.goto('/t/cualquier-token-sin-bff');
    await expect(page.getByRole('heading', { name: 'No pudimos cargar el viaje' })).toBeVisible();
  });

  test('carga un viaje válido en vivo', async ({ page, request }) => {
    const token = process.env.TEST_SHARE_TOKEN;
    test.skip(!token, 'Define TEST_SHARE_TOKEN para correr este test de integración.');
    test.skip(!(await bffReachable(request)), 'El public-bff no responde.');

    await page.goto(`/t/${token}`);
    await expect(page.getByLabel('Mapa del viaje en vivo')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Estado del viaje' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText(/En vivo|Reconectando/);
  });

  test('muestra pantalla de link expirado', async ({ page, request }) => {
    const token = process.env.TEST_EXPIRED_TOKEN;
    test.skip(!token, 'Define TEST_EXPIRED_TOKEN para correr este test de integración.');
    test.skip(!(await bffReachable(request)), 'El public-bff no responde.');

    await page.goto(`/t/${token}`);
    await expect(page.getByRole('heading', { name: 'Este link ya caducó' })).toBeVisible();
  });

  test('muestra pantalla de link revocado', async ({ page, request }) => {
    const token = process.env.TEST_REVOKED_TOKEN;
    test.skip(!token, 'Define TEST_REVOKED_TOKEN para correr este test de integración.');
    test.skip(!(await bffReachable(request)), 'El public-bff no responde.');

    await page.goto(`/t/${token}`);
    await expect(page.getByRole('heading', { name: 'El viaje dejó de compartirse' })).toBeVisible();
  });
});
