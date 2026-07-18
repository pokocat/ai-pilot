// SVG → data-URI 背景，跨端稳态方案。
//
// 为什么用 base64 而非 URL 编码：
//   `background-image: url("data:image/svg+xml,<encodeURIComponent...>")` 在微信小程序真机
//   （尤其 iOS WKWebView）经常整块不渲染——这正是「军情雷达 / 主公算力环 / 线性图标」在
//   weapp 上空白、界面像「毛坯房」的直接原因。改用 `;base64,` 形式后 weapp 稳定可渲染。
// 为什么手写 base64：weapp 运行时没有 `btoa`；SVG 全为 ASCII，手写编码器 h5/weapp 通用。

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Ascii(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 3) {
    const a = input.charCodeAt(i);
    const b = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN;
    const c = i + 2 < input.length ? input.charCodeAt(i + 2) : NaN;
    const e1 = a >> 2;
    const e2 = ((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4);
    const e3 = Number.isNaN(b) ? 64 : (((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6));
    const e4 = Number.isNaN(c) ? 64 : (c & 63);
    out += B64[e1] + B64[e2] + (e3 === 64 ? '=' : B64[e3]) + (e4 === 64 ? '=' : B64[e4]);
  }
  return out;
}

// SVG 字符串 → base64 data-URI。含多字节码点（>0xFF）时回退 URL 编码
// （本项目 SVG 均为单行 ASCII，中文标签一律用 <Text> 外置叠加，不进 SVG）。
export function svgToDataUri(svg: string): string {
  for (let i = 0; i < svg.length; i += 1) {
    if (svg.charCodeAt(i) > 0xff) return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
  return `data:image/svg+xml;base64,${base64Ascii(svg)}`;
}
