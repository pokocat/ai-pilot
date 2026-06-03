import { defineConfig } from '@tarojs/cli';
import devConfig from './dev';
import prodConfig from './prod';

export default defineConfig(async (merge, { command, mode }) => {
  const baseConfig = {
    projectName: 'junshi-app',
    date: '2026-6-1',
    // 原型按 ~390px 手机设计；设计稿基准设为 375，px → rpx 自动换算
    designWidth: 375,
    deviceRatio: { 640: 2.34 / 2, 750: 1, 375: 2 / 1, 828: 1.81 / 2 },
    sourceRoot: 'src',
    outputRoot: 'dist',
    plugins: [],
    defineConstants: {},
    copy: { patterns: [], options: {} },
    framework: 'react',
    compiler: { type: 'webpack5', prebundle: { enable: false } },
    cache: { enable: false },
    sass: {
      resource: [],
    },
    mini: {
      postcss: {
        pxtransform: { enable: true, config: {} },
        cssModules: { enable: false },
      },
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
    },
  };

  if (process.env.NODE_ENV === 'development') {
    return merge({}, baseConfig, devConfig);
  }
  return merge({}, baseConfig, prodConfig);
});
