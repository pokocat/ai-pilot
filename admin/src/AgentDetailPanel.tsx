import { useEffect, useState } from 'react';
import Icon from './Icon';
import NumInput from './NumInput';
import { api, type AgentDetail, type AgentBilling, type MemoryConfig, type MemoryIntensity, type MemorySource, type AgentProviderMode, type AgentRuntimeUpdate, type AiTestResult, type SkillToolMeta } from './api';
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
  const [billing, setBilling] = useState<AgentBilling>('free');
  const [price, setPrice] = useState(0);
  const [billingRatio, setBillingRatio] = useState(1);
  const [meterUnit, setMeterUnit] = useState<'text' | 'image'>('text');
  const [prompt, setPrompt] = useState('');
  const [mem, setMem] = useState<MemoryConfig | null>(null);
  // —— 接入方式 ——
  const [mode, setMode] = useState<AgentProviderMode>('inherit');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [apiModel, setApiModel] = useState('');
  const [apiKey, setApiKey] = useState('');        // 留空=不改动已存 key
  const [hasApiKey, setHasApiKey] = useState(false);
  const [difyBaseUrl, setDifyBaseUrl] = useState('');
  const [difyApiKey, setDifyApiKey] = useState(''); // 留空=不改动已存 key
  const [hasDifyKey, setHasDifyKey] = useState(false);
  const [difyInputsText, setDifyInputsText] = useState('{}');
  // —— 自建技能（providerMode=openai）——
  const [skillsEnabled, setSkillsEnabled] = useState(false);
  const [skillTools, setSkillTools] = useState<string[]>([]);
  const [availTools, setAvailTools] = useState<SkillToolMeta[]>([]);
  const [test, setTest] = useState<AiTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    setLoadErr('');
    api.agent(agentKey).then((d) => {
      setData(d);
      setName(d.name); setRole(d.role);
      setBilling(d.billing); setPrice(d.price);
      setBillingRatio(d.billingRatio ?? 1); setMeterUnit(d.meterUnit ?? 'text');
      setPrompt(d.systemPrompt);
      setMem(d.memoryConfig);
      const r = d.runtime;
      setMode(r.providerMode);
      setApiBaseUrl(r.apiBaseUrl); setApiModel(r.apiModel); setHasApiKey(r.hasApiKey); setApiKey('');
      setDifyBaseUrl(r.difyBaseUrl); setHasDifyKey(r.hasDifyKey); setDifyApiKey('');
      setDifyInputsText(JSON.stringify(r.difyInputs ?? {}, null, 2));
      setSkillsEnabled(r.skills?.enabled ?? false); setSkillTools(r.skills?.tools ?? []);
      setTest(null);
      setDirty(d.draftDirty ?? false); setPubVersion(d.publishedVersion ?? null);
    }).catch((e) => setLoadErr(e?.message || '加载顾问详情失败，请重试'));
  }, [agentKey]);

  // 版本/回滚变更后刷新「草稿是否脏 / 线上版本号」标识。
  const refreshMeta = () => api.agent(agentKey).then((d) => { setDirty(d.draftDirty ?? false); setPubVersion(d.publishedVersion ?? null); }).catch(() => {});

  // 可勾选的内置工具元信息（一次性加载）。
  useEffect(() => { api.skillTools().then(setAvailTools).catch(() => setAvailTools([])); }, []);

  // 加载失败时给出可见反馈 + 返回入口，而不是渲染空白（旧版静默吞错，点编辑像「没反应」）
  if (loadErr) {
    return (
      <div className="ad-detail show">
        <div className="ad-dh">
          <div className="bk" onClick={onClose}><Icon name="arrow" size={18} /></div>
          <div className="dt"><div className="t">加载失败</div><div className="s">{agentKey}</div></div>
        </div>
        <div className="ad-db">
          <div className="ai-test err" style={{ marginTop: 0 }}><Icon name="spark" size={14} /> {loadErr}</div>
        </div>
      </div>
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

  // 落库当前草稿（不发布）。C 端继续用已发布版本，直到点「发布新版本」。
  const saveDraft = async (): Promise<boolean> => {
    let runtime: AgentRuntimeUpdate;
    try { runtime = buildRuntime(); } catch (e) { setTest({ ok: false, error: 'Dify inputs JSON 格式错误：' + (e as Error).message }); return false; }
    try {
      await api.saveAgent(agentKey, {
        name, role, gift: billing === 'free', billing,
        price: billing === 'free' ? 0 : Math.max(0, Math.trunc(price)),
        billingRatio: meterUnit === 'text' ? Math.max(0.1, billingRatio) : 1,
        meterUnit,
        systemPrompt: prompt, memoryConfig: mem, runtime,
      });
      return true;
    } catch (e) { toast((e as Error)?.message || '保存失败'); return false; }
  };

  const save = async () => { if (await saveDraft()) { setDirty(true); toast('已保存草稿（未发布，C 端不受影响）'); } };

  // 发布：先把当前编辑落库，再冻结成新版本并指向它（C 端立即切换）。
  const publish = async () => {
    setPublishing(true);
    if (!(await saveDraft())) { setPublishing(false); return; }
    const label = (window.prompt('给这个版本起个名字（可选，便于回滚识别）：') || '').trim();
    try {
      const r = await api.publishAgent(agentKey, label || undefined);
      setDirty(false); setPubVersion(r.version);
      toast(r.changed ? `已发布 v${r.version} · C 端已切到新版本` : '与当前线上版本相同，未产生新版本');
    } catch (e) { toast((e as Error)?.message || '发布失败'); }
    setPublishing(false);
  };

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

  return (
    <div className="ad-detail show">
      <div className="ad-dh">
        <div className="bk" onClick={onClose}><Icon name="arrow" size={18} /></div>
        <div className="di"><Icon name={data.icon} size={18} /></div>
        <div className="dt">
          <div className="t">{data.name}{dirty && <span className="tag warn" style={{ marginLeft: 6 }}>草稿未发布</span>}</div>
          <div className="s">{pubVersion ? `线上 v${pubVersion}` : '尚未发布'} · {data.deliverableKey ? `产出 · ${data.deliverableKey}` : data.role}</div>
        </div>
      </div>

      <div className="studio-nav">
        {(['config', 'sandbox', 'versions', 'eval'] as StudioSection[]).map((k) => (
          <div key={k} className={`sn ${section === k ? 'on' : ''}`} onClick={() => setSection(k)}>{SECTION_LABEL[k]}</div>
        ))}
      </div>

      {section === 'sandbox' && <StudioSandbox agentKey={agentKey} draftDirty={dirty} />}
      {section === 'versions' && <StudioVersions agentKey={agentKey} toast={toast} onChanged={refreshMeta} />}
      {section === 'eval' && <StudioEval agentKey={agentKey} toast={toast} />}

      {section === 'config' && (<>
      <div className="ad-db">
        <div className="blk">
          <div className="blk-h"><Icon name="agent" size={15} /><span className="t">基础信息</span></div>
          <div className="ai-field"><div className="ai-fl">名称</div><input className="ai-input" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="ai-field"><div className="ai-fl">一句话定位</div><input className="ai-input" value={role} onChange={(e) => setRole(e.target.value)} /></div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="crown" size={15} /><span className="t">计费与定价</span><span className="badge">{billingLabel(billing)}</span></div>
          <div className="blk-d">控制这位智能体是注册赠送、付费解锁，还是按次计费（如图片生成类）。价格单位为「权益点」。</div>
          <div className="bill-seg">
            {BILLING.map(([v, l, d]) => (
              <div key={v} className={`bill-opt ${billing === v ? 'on' : ''}`} onClick={() => { setBilling(v); if (v === 'free') setPrice(0); }}>
                <div className="bo-t">{l}</div><div className="bo-d">{d}</div>
              </div>
            ))}
          </div>
          {billing !== 'free' && (
            <div className="ai-field">
              <div className="ai-fl">{meterUnit === 'image' ? '每张消耗（钻石）' : '解锁价格（钻石）'}</div>
              <NumInput className="ai-input" min={0} value={price} onChange={setPrice} />
            </div>
          )}
          <div className="ai-field">
            <div className="ai-fl">计费单位</div>
            <div className="bill-seg">
              <div className={`bill-opt ${meterUnit === 'text' ? 'on' : ''}`} onClick={() => setMeterUnit('text')}>
                <div className="bo-t">文本 · token 额度</div><div className="bo-d">产出按 token×比例 扣本月额度</div>
              </div>
              <div className={`bill-opt ${meterUnit === 'image' ? 'on' : ''}`} onClick={() => setMeterUnit('image')}>
                <div className="bo-t">图片 · 按张钻石</div><div className="bo-d">每次产出按张扣钻石</div>
              </div>
            </div>
          </div>
          {meterUnit === 'text' && (
            <div className="ai-field">
              <div className="ai-fl">定价档位 / 计费比例 —— 调教越好倍率越高卖越贵（当前：{tierName(billingRatio)} ×{billingRatio}）</div>
              <div className="bill-seg" style={{ marginBottom: 8 }}>
                {([['标准', 1], ['进阶', 1.5], ['旗舰', 2]] as [string, number][]).map(([l, r]) => (
                  <div key={l} className={`bill-opt ${billingRatio === r ? 'on' : ''}`} onClick={() => setBillingRatio(r)}>
                    <div className="bo-t">{l}</div><div className="bo-d">×{r}</div>
                  </div>
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
            {VARS.map((v) => <span key={v} className="var" onClick={() => insertVar(v)}>＋ {v}</span>)}
          </div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="insight" size={15} /><span className="t">接入方式 / API</span><span className="badge">{modeLabel(mode)}</span></div>
          <div className="blk-d">为这位智能体单独指定后端：跟随全局模型、自定义 OpenAI 兼容端点，或绑定一个 Dify 应用（走 chat-messages 接口）。</div>
          <div className="bill-seg">
            {PROVIDER_MODES.map(([v, l, d]) => (
              <div key={v} className={`bill-opt ${mode === v ? 'on' : ''}`} onClick={() => { setMode(v); setTest(null); }}>
                <div className="bo-t">{l}</div><div className="bo-d">{d}</div>
              </div>
            ))}
          </div>

          {mode === 'openai' && (
            <>
              <div className="ai-field"><div className="ai-fl">Base URL</div><input className="ai-input" placeholder="https://api.deepseek.com/v1" value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} /></div>
              <div className="ai-field"><div className="ai-fl">模型</div><input className="ai-input" placeholder="deepseek-chat" value={apiModel} onChange={(e) => setApiModel(e.target.value)} /></div>
              <div className="ai-field"><div className="ai-fl">API Key{hasApiKey ? ' · 已配置' : ''}</div><input className="ai-input" type="password" placeholder={hasApiKey ? '已保存 · 留空则不修改' : 'sk-...'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></div>
            </>
          )}
          {/* 技能与「模型接入方式」解耦：跟随全局模型(inherit)或自定义 openai 端点都可配；dify 自带编排不显示 */}
          {mode !== 'dify' && (
            <>
              <div className="cfg">
                <div className="cfg-row">
                  <div className="cb"><div className="ct">启用技能（工具调用）</div><div className="cs">让模型自行调用知识库检索 / 记忆召回等工具后再作答（需 OpenAI 兼容或 Claude 模型；当前生效模型为 mock 或 Dify 接入时技能不会执行）</div></div>
                  <div className={`sw ${skillsEnabled ? 'on' : ''}`} onClick={() => setSkillsEnabled((v) => !v)}><i /></div>
                </div>
              </div>
              {skillsEnabled && (
                <div className="mem-list" style={{ marginTop: 8 }}>
                  {availTools.filter((t) => t.kind !== 'output').map((t) => {
                    const on = skillTools.includes(t.name);
                    return (
                      <div key={t.name} className="mem-card">
                        <span className="mi"><Icon name="insight" size={16} /></span>
                        <div className="mb"><div className="mt">{t.name}{t.builtin && <span className="tag off">内置</span>}</div><div className="mm">{t.description}</div></div>
                        <div className={`sw ${on ? 'on' : ''}`} onClick={() => setSkillTools((s) => on ? s.filter((x) => x !== t.name) : [...s, t.name])}><i /></div>
                      </div>
                    );
                  })}
                  {!availTools.some((t) => t.kind !== 'output') && <div className="blk-d">（暂无可用工具）</div>}
                </div>
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
              <div className="var-row">{INPUT_VARS.map((v) => <span key={v} className="var" onClick={() => setDifyInputsText((t) => t + (!t || t.endsWith('\n') ? '' : ' ') + v)}>＋ {v}</span>)}</div>
              <div className="blk-d" style={{ margin: '6px 0 0' }}>键 = 你在 Dify 应用里声明的输入变量名；值里可用上面的占位符，运行时按每个用户的真实上下文填充。多轮会自动用 Dify 的 conversation_id 续接。</div>
            </>
          )}

          {mode !== 'inherit' && (
            <div className="ai-field">
              <button className="ai-btn ghost auto" onClick={runTest} disabled={testing}><Icon name="spark" size={15} /> {testing ? '测试中…' : '测试连接'}</button>
              {test && <div className={`blk-d ${test.ok ? 'ok' : 'err'}`} style={{ marginTop: 8 }}>{test.ok ? `连通正常 · ${test.latencyMs ?? '-'}ms${test.sample ? ' · 样例：' + test.sample : ''}` : `失败：${test.error ?? '未知错误'}`}</div>}
            </div>
          )}
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="layers" size={15} /><span className="t">Agent Memory · 持续学习</span></div>
          <div className="blk-d">控制这位顾问如何从对话与企业资料中学习、沉淀长期记忆，越用越懂客户。</div>
          <div className="cfg">
            <div className="cfg-row">
              <div className="cb"><div className="ct">开启长期记忆</div><div className="cs">跨会话记住客户的偏好、结论与口径</div></div>
              <div className={`sw ${mem.longTerm ? 'on' : ''}`} onClick={() => setMem({ ...mem, longTerm: !mem.longTerm })}><i /></div>
            </div>
            <div className="cfg-row">
              <div className="cb"><div className="ct">从对话中自动学习</div><div className="cs">每次对话后提炼要点，写入长期记忆</div></div>
              <div className={`sw ${mem.autoLearn ? 'on' : ''}`} onClick={() => setMem({ ...mem, autoLearn: !mem.autoLearn })}><i /></div>
            </div>
            <div className="cfg-row">
              <div className="cb"><div className="ct">学习强度</div><div className="cs">更高更敏感，但也更易受单次对话影响</div></div>
              <div className="seg">{INTENSITY.map(([v, l]) => <b key={v} className={mem.intensity === v ? 'on' : ''} onClick={() => setMem({ ...mem, intensity: v as MemoryIntensity })}>{l}</b>)}</div>
            </div>
            <div className="cfg-row">
              <div className="cb"><div className="ct">记忆留存</div><div className="cs">超出时长的低价值记忆自动淡化</div></div>
              <div className="seg">{RETENTION.map(([v, l]) => <b key={v} className={mem.retentionDays === v ? 'on' : ''} onClick={() => setMem({ ...mem, retentionDays: v as number })}>{l}</b>)}</div>
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
                <div className={`sw ${mem.sources.includes(key as MemorySource) ? 'on' : ''}`} onClick={() => toggleSource(key as MemorySource)}><i /></div>
              </div>
            ))}
          </div>
          <div className="blk-d" style={{ margin: '9px 0 0' }}>记忆随真实使用持续积累（不展示估算值，避免误导）。</div>
        </div>
        <div style={{ height: 70 }} />
      </div>

      <div className="save-bar">
        <button className="gh" onClick={() => { setPrompt(data.systemPrompt); }} title="还原提示词"><Icon name="clock" size={16} /></button>
        <button className="gh gh-wide" onClick={save}><Icon name="check" size={16} /> 存草稿</button>
        <button className="sv" onClick={publish} disabled={publishing}><Icon name="spark" size={16} /> {publishing ? '发布中…' : '发布新版本'}</button>
      </div>
      </>)}
    </div>
  );
}

function billingLabel(b: AgentBilling) {
  return b === 'free' ? '免费赠送' : b === 'unlock' ? '付费解锁' : '按次计费';
}

function modeLabel(m: AgentProviderMode) {
  return m === 'inherit' ? '全局模型' : m === 'openai' ? '自定义端点' : 'Dify 应用';
}
