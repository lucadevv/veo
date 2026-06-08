import base from './base.mjs';
export default [
  ...base,
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      'react/react-in-jsx-scope': 'off',
    },
  },
];
