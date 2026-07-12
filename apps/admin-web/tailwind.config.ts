import type { Config } from 'tailwindcss';
// El preset compartido mapea los tokens semánticos OKLCH a utilidades Tailwind.
import preset from '@veo/shared-config/tailwind/preset.cjs';

const config: Config = {
  presets: [preset],
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
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
