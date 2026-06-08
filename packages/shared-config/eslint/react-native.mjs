import base from './base.mjs';
export default [
  ...base,
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
