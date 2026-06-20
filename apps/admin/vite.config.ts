import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Admin SPA (admin.memesh.co.il). Calls the API at VITE_API_URL directly —
// no /api proxy. Port 3020 sits between staff (3010) and a future customer
// (3030) so all three can run side-by-side against the shared apps/api on 3001.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3020,
  },
});
