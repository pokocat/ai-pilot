// 军师记忆库（P2）：把用户级共享事实池按六类结构化，供主公档案页「军师记事」呈现。
// strategy 类合并 StrategicProfile 已确认战略事实（复用既有结构化档案，不重复造轮子）。

import { prisma } from '../db.js';
import { loadStrategicProfile } from './strategicProfile.js';
import { MEMORY_CATEGORIES } from '../llm/gateway.js';
import type { MemoryLibraryView, MemoryLibraryGroup, MemoryLibraryEntry, MemoryFillLevel } from '../../../shared/contracts';

const ENTRY_LIMIT = 8;

function fillLevel(count: number, settled: boolean): MemoryFillLevel {
  if (settled) return 'settled';
  if (count === 0) return 'unknown';
  if (count >= 3) return 'known';
  return 'thin';
}

export async function buildMemoryLibrary(userId: string): Promise<MemoryLibraryView> {
  const now = new Date();
  const rows = await prisma.memory.findMany({
    where: { userId, category: { not: null }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
    take: 200,
    select: { id: true, text: true, category: true, source: true, createdAt: true },
  });

  const byCat = new Map<string, MemoryLibraryEntry[]>();
  for (const r of rows) {
    const c = r.category as string;
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push({ id: r.id, text: r.text, source: r.source });
  }

  // strategy 类合并已确认战略事实（排在对话记忆之前）。
  const strategic = await loadStrategicProfile(userId).catch(() => null);
  const strategicEntries: MemoryLibraryEntry[] = [];
  if (strategic) {
    if (strategic.mainContradiction) strategicEntries.push({ id: 'sp-mc', text: `主要矛盾：${strategic.mainContradiction}`, source: 'strategic' });
    if (strategic.positioning) strategicEntries.push({ id: 'sp-pos', text: `战略定位：${strategic.positioning}`, source: 'strategic' });
    if (strategic.track) strategicEntries.push({ id: 'sp-track', text: `聚焦赛道：${strategic.track}`, source: 'strategic' });
    if (strategic.stage) strategicEntries.push({ id: 'sp-stage', text: `当前阶段：${strategic.stage}`, source: 'strategic' });
  }

  const groups: MemoryLibraryGroup[] = MEMORY_CATEGORIES.map((cat) => {
    const mems = byCat.get(cat) ?? [];
    if (cat === 'strategy') {
      const entries = [...strategicEntries, ...mems].slice(0, ENTRY_LIMIT);
      return { category: cat, fill: fillLevel(entries.length, strategicEntries.length > 0), entries };
    }
    const entries = mems.slice(0, ENTRY_LIMIT);
    return { category: cat, fill: fillLevel(entries.length, false), entries };
  });

  const total = rows.length + strategicEntries.length;
  const updatedAt = rows[0]?.createdAt?.toISOString() ?? strategic?.updatedAt ?? null;
  return { total, groups, updatedAt };
}
