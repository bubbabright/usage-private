import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev UI for the Python daemon running on :8788.
// Separate frontend port so it can run alongside the default UI and the daemon.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5175,
    strictPort: true,
    allowedHosts: ['usage.hoboguppy.com', 'localhost'],
    proxy: { '/usage': 'http://127.0.0.1:8788' }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
