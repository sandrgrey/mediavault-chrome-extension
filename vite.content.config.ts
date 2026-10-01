import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'dist', emptyOutDir: false, sourcemap: false,
    lib: { entry: 'src/content/main.tsx', name: 'MediaVault', formats: ['iife'], fileName: () => 'content.js' },
  },
});
