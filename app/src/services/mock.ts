import Taro from '@tarojs/taro';
import type {
  Agent, Me, LoginResult, SurveyQuestion, Profile, TodaySaying,
  SessionItem, SessionDetail, SessionMessage, GenRequest, GenResult,
  Deliverable, LibItem, SaveLibRequest,
} from '../../../shared/contracts';
import { DEFAULT_AGENTS } from '../data/agents';
import { DELIVERABLES, REPLIES, TRUST_NOTE } from '../data/deliverables';
import { agentForText } from '../data/intents';
import { getToken } from './token';

// ── mock 静态数据源（与后端 seed 对齐） ──
const SURVEY: SurveyQuestion[] = [
  { key: 'industry', title: '你的行业？', options: ['SaaS / 软件', '消费 / 零售', '制造', '服务 / 咨询', '其他'] },
  { key: 'stage', title: '当前阶段？', options: ['起步 / 验证', 'A 轮前后', '规模化', '稳定盈利'] },
  { key: 'pain', title: '最头疼的事？', options: ['增长乏力', '现金流', '融资', '组织 / 团队', '定位 / 竞争'] },
];
const SAYINGS = [
  '先把自己<em>立于不败</em>，再等对手露出破绽。',
  '组织的上限，往往是<em>创始人认知</em>的上限。',
  '现金流是<em>呼吸</em>，利润才是<em>体格</em>。',
  '战略的本质，是学会<em>放弃</em>。',
];

// ── 每账号(token)隔离、落 Taro storage 的内存库 ──
interface SessionRec {
  id: string; agentKey: string; title: string;
  createdAt: string; updatedAt: string;
  messages: SessionMessage[];
}
interface UserData {
  name: string; phone: string; benmingColor: string; onboarded: boolean;
  profile: Profile | null; sessions: SessionRec[]; library: LibItem[];
}

const uid = (p = '') => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const now = () => new Date().toISOString();
const dataKey = (token: string) => `mock.data.${token}`;

