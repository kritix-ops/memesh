import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Customer personal area (my.memesh.co.il). Calls the API at VITE_API_URL
// directly — no /api proxy. Port 3030 keeps the three frontends and apps/api
// on distinct ports so they can run side-by-side in dev:
//   3001 apps/api, 3010 apps/staff, 3020 apps/admin, 3030 apps/customer.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3030,
  },
});
