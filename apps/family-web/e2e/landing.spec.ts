import { test, expect } from '@playwright/test';

test.describe('Landing pública', () => {
  test('muestra qué es VEO Family y cómo funciona el link', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Acompaña el viaje');
    await expect(page.getByRole('heading', { name: 'Cómo funciona el link' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Qué vas a ver' })).toBeVisible();
  });

  test('no genera scroll horizontal en mobile (375px)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
