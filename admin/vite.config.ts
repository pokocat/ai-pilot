import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发代理目标可配，用于把本地运营后台指向不同环境：
//   本地后端（默认）  npm run dev
//   预发 preprod      npm run dev:preprod
// 前端代码里 BASE 恒为 '/api'（见 src/api.ts），所以指向 preprod 时要把路径前缀重写成 /api_preprod。
const target = process.env.ADMIN_API_TARGET || 'http://localhost:4000';
const prefix = process.env.ADMIN_API_PREFIX || '/api';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        ...(prefix !== '/api' ? { rewrite: (p: string) => p.replace(/^\/api/, prefix) } : {}),
      },
    },
  },
});
