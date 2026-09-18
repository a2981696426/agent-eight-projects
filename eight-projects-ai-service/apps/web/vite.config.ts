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
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/echarts') || id.includes('node_modules/zrender') || id.includes('echarts-for-react')) return 'echarts';
          if (id.includes('node_modules/antd') || id.includes('node_modules/@ant-design') || id.includes('node_modules/rc-')) return 'antd';
          if (id.includes('node_modules/react')) return 'react';
        },
      },
    },
  },
});
