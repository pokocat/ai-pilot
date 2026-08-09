# 自带中文衬线字体

`junshi-serif-{400,600}.woff2` = **思源宋体 SC（Noto Serif SC）子集**，SIL Open Font License 1.1，可商用。

- 字表：GB2312 一级汉字 3755 字 ∪ 仓库里 UI 文案实际用到的汉字 ∪ ASCII/拉丁/CJK 标点/带圈数字/几何符号，合计 5743 字形。
- 两个字重对应设计里的正文（400）与标题（600）；只发这两个，其余字重由渲染器就近取。
- 生成方式见 `docs/DEPLOYMENT.md`「自带字体」；改字表就重新子集化后替换本目录，**不要**手工编辑。

## 为什么放在仓库里、而不是 OSS

字体在浏览器里是 CORS 资源，跨域托管必须给桶配 `Access-Control-Allow-Origin`。
放在这里 → 随 H5 产物发到 `https://域名/fonts/`，与页面同源，**没有 CORS 这回事**；
小程序 `wx.loadFontFace` 也指向同一个 URL（该域名需在微信后台 `downloadFile` 合法域名里）。
