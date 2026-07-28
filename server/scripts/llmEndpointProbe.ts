/**
 * LLM 端点并发探针 —— 直连上游、绕过我们自己的并发闸，测「供应商到底允许多少并发」。
 *
 *   cd /opt/junshi/server && node --import tsx scripts/llmEndpointProbe.ts [--max-conc 16] [--budget 5]
 *
 * 为什么必须绕过 llmGate：后台给每个端点配的 maxConcurrency=4（两端点合计 8）是**我们自己填的**，
 * 不是实测出来的。走 gateway 只会测到这个自设值，永远问不出上游的真实上限。本探针直接打
 * {baseUrl}/v1/messages，并显式关掉 SDK 重试（用裸 fetch），让 429 / 5xx 原样暴露出来。
 *
 * 安全：密钥经 loadPool() 在进程内解密后只用于请求头，**从不打印**（只输出 sha256 前 8 位用于区分端点）。
 * 花费：每次请求极小 payload（约 20 输入 + ≤8 输出 token）。按 ¥36/¥180 per 1M 算约 ¥0.0016/次，
 *      默认阶梯合计 <200 次 ≈ ¥0.3。--budget 是元为单位的硬上限，预估超了直接不跑。
 */
import { createHash } from 'node:crypto';
// 必须最先 import：secretBox 在**调用时**才读 process.env.APP_ENCRYPTION_KEY，
// 若 dotenv 还没跑，池里的 key 会静默解不开 → endpoints 全被过滤掉 → 探针误报「池内无端点」。
import '../src/env.js';
import { loadPool } from '../src/services/llmPool.js';

const argOf = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const MAX_CONC = argOf('max-conc', 16);
const BUDGET_YUAN = argOf('budget', 5);
const REPEAT = argOf('repeat', 3);        // 每档请求数 = 并发 × repeat
const TIMEOUT_MS = argOf('timeout', 60_000);

const LADDER = [1, 2, 4, 8, 12, 16, 24, 32].filter((c) => c <= MAX_CONC);

const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8);
const pctl = (arr: number[], p: number): number => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

interface Attempt {
  ok: boolean;
  status: number;
  ms: number;
  inTok: number;
  outTok: number;
  err?: string;
  retryAfter?: string;
  rateLimitHeaders?: string;
}

/** 单次极小请求。裸 fetch + 无重试：429/5xx 必须原样可见，被 SDK 悄悄重试掉就白测了。 */
async function oneShot(baseUrl: string, apiKey: string, model: string): Promise<Attempt> {
  const url = `${baseUrl.replace(/\/+$/, '').replace(/\/v1(\/messages)?$/i, '')}/v1/messages`;
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
      }),
    });
    const ms = Date.now() - t0;
    // 上游的限流头是本次探测最值钱的产物：它直接告诉我们真实配额，不必靠二分猜。
    const rl = ['retry-after', 'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining',
      'anthropic-ratelimit-tokens-limit', 'anthropic-ratelimit-tokens-remaining', 'x-ratelimit-limit',
      'x-ratelimit-remaining']
      .map((h) => [h, res.headers.get(h)] as const)
      .filter(([, v]) => v != null)
      .map(([h, v]) => `${h}=${v}`)
      .join(' ');
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, status: res.status, ms, inTok: 0, outTok: 0, err: body,
        retryAfter: res.headers.get('retry-after') ?? undefined, rateLimitHeaders: rl };
    }
    const j = (await res.json()) as { usage?: { input_tokens?: number; output_tokens?: number } };
    return { ok: true, status: res.status, ms,
      inTok: j.usage?.input_tokens ?? 0, outTok: j.usage?.output_tokens ?? 0, rateLimitHeaders: rl };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, inTok: 0, outTok: 0,
      err: (e as Error).name === 'AbortError' ? `timeout>${TIMEOUT_MS}ms` : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 稳态 RPM 探测。并发阶梯只能证明「限的是 RPM 不是并发」，但钉不死配额值——
 * RPM 是滚动窗口，前一档吃掉的额度会让后一档凭空全挂（实测并发 24 那一档 72 个请求 100% 429，
 * 就是被前面几档的余额拖累，跟它自己的并发数无关）。
 * 所以要按固定速率恒速打一段时间，并在档间留够一个窗口让额度回满。
 */
