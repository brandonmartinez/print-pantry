import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': { target: `http://localhost:${process.env.API_PORT ?? 3000}`, rewrite: (path) => path.replace(/^\/api/, '') } },
  },
  test: { environment: 'jsdom' },
});
