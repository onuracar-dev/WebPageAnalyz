import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  const apiProxyTarget = process.env.VITE_DEV_API_PROXY_TARGET || 'http://localhost:8080';

  return {
    plugins: [react()],
    base: '/',
    server: {
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          headers: { Origin: apiProxyTarget },
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 540,
      rollupOptions: {
        maxParallelFileOps: 128,
      },
    },
  };
});
