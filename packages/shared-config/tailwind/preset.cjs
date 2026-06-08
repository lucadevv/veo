/**
 * VEO · Preset Tailwind compartido (admin-web, family-web).
 * Mapea tokens semánticos OKLCH (definidos en tokens.css) a utilidades Tailwind.
 * Uso en tailwind.config.ts de cada app:  presets: [require('@veo/shared-config/tailwind/preset.cjs')]
 * Dark mode por clase: <html class="dark">.
 */

/** color() helper: token semántico con soporte de opacidad (<alpha-value>). */
const c = (name) => `oklch(from var(${name}) l c h / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: c('--bg'),
        surface: { DEFAULT: c('--surface'), 2: c('--surface-2') },
        ink: { DEFAULT: c('--ink'), muted: c('--ink-muted'), subtle: c('--ink-subtle') },
        border: { DEFAULT: c('--border'), strong: c('--border-strong') },
        brand: { DEFAULT: c('--brand'), hover: c('--brand-hover'), on: c('--on-brand') },
        accent: { DEFAULT: c('--accent'), hover: c('--accent-hover'), on: c('--on-accent') },
        success: { DEFAULT: c('--success'), on: c('--on-success') },
        warn: { DEFAULT: c('--warn'), on: c('--on-warn') },
        danger: { DEFAULT: c('--danger'), hover: c('--danger-hover'), on: c('--on-danger') },
        focus: c('--focus'),
      },
      borderColor: { DEFAULT: c('--border') },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
      boxShadow: {
        1: 'var(--shadow-1)',
        2: 'var(--shadow-2)',
        3: 'var(--shadow-3)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.875rem', { lineHeight: '1.25rem' }],
        base: ['1rem', { lineHeight: '1.6' }],
        lg: ['1.125rem', { lineHeight: '1.6' }],
        xl: ['1.25rem', { lineHeight: '1.5' }],
        '2xl': ['1.5rem', { lineHeight: '1.3' }],
        '3xl': ['1.875rem', { lineHeight: '1.2' }],
        '4xl': ['2.25rem', { lineHeight: '1.15' }],
        '5xl': ['3rem', { lineHeight: '1.1', letterSpacing: '-0.02em' }],
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        'in-out': 'var(--ease-in-out)',
        drawer: 'var(--ease-drawer)',
      },
      zIndex: {
        dropdown: '10',
        sticky: '20',
        backdrop: '30',
        modal: '40',
        toast: '50',
        tooltip: '60',
      },
      ringColor: { DEFAULT: c('--focus') },
    },
  },
  plugins: [],
};
