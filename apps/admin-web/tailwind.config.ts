import type { Config } from 'tailwindcss';
// El preset compartido mapea los tokens semánticos OKLCH a utilidades Tailwind.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const preset = require('@veo/shared-config/tailwind/preset.cjs') as Config;

const config: Config = {
  presets: [preset],
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
};

export default config;
