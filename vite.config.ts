import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173, open: false },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Many tests run the full simulation (Rapier + water solver); on a loaded machine they can
    // exceed vitest's 5 s default without anything being wrong. (Tests that need more set their own.)
    testTimeout: 30_000,
  },
});
