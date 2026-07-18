import { View, Text, WebView } from '@tarojs/components';
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

// 只放行 http(s) 外链，其余（空/非法/javascript: 等）一律视为无效，给友好占位而非白屏。
function isValidUrl(u: string): boolean {
  return /^https?:\/\/.+/i.test(u);
}

export default function Webview() {
  const router = useRouter();
  const url = safeDecode((router.params.url as string) || '');

  // D6：空/非法 url 不再 return null 造成白屏——给友好占位 + 返回按钮。
  if (!isValidUrl(url)) {
    return (
      <View className="wv-empty" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 40px', boxSizing: 'border-box', background: 'var(--bg)' }}>
        <Text style={{ fontSize: '15px', fontWeight: 600, color: 'var(--ink)' }}>网页地址无效</Text>
        <Text style={{ marginTop: '8px', fontSize: '12.5px', lineHeight: 1.6, color: 'var(--ink-3)', textAlign: 'center' }}>没有拿到有效的网页链接，可能是入口已过期。返回上一页再试一次。</Text>
        <View
          onClick={() => { if (Taro.getCurrentPages().length > 1) Taro.navigateBack(); else Taro.switchTab({ url: '/pages/home/index' }).catch(() => {}); }}
          style={{ marginTop: '20px', height: '40px', padding: '0 24px', borderRadius: '10px', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 600, color: 'var(--ink)' }}
        >
          <Text>返回</Text>
        </View>
      </View>
    );
  }

  return (
    <WebView
      src={url}
      onError={() => {
        Taro.showToast({ title: '网页打开失败，请稍后重试', icon: 'none' });
      }}
    />
  );
}