function load(token: string): UserData {
  try {
    const raw = Taro.getStorageSync(dataKey(token));
    if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { /* noop */ }
  const phone = token.replace(/^(mock-|local-)/, '');
  return { name: `用户${phone.slice(-4)}`, phone, benmingColor: 'gold', onboarded: false, profile: null, sessions: [], library: [] };
}
function save(token: string, d: UserData) {
  try { Taro.setStorageSync(dataKey(token), JSON.stringify(d)); } catch { /* noop */ }
}
function current(): { token: string; d: UserData } {
  const token = getToken();
  return { token, d: load(token) };
}

const agentOf = (key: string): Agent =>
  DEFAULT_AGENTS.find((a) => a.key === key) || DEFAULT_AGENTS.find((a) => a.key === 'general')!;

function metaOf(d: UserData): string {
  return d.profile?.industry ? `云栖科技 · ${d.profile.industry}` : '云栖科技 · 已就绪';
}

function buildDeliverable(deliverableKey: string, d: UserData): Deliverable {
  const tpl = DELIVERABLES[deliverableKey] ?? DELIVERABLES['战略体检'];
  const pain = d.profile?.pain || '增长与盈利';
  return {
    title: tpl.title,
    icon: tpl.icon,
    meta: metaOf(d),
    sections: tpl.sections.map((s) => ({ h: s.h, b: s.b ? s.b.replaceAll('{PAIN}', pain) : undefined, list: s.list })),
    trust: TRUST_NOTE,
    actions: ['save_to_library', 'export_pdf'],
  };
}

const delay = <T>(v: T, ms = 280): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

// ── mock api（与后端同口径） ──
export const mock = {
  async login(phone: string, name?: string): Promise<LoginResult> {
    const token = `mock-${phone}`;
    const existed = !!Taro.getStorageSync(dataKey(token));
    const d = load(token);
    if (name) d.name = name;
    save(token, d);
    return delay({
      token, isNew: !existed, onboarded: d.onboarded,
      user: { id: token, name: d.name, phone, benmingColor: d.benmingColor },
    });
  },

  async me(): Promise<Me> {
    const { d } = current();
    return delay({
      user: { id: getToken(), name: d.name, role: 'owner', benmingColor: d.benmingColor },
      tenant: { id: `t-${d.phone}`, name: '云栖科技', industry: d.profile?.industry ?? 'SaaS / 软件', stage: d.profile?.stage ?? 'A 轮前后' },
      plan: { name: '决策版', creditsPerMonth: 200 },
      creditBalance: 68,
      onboarded: d.onboarded,
      ai: { provider: 'mock', model: 'template', ready: false, claudeReady: false },
    });
  },

  async setColor(color: string) {
    const { token, d } = current();
    d.benmingColor = color; save(token, d);
    return delay({ ok: true });
  },

  async agents(): Promise<Agent[]> { return delay(DEFAULT_AGENTS); },
  async survey(): Promise<SurveyQuestion[]> { return delay(SURVEY); },

  async getProfile(): Promise<Profile | null> { return delay(current().d.profile); },
  async saveProfile(p: Profile): Promise<Profile> {
    const { token, d } = current();
    d.profile = { ...d.profile, ...p }; d.onboarded = true; save(token, d);
    return delay(d.profile);
  },

  async todaySaying(): Promise<TodaySaying> {
    const n = new Date();
    const doy = Math.floor((n.getTime() - new Date(n.getFullYear(), 0, 0).getTime()) / 86400000);
    return delay({ text: SAYINGS[doy % SAYINGS.length], date: `${n.getMonth() + 1}月${n.getDate()}日` });
  },

  async sessions(): Promise<SessionItem[]> {
    const { d } = current();
    return delay(
      [...d.sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((s) => {
        const last = s.messages[s.messages.length - 1];
        let snippet = '新对话';
        if (last) { const c = last.content as any; snippet = c.text || (c.title ? `已产出《${c.title}》` : '已回复'); }
        const ag = agentOf(s.agentKey);
        return { id: s.id, agentKey: s.agentKey, agentName: ag.name, agentIcon: ag.icon, title: s.title, snippet, updatedAt: s.updatedAt };
      }),
    );
  },

  async session(id: string): Promise<SessionDetail> {
    const { d } = current();
    const s = d.sessions.find((x) => x.id === id);
    if (!s) throw Object.assign(new Error('session not found'), { code: 'NOT_FOUND' });
    const ag = agentOf(s.agentKey);
    return delay({
      id: s.id, agentKey: s.agentKey,
      agent: { key: ag.key, name: ag.name, role: ag.role, icon: ag.icon, greet: ag.greet, chips: ag.chips, memText: ag.memText, learnText: ag.learnText },
      title: s.title, messages: s.messages,
    });
  },

  async deleteSession(id: string) {
    const { token, d } = current();
    d.sessions = d.sessions.filter((s) => s.id !== id); save(token, d);
    return delay({ ok: true });
  },

  async generate(body: GenRequest): Promise<GenResult> {
    const { token, d } = current();
    const text = (body.text || '').trim();
    let session = body.sessionId ? d.sessions.find((s) => s.id === body.sessionId) : undefined;
    const agentKey = session?.agentKey ?? body.agentKey ?? agentForText(text);
    const ag = agentOf(agentKey);

    let created = false;
    if (!session) {
      session = { id: uid('s-'), agentKey: ag.key, title: text.slice(0, 18) || '新对话', createdAt: now(), updatedAt: now(), messages: [] };
      d.sessions.push(session); created = true;
    } else if (session.title === '新对话') {
      session.title = text.slice(0, 18);
    }
    session.messages.push({ id: uid('m-'), role: 'user', content: { text }, at: now() });

    let res: GenResult;
    if (ag.deliverableKey) {
      const deliverable = buildDeliverable(ag.deliverableKey, d);
      const msg: SessionMessage = { id: uid('m-'), role: 'report', content: deliverable, at: now() };
      session.messages.push(msg);
      res = {
        sessionId: session.id, created, agentKey: ag.key, kind: 'report', messageId: msg.id,
        deliverable, memory: ag.key !== 'general' ? { learned: true, agentName: ag.name } : null,
      };
    } else {
      const r = REPLIES['默认'];
      const reply = { text: r.t, points: r.points, acts: r.acts };
      const msg: SessionMessage = { id: uid('m-'), role: 'assistant', content: reply, at: now() };
      session.messages.push(msg);
      res = { sessionId: session.id, created, agentKey: ag.key, kind: 'chat', messageId: msg.id, reply };
    }
    session.updatedAt = now();
    save(token, d);
    return delay(res, 420);
  },

  async library(): Promise<LibItem[]> {
    const { d } = current();
    return delay([...d.library].sort((a, b) => (a.at < b.at ? 1 : -1)));
  },

  async saveToLibrary(body: SaveLibRequest): Promise<{ id: string; at: string }> {
    const { token, d } = current();
    const ag = agentOf(body.agentKey);
    const item: LibItem = {
      id: uid('d-'), title: body.title, type: body.type, agentKey: body.agentKey, agentName: ag.name,
      sessionId: body.sessionId ?? null, content: body.content as Deliverable, at: now(),
    };
    d.library.unshift(item); save(token, d);
    return delay({ id: item.id, at: item.at });
  },
};
