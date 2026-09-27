// 运营自建技能：把一个「自定义 HTTP 工具」定义包成可被模型调用的 Tool。
// 安全：SSRF 防护（默认拒私网/环回/云元数据）、超时、响应截断。
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { env } from '../../env.js';
import type { Tool } from './types.js';

const RESP_MAX = 4000;

/** DB 行解码后的运行时定义（headers 含明文，仅服务端内部用）。 */
export interface HttpToolDef {
  key: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  httpMethod: string; // GET | POST
  httpUrl: string;
  headers: Record<string, string>;
  argsLocation: string; // body | query
}

function isPrivateV4(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // 解析异常 → 拒（fail-closed）
  if (a === 0 || a === 127) return true;            // 0.0.0.0/8, loopback
  if (a === 10) return true;                         // 10/8
  if (a === 192 && b === 168) return true;           // 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
  if (a === 169 && b === 254) return true;           // link-local + 169.254.169.254 metadata
  if (a === 100 && b === 100) return true;           // aliyun metadata 100.100.100.200
  return false;
}

/**
 * 把任意文本形式的 IPv6（压缩 `::` / 完整展开 / 内嵌 IPv4）解析成 128-bit BigInt；
 * 无法解析返回 null。用数值判定能覆盖同一地址的所有写法 —— 之前的实现只认
 * 点分的 `::ffff:127.0.0.1`，认不出等价的十六进制 `::ffff:7f00:1`（= 127.0.0.1）
 * 或 `::ffff:a9fe:a9fe`（= 169.254.169.254 云元数据），这类写法会被当成公网放行（SSRF）。
 */
function ipv6ToBigInt(ip: string): bigint | null {
  let s = ip.toLowerCase().split('%')[0]; // 去掉 zone id（如 fe80::1%eth0）
  const dotted = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const q = dotted[2].split('.').map(Number);
    if (q.some((n) => Number.isNaN(n) || n > 255)) return null;
    const hi = ((q[0] << 8) | q[1]).toString(16);
    const lo = ((q[2] << 8) | q[3]).toString(16);
    s = dotted[1] + hi + ':' + lo; // 把尾部点分 IPv4 折成两段十六进制
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups: string[];
  if (tail === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b, c, d] = ip.split('.').map(Number);
    return isPrivateV4(a, b, c, d);
  }
  if (kind === 6) {
    const n = ipv6ToBigInt(ip);
    if (n === null) return true;               // 解析不了 → 拒（fail-closed）
    if (n === 0n || n === 1n) return true;     // :: 未指定 / ::1 环回
    if (((n >> 120n) & 0xfen) === 0xfcn) return true; // fc00::/7 ULA
    if ((n >> 118n) === 0x3fan) return true;   // fe80::/10 link-local
    const hi96 = n >> 32n;
    let v4: number | null = null;
    if (hi96 === 0xffffn) v4 = Number(n & 0xffffffffn);            // ::ffff:0:0/96 IPv4-mapped
    else if (hi96 === (0x64ff9bn << 64n)) v4 = Number(n & 0xffffffffn); // 64:ff9b::/96 NAT64（前缀在高位）
    else if (hi96 === 0n) v4 = Number(n & 0xffffffffn);            // ::/96 IPv4-compatible（已弃用，一并拦）
    if (v4 !== null) return isPrivateV4((v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff);
    return false;
  }
  return false; // 非 IP 字面（调用点已 isIP 过滤，理论上不会到这里）
}

/** 校验目标 URL：仅 http/https；未放开时拒私网（含 DNS 解析后的地址）。 */
export async function assertSafeUrl(raw: string): Promise<void> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('非法 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https');
  if (env.skillToolAllowPrivateNet) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else if (/^localhost$/i.test(host)) throw new Error('目标指向内网/环回，已拒绝');
  else {
    // DNS 解析加 5s 超时防 DNS-hang 攻击（无超时时 lookup() 可永久阻塞）。
    const dnsTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('DNS 解析超时，已拒绝')), 5000),
    );
    addrs = await Promise.race([
      lookup(host, { all: true }).then((rs) => rs.map((r) => r.address)),
      dnsTimeout,
    ]);
  }
  for (const a of addrs) if (isPrivateIp(a)) throw new Error('目标指向内网/环回，已拒绝');
}

/** 把自定义 HTTP 工具定义包成 Tool；run 时发请求并把响应文本喂回模型。 */
export function makeHttpTool(def: HttpToolDef): Tool {
  return {
    name: def.key,
    description: def.description,
    inputSchema: def.inputSchema,
    async run(args, ctx) {
      try {
        await assertSafeUrl(def.httpUrl);
      } catch (err) {
        return `（工具「${def.key}」配置错误：${(err as Error).message}）`;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), env.skillToolTimeoutMs);
      try {
        const method = def.httpMethod === 'GET' ? 'GET' : 'POST';
        const headers: Record<string, string> = { ...def.headers };
        // 自动注入身份头，外部 API 可据此做数据隔离/鉴权。
        if (ctx.tenantId) headers['X-Tenant-Id'] = ctx.tenantId;
        if (ctx.userId) headers['X-User-Id'] = ctx.userId;
        headers['X-Agent-Key'] = ctx.agentKey;

        let url = def.httpUrl;
        let body: string | undefined;
        if (method === 'GET' || def.argsLocation === 'query') {
          const u = new URL(url);
          for (const [k, v] of Object.entries(args ?? {})) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
          url = u.toString();
        } else {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(args ?? {});
        }

        const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
        const text = (await res.text().catch(() => '')) || '';
        // 不把原始错误体返回给 LLM，避免泄露上游服务内部信息。
        if (!res.ok) return `（工具调用失败 HTTP ${res.status}，请稍后重试）`;
        return text.length > RESP_MAX ? text.slice(0, RESP_MAX) + '…' : text || '（工具返回空）';
      } catch (err) {
        const aborted = /abort/i.test((err as Error).message);
        return `（工具调用${aborted ? '超时' : '异常'}：${(err as Error).message}）`;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