async function rpmProbe(baseUrl: string, apiKey: string, model: string, levels: number[], holdSec: number): Promise<{ inTok: number; outTok: number }> {
  let inTok = 0, outTok = 0;
  console.log(`\n======== 稳态 RPM 探测（每档恒速 ${holdSec}s，档间静默 70s 等滚动窗口回满）========`);
  console.log('目标速率   实发  成功   429   首个 429 出现在   实际达成速率');
  for (const rps of levels) {
    const total = Math.round(rps * holdSec);
    const gapMs = 1000 / rps;
    const started = Date.now();
    const results: Attempt[] = [];
    const inflight: Promise<void>[] = [];
    let first429At: number | null = null;
    for (let i = 0; i < total; i++) {
      // 恒速发射：按绝对时间轴对齐，避免「等上一个回来再发」把速率压成 1/latency。
      const due = started + i * gapMs;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      inflight.push(oneShot(baseUrl, apiKey, model).then((r) => {
        results.push(r);
        if (r.status === 429 && first429At === null) first429At = Date.now() - started;
      }));
    }
    await Promise.all(inflight);
    const wall = (Date.now() - started) / 1000;
    inTok += results.reduce((a, r) => a + r.inTok, 0);
    outTok += results.reduce((a, r) => a + r.outTok, 0);
    const ok = results.filter((r) => r.ok).length;
    const c429 = results.filter((r) => r.status === 429).length;
    console.log(`${rps.toFixed(1).padStart(6)} req/s ${String(total).padStart(5)} ${String(ok).padStart(5)} ${String(c429).padStart(5)}` +
      `   ${first429At === null ? '未出现'.padStart(12) : `${(first429At / 1000).toFixed(1)}s 处`.padStart(13)}` +
      `   ${(ok / wall).toFixed(2)} req/s`);
    if (c429 > 0) {
      // 已经找到会触发限流的速率，再往上没有信息量，只是烧钱。
      console.log(`     >> ${rps} req/s 已触发限流，停止加速`);
      break;
    }
    if (rps !== levels[levels.length - 1]) {
      process.stdout.write('     (静默 70s 等额度回满…)\n');
      await new Promise((r) => setTimeout(r, 70_000));
    }
  }
  return { inTok, outTok };
}

