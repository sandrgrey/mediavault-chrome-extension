import { defineConfig } from 'vite';
export default defineConfig({
  publicDir: false,
  build: { outDir: 'dist', emptyOutDir: false, sourcemap: false,
    lib: { entry: 'src/media/bridgeMain.ts', name: 'MediaVaultBridge', formats: ['iife'], fileName: () => 'page-bridge.js' },
  },
});
