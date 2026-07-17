import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trustColors } from '../src/index';
// @ts-expect-error — módulo .mjs sin tipos (render puro del codegen, mismo que corre generate:css)
import { renderTokensCss } from '../scripts/render-css.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('canon Trust — correcciones ratificadas por el dueño (2026-07-16)', () => {
  it('1. success/safe = #00C853 en todo el sistema (muere el jade #17C08A); montos = #009624', () => {
    expect(trustColors.success).toBe('#00C853');
    expect(trustColors.safe).toBe('#00C853');
    expect(trustColors.successDim).toBe('rgba(0,200,83,0.10)');
    expect(trustColors.accentStrong).toBe('#009624');
  });

  it('2. inkMuted unificado #647386 (muere el drift #6B7A8F del driver)', () => {
    expect(trustColors.inkMuted).toBe('#647386');
  });

  it('3. info alineado a la familia #0097CE (info e infoDim en la MISMA familia)', () => {
    expect(trustColors.info).toBe('#0097CE');
    expect(trustColors.infoDim).toBe('rgba(0,151,206,0.10)');
  });

  it('safe es alias exacto de success (contrato RN)', () => {
    expect(trustColors.safe).toBe(trustColors.success);
    expect(trustColors.onSafe).toBe(trustColors.onSuccess);
  });
});

describe('tokens.css generado — sincronía con el canon', () => {
  it('el tokens.css commiteado en shared-config es EXACTAMENTE el render del canon (si falla: pnpm --filter @veo/design-tokens generate:css)', () => {
    const committed = readFileSync(
      resolve(HERE, '../../shared-config/tailwind/tokens.css'),
      'utf8',
    );
    expect(committed).toBe(renderTokensCss(trustColors));
  });

  it('el render expresa Trust LIGHT como :root (sin bloque .dark, sin OKLCH dark heredado)', () => {
    const css = renderTokensCss(trustColors) as string;
    expect(css).toContain(`--bg: ${trustColors.bg};`);
    expect(css).toContain('--brand: #0075A9;');
    expect(css).not.toMatch(/^\.dark\b/m);
    // Vars que el preset Tailwind compartido referencia — el contrato no puede romperse.
    for (const varName of [
      '--bg', '--surface', '--surface-2', '--ink', '--ink-muted', '--ink-subtle',
      '--border', '--border-strong', '--brand', '--brand-hover', '--on-brand',
      '--accent', '--accent-hover', '--on-accent', '--success', '--on-success',
      '--warn', '--on-warn', '--danger', '--danger-hover', '--on-danger', '--focus',
      '--radius-sm', '--radius-md', '--radius-lg', '--shadow-1', '--shadow-2', '--shadow-3',
      '--ease-out', '--ease-in-out', '--ease-drawer',
    ]) {
      expect(css).toContain(`${varName}: `);
    }
  });
});
