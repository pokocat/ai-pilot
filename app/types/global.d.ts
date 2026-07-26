/// <reference types="@tarojs/taro" />

declare module '*.png';
declare module '*.gif';
declare module '*.jpg';
declare module '*.jpeg';
declare module '*.svg';
declare module '*.css';
declare module '*.scss';

declare const defineAppConfig: (config: any) => any;
declare const definePageConfig: (config: any) => any;

declare namespace NodeJS {
  interface ProcessEnv {
    TARO_ENV: 'weapp' | 'h5' | string;
    TARO_APP_API?: string;
    TARO_APP_MODE?: 'mock' | 'server';
    TARO_APP_STREAM?: string;
    TARO_APP_VERSION?: string;
    TARO_APP_BUILD_SHA?: string;
    NODE_ENV: 'development' | 'production';
  }
}
