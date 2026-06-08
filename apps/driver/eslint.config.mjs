import path from 'node:path';
import {fileURLToPath} from 'node:url';
import js from '@eslint/js';
import {FlatCompat} from '@eslint/eslintrc';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({
  baseDirectory: dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  {
    ignores: [
      'node_modules/**',
      'android/**',
      'ios/**',
      'coverage/**',
      'detox-artifacts/**',
      'babel.config.js',
      'metro.config.js',
      'jest.config.js',
      'jest.setup.js',
      '.detoxrc.js',
      'eslint.config.mjs',
    ],
  },
  // Reutiliza la config oficial de React Native (eslint 8) vía capa de compatibilidad.
  ...compat.extends('@react-native'),
  {
    rules: {
      // El formateo se delega a prettier por separado; no bloquea el lint.
      'prettier/prettier': 'off',
    },
  },
];