async function main(): Promise<void> {
  const { endpoints, settings } = await loadPool();
  console.log(`路由模式=${settings.mode} 会话粘性=${settings.sticky} 池内端点=${endpoints.length}\n`);
  if (!endpoints.length) {
    console.log('池内无可用端点（routingMode!=pool 或 key 解不开），无法探测。');
    return;
  }

  // 同 baseUrl + 同 key 的多个「端点」其实是一个上游，合并成一个物理目标探测。
  // 否则会把同一条限流通道当成两条，得出错误的冗余结论。
  const physical = new Map<string, { baseUrl: string; apiKey: string; models: string[]; labels: string[] }>();
  for (const e of endpoints) {
    const k = `${e.baseUrl}|${shortHash(e.apiKey)}`;
    const cur = physical.get(k) ?? { baseUrl: e.baseUrl, apiKey: e.apiKey, models: [], labels: [] };
    cur.models.push(e.model);
    cur.labels.push(`${e.label}(conc=${e.maxConcurrency || '不限'})`);
    physical.set(k, cur);
  }
  console.log(`池内 ${endpoints.length} 个逻辑端点 → ${physical.size} 个物理上游（同 baseUrl+同 key 视为一个）`);
  for (const [k, v] of physical) {
    console.log(`  · ${v.baseUrl} key=${k.split('|')[1]} models=[${v.models.join(', ')}] ← ${v.labels.join(' + ')}`);
  }

  const RPM_MODE = process.argv.includes('--rpm');
  const RPM_LEVELS = [1.5, 2, 3, 4];
  const HOLD_SEC = argOf('hold', 60);

  const totalReq = physical.size * (RPM_MODE
    ? RPM_LEVELS.reduce((a, r) => a + Math.round(r * HOLD_SEC), 0)
    : LADDER.reduce((a, c) => a + c * REPEAT, 0));
  const estYuan = totalReq * (20 * 36 + 8 * 180) / 1e6;
  console.log(`\n阶梯 ${LADDER.join('/')} 并发 × ${REPEAT} 轮 → 共 ${totalReq} 次请求，预估花费 ¥${estYuan.toFixed(2)}（上限 ¥${BUDGET_YUAN}）`);
  if (estYuan > BUDGET_YUAN) {
    console.log('预估超预算，不执行。调小 --max-conc / --repeat，或显式提高 --budget。');
    return;
  }

  let spentIn = 0, spentOut = 0;
  for (const [k, up] of physical) {
    const model = up.models[0];
    console.log(`\n======== 上游 ${up.baseUrl} (key=${k.split('|')[1]}, model=${model}) ========`);
    if (RPM_MODE) {
      const t = await rpmProbe(up.baseUrl, up.apiKey, model, RPM_LEVELS, HOLD_SEC);
      spentIn += t.inTok; spentOut += t.outTok;
      continue;
    }
    console.log('并发  请求  成功  latency p50/p95(ms)  非 200 分布');
    let brokeAt: number | null = null;

    for (const conc of LADDER) {
      const n = conc * REPEAT;
      const t0 = Date.now();
      const results: Attempt[] = [];
      // 固定 conc 个 worker 持续取任务：这样在途请求数**恒等于 conc**，
      // 而不是「一次性发 n 个再等」——后者测的是突发，不是稳定并发。
      let next = 0;
      await Promise.all(Array.from({ length: conc }, async () => {
        while (next < n) {
          next += 1;
          results.push(await oneShot(up.baseUrl, up.apiKey, model));
        }
      }));
      const wall = Date.now() - t0;

      const ok = results.filter((r) => r.ok);
      const bad = results.filter((r) => !r.ok);
      spentIn += results.reduce((a, r) => a + r.inTok, 0);
      spentOut += results.reduce((a, r) => a + r.outTok, 0);
      const dist = [...bad.reduce((m, r) => m.set(r.status || 'net', (m.get(r.status || 'net') ?? 0) + 1), new Map())]
        .map(([s, c]) => `${s}×${c}`).join(' ') || '—';
      const lat = ok.map((r) => r.ms);
      console.log(`${String(conc).padStart(3)}  ${String(n).padStart(4)}  ${String(ok.length).padStart(4)}  ` +
        `${String(pctl(lat, 0.5)).padStart(6)}/${String(pctl(lat, 0.95)).padStart(6)}      ${dist}` +
        `   吞吐 ${(n / (wall / 1000)).toFixed(2)} req/s`);

      const rl = results.find((r) => r.rateLimitHeaders)?.rateLimitHeaders;
      if (rl) console.log(`     上游限流头: ${rl}`);
      const sample = bad.find((r) => r.err);
      if (sample) console.log(`     首个失败(${sample.status}): ${String(sample.err).replace(/\s+/g, ' ').slice(0, 160)}`);

      // 一旦失败过半就停止加压：再往上只是烧钱，拐点已经找到了。
      if (bad.length > n / 2) { brokeAt = conc; console.log(`     >> 失败过半，停止加压`); break; }
    }
    console.log(brokeAt ? `结论：并发 ${brokeAt} 已明显不可用（拐点在此之下）` : `结论：到 ${LADDER[LADDER.length - 1]} 并发仍未压出错误`);
  }

  const cost = (spentIn * 36 + spentOut * 180) / 1e6;
  console.log(`\n实际消耗 输入 ${spentIn} / 输出 ${spentOut} token，按后台单价折约 ¥${cost.toFixed(3)}`);
  console.log('PROBE_DONE');
}

main().then(() => process.exit(0)).catch((e) => { console.error('探针失败:', e); process.exit(1); });
