import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Enable HTTPS on the dev server when a self-signed cert is present (generated
// into web/certs/). Needed so non-localhost redirect URIs work with providers
// like Microsoft that require https. Falls back to http when absent.
const keyPath = fileURLToPath(new URL('./certs/dev-key.pem', import.meta.url));
const certPath = fileURLToPath(new URL('./certs/dev-cert.pem', import.meta.url));
const https =
  fs.existsSync(keyPath) && fs.existsSync(certPath)
    ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
    : undefined;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Bind to all interfaces so the dev server is reachable from outside the
    // container. HMR is served over the mapped 5173 port.
    host: true,
    // Dev server is reached by machine hostname (not just localhost), so accept
    // any Host header. Dev-only — the production build is served by Express.
    allowedHosts: true,
    https,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
