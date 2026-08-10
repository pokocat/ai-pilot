import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// PC 工作台的构建：纯 Vite + React DOM，**不经过 Taro**。
// 与移动端 H5（Taro，config/index.ts → dist-h5）完全独立的两条流水线，共用 src/services 与 src/data
// 业务层（那一层已由 services/platform.ts 与 Taro 解耦）。
//
// 产物 dist-pc/ 与 dist-h5/ 物理隔离；线上 PC 挂在 /pc/ 路径下，移动 H5 保持在站点根不受影响。

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

const gitSha = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
})();

export default defineConfig(() => {
  // 与 Taro 侧同名同义：mock = 本地假数据，server = 连真实后端。
  const mode = process.env.TARO_APP_MODE || 'mock';
  const api = process.env.TARO_APP_API || '';

  return {
    root: path.resolve(__dirname, 'src/pc'),
    base: '/pc/',
    plugins: [react()],
    build: {
      outDir: path.resolve(__dirname, 'dist-pc'),
      emptyOutDir: true,
      sourcemap: false,
    },
    server: { port: 5175, strictPort: false },
    // 业务层用 process.env.* 读构建期常量（沿用 Taro 时代的写法，避免 services 层为 PC 分叉）。
    define: {
      'process.env.TARO_APP_MODE': JSON.stringify(mode),
      'process.env.TARO_APP_API': JSON.stringify(api),
      'process.env.TARO_APP_STREAM': JSON.stringify(process.env.TARO_APP_STREAM || ''),
      'process.env.TARO_APP_VERSION': JSON.stringify(process.env.TARO_APP_VERSION || pkg.version),
      'process.env.TARO_APP_BUILD_SHA': JSON.stringify(process.env.TARO_APP_BUILD_SHA || gitSha),
      // services 里少数分支用 TARO_ENV 判端；PC 归为 h5（非小程序）。
      'process.env.TARO_ENV': JSON.stringify('h5'),
    },
  };
});
