import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Bind to all interfaces so the dev server is reachable from outside the
    // container. HMR is served over the mapped 5173 port.
    host: true,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
