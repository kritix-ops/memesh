import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, the SPA calls /api/* and Vite forwards it to the Fastify API on
// localhost:3001 (stripping the /api prefix). In prod (single-origin Cloudways),
// the reverse proxy plays the same role. The client codebase calls /api/* in
// both environments — see apps/web/src/lib/api.ts.
//
// API_DEV_TARGET lets you point the proxy at a different API host (e.g. WSL,
// a teammate's machine) without editing this file.
const API_DEV_TARGET = process.env['API_DEV_TARGET'] ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: API_DEV_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
