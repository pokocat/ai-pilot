import { WebView } from '@tarojs/components';
import { useRouter } from '@tarojs/taro';

// 通用外链承载页（web-view）：报告网页版 / 分享落地等。
// src 由调用方 encodeURIComponent 传入；weapp 需在「业务域名」白名单里加 OSS/后端域名，否则加载空白。
export default function Webview() {
  const router = useRouter();
  const url = decodeURIComponent((router.params.url as string) || '');
  if (!url) return null;
  return <WebView src={url} />;
}
