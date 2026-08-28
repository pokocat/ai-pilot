/**
 * 闸门 A 的统计口径实现。
 *
 * 百分位算法按协议 §1.4 写死：线性插值法（等价 Excel PERCENTILE.INC /
 * numpy percentile(method='linear')），而且**先合并再算** ——
 * 一个格子里所有跑次的样本并成一个池子算一次 P95，不是每跑一次算个 P95 再平均，
 * 后者会把长尾抹掉。
 *
 * 判据线按协议 §2.4（在方案 §11.0 基础上补了 max 线）。
 * §2.5 那两条修订建议（163 秒 ≤ 400ms、任意 15 秒滑窗 ≤ 125ms）尚未拍板，
 * 这里**一并算出来但单独标注**，不混进过/不过的判定。
 */

/** 线性插值百分位。p 用 0–100。 */
function percentile(values, p) {
  const a = values.filter((v) => typeof v === 'number' && isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  if (a.length === 1) return a[0];
  const rank = (p / 100) * (a.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (rank - lo);
}

function maxOf(values) {
  const a = values.filter((v) => typeof v === 'number' && isFinite(v));
  return a.length ? Math.max.apply(null, a) : null;
}

/**
 * 漂移曲线上任意 15 秒滑窗内的漂移变化幅度。
 * 口型是局部判断，用户不看总账 —— 这条才是「口播对不对得上」（§2.5）。
 * 取窗内 max−min，而不是窗内绝对值，因为恒定偏移可以整体校准掉，
 * 窗内的**变化**才是看得出来的不同步。
 */
function maxWindowSwing(series, windowSec) {
  if (!series || series.length < 2) return null;
  let worst = 0;
  for (let i = 0; i < series.length; i++) {
    let lo = series[i].d;
    let hi = series[i].d;
    for (let j = i + 1; j < series.length; j++) {
      if (series[j].t - series[i].t > windowSec) break;
      if (series[j].d < lo) lo = series[j].d;
      if (series[j].d > hi) hi = series[j].d;
    }
    if (hi - lo > worst) worst = hi - lo;
  }
  return worst;
}

/** 取漂移曲线上最接近 atSec 的一个采样点。 */
function driftAt(series, atSec) {
  if (!series || !series.length) return null;
  let best = series[0];
  for (const s of series) {
    if (Math.abs(s.t - atSec) < Math.abs(best.t - atSec)) best = s;
  }
  return Math.abs(best.t - atSec) <= 2 ? best.d : null;
}

const LINES = {
  gapP95: 150, gapMax: 400,
  firstFrameP95: 1500, firstFrameMax: 3000,
  drift45: 200,
  // 以下两条是 §2.5 的修订建议，未拍板，不参与判定
  proposedDrift163: 400,
  proposedWindow15: 125,
};

function summarize(raw) {
  const gaps = raw.gaps || [];
  const drift = raw.drift || [];
  const first = raw.firstFrame || [];

  const gapP95 = percentile(gaps, 95);
  const gapMax = maxOf(gaps);
  const ffP95 = percentile(first, 95);
  const ffMax = maxOf(first);
  const d45 = driftAt(drift, 45);
  const d163 = driftAt(drift, 163);
  const swing15 = maxWindowSwing(drift, 15);

  const checks = [
    mk('切换间隙 P95', gapP95, LINES.gapP95, 'ms'),
    mk('切换间隙 max', gapMax, LINES.gapMax, 'ms'),
    mk('首帧起播 P95', ffP95, LINES.firstFrameP95, 'ms'),
    mk('首帧起播 max', ffMax, LINES.firstFrameMax, 'ms'),
    mk('45 秒累计漂移', d45 === null ? null : Math.abs(d45), LINES.drift45, 'ms'),
    mk('崩溃 / OOM', raw.crashes || 0, 0, '次'),
  ];
  const proposed = [
    mk('163 秒累计漂移', d163 === null ? null : Math.abs(d163), LINES.proposedDrift163, 'ms'),
    mk('任意 15 秒滑窗漂移', swing15, LINES.proposedWindow15, 'ms'),
  ];

  const measured = checks.filter((c) => c.value !== null);
  const rate = raw.rate || [];
  return {
    checks, proposed,
    rate: rate.length ? { median: percentile(rate, 50), min: Math.min.apply(null, rate), n: rate.length } : null,
    passed: measured.length === checks.length && measured.every((c) => c.ok),
    incomplete: measured.length !== checks.length,
    counts: { gaps: gaps.length, drift: drift.length, firstFrame: first.length },
    series: drift,
  };
}

function mk(name, value, line, unit) {
  const v = value === null || value === undefined ? null : Math.round(value * 10) / 10;
  return { name, value: v, line, unit, ok: v === null ? null : v <= line };
}

module.exports = { percentile, maxOf, maxWindowSwing, driftAt, summarize, LINES };
