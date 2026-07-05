import path from 'path';
import { defineConfig } from '@tarojs/cli';
import devConfig from './dev';
import prodConfig from './prod';

export default defineConfig(async (merge, { command, mode }) => {
  const taroAppMode = process.env.TARO_APP_MODE || 'mock';
  const taroAppApi = process.env.TARO_APP_API || '';
  const taroAppStream = process.env.TARO_APP_STREAM || ''; // P1-B3：聊天流式开关，须注入 defineConstants 否则运行期 process 未定义

  // 生产（server 模式）把 './mock' 换成空桩：874 行 mock 假数据不进生产包（IS_MOCK 恒 false，运行时用不到）。
  const stripMock = (chain: { plugin: (n: string) => { use: (p: unknown, a: unknown[]) => void } }) => {
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
    outputRoot: 'dist',
    plugins: [],
    defineConstants: {
      'process.env.TARO_APP_MODE': JSON.stringify(taroAppMode),
      'process.env.TARO_APP_API': JSON.stringify(taroAppApi),
      'process.env.TARO_APP_STREAM': JSON.stringify(taroAppStream),
    },
    copy: { patterns: [], options: {} },
    framework: 'react',
    compiler: { type: 'webpack5', prebundle: { enable: false } },
    cache: { enable: true },
    sass: {
      resource: [],
    },
    mini: {
      postcss: {
        pxtransform: { enable: true, config: {} },
        cssModules: { enable: false },
      },
      webpackChain: stripMock,
    },
    h5: {
      publicPath: '/',
      staticDirectory: 'static',
      // hash 路由：dist/ 可被任意静态服务器直接打开，无需 SPA 回退配置（便于本地 H5 测试）
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
