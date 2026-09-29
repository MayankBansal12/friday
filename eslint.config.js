import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist', 'dist-electron', 'release', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: { ...reactHooks.configs.recommended.rules, ...reactRefresh.configs.vite.rules },
  },
  {
    files: ['native/gnome-extension/*.js', 'tests/native/*.js'],
    languageOptions: { globals: { global: 'readonly', console: 'readonly', TextDecoder: 'readonly' } },
  },
  { files: ['electron/**/*.ts', 'tests/**/*.ts', 'tests/native/*.mjs'], languageOptions: { globals: globals.node } },
);
