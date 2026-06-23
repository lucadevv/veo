import type { Config } from 'tailwindcss';

/**
 * El hub es la cara pública del ecosistema y va en la MARCA VEO: monomarca azul
 * (#2D7FF9) sobre lienzo oscuro, texto blanco. Un solo acento (`brand`) — no hay
 * color por app. Los nombres semánticos viven acá, una sola vez; los componentes
 * nunca hardcodean hex.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Referencian las variables CSS definidas en globals.css (única fuente de verdad).
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        ink: 'var(--ink)',
        'ink-muted': 'var(--ink-muted)',
        'ink-subtle': 'var(--ink-subtle)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        brand: 'var(--brand)',
      },
      fontFamily: {
        display: ['var(--font-display)', 'sans-serif'],
        sans: ['var(--font-sans)', 'sans-serif'],
        mono: ['var(--font-mono)', 'monospace'],
      },
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
