import { useRef } from 'react';
import { WebView } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';

// 通用外链承载页（web-view）：报告网页版 / 分享落地等。
// src 由调用方 encodeURIComponent 传入；报告链接应优先使用自有业务域名 /api/r/:id，避免 OSS 域名未进白名单导致空白。
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default function Webview() {
  const router = useRouter();
  const warned = useRef(false);
  const url = safeDecode((router.params.url as string) || '');
  if (!url) return null;
  return (
    <WebView
      src={url}
      onError={() => {
        if (warned.current) return;
        warned.current = true;
        Taro.setClipboardData({
          data: url,
          success: () => Taro.showModal({ title: '网页暂时打不开', content: '链接已复制，可以在浏览器打开。', showCancel: false }),
          fail: () => Taro.showModal({ title: '网页暂时打不开', content: '请稍后重试。', showCancel: false }),
        });
      }}
    />
  );
}
