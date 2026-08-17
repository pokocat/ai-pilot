import { useEffect, useState } from 'react';
import Icon from './Icon';
import NumInput from './NumInput';
import { api, type AgentDetail, type AgentType, type AgentBilling, type AdminAgentUpdate, type MemoryConfig, type MemoryIntensity, type MemorySource, type AgentProviderMode, type AgentRuntimeUpdate, type AiTestResult, type SkillToolMeta, type AdminAgentMemoryItem, type ToolStatItem } from './api';
import { ConfirmDialog, ErrorState, Switch, type ConfirmSpec } from './components';
import StudioSandbox from './StudioSandbox';
import StudioVersions, { tierName } from './StudioVersions';
import StudioEval from './StudioEval';

type StudioSection = 'config' | 'sandbox' | 'versions' | 'eval';
const SECTION_LABEL: Record<StudioSection, string> = { config: '配置', sandbox: '沙盒', versions: '版本', eval: '评测' };

const VARS = ['{企业档案}', '{行业基准}', '{长期记忆}', '{本命色}'];
const PROVIDER_MODES: [AgentProviderMode, string, string][] = [
  ['inherit', '跟随全局模型', '用「模型配置」里的统一大模型'],
  ['openai', '自定义模型端点', '单独填一套 OpenAI 兼容 baseUrl / 模型 / key'],
  ['dify', 'Dify 应用', '绑定一个 Dify 智能体（chat-messages 接口）'],
];
// Dify inputs 可用的本地上下文占位符（值里写这些，运行时按本轮真实数据填充）。
const INPUT_VARS = ['{企业档案}', '{长期记忆}', '{引用资料}', '{知识库}', '{个人档案}', '{客户名}', '{用户消息}'];
const INTENSITY = [['conservative', '保守'], ['balanced', '均衡'], ['aggressive', '激进']];
const RETENTION = [[30, '30天'], [180, '180天'], [-1, '永久']];
const BILLING: [AgentBilling, string, string][] = [
  ['free', '免费', '注册即赠送 · 所有用户可用'],
  ['unlock', '一次性解锁', '用权益点购买后永久可用 / 后台可指定开通'],
  ['metered', '按次计费', '无需解锁，每次产出消耗权益点（如图片生成）'],
];
const SOURCES = [
  ['conversation', '对话记忆', '从历史会话提炼洞察', 'chat'],
  ['document', '企业资料（可选投喂）', '客户补充的背景资料', 'doc'],
  ['deliverable_feedback', '产出反馈', '采纳 / 修改 / 忽略 信号回流', 'chart'],
];

