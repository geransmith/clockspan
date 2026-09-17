import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Syntax-level rules only (no type-aware linting): `npm run typecheck` already does the
// type work, and this keeps `npm run lint` at a couple of seconds.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'data/', 'docs/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_`-prefixed names are the convention for "deliberately unused" (rest-destructuring a
      // row to drop columns, unused handler params).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
    },
  },
  {
    files: ['client/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['client/public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ['server/**/*.ts', 'shared/**/*.ts', 'scripts/**/*.mjs', '*.ts', '*.js'],
    languageOptions: { globals: globals.node },
  },
);
