import type { Config } from 'tailwindcss';
// El preset compartido mapea los tokens semánticos (tokens.css generado por @veo/design-tokens)
// a utilidades Tailwind.
import preset from '@veo/shared-config/tailwind/preset.cjs';

const config: Config = {
  presets: [preset],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // display (Clash Display, la display de marca de las apps RN, admin y hub): el preset
      // solo mapea sans (Outfit) y mono (Space Mono).
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
      },
      // Texto/íconos success con contraste AA sobre lienzo claro (#00873A): el preset solo
      // mapea success/on-success (#00C853 es de relleno, no alcanza 3:1 sobre blanco).
      colors: {
        'success-text': 'oklch(from var(--success-text) l c h / <alpha-value>)',
      },
    },
  },
};

export default config;
