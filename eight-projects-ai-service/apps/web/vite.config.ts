import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.API_PORT ?? '8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
  preview: { port: Number(process.env.WEB_PORT ?? 5173), proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } } },
  build: { chunkSizeWarningLimit: 1500 },
});