// 调教 studio：配置（草稿编辑）+ 沙盒（反复试）+ 版本（发布/回滚）+ 评测（打分→建议定价）。
export default function AgentDetailPanel({ agentKey, onClose, toast }: { agentKey: string; onClose: () => void; toast: (m: string) => void }) {
  const [data, setData] = useState<AgentDetail | null>(null);
  const [section, setSection] = useState<StudioSection>('config');
  const [dirty, setDirty] = useState(false);          // 草稿与已发布是否有差异
  const [pubVersion, setPubVersion] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [agentType, setAgentType] = useState<AgentType>('advisory');
  const [billing, setBilling] = useState<AgentBilling>('free');
  const [price, setPrice] = useState(0);
  const [billingRatio, setBillingRatio] = useState(1);
  const [meterUnit, setMeterUnit] = useState<'text' | 'image'>('text');
  const [prompt, setPrompt] = useState('');
  const [greet, setGreet] = useState(''); // P2-13：开场白
  const [memText, setMemText] = useState('');
  const [learnText, setLearnText] = useState('');
  const [deliverableKey, setDeliverableKey] = useState(''); // P2-13：产出模板键
  const [mem, setMem] = useState<MemoryConfig | null>(null);
  // —— 接入方式 ——
  const [mode, setMode] = useState<AgentProviderMode>('inherit');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [apiModel, setApiModel] = useState('');
  const [apiTemperature, setApiTemperature] = useState(''); // P2-7：per-agent 温度（空=跟随全局）
  const [apiKey, setApiKey] = useState('');        // 留空=不改动已存 key
  const [hasApiKey, setHasApiKey] = useState(false);
  const [difyBaseUrl, setDifyBaseUrl] = useState('');
  const [difyApiKey, setDifyApiKey] = useState(''); // 留空=不改动已存 key
  const [hasDifyKey, setHasDifyKey] = useState(false);
  const [difyInputsText, setDifyInputsText] = useState('{}');
  // —— 自建技能（providerMode=openai）——
  const [skillsEnabled, setSkillsEnabled] = useState(false);
  const [skillTools, setSkillTools] = useState<string[]>([]);
  const [agentMems, setAgentMems] = useState<AdminAgentMemoryItem[] | null>(null); // P1-C4：跨用户已学记忆治理
  const [agentMemsLoading, setAgentMemsLoading] = useState(false);
  const [agentMemsErr, setAgentMemsErr] = useState('');
  const [availTools, setAvailTools] = useState<SkillToolMeta[]>([]);
  const [availToolsErr, setAvailToolsErr] = useState('');
  const [dryRunning, setDryRunning] = useState(''); // P2-10 工具试跑中的工具名
  const [toolStats, setToolStats] = useState<ToolStatItem[]>([]); // P2-10 per-tool 运行统计
  const [test, setTest] = useState<AiTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    setLoadErr('');
    api.agent(agentKey).then((d) => {
      setData(d);
      setName(d.name); setRole(d.role);
      setAgentType(d.type);
      setBilling(d.billing); setPrice(d.price);
      setBillingRatio(d.billingRatio ?? 1); setMeterUnit(d.meterUnit ?? 'text');
      setPrompt(d.systemPrompt);
      setGreet(d.greet ?? ''); setMemText(d.memText); setLearnText(d.learnText); setDeliverableKey(d.deliverableKey ?? '');
      setMem(d.memoryConfig);
      const r = d.runtime;
      setMode(r.providerMode);
      setApiBaseUrl(r.apiBaseUrl); setApiModel(r.apiModel); setApiTemperature(r.apiTemperature == null ? '' : String(r.apiTemperature)); setHasApiKey(r.hasApiKey); setApiKey('');
      setDifyBaseUrl(r.difyBaseUrl); setHasDifyKey(r.hasDifyKey); setDifyApiKey('');
      setDifyInputsText(JSON.stringify(r.difyInputs ?? {}, null, 2));
      setSkillsEnabled(r.skills?.enabled ?? false); setSkillTools(r.skills?.tools ?? []);
      setTest(null);
      setDirty(d.draftDirty ?? false); setPubVersion(d.publishedVersion ?? null);
    }).catch((e) => setLoadErr(e?.message || '加载顾问详情失败，请重试'));
  }, [agentKey]);

  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);

  // 版本/回滚变更后刷新「草稿是否脏 / 线上版本号」标识。
  // 只刷徽标（草稿脏标 / 线上版本号），失败不打断当前编辑——正文数据由主 load 负责报错。
  const refreshMeta = () => api.agent(agentKey).then((d) => { setDirty(d.draftDirty ?? false); setPubVersion(d.publishedVersion ?? null); }).catch(() => { /* 徽标刷新失败不影响编辑 */ });

  // 可勾选的内置工具元信息（一次性加载）。
  const loadTools = () => {
    setAvailToolsErr('');
    api.skillTools().then(setAvailTools).catch((e) => setAvailToolsErr((e as Error)?.message || '技能目录加载失败'));
  };
  useEffect(loadTools, []);
  useEffect(() => { api.toolStats(agentKey).then((v) => setToolStats(v.stats)).catch(() => setToolStats([])); }, [agentKey]); // P2-10

  // 加载失败时给出可见反馈 + 返回入口，而不是渲染空白（旧版静默吞错，点编辑像「没反应」）
  if (loadErr) {
    return (
      <section className="ad-detail show" aria-label="顾问详情加载失败">
        <div className="ad-dh">
          <button type="button" className="bk" onClick={onClose} aria-label="关闭顾问详情"><Icon name="arrow" size={18} /></button>
          <div className="dt"><div className="t">加载失败</div><div className="s">{agentKey}</div></div>
        </div>
        <div className="ad-db">
          <div className="ai-test err" style={{ marginTop: 0 }}><Icon name="spark" size={14} /> {loadErr}</div>
        </div>
      </section>
    );
  }

  if (!data || !mem) return null;

  const insertVar = (v: string) => setPrompt((p) => (p.endsWith('\n') || !p ? p : p + ' ') + v);
  const toggleSource = (s: MemorySource) =>
    setMem((m) => m && ({ ...m, sources: m.sources.includes(s) ? m.sources.filter((x) => x !== s) : [...m.sources, s] }));

  // difyInputs 文本 → 校验过的 { 变量名: 模板 } 对象（非对象 / 非法 JSON 抛错）。
  const parseDifyInputs = (): Record<string, string> => {
    const t = difyInputsText.trim();
    if (!t) return {};
    const obj = JSON.parse(t);
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('需为 JSON 对象');
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = String(v);
    return out;
  };

  // 组装接入更新入参。key 仅在用户重新输入时下发（留空=保留已存 key，不被脱敏回显覆盖）。
  const buildRuntime = (): AgentRuntimeUpdate => {
    const rt: AgentRuntimeUpdate = { providerMode: mode };
    if (mode === 'openai') {
      rt.apiBaseUrl = apiBaseUrl; rt.apiModel = apiModel;
      rt.apiTemperature = apiTemperature.trim() === '' || !Number.isFinite(Number(apiTemperature)) ? null : Number(apiTemperature);
      if (apiKey.trim()) rt.apiKey = apiKey.trim();
    } else if (mode === 'dify') {
      rt.difyBaseUrl = difyBaseUrl;
      if (difyApiKey.trim()) rt.difyApiKey = difyApiKey.trim();
      rt.difyInputs = parseDifyInputs();
    }
    // 技能与「模型接入方式」解耦：inherit（跟随全局模型）/ openai 自定义端点均可配技能；dify 自带编排，不走自建技能
    if (mode !== 'dify') rt.skills = { enabled: skillsEnabled, tools: skillTools };
    return rt;
  };

  // 落库当前草稿（不发布）。提示词/计费/接入等版本字段继续用已发布版本；
  // 名称、角色、类型/用户端入口属于 Agent 身份字段，保存后即时生效。
  const saveDraft = async (): Promise<boolean> => {
    let runtime: AgentRuntimeUpdate;
    try { runtime = buildRuntime(); } catch (e) { setTest({ ok: false, error: 'Dify inputs JSON 格式错误：' + (e as Error).message }); return false; }
    try {
      // 真正的 dirty-field PATCH：发布前不再把整个表单重发一遍，避免只改展示文案时夹带
      // prompt / 定价 / 接入配置等未编辑字段。API Key 仅在重新输入时下发。
      const patch: AdminAgentUpdate = {};
      if (name !== data.name) patch.name = name;
      if (role !== data.role) patch.role = role;
      if (agentType !== data.type) patch.type = agentType;
      if (billing !== data.billing) { patch.billing = billing; patch.gift = billing === 'free'; }
      const nextPrice = billing === 'free' ? 0 : Math.max(0, Math.trunc(price));
      if (nextPrice !== data.price) patch.price = nextPrice;
      // 2026-08-13 计费改造：对话一律扣 token 额度，倍率对所有智能体都生效。
      // 旧逻辑在 meterUnit==='image' 时把倍率强制写回 1 —— 那会让「海报对话设成 5 倍」这类
      // 配置在保存的瞬间被悄悄抹掉（库里仍是 image 的 poster/ip 正好中招）。
      const nextRatio = Math.max(0.1, billingRatio);
      if (nextRatio !== data.billingRatio) patch.billingRatio = nextRatio;
      if (meterUnit !== data.meterUnit) patch.meterUnit = meterUnit;
      if (prompt !== data.systemPrompt) patch.systemPrompt = prompt;
      if (greet !== (data.greet ?? '')) patch.greet = greet;
      if (memText !== data.memText) patch.memText = memText;
      if (learnText !== data.learnText) patch.learnText = learnText;
      const nextDeliverable = deliverableKey.trim() || null;
      if (nextDeliverable !== data.deliverableKey) patch.deliverableKey = nextDeliverable;
      if (JSON.stringify(mem) !== JSON.stringify(data.memoryConfig)) patch.memoryConfig = mem;
      const currentRuntime = data.runtime;
      const runtimeChanged = mode !== currentRuntime.providerMode
        || apiBaseUrl !== currentRuntime.apiBaseUrl || apiModel !== currentRuntime.apiModel
        || (apiTemperature.trim() === '' ? null : Number(apiTemperature)) !== currentRuntime.apiTemperature
        || difyBaseUrl !== currentRuntime.difyBaseUrl
        || JSON.stringify(JSON.parse(difyInputsText.trim() || '{}')) !== JSON.stringify(currentRuntime.difyInputs ?? {})
        || skillsEnabled !== (currentRuntime.skills?.enabled ?? false)
        || JSON.stringify(skillTools) !== JSON.stringify(currentRuntime.skills?.tools ?? [])
        || !!apiKey.trim() || !!difyApiKey.trim();
      if (runtimeChanged) patch.runtime = runtime;
      if (Object.keys(patch).length) await api.saveAgent(agentKey, patch);
      const latest = await api.agent(agentKey);
      setData(latest); setDirty(latest.draftDirty ?? false); setPubVersion(latest.publishedVersion ?? null);
      return true;
    } catch (e) { toast((e as Error)?.message || '保存失败'); return false; }
  };

  const save = async () => { if (await saveDraft()) toast('已保存草稿；用户端入口等基础信息已生效，内容配置待发布'); };

  // 发布：先把当前编辑落库，再冻结成新版本并指向它（C 端立即切换）。
  // 版本名原先用 window.prompt 收（系统弹窗，不显示「这次会对 C 端生效」，回车即发布）。
  const publish = () => setConfirmSpec({
    title: '发布新版本',
    desc: '先把当前草稿落库，再冻结成新版本并把线上指针指向它。C 端用户立即切到新版本（含其倍率 / 定价）。',
    echo: [
      { k: '顾问', v: agentKey },
      { k: '当前线上', v: pubVersion ? `v${pubVersion}` : '未发布' },
    ],
    reason: { label: '版本名（可选，便于回滚识别）', maxLength: 40 },
    confirmText: '发布',
    onConfirm: async (label) => {
      setPublishing(true);
      try {
        if (!(await saveDraft())) throw new Error('草稿保存失败，未发布');
        const r = await api.publishAgent(agentKey, label || undefined);
        setDirty(false); setPubVersion(r.version);
        // P1-A2：发布软门警示（配 EVAL_GATE_MIN 时）——已发布但提示评测分偏低，不拦截。
        if (r.warning) toast(`已发布 v${r.version}，但 ${r.warning}`);
        else toast(r.changed ? `已发布 v${r.version} · C 端已切到新版本` : '与当前线上版本相同，未产生新版本');
      } finally { setPublishing(false); }
    },
  });

  const runTest = () => {
    let runtime: AgentRuntimeUpdate;
    try { runtime = buildRuntime(); } catch (e) { setTest({ ok: false, error: 'Dify inputs JSON 格式错误：' + (e as Error).message }); return; }
    setTesting(true); setTest(null);
    api.testAgent(agentKey, runtime).then((r) => {
      // Dify 报「缺失必填输入变量」时，把缺的 key 自动补进映射框（值留占位待运营填真实占位符）。
      if (r.missingInputs?.length) addMissingInputs(r.missingInputs);
      setTest(r);
    }).catch((e) => setTest({ ok: false, error: e?.message ?? '测试失败' })).finally(() => setTesting(false));
  };

  // P2-10：单工具试跑（默认 query 入参，烟雾测试工具能否执行；结果走 toast）。
  const runDry = async (name: string) => {
    setDryRunning(name);
    try {
      const r = await api.dryRunTool(agentKey, name, { query: '测试' });
      toast(r.ok ? `✓ ${name} · ${r.ms}ms · ${(r.output || '').slice(0, 40) || '(空输出)'}` : `✗ ${name}：${r.error}`);
    } catch (e) { toast((e as Error)?.message || '试跑失败'); }
    setDryRunning('');
  };

  // 把缺失的 Dify 输入变量名并入当前映射 JSON（已存在的 key 不覆盖）。
  const addMissingInputs = (keys: string[]) => {
    setDifyInputsText((t) => {
      let obj: Record<string, unknown>;
      try { const p = JSON.parse(t.trim() || '{}'); obj = (p && typeof p === 'object' && !Array.isArray(p)) ? p : {}; }
      catch { obj = {}; }
      for (const k of keys) if (!(k in obj)) obj[k] = '';
      return JSON.stringify(obj, null, 2);
    });
  };

  const loadAgentMems = () => {
    setAgentMemsLoading(true);
    setAgentMemsErr('');
    api.agentMemories(agentKey)
      .then((r) => setAgentMems(r.items))
      .catch((e) => setAgentMemsErr((e as Error)?.message || '已学记忆加载失败'))
      .finally(() => setAgentMemsLoading(false));
  };

  return (
    <section className="ad-detail show" aria-label={`顾问详情：${data.name}`}>
      <div className="ad-dh">
        <button type="button" className="bk" onClick={onClose} aria-label="关闭顾问详情"><Icon name="arrow" size={18} /></button>
        <div className="di"><Icon name={data.icon} size={18} /></div>
        <div className="dt">
          <div className="t">{data.name}{dirty && <span className="tag warn" style={{ marginLeft: 6 }}>草稿未发布</span>}</div>
          <div className="s">{pubVersion ? `线上 v${pubVersion}` : '尚未发布'} · {data.deliverableKey ? `产出 · ${data.deliverableKey}` : data.role}</div>
        </div>
      </div>

      <div className="studio-nav">
        {(['config', 'sandbox', 'versions', 'eval'] as StudioSection[]).map((k) => (
          <button key={k} type="button" className={`sn ${section === k ? 'on' : ''}`} onClick={() => setSection(k)} aria-pressed={section === k}>{SECTION_LABEL[k]}</button>
        ))}
      </div>

      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}

      {section === 'sandbox' && <StudioSandbox agentKey={agentKey} draftDirty={dirty} />}
      {section === 'versions' && <StudioVersions agentKey={agentKey} toast={toast} onChanged={refreshMeta} />}
      {section === 'eval' && <StudioEval agentKey={agentKey} toast={toast} />}

      {section === 'config' && (<>
      <div className="ad-db">
        <div className="blk">
          <div className="blk-h"><Icon name="agent" size={15} /><span className="t">基础信息</span></div>
          <div className="ai-field"><div className="ai-fl">名称</div><input className="ai-input" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="ai-field"><div className="ai-fl">一句话定位</div><input className="ai-input" value={role} onChange={(e) => setRole(e.target.value)} /></div>
          <div className="ai-field">
            <div className="ai-fl">用户端入口</div>
            <select className="ai-input" value={agentType} onChange={(e) => setAgentType(e.target.value as AgentType)}>
              <option value="general" disabled={agentKey !== 'general'}>对话 · 总军师</option>
              <option value="advisory">对话 · 专业顾问</option>
              <option value="creative">执行 · 内容出品</option>
              <option value="custom">对话 · 自定义顾问</option>
            </select>
            <div className="blk-d">上架后按这里进入用户端目录；“内容出品”显示在执行页，其余顾问显示在对话页。</div>
          </div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="crown" size={15} /><span className="t">计费与定价</span><span className="badge">{billingLabel(billing)}</span></div>
          <div className="blk-d">控制这位智能体是注册赠送、付费解锁，还是按次计费（如图片生成类）。价格单位为「权益点」。</div>
          <div className="bill-seg">
            {BILLING.map(([v, l, d]) => (
              <button type="button" key={v} className={`bill-opt ${billing === v ? 'on' : ''}`} onClick={() => { setBilling(v); if (v === 'free') setPrice(0); }} aria-pressed={billing === v}>
                <div className="bo-t">{l}</div><div className="bo-d">{d}</div>
              </button>
            ))}
          </div>
          {billing !== 'free' && (
            <div className="ai-field">
              <div className="ai-fl">{meterUnit === 'image' ? '每张消耗（钻石）' : '解锁价格（钻石）'}</div>
              <NumInput className="ai-input" min={0} value={price} onChange={setPrice} />
            </div>
          )}
          <div className="ai-field">
            <div className="ai-fl">计费单位（已废弃 · 不再影响计费）</div>
            <div className="bill-seg">
              <button type="button" className={`bill-opt ${meterUnit === 'text' ? 'on' : ''}`} onClick={() => setMeterUnit('text')} aria-pressed={meterUnit === 'text'}>
                <div className="bo-t">文本 · token 额度</div><div className="bo-d">对话扣 token×倍率（当前唯一口径）</div>
              </button>
              <button type="button" className={`bill-opt ${meterUnit === 'image' ? 'on' : ''}`} onClick={() => setMeterUnit('image')} aria-pressed={meterUnit === 'image'}>
                <div className="bo-t">图片 · 按张钻石</div><div className="bo-d">旧口径，已停用</div>
              </button>
            </div>
            <div className="ai-note">
              2026-08-13 起<b>这一项不再参与计费判定</b>：对话一律扣月度 token 额度 × 下方倍率；
              钻石只在产出物（成品图 / 成片）那条链路上，按「技能 × 规格」的价目表结算
              —— 海报的「创意排版 / 主视觉大片」就是在那张表里定价的，不在这里。
              旧值留着只为可追溯，建议把仍是「图片」的智能体改回「文本」，免得下一个人误以为还在按张扣钻。
            </div>
          </div>
          {(
            <div className="ai-field">
              <div className="ai-fl">定价档位 / 计费比例 —— 调教越好倍率越高卖越贵（当前：{tierName(billingRatio)} ×{billingRatio}）</div>
              <div className="bill-seg" style={{ marginBottom: 8 }}>
                {([['标准', 1], ['进阶', 1.5], ['旗舰', 2]] as [string, number][]).map(([l, r]) => (
                  <button type="button" key={l} className={`bill-opt ${billingRatio === r ? 'on' : ''}`} onClick={() => setBillingRatio(r)} aria-pressed={billingRatio === r}>
                    <div className="bo-t">{l}</div><div className="bo-d">×{r}</div>
                  </button>
                ))}
              </div>
              <NumInput className="ai-input" min={0} step={0.1} value={billingRatio} onChange={setBillingRatio} />
              <div className="blk-d" style={{ margin: '6px 0 0' }}>倍率随版本走，发布后生效；可在「评测」里跑分，按建议档位定价。</div>
            </div>
          )}
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="pen" size={15} /><span className="t">System 提示词</span><span className="badge">可优化</span></div>
          <div className="blk-d">定义这位顾问的角色、产出结构与语气。变量会在运行时注入企业档案与记忆。</div>
          <textarea className="ta" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={9} />
          <div className="var-row">
            {VARS.map((v) => <button type="button" key={v} className="var" onClick={() => insertVar(v)}>＋ {v}</button>)}
          </div>
        </div>

        {/* 用户端公开文案随版本发布；dirty-field PATCH 防止文案修改夹带 prompt/定价/接入配置。 */}
        <div className="blk">
          <div className="blk-h"><Icon name="pen" size={15} /><span className="t">用户端公开文案 / 产出模板</span></div>
          <div className="blk-d">开场白、记忆说明和学习状态会随版本发布到 C 端；保存时只提交实际改动字段。</div>
          <textarea className="ta" value={greet} onChange={(e) => setGreet(e.target.value)} rows={2} placeholder="开场白" />
          <textarea className="ta" value={memText} onChange={(e) => setMemText(e.target.value)} rows={2} placeholder="记忆说明（支持 <b>关键名词</b>）" />
          <textarea className="ta" value={learnText} onChange={(e) => setLearnText(e.target.value)} rows={1} placeholder="学习状态，如：记下了" />
          <textarea className="ta" value={deliverableKey} onChange={(e) => setDeliverableKey(e.target.value)} rows={1} placeholder="产出模板键（如 战略体检；留空=纯对话）" />
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="insight" size={15} /><span className="t">接入方式 / API</span><span className="badge">{modeLabel(mode)}</span></div>
          <div className="blk-d">为这位智能体单独指定后端：跟随全局模型、自定义 OpenAI 兼容端点，或绑定一个 Dify 应用（走 chat-messages 接口）。</div>
          <div className="bill-seg">
            {PROVIDER_MODES.map(([v, l, d]) => (
              <button type="button" key={v} className={`bill-opt ${mode === v ? 'on' : ''}`} onClick={() => { setMode(v); setTest(null); }} aria-pressed={mode === v}>
                <div className="bo-t">{l}</div><div className="bo-d">{d}</div>
              </button>
            ))}
          </div>

          {mode === 'openai' && (
            <>
              <div className="ai-field"><div className="ai-fl">Base URL</div><input className="ai-input" placeholder="https://api.deepseek.com/v1" value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} /></div>
              <div className="ai-field"><div className="ai-fl">模型</div><input className="ai-input" placeholder="deepseek-chat" value={apiModel} onChange={(e) => setApiModel(e.target.value)} /></div>
              <div className="ai-field"><div className="ai-fl">温度</div><input className="ai-input" placeholder="留空=跟随全局，如 0.7" value={apiTemperature} onChange={(e) => setApiTemperature(e.target.value)} /></div>
              <div className="ai-field"><div className="ai-fl">API Key{hasApiKey ? ' · 已配置' : ''}</div><input className="ai-input" type="password" placeholder={hasApiKey ? '已保存 · 留空则不修改' : 'sk-...'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></div>
            </>
          )}
          {/* 技能与「模型接入方式」解耦：跟随全局模型(inherit)或自定义 openai 端点都可配；dify 自带编排不显示 */}
          {mode !== 'dify' && (
            <>
              <div className="cfg">
                <div className="cfg-row">
                  <div className="cb"><div className="ct">启用技能（工具调用）</div><div className="cs">让模型自行调用知识库检索 / 记忆召回等工具后再作答（需 OpenAI 兼容或 Claude 模型；当前生效模型为 mock 或 Dify 接入时技能不会执行）</div></div>
                  <Switch checked={skillsEnabled} onChange={setSkillsEnabled} label="启用技能调用" />
                </div>
              </div>
              {availToolsErr && <div className="ai-note"><ErrorState msg={availToolsErr} onRetry={loadTools} /></div>}
              {skillsEnabled && (
                <div className="mem-list" style={{ marginTop: 8 }}>
                  {/* 只列 kind==='tool'：白名单而不是「排除 output」——排除法在新增第三种 kind（artifact，
                      如海报成品图 canvas_design）时会把它静默混进「模型工具」组，让运营以为那是模型会自己
                      调用的工具（实际是异步任务产二进制交付物，不进模型循环）。artifact 单独一组见下方。 */}
                  {availTools.filter((t) => t.kind === 'tool').map((t) => {
                    const on = skillTools.includes(t.name);
                    return (
                      <div key={t.name} className="mem-card">
                        <span className="mi"><Icon name="insight" size={16} /></span>
                        <div className="mb"><div className="mt">{t.name}{t.builtin && <span className="tag off">内置</span>}</div><div className="mm">{t.description}</div></div>
                        {on && <button className="mini-btn" disabled={dryRunning === t.name} onClick={() => runDry(t.name)}>{dryRunning === t.name ? '…' : '试跑'}</button>}
                        <Switch checked={on} onChange={() => setSkillTools((s) => on ? s.filter((x) => x !== t.name) : [...s, t.name])} label={`${on ? '停用' : '启用'}技能 ${t.name}`} />
                      </div>
                    );
                  })}
                  {!availToolsErr && !availTools.some((t) => t.kind === 'tool') && <div className="blk-d">（暂无可用工具）</div>}
                </div>
              )}
              {/* 成品交付（kind='artifact'）：勾选后该顾问才对外开放这项交付能力，但它不进模型工具循环
                  ——由异步任务（CreativeJob）执行、可能单独计费与退款，所以既要能勾选，又不能和「模型工具」
                  混在一组（也没有「试跑」——试跑走的是工具调用协议，对交付物没意义）。
                  不受上面「启用技能（工具调用）」开关约束：即便这位顾问不用工具调用，也可以开成品交付。 */}
              {availTools.some((t) => t.kind === 'artifact') && (
                <>
                  <div className="blk-d" style={{ marginTop: 10 }}>成品交付（异步出成品文件 · 按次计费，失败自动退款 · 需勾选才对外开放）</div>
                  <div className="mem-list" style={{ marginTop: 6 }}>
                    {availTools.filter((t) => t.kind === 'artifact').map((t) => {
                      const on = skillTools.includes(t.name);
                      return (
                        <div key={t.name} className="mem-card">
                          <span className="mi"><Icon name="image" size={16} /></span>
                          <div className="mb">
                            <div className="mt">{t.name}<span className="tag off">成品交付</span>{t.builtin && <span className="tag off">内置</span>}</div>
                            <div className="mm">{t.description}</div>
                          </div>
                          <Switch checked={on} onChange={() => setSkillTools((s) => on ? s.filter((x) => x !== t.name) : [...s, t.name])} label={`${on ? '停用' : '启用'}技能 ${t.name}`} />
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              {availTools.some((t) => t.kind === 'output') && (
                <>
                  <div className="blk-d" style={{ marginTop: 10 }}>产出处理技能（成果产出后按需生成，无需勾选）</div>
                  <div className="mem-list" style={{ marginTop: 6 }}>
                    {availTools.filter((t) => t.kind === 'output').map((t) => (
                      <div key={t.name} className="mem-card">
                        <span className="mi"><Icon name="layers" size={16} /></span>
                        <div className="mb"><div className="mt">{t.name}<span className="tag off">产出处理</span></div><div className="mm">{t.description}</div></div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {toolStats.length > 0 && (
                <>
                  <div className="blk-d" style={{ marginTop: 10 }}>工具运行统计（本 agent · 近 7 天）</div>
                  <div className="mem-list" style={{ marginTop: 6 }}>
                    {toolStats.map((s) => (
                      <div key={s.tool} className="mem-card">
                        <span className="mi"><Icon name="insight" size={16} /></span>
                        <div className="mb"><div className="mt">{s.tool}{s.errorRate > 0 && <span className="tag warn" style={{ marginLeft: 6 }}>错误 {s.errorRate}%</span>}</div><div className="mm">{s.calls} 次调用 · 失败 {s.errors} · 均 {s.avgMs}ms</div></div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {mode === 'dify' && (
            <>
              <div className="ai-field"><div className="ai-fl">Dify Base URL</div><input className="ai-input" placeholder="http://ai.aibuzz.cn/v1" value={difyBaseUrl} onChange={(e) => setDifyBaseUrl(e.target.value)} /></div>
              <div className="ai-field"><div className="ai-fl">应用 API Key{hasDifyKey ? ' · 已配置' : ''}</div><input className="ai-input" type="password" placeholder={hasDifyKey ? '已保存 · 留空则不修改' : 'app-...'} value={difyApiKey} onChange={(e) => setDifyApiKey(e.target.value)} /></div>
              <div className="ai-field">
                <div className="ai-fl">输入变量映射（Dify inputs）</div>
                <textarea className="ta" rows={5} value={difyInputsText} onChange={(e) => setDifyInputsText(e.target.value)} placeholder={'{\n  "client_profile": "{企业档案}",\n  "memory": "{长期记忆}"\n}'} />
              </div>
              <div className="var-row">{INPUT_VARS.map((v) => <button type="button" key={v} className="var" onClick={() => setDifyInputsText((t) => t + (!t || t.endsWith('\n') ? '' : ' ') + v)}>＋ {v}</button>)}</div>
              <div className="blk-d" style={{ margin: '6px 0 0' }}>键 = 你在 Dify 应用里声明的输入变量名；值里可用上面的占位符，运行时按每个用户的真实上下文填充。多轮会自动用 Dify 的 conversation_id 续接。</div>
            </>
          )}

          {mode !== 'inherit' && (
            <div className="ai-field">
              <button className="ai-btn ghost auto" onClick={runTest} disabled={testing}><Icon name="spark" size={15} /> {testing ? '测试中…' : '测试连接'}</button>
              {test && <div className={`blk-d ${test.ok ? 'ok' : 'err'}`} style={{ marginTop: 8 }}>{test.ok ? `连通正常 · ${test.latencyMs ?? '-'}ms${test.sample ? ' · 样例：' + test.sample : ''} · 注：仅验连通，不验证工具调用（P2-9，需用实际产出确认）` : `失败：${test.error ?? '未知错误'}`}</div>}
            </div>
          )}
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="layers" size={15} /><span className="t">Agent Memory · 持续学习</span></div>
          <div className="blk-d">控制这位顾问如何从对话与企业资料中学习、沉淀长期记忆，越用越懂客户。</div>
          <div className="cfg">
            <div className="cfg-row">
              <div className="cb"><div className="ct">开启长期记忆</div><div className="cs">跨会话记住客户的偏好、结论与口径</div></div>
              <Switch checked={mem.longTerm} onChange={(longTerm) => setMem({ ...mem, longTerm })} label="长期记忆" />
            </div>
            <div className="cfg-row">
              <div className="cb"><div className="ct">从对话中自动学习</div><div className="cs">每次对话后提炼要点，写入长期记忆</div></div>
              <Switch checked={mem.autoLearn} onChange={(autoLearn) => setMem({ ...mem, autoLearn })} label="自动学习" />
            </div>
            <div className="cfg-row">
              <div className="cb"><div className="ct">学习强度</div><div className="cs">更高更敏感，但也更易受单次对话影响</div></div>
              <div className="seg">{INTENSITY.map(([v, l]) => <button type="button" key={v} className={mem.intensity === v ? 'on' : ''} onClick={() => setMem({ ...mem, intensity: v as MemoryIntensity })} aria-pressed={mem.intensity === v}>{l}</button>)}</div>
            </div>
            <div className="cfg-row">
              <div className="cb"><div className="ct">记忆留存</div><div className="cs">超出时长的低价值记忆自动淡化</div></div>
              <div className="seg">{RETENTION.map(([v, l]) => <button type="button" key={v} className={mem.retentionDays === v ? 'on' : ''} onClick={() => setMem({ ...mem, retentionDays: v as number })} aria-pressed={mem.retentionDays === v}>{l}</button>)}</div>
            </div>
          </div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="insight" size={15} /><span className="t">记忆来源</span><span className="badge">{mem.sources.length} 路</span></div>
          <div className="mem-list">
            {SOURCES.map(([key, t, m, ic]) => (
              <div key={key} className="mem-card">
                <span className="mi"><Icon name={ic} size={16} /></span>
                <div className="mb"><div className="mt">{t}</div><div className="mm">{m}</div></div>
                <Switch checked={mem.sources.includes(key as MemorySource)} onChange={() => toggleSource(key as MemorySource)} label={`${t}记忆来源`} />
              </div>
            ))}
          </div>
          <div className="blk-d" style={{ margin: '9px 0 0' }}>记忆随真实使用持续积累（不展示估算值，避免误导）。</div>
        </div>

        {/* P1-C4：跨用户已学记忆治理——浏览并清理 auto-learn 写入的脏记忆 */}
        <div className="blk">
          <div className="blk-h"><Icon name="insight" size={15} /><span className="t">已学记忆 · 治理</span>{agentMems && <span className="badge">{agentMems.length}</span>}</div>
          {agentMemsErr && <ErrorState msg={agentMemsErr} onRetry={loadAgentMems} />}
          {!agentMems ? (
            <button type="button" className="ai-btn" onClick={loadAgentMems} disabled={agentMemsLoading}>{agentMemsLoading ? '加载中…' : '查看该顾问跨用户已学到的记忆'}</button>
          ) : agentMems.length === 0 ? (
            <div className="blk-d">暂无已学记忆。</div>
          ) : (
            <div className="mem-list">
              {agentMems.map((m) => (
                <div key={m.id} className="mem-card">
                  <div className="mb"><div className="mt">{m.text.slice(0, 40)}</div><div className="mm">用户 {m.userId.slice(0, 8)} · {m.kind} · {new Date(m.createdAt).toLocaleDateString()}</div></div>
                  <button className="mini-btn" onClick={() => api.deleteAgentMemory(agentKey, m.id).then(() => setAgentMems((cur) => cur ? cur.filter((x) => x.id !== m.id) : cur)).catch((e: unknown) => toast((e as Error)?.message || '删除记忆失败'))}>删除</button>
                </div>
              ))}
            </div>
          )}
          <div className="blk-d" style={{ margin: '9px 0 0' }}>清理自动学习写入的脏记忆（跨用户）。删除即时生效。</div>
        </div>
        <div style={{ height: 70 }} />
      </div>

      <div className="save-bar">
        <button className="gh" onClick={() => { setPrompt(data.systemPrompt); }} title="还原提示词"><Icon name="clock" size={16} /></button>
        <button className="gh gh-wide" onClick={save}><Icon name="check" size={16} /> 存草稿</button>
        <button className="sv" onClick={publish} disabled={publishing}><Icon name="spark" size={16} /> {publishing ? '发布中…' : '发布新版本'}</button>
      </div>
      </>)}
    </section>
  );
}

function billingLabel(b: AgentBilling) {
  return b === 'free' ? '免费赠送' : b === 'unlock' ? '付费解锁' : '按次计费';
}

function modeLabel(m: AgentProviderMode) {
  return m === 'inherit' ? '全局模型' : m === 'openai' ? '自定义端点' : 'Dify 应用';
}
