import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Staff station SPA (staff.memesh.co.il). The frontend calls the API at
// VITE_API_URL directly — no /api proxy here. In dev that means localhost:3001
// (apps/api), in prod it's https://api.memesh.co.il.
//
// Port 3010 reserves room: 3000 stays with apps/web during the transition,
// 3001 belongs to apps/api, 3020 will be apps/admin, 3030 will be apps/customer.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3010,
  },
});
