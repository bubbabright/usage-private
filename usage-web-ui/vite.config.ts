import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['usage.hoboguppy.com', 'localhost'],
    // dev-only: proxy API calls to the usage-daemon running locally.
    proxy: { '/usage': 'http://127.0.0.1:8787' }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
