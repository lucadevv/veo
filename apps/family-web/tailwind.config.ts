import type { Config } from 'tailwindcss';
// El preset compartido mapea los tokens semánticos OKLCH a utilidades Tailwind.
import preset from '@veo/shared-config/tailwind/preset.cjs';

const config: Config = {
  presets: [preset],
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
};

export default config;
