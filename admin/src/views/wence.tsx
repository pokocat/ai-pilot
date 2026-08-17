// 问策入口（WP5）：两个内容池 + 一个灰度开关，都是运营手上的东西。
//
// 为什么单独成页而不是塞进 settings.tsx 的开关段：本屏要同时承载「提示问题池 / 进场主动消息池
// （含 chips 编辑）/ 改版灰度权重 + 用法说明」，塞进 FlagsView 会把那张一行一开关的清单挤没，
// 也会让「问策」这件事在导航里没有名字（运营嘴里说的是「问策入口」，不是「功能开关第 6 行」）。
// 同「模型配置」「创作任务」——都属「配置」组，只是页面体量够大所以独立文件。
//
// 两条呈现口径，写在这里免得以后再漂：
//  ① 灰度**按语义呈现**：界面只有「现状 control / 新问策页 chat」两档（合计 100），
//     dock（列表页+输入坞）是保留臂，不给运营选，PATCH 固定传 dock:0。但读到历史配置里
//     dock>0 时必须如实显示——否则运营看到的 100% 和真正生效的分桶对不上，那种「界面骗人」
//     比少一个选项糟得多（服务端展示与运行时共用 effectiveArms，本页只做归一化换算）。
//  ② 权重是**相对权重**不是百分比（服务端默认 34/33/33）。所以展示一律归一化到 100 再说话。

import { useEffect, useState } from 'react';
import Icon from '../Icon';
import NumInput from '../NumInput';
import { api, type AdminWenceTemplate, type WenceTemplateKind } from '../api';
import { PageHead, ViewState, EmptyState, ConfirmDialog, Switch, type ConfirmSpec } from '../components';
import { useResource } from '../useResource';

/** 灰度开关 key（服务端 FEATURE_FLAG_CATALOG / services/wence.ts 的 WENCE_FLAG 同一个）。 */
const WENCE_FLAG_ID = 'wence_entry';

/** 界面暴露的两档快捷比例：急停 / 小流量试水 / 对半 / 全量。 */
const CHAT_PRESETS = [0, 10, 50, 100];

/**
 * 相对权重 → 百分比（合计恒为 100）。服务端存的是权重不是百分比（默认 34/33/33），
 * 直接把 34 当「34%」在三臂时碰巧接近、在两臂时（如 1:1 存成 5/0/5）就会显示成 5%/5%。
 * chat 用 100 减法兜底，保证三档相加永远是 100，不会出现「99%」这种让运营怀疑数据的显示。
 */
