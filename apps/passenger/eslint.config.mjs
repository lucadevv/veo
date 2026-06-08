// ESLint flat config alineado a TypeScript estricto para el VEO Passenger App.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    // Rutas que ESLint no debe analizar.
    ignores: [
      'node_modules/**',
      'ios/**',
      'android/**',
      'coverage/**',
      'dist/**',
      '**/*.config.js',
      '**/*.config.mjs',
      'jest.setup.js',
      'babel.config.js',
      'metro.config.js',
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
    // Tests: el re-import dinámico para aislar módulos (jest.isolateModules) usa
    // `require()` bajo el preset CJS de jest, y `typeof import()` para tipar el módulo
    // re-importado. Ambos son idiomáticos en specs; se relajan sólo acá.
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
);
