// ESLint flat config para el VEO Driver App (RN). Modelado en passenger: flat config puro con
// typescript-eslint. NO usa el preset legacy `@react-native` vía FlatCompat — ese preset referencia
// reglas removidas en typescript-eslint v8 (p.ej. `func-call-spacing`) y rompía el lint entero.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'android/**',
      'ios/**',
      'coverage/**',
      'detox-artifacts/**',
      'dist/**',
      '**/*.config.js',
      '**/*.config.mjs',
      'babel.config.js',
      'metro.config.js',
      'jest.config.js',
      'jest.setup.js',
      '.detoxrc.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2021,
        __DEV__: 'readonly',
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Tests: re-import dinámico para aislar módulos (require/typeof import) e `any` en los dobles de
    // test (mocks de fetch/HTTP) — idiomático en specs. Misma convención que el config raíz del backend.
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
