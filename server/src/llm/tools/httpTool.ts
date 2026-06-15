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

function isPrivateIp(ip: string): boolean {
  if (ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip)) return true; // IPv6 loopback/ULA/link-local
  const v4 = ip.replace(/^::ffff:/i, '');
  const p = v4.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  const [a, b] = p;
  if (a === 0 || a === 127) return true;            // 0.0.0.0/8, loopback
  if (a === 10) return true;                         // 10/8
  if (a === 192 && b === 168) return true;           // 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
  if (a === 169 && b === 254) return true;           // link-local + 169.254.169.254 metadata
  if (a === 100 && b === 100) return true;           // aliyun metadata 100.100.100.200
  return false;
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
  else addrs = (await lookup(host, { all: true })).map((r) => r.address);
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
        if (!res.ok) return `（工具调用失败 HTTP ${res.status}）${text.slice(0, 200)}`;
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
