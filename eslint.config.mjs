import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['**/dist', '**/node_modules'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build scripts run in Node.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
];
