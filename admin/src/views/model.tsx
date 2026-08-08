// 模型配置：添加/切换模型 · 端点池分流 · 检索增强（嵌入/重排）。
import { useEffect, useState } from 'react';
import Icon from '../Icon';
import NumInput from '../NumInput';
import { api, type AiConfig, type AiPreset, type AiProvider, type AiThinkingMode, type AiModel, type AiRouting, type AiRoutingStatus, type AiModelUpsert, type AiDialectMeta, type AiProbeReport, type AiV2Status } from '../api';
import { Field } from '../format';
import { PageHead, ErrorState, Skeleton, ConfirmDialog, type ConfirmSpec } from '../components';
import { modelGatewayField, modelSupportsThinking, auxReuseBlock, probeName, dialectLine as fmtDialectLine, probeLine as fmtProbeLine, auxMissingReason } from '../modelGateway';
// —— 大模型配置：运营添加接入点（接入商 × 协议 × 方言三个正交维度）——
// 旧版这里有个 ModelMode（builtin/compatible/custom）三选一，那是假分类：把「你怎么填的表」
// 和「这是什么协议」混成一档。预设现在本身就是「厂商 × 协议」，三选一因此彻底没有意义，已删。
interface ModelForm {
  id?: string;          // 编辑时有
  preset: string;       // 选中的接入商预设 id（'' = 自定义手填）
  provider: AiProvider; // 线协议
  dialect: string;      // 协议方言；'' = 跟随接入商自动判定
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  thinkingMode: AiThinkingMode;
  thinkingBudget: number;
  priceInput: number;       // 元 / 1M 输入 token（内部成本核算）
  priceOutput: number;      // 元 / 1M 输出 token
  priceCachedInput: number; // 元 / 1M 命中缓存输入 token（0=同输入价）
  priceCacheWrite: number;  // 元 / 1M 写入缓存输入 token（0=按输入价 ×1.25 推导）
  hasKey: boolean;      // 编辑时该模型是否已存 key（决定 Key 占位符）
}

const BLANK_MODEL: ModelForm = {
  preset: '', provider: 'openai', dialect: '', label: '', baseUrl: '', model: '', apiKey: '',
  temperature: 0.7, thinkingMode: 'disabled', thinkingBudget: 1024,
  priceInput: 0, priceOutput: 0, priceCachedInput: 0, priceCacheWrite: 0, hasKey: false,
};

