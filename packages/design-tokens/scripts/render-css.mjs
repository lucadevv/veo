/**
 * Render PURO del `tokens.css` compartido a partir del canon `trustColors`.
 * Separado del escritor (`generate-css.mjs`) para que el spec de sincronía
 * (`test/tokens.spec.ts`) pueda comparar el render contra el archivo commiteado
 * sin tocar el filesystem de salida.
 */

/** '#RRGGBB' → 'r,g,b' (para componer sombras rgba() tintadas con la tinta del canon). */
function hexToRgbTriplet(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/**
 * @param {import('../src/index.ts').SemanticColors} c — canon de color (trustColors).
 * @returns {string} contenido completo de tokens.css
 */
export function renderTokensCss(c) {
  const ink = hexToRgbTriplet(c.ink);
  return `/**
 * VEO · Design tokens · GENERADO por \`@veo/design-tokens\` — NO editar a mano.
 * Regenerar con:  pnpm --filter @veo/design-tokens generate:css
 *
 * Fuente ÚNICA de marca: \`packages/design-tokens/src/index.ts\` (canon Trust LIGHT, el mismo
 * que consumen passenger y driver vía @veo/ui-kit). Importar UNA vez en el globals.css de cada
 * app web antes de las capas de Tailwind:  @import "@veo/shared-config/tailwind/tokens.css";
 *
 * El sistema es LIGHT-first (Trust: lienzo claro + teal #0075A9 disciplinado); no hay bloque
 * .dark — un \`html.dark\` hereda estos mismos tokens, la clase no parte la marca. Los valores
 * van en hex/rgba sRGB: el preset Tailwind los normaliza con \`oklch(from var(--x) l c h / α)\`
 * (relative color syntax), así que el formato de origen es indistinto.
 *
 * NOTA: \`surfaceElevated\` del canon no se emite (en light es === surface #FFFFFF);
 * la 2ª superficie web (--surface-2) es la recesada \`surfaceMuted\`. \`safe\`/\`onSafe\`
 * tampoco (alias RN de success).
 */

:root {
  /* Superficies — lienzo claro Trust (canvas gris, tarjetas blancas, recesado sutil) */
  --bg: ${c.bg};
  --surface: ${c.surface};
  --surface-2: ${c.surfaceMuted};

  /* Tinta / texto */
  --ink: ${c.ink};
  --ink-muted: ${c.inkMuted};
  --ink-subtle: ${c.inkSubtle};

  /* Bordes y divisores */
  --border: ${c.border};
  --border-strong: ${c.borderStrong};
  --divider: ${c.divider};

  /* Marca + acento = teal de confianza · texto encima = BLANCO */
  --brand: ${c.brand};
  --brand-hover: ${c.brandHover};
  --on-brand: ${c.onBrand};
  --brand-dim: ${c.brandDim};
  --brand-deep: ${c.brandDeep};
  --accent: ${c.accent};
  --accent-hover: ${c.accentHover};
  --on-accent: ${c.onAccent};
  --accent-strong: ${c.accentStrong};

  /* Estado (canon trust-*: success #00C853 · warn #FFA000 · danger #D11216 · info #0097CE) */
  --success: ${c.success};
  --on-success: ${c.onSuccess};
  --success-text: ${c.successText};
  --success-dim: ${c.successDim};
  --warn: ${c.warn};
  --on-warn: ${c.onWarn};
  --warn-text: ${c.warnText};
  --warn-dim: ${c.warnDim};
  --danger: ${c.danger};
  --danger-hover: ${c.dangerHover};
  --on-danger: ${c.onDanger};
  --danger-dim: ${c.dangerDim};
  --info: ${c.info};
  --on-info: ${c.onInfo};
  --info-dim: ${c.infoDim};

  /* Foco accesible + scrim + skeleton */
  --focus: ${c.focus};
  --overlay: ${c.overlay};
  --skeleton: ${c.skeleton};
  --skeleton-highlight: ${c.skeletonHighlight};

  /* Radios y sombras (light: sombra SUAVE teñida de la tinta azul-gris, nunca negra pura) */
  --radius-sm: 0.5rem;
  --radius-md: 0.75rem;
  --radius-lg: 1rem;
  --shadow-1: 0 1px 2px rgba(${ink}, 0.06), 0 1px 1px rgba(${ink}, 0.04);
  --shadow-2: 0 4px 12px -2px rgba(${ink}, 0.08);
  --shadow-3: 0 18px 40px -12px rgba(${ink}, 0.12);

  /* Curvas de easing (emil-design-eng) */
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
`;
}
