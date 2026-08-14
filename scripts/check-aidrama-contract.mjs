#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/check-aidrama-contract.mjs
//
// 校验 server 代理到 AIStarEcosystem 的每一个上游路径，在对面的 specs/openapi.yaml
// 里既有 path 又有匹配的 method。
//
// 为什么需要它：对面仓的 check:api-contract 只扫它自己的 6 个 web app 根，扫不到
// 我们这边。结果是 GET /me/clip/assets/storage 这个只有军师小程序在调的端点，在对面
// 的 openapi.yaml 里长期根本没有条目——两边的检查各扫各的，中间这条缝没人看。
//
// 跨仓库，所以 spec 的位置按顺序找：
//   1. 环境变量 AIDRAMA_SPEC
//   2. ../AIStarEcosystem/specs/openapi.yaml（与本仓同级的默认布局）
// 都找不到就**跳过并明说**（退出 0）——CI 只 checkout 本仓，硬失败等于逼所有人配
// 一个它拿不到的文件；但只要 spec 在，漂移就是硬失败。
//
// 用法：
//   node scripts/check-aidrama-contract.mjs
//   npm run check:aidrama-contract
//   AIDRAMA_SPEC=/path/to/openapi.yaml npm run check:aidrama-contract
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
/** 代理调用点。新增走 aidramaGateway 的文件时加进来。 */
const SOURCES = ["server/src/routes/video.ts"];
/** 上游 base：调用点写 /api/me/clip/…，spec 里的 path 是去掉 /api 之后的。 */
const API_PREFIX = "/api";

