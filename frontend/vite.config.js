import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The browser E2E scripts write many screenshots into e2e-shots/; they are not source, so the dev server does not watch them.
    watch: { ignored: ['**/e2e-shots/**'] },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,           // the device WebSocket lives under /api/torqva/ws
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/tests/setup.js',
  },
});