export function armPercents(arms: Record<string, number> | undefined): { control: number; dock: number; chat: number } {
  const w = (k: string) => { const n = Math.floor(Number(arms?.[k] ?? 0)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const control = w('control'), dock = w('dock'), chat = w('chat');
  const total = control + dock + chat;
  // 读不出任何权重时按「全量现状」呈现：宁可显示成没在分流，也不假装有个说不清的分桶在跑。
  if (total <= 0) return { control: 100, dock: 0, chat: 0 };
  const pc = Math.round((control / total) * 100);
  const pd = Math.round((dock / total) * 100);
  return { control: pc, dock: pd, chat: Math.max(0, 100 - pc - pd) };
}

/**
 * 界面上的 chat 占比 → 提交给服务端的三臂权重。dock 固定 0（本次灰度不投这一臂），
 * control 吃掉剩余——两档合计恒 100，服务端「权重总和必须大于 0」的校验也就永远过得去。
 */
export function twoArmPayload(chatPct: number): { control: number; dock: number; chat: number } {
  const chat = Math.min(100, Math.max(0, Math.round(Number.isFinite(chatPct) ? chatPct : 0)));
  return { control: 100 - chat, dock: 0, chat };
}

/**
 * 上移/下移后需要回写的 (id, sort)。**整段重排号**而不是只交换两行的 sort 值：
 * 服务端建模板时 sort 取「同 kind 当前条数」，删过几条之后池里会出现重复 / 断号的 sort，
 * 此时两两交换会得到「点了上移但顺序没变」的鬼故事。只回写真的变了的行，省掉无谓 PATCH。
 */
export function reorderSorts<T extends { id: string; sort: number }>(list: T[], from: number, to: number): { id: string; sort: number }[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [];
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const out: { id: string; sort: number }[] = [];
  next.forEach((t, i) => { if (t.sort !== i) out.push({ id: t.id, sort: i }); });
  return out;
}

/**
 * 4 格 chip 输入 → 提交值（与服务端 normalizeChips 同口径：去空白、丢空串、最多 4 条）。
 * 全空返回 `[]`——服务端据此把 chipsJson 置空，这是运营「删掉这一排」的唯一途径。
 */
export function packChips(raw: string[]): string[] {
  return raw.map((c) => c.trim()).filter(Boolean).slice(0, 4);
}

type TplForm = { text: string; chips: string[] };
const BLANK: TplForm = { text: '', chips: ['', '', '', ''] };
const toForm = (t: AdminWenceTemplate): TplForm => ({
  text: t.text,
  chips: [0, 1, 2, 3].map((i) => t.chips?.[i] ?? ''),
});

const POOL_HINT: Record<WenceTemplateKind, string> = {
  hint: '输入框上方的提示问题 pill。全部启用项按 sort 升序整批下发给端上（含游客）；池空则端上回退到本地兜底词，不影响进场。',
  proactive: '军师先开口的那条消息。按 sort 取第一条启用的模板，注入给从未发过消息的新用户（判据：该用户还没有 general 会话，所以每人至多收到一次）；池空则不注入，用户只看到问候语。',
};

export function WenceView({ toast }: { toast: (m: string) => void }) {
  const tplRes = useResource(api.wenceTemplates, []);
  const flagRes = useResource(api.flags, []);
  const [kind, setKind] = useState<WenceTemplateKind>('hint');
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<TplForm>(BLANK);
  const [busy, setBusy] = useState('');
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);

  const all = tplRes.data ?? [];
  const hints = all.filter((t) => t.kind === 'hint');
  const proactives = all.filter((t) => t.kind === 'proactive');
  const list = kind === 'hint' ? hints : proactives;

  const flag = (flagRes.data ?? []).find((f) => f.id === WENCE_FLAG_ID) ?? null;
  const live = armPercents(flag?.arms);
  // null = 跟随服务端；任何一次取回新数据都丢弃草稿，免得运营看着「已保存」其实是本地残留。
  const [chatDraft, setChatDraft] = useState<number | null>(null);
  useEffect(() => { setChatDraft(null); }, [flagRes.updatedAt]);
  const chat = chatDraft ?? live.chat;
  // dock>0 也算「待落库」：保存这一下会把保留臂归零，按钮不能是灰的，否则运营没有归一化的入口。
  const armsDirty = chat !== live.chat || live.dock > 0;

  const reset = () => { setAdding(false); setEditId(null); setForm(BLANK); };

  const toggleFlag = async () => {
    if (!flag) return;
    setBusy(WENCE_FLAG_ID);
    try {
      await api.setFlag(WENCE_FLAG_ID, !flag.enabled);
      flagRes.reload();
      toast(flag.enabled ? '已关闭 · 全量回到现状列表' : '已开启 · 按下方权重分桶');
    } catch (e) { toast((e as Error)?.message || '操作失败'); }
    setBusy('');
  };

  const saveArms = async () => {
    setBusy('arms');
    try {
      await api.setFlagArms(WENCE_FLAG_ID, twoArmPayload(chat));
      setChatDraft(null);
      flagRes.reload();
      toast(`权重已保存：现状 ${100 - chat}% / 新问策页 ${chat}%`);
    } catch (e) { toast((e as Error)?.message || '保存失败'); }
    setBusy('');
  };

  const create = async () => {
    const text = form.text.trim();
    if (!text) return toast('文案不能为空');
    setBusy('new');
    try {
      // 不传 sort：服务端排到同 kind 末尾，运营再用上移调位置（比让人手填数字可靠）。
      await api.createWenceTemplate({ kind, text, ...(kind === 'proactive' ? { chips: packChips(form.chips) } : {}) });
      reset();
      tplRes.reload();
      toast('已新增模板');
    } catch (e) { toast((e as Error)?.message || '新增失败'); }
    setBusy('');
  };

  const save = async (t: AdminWenceTemplate) => {
    const text = form.text.trim();
    if (!text) return toast('文案不能为空');
    setBusy(t.id);
    try {
      // chips 显式带上（含空数组）：不传 = 不动，运营就永远删不掉已配的那一排。
      await api.updateWenceTemplate(t.id, { text, ...(t.kind === 'proactive' ? { chips: packChips(form.chips) } : {}) });
      reset();
      tplRes.reload();
      toast('已保存');
    } catch (e) { toast((e as Error)?.message || '保存失败'); }
    setBusy('');
  };

  const toggleTpl = async (t: AdminWenceTemplate) => {
    setBusy(t.id);
    try {
      await api.updateWenceTemplate(t.id, { enabled: !t.enabled });
      tplRes.reload();
      toast(t.enabled ? '已停用' : '已启用');
    } catch (e) { toast((e as Error)?.message || '操作失败'); }
    setBusy('');
  };

  const move = async (from: number, to: number) => {
    const changes = reorderSorts(list, from, to);
    if (!changes.length) return;
    setBusy(list[from].id);
    try {
      for (const c of changes) await api.updateWenceTemplate(c.id, { sort: c.sort });
      tplRes.reload();
    } catch (e) { toast((e as Error)?.message || '排序失败'); }
    setBusy('');
  };

  const remove = (t: AdminWenceTemplate) => setConfirmSpec({
    title: '删除这条模板',
    desc: t.kind === 'hint'
      ? '删除后这条提示问题不再下发。池子被删空是合法状态：端上会回退到本地兜底词。'
      : '删除后这条主动消息不再注入。若它是当前生效的那条（按 sort 最靠前的启用项），删除即换成下一条；池子删空则新用户不再收到主动消息。',
    echo: [
      { k: '池', v: t.kind === 'hint' ? '提示问题' : '进场主动消息' },
      { k: '文案', v: t.text.length > 40 ? `${t.text.slice(0, 40)}…` : t.text },
      { k: '状态', v: `${t.enabled ? '启用中' : '已停用'} · sort ${t.sort}` },
    ],
    confirmText: '删除',
    danger: true,
    onConfirm: async () => { await api.deleteWenceTemplate(t.id); reset(); tplRes.reload(); toast('已删除'); },
  });

  const editor = (onSave: () => void, onCancel: () => void, saving: boolean) => (
    <div className="crd new-agent">
      <div className="ai-field">
        <div className="ai-fl">{kind === 'hint' ? '提示问题文案（一句话，端上显示为 pill）' : '主动消息文案（军师先开口说的那段，可多行）'}</div>
        {kind === 'hint'
          ? <input className="ai-input" value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="如：这个月怎么把复购提上去？" />
          : <textarea className="ta" value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="如：我看了下你的档案，这个阶段最该先动的是获客成本。要不要我先算一版？" />}
      </div>
      {kind === 'proactive' && form.chips.map((c, i) => (
        <div key={i} className="ai-field">
          <div className="ai-fl">{i === 0 ? '快捷回应 chips（最多 4 条 · 全部留空 = 端上不渲染这一排）· chip 1' : `chip ${i + 1}`}</div>
          <input
            className="ai-input"
            value={c}
            placeholder="留空即跳过"
            onChange={(e) => setForm({ ...form, chips: form.chips.map((x, j) => (j === i ? e.target.value : x)) })}
          />
        </div>
      ))}
      <div className="ai-actions">
        <button className="ai-btn ghost" onClick={onCancel}>取消</button>
        <button className="ai-btn primary" disabled={saving} onClick={onSave}><Icon name="check" size={14} /> 保存</button>
      </div>
    </div>
  );

  return (
    <>
      <PageHead
        k="wence"
        badge={`提示 ${hints.filter((t) => t.enabled).length}/${hints.length} · 主动 ${proactives.filter((t) => t.enabled).length}/${proactives.length}`}
        res={{
          loading: tplRes.loading || flagRes.loading,
          reload: () => { tplRes.reload(); flagRes.reload(); },
          updatedAt: Math.min(tplRes.updatedAt || 0, flagRes.updatedAt || 0),
        }}
      />

      <div className="sec-h"><span className="t">灰度开关</span><span className="s">展示的就是生效权重（与服务端分桶同源）</span></div>
      <ViewState res={flagRes} skeleton="rows">
        {() => !flag ? (
          <div className="pad"><EmptyState msg="服务端未注册 wence_entry 开关" hint="需要后端在 FEATURE_FLAG_CATALOG 里登记后才能在这里调权重。" /></div>
        ) : (
          <div className="pad">
            <div className="crd">
              <div className="crd-row">
                <span className="crd-ic"><Icon name="chat" size={18} /></span>
                <div className="crd-b">
                  <div className="ct">{flag.label} <span className={`tag ${flag.enabled ? 'live' : 'off'}`}>{flag.enabled ? '灰度中' : '已关闭'}</span></div>
                  <div className="cs">{flag.enabled ? '按下方权重稳定分桶（同一用户每次进都是同一档）' : '全量走现状军师列表，权重不生效'}</div>
                </div>
                <Switch checked={flag.enabled} onChange={toggleFlag} label="启用问策入口实验" disabled={busy === WENCE_FLAG_ID} />
              </div>
              <div className="ai-note">急停：关闭这个开关 = 全量回到现状列表（游客与登录用户都覆盖），不需要先把权重调回 0；重新打开时权重还是下面这一组，不会被清。</div>
            </div>

            <div className="ai-field">
              <div className="ai-fl">新问策页（chat）占比 · 剩下的自动留在现状（control）</div>
              <input className="ai-range" type="range" min={0} max={100} step={1} value={chat} onChange={(e) => setChatDraft(Number(e.target.value))} />
            </div>
            <div className="pill-row">
              <span className="pill">现状 control {100 - chat}%</span>
              <span className="pill">新问策页 chat {chat}%</span>
              {live.dock > 0 && <span className="pill">保留臂 dock {live.dock}%</span>}
            </div>
            <div className="chip-row">
              {CHAT_PRESETS.map((p) => (
                <button key={p} type="button" className={`chip ${chat === p ? 'on' : ''}`} onClick={() => setChatDraft(p)}>{p}%</button>
              ))}
            </div>
            <div className="say-row">
              <span className="grip"><Icon name="target" size={15} /></span>
              <div className="sb">
                <div className="stx">当前生效：现状 {live.control}% · 新问策页 {live.chat}%</div>
                <div className="smeta">{armsDirty ? '有未保存的改动，点右侧保存才会生效' : '与线上一致'} · 权重只影响登录用户的分桶（同一用户稳定命中同一档），游客一律按现状渲染</div>
              </div>
              <NumInput className="ai-input flag-num" min={0} max={100} value={chat} onChange={(n) => setChatDraft(Math.min(100, Math.max(0, Math.round(n))))} />
              <button className="mini-btn primary" disabled={busy === 'arms' || !armsDirty} onClick={saveArms}>保存</button>
            </div>
            {live.dock > 0 && (
              <div className="ai-note">存在保留臂 dock {live.dock}%（列表页+输入坞形态，本次灰度不投）。这一档本页不提供编辑，点「保存」会把它归零、按上面两档重新分流。</div>
            )}
          </div>
        )}
      </ViewState>

      <div className="sec-h"><span className="t">模板池</span><span className="s">两个池互不影响 · 空池都是合法状态，不会报错</span></div>
      <div className="pad">
        <div className="chip-row">
          <button type="button" className={`chip ${kind === 'hint' ? 'on' : ''}`} onClick={() => { setKind('hint'); reset(); }}>提示问题 {hints.length}</button>
          <button type="button" className={`chip ${kind === 'proactive' ? 'on' : ''}`} onClick={() => { setKind('proactive'); reset(); }}>进场主动消息 {proactives.length}</button>
        </div>
        <div className="ai-note">{POOL_HINT[kind]}</div>
      </div>
      <ViewState res={tplRes} skeleton="rows">
        {() => (
          <div className="pad">
            {!adding && !editId ? (
              <button className="add-btn full" onClick={() => { setForm(BLANK); setAdding(true); }}><Icon name="spark" size={15} /> 新增{kind === 'hint' ? '提示问题' : '主动消息'}</button>
            ) : null}
            {adding && editor(create, reset, busy === 'new')}
            {!list.length && !adding && (
              <EmptyState
                msg={kind === 'hint' ? '提示问题池是空的' : '主动消息池是空的'}
                hint={kind === 'hint' ? '端上会用本地兜底词，进场不受影响。' : '新用户不会收到主动消息，只看到问候语。'}
              />
            )}
            {list.map((t, i) => editId === t.id ? (
              <div key={t.id}>{editor(() => save(t), reset, busy === t.id)}</div>
            ) : (
              <div key={t.id} className="crd">
                <div className="crd-row">
                  <span className="crd-ic"><Icon name={kind === 'hint' ? 'spark' : 'chat'} size={18} /></span>
                  {/* 状态标记走 .cs 而不是 .ct：.ct 是 flex 行，模板文案往往几十字，
                      同行的 .tag 会被压缩成「每行一个字」的竖条（.tag 没有 flex:0 0 auto）。 */}
                  <div className="crd-b">
                    <div className="ct">{t.text}</div>
                    <div className="cs">
                      第 {i + 1} 位（sort {t.sort}）
                      {' · '}
                      {t.enabled ? <span className="tag live">启用</span> : <span className="tag off">停用</span>}
                      {kind === 'proactive' && t.enabled && i === list.findIndex((x) => x.enabled) && <>{' '}<span className="tag">当前生效</span></>}
                      {kind === 'proactive' ? ` · ${t.chips?.length ? `chips：${t.chips.join(' / ')}` : '无 chips'}` : ''}
                    </div>
                  </div>
                  <Switch checked={t.enabled} onChange={() => toggleTpl(t)} label={`${t.enabled ? '停用' : '启用'}模板 ${t.text}`} disabled={busy === t.id} />
                </div>
                <div className="crd-actions" style={{ marginTop: 8 }}>
                  <button className="mini-btn" disabled={i === 0 || busy === t.id} onClick={() => move(i, i - 1)}>上移</button>
                  <button className="mini-btn" disabled={i === list.length - 1 || busy === t.id} onClick={() => move(i, i + 1)}>下移</button>
                  <button className="mini-btn" onClick={() => { setAdding(false); setEditId(t.id); setForm(toForm(t)); }}>编辑</button>
                  <button className="mini-btn danger" onClick={() => remove(t)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </ViewState>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}
