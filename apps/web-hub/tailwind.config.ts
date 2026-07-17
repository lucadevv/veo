import type { Config } from 'tailwindcss';
// El preset compartido mapea los tokens semánticos (tokens.css generado por @veo/design-tokens)
// a utilidades Tailwind: bg/surface/surface-2/ink/border/brand/accent/success/warn/danger/focus.
import preset from '@veo/shared-config/tailwind/preset.cjs';

/**
 * El hub es la cara pública del ecosistema y va en la MARCA VEO: monomarca teal de
 * confianza (#0075A9, token `--brand` del sistema compartido) sobre lienzo claro Trust.
 * Un solo acento (`brand`) — no hay color por app. Los componentes nunca hardcodean hex.
 */
const config: Config = {
  presets: [preset],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // display (Clash Display, la display de marca de las apps RN y el admin): el preset
      // solo mapea sans (Outfit) y mono (Space Mono).
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
      },
      // Métricas propias del layout del hub (no son tokens de marca).
      borderRadius: {
        card: '22px',
      },
      maxWidth: {
        wrap: '1080px',
      },
      letterSpacing: {
        eyebrow: '0.2em',
      },
    },
  },
  plugins: [],
};

export default config;
