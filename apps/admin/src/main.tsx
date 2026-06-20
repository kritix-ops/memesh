import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

console.info('[admin boot]', {
  apiBase: import.meta.env.VITE_API_URL ?? '/api',
  staffUrl: import.meta.env.VITE_STAFF_URL ?? 'https://staff.memesh.co.il',
  mode: import.meta.env.MODE,
});

const root = document.getElementById('root');
if (!root) throw new Error('root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