function findSpec() {
  const candidates = [
    process.env.AIDRAMA_SPEC,
    join(REPO_ROOT, "../AIStarEcosystem/specs/openapi.yaml"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ── 1. 提取代理调用点 ───────────────────────────────────────────────────────

/** 从 open 的下一个字符开始配平扫描，返回收尾括号的下标。 */
function balancedEnd(src, from, open, close) {
  let depth = 1;
  let i = from;
  while (i < src.length && depth > 0) {
    if (src[i] === open) depth += 1;
    else if (src[i] === close) depth -= 1;
    i += 1;
  }
  return i - 1;
}

/**
 * for (const action of ['preview-voice', 'estimate'] as const) 这种循环里注册的路由，
 * 路径里的 ${action} 不是路径参数而是常量枚举，必须展开成多条真实路径来比对，
 * 否则会被当成 {action} 通配，静默漏掉。
 */
function loopConstants(src) {
  const out = new Map();
  const re = /for\s*\(\s*const\s+(\w+)\s+of\s*\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const values = [...m[2].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
    if (values.length) out.set(m[1], values);
  }
  return out;
}

/** `${enc(req.params.id)}` → `{id}`：取表达式里最后一个标识符当参数名。 */
function normalize(raw) {
  return raw.replace(/\$\{([^}]*)\}/g, (_, expr) => {
    const words = expr.match(/[a-zA-Z_]\w*/g);
    return `{${words ? words[words.length - 1] : "var"}}`;
  });
}

function extractCalls() {
  const calls = [];
  for (const rel of SOURCES) {
    const src = readFileSync(join(REPO_ROOT, rel), "utf8");
    const constants = loopConstants(src);
    const re = /aidrama(Json|Upload)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const open = src.indexOf("(", m.index);
      if (open < 0) continue;
      const args = src.slice(open + 1, balancedEnd(src, open + 1, "(", ")"));
      const literal = args.match(/^\s*(['"`])([^'"`]+)\1/);
      if (!literal) continue; // import 语句等非调用点

      // aidramaUpload 恒为 POST；aidramaJson 不写 method 时默认 GET。
      const declared = args.match(/method:\s*['"]([A-Z]+)['"]/);
      const method = m[1] === "Upload" ? "POST" : (declared?.[1] ?? "GET");

      // 先展开循环常量，再把剩下的 ${…} 归一成 {param}
      let variants = [literal[2]];
      for (const [name, values] of constants) {
        if (!variants.some((v) => v.includes("${" + name + "}"))) continue;
        variants = variants.flatMap((v) =>
          values.map((value) => v.replaceAll("${" + name + "}", value)),
        );
      }
      for (const variant of variants) {
        const path = normalize(variant);
        if (!path.startsWith(API_PREFIX + "/")) continue; // 非上游调用
        calls.push({ file: rel, method, path: path.slice(API_PREFIX.length) });
      }
    }
  }
  return calls;
}

// ── 2. 提取 openapi.yaml 的 path × method（与对面 check-api-contract.mjs 同法） ──

function extractOpenapi(specPath) {
  const methodsByPath = new Map();
  let inPaths = false;
  let current = null;
  for (const line of readFileSync(specPath, "utf8").split("\n")) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (inPaths && /^[a-zA-Z]/.test(line)) break;
    if (!inPaths) continue;

    const pm = line.match(/^ {2}(\/[^:\s]+):\s*(.*)$/);
    if (pm) {
      current = pm[1];
      if (!methodsByPath.has(current)) methodsByPath.set(current, new Set());
      for (const mm of (pm[2] || "").matchAll(/\b(get|post|put|patch|delete):/g)) {
        methodsByPath.get(current).add(mm[1].toUpperCase());
      }
      continue;
    }
    if (!current) continue;
    const mm = line.match(/^ {4}(get|post|put|patch|delete):/);
    if (mm) methodsByPath.get(current).add(mm[1].toUpperCase());
  }
  return methodsByPath;
}

function matchPath(callPath, paths) {
  if (paths.has(callPath)) return callPath;
  for (const p of paths) {
    if (!p.includes("{")) continue;
    const re = new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+").replace(/\//g, "\\/") + "$");
    if (re.test(callPath)) return p;
  }
  return null;
}

// ── 3. 比对 ─────────────────────────────────────────────────────────────────

function main() {
  console.log("─".repeat(72));
  console.log("AIStarEcosystem 代理契约校验");

  const specPath = findSpec();
  if (!specPath) {
    console.log("─".repeat(72));
    console.log("\n⏭  跳过：找不到对面的 openapi.yaml。");
    console.log("    找过：$AIDRAMA_SPEC 与 ../AIStarEcosystem/specs/openapi.yaml");
    console.log("    本仓 CI 只 checkout 自己，拿不到对面的 spec，属预期跳过；");
    console.log("    本地两仓同级 clone 时它会自动生效。\n");
    return;
  }

  const calls = extractCalls();
  const methodsByPath = extractOpenapi(specPath);
  const paths = new Set(methodsByPath.keys());

  console.log(`  Spec  : ${specPath}`);
  console.log(`  Calls : ${calls.length} 个代理调用点，来自 ${SOURCES.length} 个文件`);
  console.log("─".repeat(72));

  const missingPath = [];
  const missingMethod = [];
  for (const c of calls) {
    const hit = matchPath(c.path, paths);
    if (!hit) { missingPath.push(c); continue; }
    const methods = methodsByPath.get(hit) ?? new Set();
    if (!methods.has(c.method)) {
      missingMethod.push({ ...c, openapiPath: hit, openapiMethods: [...methods] });
    }
  }

  if (missingPath.length === 0) {
    console.log("\n✓  每个上游路径在 openapi.yaml 里都有条目。");
  } else {
    console.log(`\n❌  openapi.yaml 缺 path (${missingPath.length}):`);
    for (const c of missingPath) console.log(`     ${c.method} ${c.path}   ← ${c.file}`);
  }

  if (missingMethod.length === 0) {
    console.log("\n✓  每个上游 method 都在对应 path 上有定义。");
  } else {
    console.log(`\n❌  openapi.yaml 缺 method (${missingMethod.length}):`);
    for (const c of missingMethod) {
      console.log(
        `     ${c.method} ${c.openapiPath}  (spec 只有: ${c.openapiMethods.sort().join(",") || "none"})   ← ${c.file}`,
      );
    }
  }

  console.log();
  if (missingPath.length || missingMethod.length) {
    console.error(
      `FAIL: 缺 ${missingPath.length} 个 path、${missingMethod.length} 个 method。` +
        "去 AIStarEcosystem/specs/openapi.yaml 补齐——代理在调的端点，spec 里必须写着。",
    );
    process.exit(1);
  }
  console.log("OK.");
}

main();