export function ModelView({ toast }: { toast: (m: string) => void }) {
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [presets, setPresets] = useState<AiPreset[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [form, setForm] = useState<ModelForm | null>(null);
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // 检索增强（向量嵌入 / 重排）——全局配置，不随对话模型切换变动；可独立配凭证，留空回退当前生效模型。
  const [aux, setAux] = useState({ embeddingEnabled: false, embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '' });
  const [auxTest, setAuxTest] = useState<{ ok: boolean; msg: string } | null>(null);
  // 端点池：多路分流 + 故障转移。单端点被上游限流时把流量转到同 tier 的其它端点。
  const [routing, setRouting] = useState<AiRoutingStatus | null>(null);
  // 协议方言目录：显式固化后这个端点不再靠推断组装请求（见 server/src/llm/dialects.ts）。
  const [dialects, setDialects] = useState<AiDialectMeta[]>([]);
  // 深度检测结果：按端点 id 存最近一次。
  const [probes, setProbes] = useState<Record<string, AiProbeReport>>({});
  // 归一化接入配置（三期）的就绪状态。只读展示——切换靠 AI_CONFIG_V2 环境变量，
  // 故意不做成后台开关：这是一次需要迁移窗口 + 观察期的读路径切换，不该一键点开。
  const [v2, setV2] = useState<AiV2Status | null>(null);

  const [loadErr, setLoadErr] = useState('');
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const load = () => api.aiConfig().then((v) => {
    setCfg(v.config); setPresets(v.presets); setModels(v.models);
    setLoadErr('');
    setAux({
      embeddingEnabled: v.config.embeddingEnabled, embeddingModel: v.config.embeddingModel, embeddingBaseUrl: v.config.embeddingBaseUrl, embeddingApiKey: '',
      rerankEnabled: v.config.rerankEnabled, rerankModel: v.config.rerankModel, rerankBaseUrl: v.config.rerankBaseUrl, rerankApiKey: '',
    });
  }).catch((e: unknown) => setLoadErr((e as Error)?.message || '模型配置加载失败'));
  const loadRouting = () => api.aiRouting().then(setRouting).catch(() => { /* 端点池状态次要，失败不挡主配置 */ });
  useEffect(() => {
    load();
    loadRouting();
    // 方言目录是代码常量，取一次即可；失败不挡主配置（端点行退回只显示推断值）。
    api.aiDialects().then((v) => setDialects(v.dialects)).catch(() => { /* 次要 */ });
    api.aiV2Status().then(setV2).catch(() => { /* 未迁移时后端也可能没这张表，忽略 */ });
  }, []);
  // 模型配置是「改一下全线上都变」的屏，加载失败必须明说并可重试，不能空白等着运营乱点。
  if (!cfg) {
    return (
      <>
        <PageHead k="model" />
        <div className="pad">{loadErr ? <ErrorState msg={loadErr} onRetry={load} /> : <Skeleton kind="stats" />}</div>
      </>
    );
  }

  const set = (p: Partial<ModelForm>) => setForm((f) => (f ? { ...f, ...p } : f));

  // 快速切换：点选某个已添加模型 → 即时生效。
  const activate = (m: AiModel) => {
    if (m.active || busy) return;
    setBusy(true);
    api.activateAiModel(m.id)
      .then((v) => { setCfg(v.config); setModels(v.models); toast(`已切换到「${m.label}」`); })
      .catch((e) => toast(e?.message || '切换失败'))
      .finally(() => setBusy(false));
  };
  const del = (m: AiModel) => {
    setConfirmSpec({
      title: '删除模型',
      desc: m.active
        ? '这是当前生效模型。删除后需立刻切换到别的模型，否则产出会降级到本地模板。'
        : '从已添加列表移除该模型；若它在分流池里也会一并移出。',
      echo: [{ k: '展示名', v: m.label }, { k: 'model', v: m.model }, { k: '状态', v: m.active ? '当前生效' : m.poolEnabled ? '在分流池' : '未启用' }],
      warn: m.active ? '正在被线上使用。' : undefined,
      confirmText: '删除模型',
      danger: true,
      onConfirm: async () => { await api.delAiModel(m.id); toast('已删除'); load(); },
    });
  };
  // 入池/出池：只改 poolEnabled，不动其它字段（PATCH 是 patch 语义，未传的不改）。
  const togglePool = (m: AiModel) => {
    if (busy) return;
    setBusy(true);
    api.updateAiModel(m.id, { provider: m.provider, label: m.label, model: m.model, poolEnabled: !m.poolEnabled })
      .then(() => { toast(m.poolEnabled ? `「${m.label}」已移出分流池` : `「${m.label}」已加入分流池`); load(); loadRouting(); })
      .catch((e) => toast(e?.message || '操作失败'))
      .finally(() => setBusy(false));
  };
  // 单个端点的池参数（权重 / 备份层 / 每实例并发上限）。
  const setPoolField = (m: AiModel, patch: { weight?: number; tier?: number; maxConcurrency?: number }) => {
    api.updateAiModel(m.id, { provider: m.provider, label: m.label, model: m.model, ...patch })
      .then(() => { load(); loadRouting(); })
      .catch((e) => toast(e?.message || '保存失败'));
  };
  const saveRouting = (patch: Partial<AiRouting>) => {
    api.saveAiRouting(patch)
      .then((r) => { setRouting(r); toast('已保存路由设置'); })
      .catch((e) => toast(e?.message || '保存失败'));
  };
  // 深度检测：连通性 + thinking 写法 + 模型范围。结果回填能力标记，校验器立刻据此拦截。
  // 只跑这三项而不是全部八项：它们最便宜、覆盖了线上最常炸的那几类，且不产生长输出账单。
  const probe = (m: AiModel) => {
    if (busy) return;
    setBusy(true);
    api.probeAiModel(m.id, ['connectivity', 'thinking', 'model_scope'])
      .then((r) => {
        setProbes((prev) => ({ ...prev, [m.id]: r }));
        const bad = r.results.filter((x) => !x.ok);
        toast(bad.length ? `检测未通过：${bad.map((x) => `${probeName(x.kind)}(${x.error || '失败'})`).join('；')}` : '检测全部通过');
        load(); // 能力标记可能被回填，刷新列表
      })
      .catch((e) => toast(e?.message || '检测请求失败'))
      .finally(() => setBusy(false));
  };
  // 「确认固化」：把当前推断出的方言写死进这个端点，从此不再靠猜。
  const fixDialect = (m: AiModel) => {
    const target = m.resolvedDialect;
    if (!target || busy) return;
    setBusy(true);
    api.updateAiModel(m.id, { provider: m.provider, label: m.label, model: m.model, dialect: target })
      .then(() => { toast(`已固化方言：${dialectLabel(target)}`); load(); })
      .catch((e) => toast(e?.message || '固化失败'))
      .finally(() => setBusy(false));
  };
  const dialectLabel = (id?: string | null) => dialects.find((d) => d.id === id)?.label || id || '未知';
  // 展示口径全部收在 modelGateway 的纯函数里（可单测）；这里只做取值绑定。
  const dialectLine = (m: AiModel) => fmtDialectLine(m, dialectLabel);
  const probeLine = (m: AiModel) => fmtProbeLine(m, probes[m.id]);
  const edit = (m: AiModel) => {
    setTest(null);
    setForm({
      id: m.id, preset: m.preset || '', provider: m.provider, dialect: m.dialect || '',
      label: m.label, baseUrl: m.baseUrl, model: m.model,
      apiKey: '', temperature: m.temperature,
      thinkingMode: m.thinkingMode, thinkingBudget: m.thinkingBudget,
      priceInput: m.priceInput, priceOutput: m.priceOutput, priceCachedInput: m.priceCachedInput,
      priceCacheWrite: m.priceCacheWrite, hasKey: m.hasKey,
    });
  };

  // —— 添加/编辑表单 ——
  if (form) {
    const applyPreset = (id: string) => {
      setTest(null);
      const p = presets.find((x) => x.id === id);
      if (!p) { set({ preset: '' }); return; }  // 自定义：只清预设标记，已填的地址/模型保留
      set({
        preset: p.id, provider: p.provider, dialect: '',
        label: form.label.trim() ? form.label : p.label, baseUrl: p.baseUrl, model: p.model,
      });
    };
    const gatewayField = modelGatewayField(form.provider);
    const showKey = form.provider !== 'mock';
    const showThinking = modelSupportsThinking(form.provider, form.model);
    const thinkingOn = form.thinkingMode !== 'disabled';
    const setThinkingMode = (thinkingMode: AiThinkingMode) => set({ thinkingMode });

    const testModel = async () => {
      setBusy(true); setTest(null);
      try {
        const r = await api.testAiModel({
          provider: form.provider, label: form.label, baseUrl: form.baseUrl, model: form.model,
          temperature: Number(form.temperature),
          thinkingMode: form.thinkingMode, thinkingBudget: Number(form.thinkingBudget),
          ...(form.apiKey ? { apiKey: form.apiKey } : {}), ...(form.id ? { modelId: form.id } : {}),
        });
        setTest({ ok: r.ok, msg: r.ok ? `连通 · ${r.latencyMs}ms · ${r.model}${r.sample ? ' · 「' + r.sample + '」' : ''}` : (r.error || '未连通') });
      } catch { setTest({ ok: false, msg: '测试请求失败' }); }
      setBusy(false);
    };
    const saveModel = () => {
      if (!form.label.trim()) { toast('请填写展示名'); return; }
      if (form.provider !== 'mock' && !form.model.trim()) { toast('请填写模型 model'); return; }
      const body: AiModelUpsert = {
        provider: form.provider, label: form.label.trim(), baseUrl: form.baseUrl.trim(), model: form.model.trim(),
        temperature: Number(form.temperature), preset: form.preset || null,
        dialect: form.dialect || null,
        thinkingMode: form.thinkingMode, thinkingBudget: Number(form.thinkingBudget),
        priceInput: Number(form.priceInput) || 0, priceOutput: Number(form.priceOutput) || 0,
        priceCachedInput: Number(form.priceCachedInput) || 0, priceCacheWrite: Number(form.priceCacheWrite) || 0,
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      };
      const p = form.id ? api.updateAiModel(form.id, body) : api.addAiModel(body);
      p.then(() => { toast(form.id ? '已更新' : '已添加'); setForm(null); load(); }).catch((e) => toast(e?.message || '保存失败'));
    };

    return (
      <>
        <div className="sec-h"><span className="t">{form.id ? '编辑模型' : '添加模型'}</span><span className="s">{form.id ? '保存后若为生效模型则即时更新' : '保存后进入快速切换'}</span></div>
        <div className="pad">
          {/* 接入商 × 协议 —— 两个正交维度。
              旧版这里是「内置接入商 / 通用兼容协议 / 完全自主定义」三选一，那是个假分类：
              它把「你怎么填的表」和「这是什么协议」混成一档，而协议只在「完全自主定义」下才露面。
              预设本身现在已经是「厂商 × 协议」（七牛占两条：Anthropic 与 OpenAI 兼容各一），
              所以这里改成先选接入商、协议随之带出且始终可见可改。 */}
          <Field label="接入商">
            <select className="ai-input" value={form.preset} onChange={(e) => applyPreset(e.target.value)}>
              <option value="">自定义（手填网关地址）</option>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.label}{p.note ? ` · ${p.note}` : ''}</option>)}
            </select>
          </Field>

          <Field label="协议">
            <select className="ai-input" value={form.provider} onChange={(e) => set({ provider: e.target.value as AiProvider, dialect: '' })}>
              <option value="claude">Anthropic 协议（/v1/messages）</option>
              <option value="openai">OpenAI 兼容协议（/v1/chat/completions）</option>
              <option value="mock">本地模板（不外呼）</option>
            </select>
          </Field>
          <div className="ai-note" style={{ marginTop: 0, marginBottom: 12 }}>
            协议决定请求长什么样，**不是模型名的属性**——同一家厂商的两种协议是两个不同的网关地址，选错就是上线后 404/400。
          </div>

          {form.provider !== 'mock' && dialects.length > 0 && (
            <>
              <Field label="协议方言">
                <select className="ai-input" value={form.dialect} onChange={(e) => set({ dialect: e.target.value })}>
                  <option value="">跟随接入商自动判定</option>
                  {dialects.filter((d) => d.protocol === (form.provider === 'claude' ? 'anthropic' : 'openai_chat'))
                    .map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              </Field>
              <div className="ai-note" style={{ marginTop: 0, marginBottom: 12 }}>
                同一协议下各家的细节写法不同（关闭思考是省略字段还是显式发、能不能带思考预算）。
                留「自动判定」即按接入商推断；确认过就显式选定，这个端点从此不靠猜。
              </div>
            </>
          )}

          <Field label="展示名"><input className="ai-input" value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder="Agnes 2.0 Flash" /></Field>
          {gatewayField.visible && (
            <>
              <Field label={gatewayField.label}><input className="ai-input" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={gatewayField.placeholder} /></Field>
              {gatewayField.note && <div className="ai-note" style={{ marginTop: 0, marginBottom: 12 }}>{gatewayField.note}</div>}
            </>
          )}
          {form.provider !== 'mock' && (
            <Field label="模型 model"><input className="ai-input" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="agnes-2.0-flash" /></Field>
          )}
          {showKey && (
            <Field label={`API Key${form.id && form.hasKey ? '（已配置，留空=不改）' : ''}`}>
              <input className="ai-input" type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={form.id && form.hasKey ? '••••••（留空保留现有）' : '粘贴 API Key'} />
            </Field>
          )}
          {form.provider !== 'mock' && (
            <div className="ai-note" style={{ marginTop: 0, marginBottom: 12 }}>嵌入 / 重排模型不在这里配——它们是「检索增强」的全局配置(下方),独立于对话模型、不随切换变动。</div>
          )}
          <Field label={`配置温度 temperature · ${form.temperature}${thinkingOn ? '（思考请求实际为 1）' : ''}`}>
            <input className="ai-range" type="range" min={0} max={1} step={0.1} value={form.temperature} disabled={thinkingOn} onChange={(e) => set({ temperature: Number(e.target.value) })} />
          </Field>
          {showThinking && (
            <>
              <Field label="Thinking 思考模式">
                <div className="bill-seg">
                  {([
                    ['disabled', '关闭'],
                    ['enabled', '手动预算'],
                    ['adaptive', '自适应（4.6）'],
                  ] as const).map(([v, l]) => (
                    <div key={v} className={`bill-opt ${form.thinkingMode === v ? 'on' : ''}`} onClick={() => setThinkingMode(v)}>
                      <div className="bo-t">{l}</div>
                    </div>
                  ))}
                </div>
              </Field>
              {form.thinkingMode === 'enabled' && (
                <Field label="思考预算 budget_tokens（1024–7000）">
                  <input
                    className="ai-input"
                    type="number"
                    min={1024}
                    max={7000}
                    step={256}
                    value={form.thinkingBudget}
                    onChange={(e) => set({ thinkingBudget: Number(e.target.value) })}
                  />
                </Field>
              )}
              <div className="ai-note">
                开启思考后，仅实际思考请求临时使用 temperature=1；这里会保留原配置值，关闭思考后自动恢复。测试连接会携带当前 Thinking 配置。结构化成果和多轮工具调用按 Anthropic 限制自动关闭思考，并使用保留的配置温度。
              </div>
            </>
          )}

          {form.provider !== 'mock' && (
            <>
              <div className="ai-note" style={{ marginTop: 0, marginBottom: 8 }}>Token 单价（元 / 1M token）· 仅用于内部成本核算，不影响对用户计费 · 输入价与输出价必须同时填，缺一档整个模型不校准（成本记 0）。</div>
              <Field label="输入单价（元 / 1M token）"><NumInput className="ai-input" min={0} step={0.01} value={form.priceInput} onChange={(priceInput) => set({ priceInput })} /></Field>
              <Field label="输出单价（元 / 1M token）"><NumInput className="ai-input" min={0} step={0.01} value={form.priceOutput} onChange={(priceOutput) => set({ priceOutput })} /></Field>
              <Field label="缓存读单价（元 / 1M token · 0=同输入价）"><NumInput className="ai-input" min={0} step={0.01} value={form.priceCachedInput} onChange={(priceCachedInput) => set({ priceCachedInput })} /></Field>
              <Field label="缓存写单价（元 / 1M token · 0=按输入价 ×1.25 推导）"><NumInput className="ai-input" min={0} step={0.01} value={form.priceCacheWrite} onChange={(priceCacheWrite) => set({ priceCacheWrite })} /></Field>
              <div className="ai-note" style={{ marginTop: 0, marginBottom: 12 }}>缓存写默认按 Anthropic 5 分钟 TTL 的 1.25× 推导。用 1 小时 TTL（2×）、或供应商按统一单价结算（此时应填成与输入价相同）时，必须在这里显式填，否则成本会系统性偏差。</div>
            </>
          )}

          {test && <div className={`ai-test ${test.ok ? 'ok' : 'err'}`}><Icon name={test.ok ? 'check' : 'alert'} size={13} /> {test.msg}</div>}

          <div className="ai-actions">
            <button className="ai-btn ghost" onClick={testModel} disabled={busy}><Icon name="spark" size={14} /> 测试连接</button>
            <button className="ai-btn primary" onClick={saveModel} disabled={busy}><Icon name="check" size={14} /> {form.id ? '保存' : '添加'}</button>
          </div>
          <div className="ai-actions" style={{ marginTop: 10 }}>
            <button className="ai-btn ghost" onClick={() => setForm(null)}>取消</button>
          </div>
        </div>
      </>
    );
  }

  // —— 检索增强（嵌入 / 重排）：全局开关 + 独立凭证 ——
  // 「留空＝复用对话模型」不是永远可用的：对话端点走 Anthropic 协议时拼出的 /embeddings 不存在；
  // 七牛这类不提供嵌入的厂商即使协议合法也必定失败。命中任一条就必须显式填网关与 Key。
  const reuse = auxReuseBlock(cfg.provider, cfg.baseUrl);
  const setA = (p: Partial<typeof aux>) => setAux((a) => ({ ...a, ...p }));
  /** 闸门命中且开了增强项却没填独立网关 → 这份配置存下去必然静默失败，先拦住。 */
  const auxMissing = () => auxMissingReason(reuse.blocked, aux, cfg);
  const auxPayload = () => ({
    embeddingEnabled: aux.embeddingEnabled, embeddingModel: aux.embeddingModel, embeddingBaseUrl: aux.embeddingBaseUrl,
    rerankEnabled: aux.rerankEnabled, rerankModel: aux.rerankModel, rerankBaseUrl: aux.rerankBaseUrl,
    ...(aux.embeddingApiKey ? { embeddingApiKey: aux.embeddingApiKey } : {}),
    ...(aux.rerankApiKey ? { rerankApiKey: aux.rerankApiKey } : {}),
  });
  const testAux = async () => {
    setBusy(true); setAuxTest(null);
    try {
      const r = await api.testAiConfig(auxPayload());
      const parts: string[] = [];
      if (r.embedding) parts.push(`嵌入 ${r.embedding.ok ? '连通' + (r.embedding.dim ? `·${r.embedding.dim}维` : '') : (r.embedding.error || '未连通')}`);
      if (r.rerank) parts.push(`重排 ${r.rerank.ok ? '连通' : (r.rerank.error || '未连通')}`);
      const ok = (!r.embedding || r.embedding.ok) && (!r.rerank || r.rerank.ok);
      setAuxTest({ ok, msg: parts.length ? parts.join(' ｜ ') : '未开启任何增强项' });
    } catch { setAuxTest({ ok: false, msg: '测试请求失败' }); }
    setBusy(false);
  };
  const saveAux = async () => {
    const missing = auxMissing();
    if (missing) { toast(missing); return; }
    setBusy(true);
    try { const v = await api.saveAiConfig(auxPayload()); setCfg(v.config); setAux((a) => ({ ...a, embeddingApiKey: '', rerankApiKey: '' })); toast('检索增强配置已保存并即时生效'); }
    catch { toast('保存失败'); }
    setBusy(false);
  };

  // —— 列表 + 快速切换 ——
  // 检索增强「生效」判定：开关开 + 有模型 + (独立 baseUrl 或回退对话模型 baseUrl) + (独立 key 或回退对话模型 key)。
  const baseKey = cfg.hasKey;
  const embReady = cfg.embeddingEnabled && !!cfg.embeddingModel && (!!cfg.embeddingBaseUrl || !!cfg.baseUrl) && (cfg.hasEmbeddingKey || baseKey);
  const rerankReady = cfg.rerankEnabled && !!cfg.rerankModel && (!!cfg.rerankBaseUrl || !!cfg.baseUrl) && (cfg.hasRerankKey || baseKey);
  return (
    <>
      <PageHead
        k="model"
        badge={`${models.length} 个模型`}
        res={{ loading: false, reload: () => { load(); loadRouting(); }, updatedAt: 0 }}
      />
      {loadErr && <div className="pad"><ErrorState msg={loadErr} onRetry={load} /></div>}
      <div className="pad">
        {/* 当前生效状态 */}
        <div className={`ai-status ${cfg.ready ? 'on' : 'off'}`}>
          <span className="dot" />
          <div className="b">
            <div className="t">{cfg.label} · {cfg.model}</div>
            <div className="s">
              {cfg.ready
                ? `已就绪 · provider=${cfg.provider}`
                : `未配置 Key，当前实际走「本地模板 mock」兜底（provider=${cfg.provider}）`}
            </div>
          </div>
        </div>

        {/* ── 接入点 ──────────────────────────────────────────────────────────
            旧版这里是三块：「快速切换」（一排按钮）+「已添加模型」（一排卡片）+「端点池」
            （权重/备份层/并发另起一个分区）。前两块是同一批对象渲染两遍；第三块把同一个端点
            的属性劈到了两个地方，运营要来回找。现在合成一块：一行一个接入点，它的全部属性和
            操作都在这一行里。 */}
        <div className="ai-label">接入点 · {models.length} 个</div>
        {models.length === 0 && <div className="usage-meta" style={{ padding: '10px 0' }}>还没有接入点。点下方「添加接入点」接一个上游。</div>}
        {models.map((m) => {
          const st = routing?.endpoints.find((x: AiRoutingStatus['endpoints'][number]) => x.id === m.id);
          return (
            <div key={m.id} className="mem-card">
              <span className="mi"><Icon name="insight" size={16} /></span>
              <div className="mb" style={{ cursor: 'pointer' }} onClick={() => edit(m)}>
                <div className="mt">
                  {m.label}
                  {m.active && <span className="tag" style={{ marginLeft: 6 }}>对话生效中</span>}
                  {m.poolEnabled && <span className="tag" style={{ marginLeft: 6 }}>在分流池</span>}
                  {st?.cooling && <span className="tag off" style={{ marginLeft: 6 }}>冷却中</span>}
                  {!m.hasKey && m.provider !== 'mock' && <span className="tag" style={{ marginLeft: 6 }}>未配 Key</span>}
                </div>
                {/* 第一行＝这个端点「是什么」：协议 · 模型 · 思考 · 方言 */}
                <div className="mm">
                  {m.provider === 'claude' ? 'Anthropic 协议' : m.provider === 'openai' ? 'OpenAI 兼容' : '本地模板'}
                  {' · '}{m.model || '—'}
                  {modelSupportsThinking(m.provider, m.model) ? ` · Thinking:${m.thinkingMode}` : ''}
                  {dialectLine(m) ? ` · ${dialectLine(m)}` : ''}
                </div>
                {/* 第二行＝「花多少钱、健不健康」 */}
                <div className="mm">
                  {(m.priceInput > 0 && m.priceOutput > 0) ? `单价 入¥${m.priceInput}/出¥${m.priceOutput} 每1M` : '单价待配（成本记 0）'}
                  {probeLine(m)}
                  {st?.cooling && st.coolingUntil ? ` · ${st.coolingReason === 'rate_limited' ? '被限流' : '连续报错'}，${new Date(st.coolingUntil).toLocaleTimeString()} 后恢复` : ''}
                </div>
              </div>
              {!m.active && <button className="mini-btn" onClick={() => activate(m)} disabled={busy} title="把对话用途切到这个接入点">设为对话生效</button>}
              <button className="mini-btn" disabled={busy} title="跑一遍连通性 / Thinking 写法 / 模型范围三项检测，结果会回填能力标记" onClick={() => probe(m)}>检测</button>
              {!m.dialect && m.resolvedDialect && m.provider !== 'mock' && (
                <button className="mini-btn" disabled={busy} title="把当前推断出的协议方言写死到这个端点，之后请求组装不再靠推断" onClick={() => fixDialect(m)}>固化方言</button>
              )}
              <button className={`mini-btn ${m.poolEnabled ? 'primary' : ''}`} disabled={busy} title={m.poolEnabled ? '已在分流池内，点击移出' : '加入分流池，参与多路分流与故障转移'} onClick={() => togglePool(m)}>
                {m.poolEnabled ? '移出池' : '入池'}
              </button>
              <button className="mini-btn danger" onClick={() => del(m)}>删除</button>
              {/* 池参数内联：它是这个端点的属性，不该跑到另一个分区去 */}
              {m.poolEnabled && routing?.mode === 'pool' && (
                <div className="usage-row" style={{ width: '100%' }}>
                  <Field label="权重">
                    <input className="ai-input" type="number" min={1} defaultValue={m.weight}
                      onBlur={(e) => { const v = Math.max(1, Number(e.target.value) || 1); if (v !== m.weight) setPoolField(m, { weight: v }); }} />
                  </Field>
                  <Field label="备份层">
                    <input className="ai-input" type="number" min={0} defaultValue={m.tier}
                      onBlur={(e) => { const v = Math.max(0, Number(e.target.value) || 0); if (v !== m.tier) setPoolField(m, { tier: v }); }} />
                  </Field>
                  <Field label="并发/实例">
                    <input className="ai-input" type="number" min={0} defaultValue={m.maxConcurrency}
                      onBlur={(e) => { const v = Math.max(0, Number(e.target.value) || 0); if (v !== m.maxConcurrency) setPoolField(m, { maxConcurrency: v }); }} />
                  </Field>
                </div>
              )}
            </div>
          );
        })}
        <button className="add-btn full" onClick={() => { setTest(null); setForm({ ...BLANK_MODEL }); }}>＋ 添加接入点</button>

        {/* ── 路由：哪个用途用哪些接入点 ────────────────────────────────────
            旧版把「对话怎么分流」叫「端点池」、把「嵌入/重排用谁」叫「检索增强」，
            两者结构其实同构（用途 → 接入点），界面却是完全不同的两套，运营要学两遍。
            现在归到同一层「路由」之下。 */}
        <div className="ai-label" style={{ marginTop: 18 }}>路由 · 哪个用途用哪些接入点</div>

        <div className="ai-sub">
          <div className="ai-sub-h">
            <div className="b">
              <div className="t">对话 / 成果 · 多路分流</div>
              <div className="s">
                {routing?.mode === 'pool'
                  ? `分流中：${models.filter((m) => m.poolEnabled).length} 个接入点参与。撞 429/5xx 自动转移并冷却该端点`
                  : '关＝只用「对话生效中」那一个；开＝按权重分流，某个端点被限流时全站 AI 不会一起停摆'}
              </div>
            </div>
            <div className={`sw ${routing?.mode === 'pool' ? 'on' : ''}`} onClick={() => saveRouting({ mode: routing?.mode === 'pool' ? 'single' : 'pool' })}><i /></div>
          </div>
          {routing?.mode === 'pool' && (
            <div className="ai-sub-h">
              <div className="b"><div className="t">会话粘性</div><div className="s">同一会话固定落同一端点。上游提示词缓存按账号隔离，关掉会把缓存打散、成本上升——除非确有均散需求，否则保持开启</div></div>
              <div className={`sw ${routing.sticky ? 'on' : ''}`} onClick={() => saveRouting({ sticky: !routing.sticky })}><i /></div>
            </div>
          )}
          {routing?.mode === 'pool' && models.filter((m) => m.poolEnabled).length === 0 && (
            <div className="usage-meta" style={{ padding: '10px 0' }}>分流已开但池里没有接入点——在上面的列表里点「入池」，否则等于没开。</div>
          )}
          {routing?.mode === 'pool' && (
            <div className="ai-note">
              权重＝分流占比（按权重摊，不是均分），在上面每个接入点行内直接改。备份层 0＝正常分流；
              填 1 以上＝降级备份，只有第 0 层全部冷却时才启用——放不同模型会改变回答质量，按需使用。
              并发是<b>每个实例</b>的上限，多实例部署请按实例数分摊；0＝用全局默认。
            </div>
          )}
        </div>

        {/* 嵌入 / 重排：结构上就是另外两个用途的路由，故与上面的分流开关同属「路由」层。 */}
        <div className="ai-label" style={{ marginTop: 14 }}>检索增强用途 · 嵌入与重排</div>
        <div className={`ai-test ${embReady || rerankReady ? 'ok' : 'err'}`} style={{ margin: '0 0 12px' }}>
          <Icon name={embReady || rerankReady ? 'check' : 'alert'} size={13} />
          <span>当前生效：嵌入 {embReady ? `远程·${cfg.embeddingModel}` : '本地确定性兜底'} ｜ 重排 {rerankReady ? `远程·${cfg.rerankModel}` : '未启用（融合分顺序）'}。配置可用≠每次调用都成功——点下方「测试增强项」实地探活；调用失败会静默回退本地。</span>
        </div>
        {reuse.blocked && (
          <div className="ai-test err" style={{ margin: '0 0 12px' }}>
            <Icon name="alert" size={13} />
            <span>{reuse.reason}留空不会报错，只会在每次检索时静默回退本地嵌入——所以这里必须填满，不能靠「复用对话模型」。</span>
          </div>
        )}
        <div className="ai-sub">
          <div className="ai-sub-h">
            <div className="b"><div className="t">向量嵌入 Embedding</div><div className="s">关＝本地确定性嵌入（零依赖）；开＝调用嵌入模型，语义召回更准</div></div>
            <div className={`sw ${aux.embeddingEnabled ? 'on' : ''}`} onClick={() => setA({ embeddingEnabled: !aux.embeddingEnabled })}><i /></div>
          </div>
          {aux.embeddingEnabled && (
            <>
              <Field label="嵌入模型 model"><input className="ai-input" value={aux.embeddingModel} onChange={(e) => setA({ embeddingModel: e.target.value })} placeholder="text-embedding-3-small / text-embedding-v3" /></Field>
              <Field label={`接入地址 baseUrl${reuse.blocked ? '（必填）' : '（留空＝复用当前生效模型）'}`}>
                <input className="ai-input" value={aux.embeddingBaseUrl} onChange={(e) => setA({ embeddingBaseUrl: e.target.value })} placeholder={reuse.blocked ? '如 https://api.siliconflow.cn/v1' : '留空复用对话模型网关'} />
              </Field>
              <Field label={`API Key${cfg.hasEmbeddingKey ? '（已配置，留空＝不改）' : reuse.blocked ? '（必填）' : '（留空＝复用对话模型）'}`}>
                <input className="ai-input" type="password" value={aux.embeddingApiKey} onChange={(e) => setA({ embeddingApiKey: e.target.value })} placeholder={cfg.hasEmbeddingKey ? '••••••（留空保留现有）' : reuse.blocked ? '粘贴该厂商的 API Key' : '留空复用对话模型 Key'} />
              </Field>
            </>
          )}
        </div>

        <div className="ai-sub">
          <div className="ai-sub-h">
            <div className="b"><div className="t">重排 Rerank</div><div className="s">开＝知识库检索融合打分后，再用 rerank 模型重排候选，提升 TopN 命中</div></div>
            <div className={`sw ${aux.rerankEnabled ? 'on' : ''}`} onClick={() => setA({ rerankEnabled: !aux.rerankEnabled })}><i /></div>
          </div>
          {aux.rerankEnabled && (
            <>
              <Field label="重排模型 model"><input className="ai-input" value={aux.rerankModel} onChange={(e) => setA({ rerankModel: e.target.value })} placeholder="bge-reranker-v2-m3 / rerank-3 …" /></Field>
              <Field label={`接入地址 baseUrl${reuse.blocked ? '（必填）' : '（留空＝复用当前生效模型）'}`}>
                <input className="ai-input" value={aux.rerankBaseUrl} onChange={(e) => setA({ rerankBaseUrl: e.target.value })} placeholder="如 https://api.siliconflow.cn/v1" />
              </Field>
              <Field label={`API Key${cfg.hasRerankKey ? '（已配置，留空＝不改）' : reuse.blocked ? '（必填）' : '（留空＝复用对话模型）'}`}>
                <input className="ai-input" type="password" value={aux.rerankApiKey} onChange={(e) => setA({ rerankApiKey: e.target.value })} placeholder={cfg.hasRerankKey ? '••••••（留空保留现有）' : reuse.blocked ? '粘贴该厂商的 API Key' : '留空复用对话模型 Key'} />
              </Field>
            </>
          )}
        </div>

        {auxTest && <div className={`ai-test ${auxTest.ok ? 'ok' : 'err'}`}><Icon name={auxTest.ok ? 'check' : 'alert'} size={13} /> {auxTest.msg}</div>}
        <div className="ai-actions">
          <button className="ai-btn ghost" onClick={testAux} disabled={busy}><Icon name="spark" size={14} /> 测试增强项</button>
          <button className="ai-btn primary" onClick={saveAux} disabled={busy}><Icon name="check" size={14} /> 保存检索增强</button>
        </div>
        <div className="ai-note">提示：未配置真实 Key 时系统自动降级本地模板（mock）/ 本地嵌入，保证可用；切换后所有顾问产出 / 记忆提炼 / 对话汇总即走该模型。嵌入 / 重排为全局配置，不随对话模型切换变动。</div>
      </div>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}