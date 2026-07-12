import type { Config } from 'tailwindcss';
// El preset compartido mapea los tokens semánticos OKLCH a utilidades Tailwind.
import preset from '@veo/shared-config/tailwind/preset.cjs';

// Helper local (mismo patrón que el preset): token semántico con soporte de opacidad (<alpha-value>).
const c = (name: string) => `oklch(from var(${name}) l c h / <alpha-value>)`;

const config: Config = {
  presets: [preset],
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // `info` (#0097CE trust-info): el preset COMPARTIDO no lo mapea a propósito — family-web y
      // web-hub usan ese preset en dark y no definen --info. Se declara SCOPED a admin acá (igual que
      // display/serif/xl) para no tocar shared-config. Habilita bg-info / text-info / border-info.
      colors: {
        info: { DEFAULT: c('--info'), on: c('--on-info') },
      },
      // Sistema "Trust": display (Space Grotesk) para títulos/dígitos, serif (Fraunces) para el
      // headline editorial de marca. sans (Outfit) y mono (Space Mono) los mapea el preset compartido.
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        serif: ['var(--font-serif)', 'Georgia', 'serif'],
      },
      // Radios del veo.pen que el preset no trae: xl (cards), 2xl (cards grandes), control (botones).
      borderRadius: {
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        control: 'var(--radius-control)',
      },
    },
  },
};

export default config;
