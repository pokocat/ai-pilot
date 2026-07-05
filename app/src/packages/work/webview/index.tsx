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
  const url = safeDecode((router.params.url as string) || '');
  if (!url) return null;
  return (
    <WebView
      src={url}
      onError={() => {
        Taro.showToast({ title: '网页打开失败，请稍后重试', icon: 'none' });
      }}
    />
  );
}
