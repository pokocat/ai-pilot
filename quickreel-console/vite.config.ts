import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 与 admin 同一套代理口径：前端里 BASE 恒为 '/api'，指向 preprod 时把前缀重写掉。
const target = process.env.CONSOLE_API_TARGET || 'http://localhost:4000';
const prefix = process.env.CONSOLE_API_PREFIX || '/api';
const proxy = {
  '/api': {
    target,
    changeOrigin: true,
    ...(prefix !== '/api' ? { rewrite: (p: string) => p.replace(/^\/api/, prefix) } : {}),
  },
};

export default defineConfig({
  plugins: [react()],
  // 端口与 admin（5174/5175）错开，两套可以同时开着比对
  server: { port: 5184, proxy },
  preview: { port: 5185, proxy },
});
