import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  // .worktrees/ holds other checkouts (separate branches); test only this one.
  test: { exclude: [...configDefaults.exclude, '.worktrees/**'] },
});
