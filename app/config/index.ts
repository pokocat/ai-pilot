import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { defineConfig } from '@tarojs/cli';
import devConfig from './dev';
import prodConfig from './prod';

export default defineConfig(async (merge) => {
  const taroEnv = process.env.TARO_ENV;
  if (taroEnv && taroEnv !== 'h5') {
    throw new Error(`Taro 仅保留 H5 构建；${taroEnv} 请使用 scripts/build-native-weapp.mjs。`);
  }
  const taroAppMode = process.env.TARO_APP_MODE || 'mock';
  const taroAppApi = process.env.TARO_APP_API || '';
  const taroAppStream = process.env.TARO_APP_STREAM || ''; // P1-B3：聊天流式开关，须注入 defineConstants 否则运行期 process 未定义
  const packageVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version as string;
  const taroAppVersion = process.env.TARO_APP_VERSION || packageVersion;
  const gitSha = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
      }).trim();
    } catch {
      return 'unknown';
    }
  })();
  const taroAppBuildSha = process.env.TARO_APP_BUILD_SHA || gitSha;

  type WebpackChain = { plugin: (n: string) => { use: (p: unknown, a?: unknown[]) => void } };

  // 生产（server 模式）把 './mock' 换成空桩：874 行 mock 假数据不进生产包（IS_MOCK 恒 false，运行时用不到）。
  const stripMock = (chain: WebpackChain) => {
    if (taroAppMode !== 'server') return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const webpack = require('webpack');
    chain.plugin('strip-mock').use(webpack.NormalModuleReplacementPlugin, [
      /^\.\/mock$/,
      path.resolve(__dirname, '../src/services/mock.stub.ts'),
    ]);
  };

  const baseConfig = {
    projectName: 'junshi-app',
    date: '2026-6-1',
    // 原型按 ~390px 手机设计；设计稿基准设为 375，px → rpx 自动换算
    designWidth: 375,
    deviceRatio: { 640: 2.34 / 2, 750: 1, 375: 2 / 1, 828: 1.81 / 2 },
    sourceRoot: 'src',
    // 微信端已迁移到 weapp-native → dist-native；Taro 仅保留 H5，产物必须物理隔离。
    outputRoot: 'dist-h5',
    plugins: [],
    defineConstants: {
      'process.env.TARO_APP_MODE': JSON.stringify(taroAppMode),
      'process.env.TARO_APP_API': JSON.stringify(taroAppApi),
      'process.env.TARO_APP_STREAM': JSON.stringify(taroAppStream),
      'process.env.TARO_APP_VERSION': JSON.stringify(taroAppVersion),
      'process.env.TARO_APP_BUILD_SHA': JSON.stringify(taroAppBuildSha),
    },
    copy: { patterns: [], options: {} },
    framework: 'react',
    compiler: { type: 'webpack5', prebundle: { enable: false } },
    cache: { enable: true },
    sass: {
      resource: [],
    },
    h5: {
      publicPath: '/',
      staticDirectory: 'static',
      // hash 路由：dist-h5/ 可被任意静态服务器直接打开，无需 SPA 回退配置（便于本地 H5 测试）
      router: { mode: 'hash' },
      esnextModules: ['@tarojs'],
      postcss: {
        autoprefixer: { enable: true, config: {} },
        cssModules: { enable: false },
      },
      webpackChain: stripMock,
    },
  };

  if (process.env.NODE_ENV === 'development') {
    return merge({}, baseConfig, devConfig);
  }
  return merge({}, baseConfig, prodConfig);
});
