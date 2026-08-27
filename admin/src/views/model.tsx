// 模型配置：接入点 · 按用途路由 · 凭证。
//
// ── 这一版为什么长这样 ────────────────────────────────────────────────────────
// 旧版读写的是 `AiSetting` + `AiModel`：「生效」是把 8 个字段拷进单例、每个模型各存一份 key、
// 只有一个全局配置。界面因此被迫分成「快速切换 / 已添加模型 / 端点池 / 检索增强」四块并列——
// 前两块是同一批对象渲染两遍，第三块把端点自身的属性劈到另一个分区，第四块其实是另外两个
// 用途的路由却另起一套 UI。
//
// 现在后台直接写四张归一化表，界面按真实结构分三层：
//   ① 接入点 —— 一行一个上游，它的全部属性与操作都在这一行
//   ② 路由   —— 哪个用途用哪些接入点（对话/成果/辅助抽取/嵌入/重排同构，不再各写一套）
//   ③ 凭证   —— 换 key 的唯一入口；一把 key 喂多个端点，改一次全生效
import { useEffect, useState } from 'react';
import Icon from '../Icon';
import NumInput from '../NumInput';
import {
  api, type AiProvider, type AiThinkingMode, type AiV2View, type AiEndpointView,
  type AiRouteView, type AiRoutingStatus, type AiEndpointUpsert, type AiProbeReport, type AiRouteBudget,
  type AiConfigIssue,
} from '../api';
import { Field } from '../format';
import { PageHead, ErrorState, Skeleton, ConfirmDialog, Switch, type ConfirmSpec } from '../components';
import { modelGatewayField, modelSupportsThinking, auxReuseBlock, routeMemberRow } from '../modelGateway';

/** 用途的中文名与说明。后台不该把 purpose 的英文枚举直接甩给运营。 */
const PURPOSE_META: Record<string, { name: string; desc: string }> = {
  chat: { name: '对话', desc: '用户可见的问答主路径' },
  deliverable: { name: '成果生成', desc: '报告/方案等结构化产出，异步生成可给更长时间' },
  aux: { name: '辅助抽取', desc: '记忆提炼 / 预言抽取 / 会话标题。以前只能改环境变量，现在能在这里配' },
  embedding: { name: '向量嵌入', desc: '知识库与记忆的语义召回；留空则用本地确定性兜底' },
  rerank: { name: '重排', desc: '融合打分后再排一遍候选，提升 TopN 命中' },
  moderation: { name: '内容审核', desc: '预留用途，暂未接入' },
};
const purposeName = (p: string) => PURPOSE_META[p]?.name ?? p;

const PROBE_NAMES: Record<string, string> = {
  connectivity: '连通性', model_scope: '模型范围', thinking: 'Thinking 写法', tools: '工具调用',
  streaming: '流式', long_output: '长输出', embedding: '嵌入', rerank: '重排',
};
const probeName = (k: string) => PROBE_NAMES[k] ?? k;

interface EndpointForm {
  id?: string;
  preset: string;
  provider: AiProvider;
  dialect: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  thinkingMode: AiThinkingMode;
  thinkingBudget: number;
  priceInput: number;
  priceOutput: number;
  priceCachedInput: number;
  priceCacheWrite: number;
  hasKey: boolean;
}

const BLANK: EndpointForm = {
  preset: '', provider: 'openai', dialect: '', label: '', baseUrl: '', model: '', apiKey: '',
  temperature: 0.7, thinkingMode: 'disabled', thinkingBudget: 1024,
  priceInput: 0, priceOutput: 0, priceCachedInput: 0, priceCacheWrite: 0, hasKey: false,
};

export function ModelView({ toast }: { toast: (m: string) => void }) {
  const [v2, setV2] = useState<AiV2View | null>(null);
  const [routing, setRouting] = useState<AiRoutingStatus | null>(null);
  const [form, setForm] = useState<EndpointForm | null>(null);
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [probes, setProbes] = useState<Record<string, AiProbeReport>>({});
  const [credentialForm, setCredentialForm] = useState<{ id: string; label: string; vendor: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [routingErr, setRoutingErr] = useState('');
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);

  const load = () => api.aiV2().then((v) => { setV2(v); setLoadErr(''); })
    .catch((e: unknown) => setLoadErr((e as Error)?.message || '接入配置加载失败'));
  const loadRouting = () => api.aiRouting()
    .then((value) => { setRouting(value); setRoutingErr(''); })
    .catch((e: unknown) => { setRouting(null); setRoutingErr((e as Error)?.message || '端点冷却状态加载失败'); });
  useEffect(() => { load(); loadRouting(); }, []);

  // 这是「改一下全线上都变」的屏，加载失败必须明说并可重试，不能空白等着运营乱点。
  if (!v2) {
    return (
      <>
        <PageHead k="model" />
        <div className="pad">{loadErr ? <ErrorState msg={loadErr} onRetry={load} /> : <Skeleton kind="stats" />}</div>
      </>
    );
  }

  const set = (p: Partial<EndpointForm>) => setForm((f) => (f ? { ...f, ...p } : f));
  const epById = (id: string) => v2.endpoints.find((e) => e.id === id);
  const routeOf = (purpose: string) => v2.routes.find((r) => r.purpose === purpose);
  const chat = routeOf('chat');
  const chatPrimary = chat?.members.find((m) => m.primary);
  const activeEp = chatPrimary ? epById(chatPrimary.endpointId) : undefined;
  const dialectLabel = (id?: string | null) => v2.dialects.find((d) => d.id === id)?.label || id || '未知';

  const after = (msg: string) => { toast(msg); load(); loadRouting(); };
  const fail = (e: unknown) => toast((e as Error)?.message || '操作失败');
  // 非阻断提醒必须跟着这次操作说出来。校验器的口径是「warn＝能跑，但结果不是运营以为的那样」，
  // 可这些入口此前把 issues 整个丢掉——于是「池子还在混协议、少数协议的成员收不到流量」这种
  // 保存成功但没达到意图的事，运营在界面上一个字都看不到。
  const run = (p: Promise<unknown>, msg: string) => {
    setBusy(true);
    p.then((r) => {
      const warns = ((r as { issues?: AiConfigIssue[] } | null)?.issues ?? []).filter((i) => i.level !== 'error');
      after(warns.length ? `${msg}；仍有提醒：${warns.map((w) => w.message).join('；')}` : msg);
    }).catch(fail).finally(() => setBusy(false));
  };

  /* ── 端点操作 ── */
  const setPrimary = (purpose: string, ep: AiEndpointView) =>
    run(api.setAiRoutePrimary(purpose, ep.id), `${purposeName(purpose)}已切到「${ep.label}」`);

  const togglePool = (ep: AiEndpointView) => {
    const inPool = (chat?.members ?? []).some((m) => m.endpointId === ep.id && !m.primary);
    run(api.setAiEndpointPool(ep.id, !inPool), inPool ? `「${ep.label}」已移出分流池` : `「${ep.label}」已加入分流池`);
  };

  // 影子成员的出口。`setPrimary` 对可分流用途是「保留旧成员 + 追加新 primary」，所以切换过几次
  // 生效接入点之后，路由里会攒下几个被切走的端点；单端点模式下它们不接流量、界面也不列，
  // 直到运营打开「多路分流」——那一刻池子里凭空多出没人记得加过的成员，混协议还开不起来。
  // 端点自身的「移出池」只管 chat 用途，其余用途此前压根没有移出的入口。
  const removeMember = (r: AiRouteView, endpointId: string) => {
    const ep = epById(endpointId);
    setConfirmSpec({
      title: `从「${purposeName(r.purpose)}」移出接入点`,
      desc: '只解除这个用途对它的引用；接入点本身和它的 Key 都不动，之后把该用途的「生效接入点」切回来即可再用。',
      echo: [
        { k: '用途', v: purposeName(r.purpose) },
        { k: '接入点', v: ep?.label ?? endpointId },
        { k: '现在接不接流量', v: r.mode === 'pool' ? '接（分流成员）' : '不接（多路分流是关的）' },
      ],
      confirmText: '移出',
      onConfirm: async () => {
        await api.saveAiRoute(r.purpose, { members: r.members.filter((m) => m.endpointId !== endpointId) });
        after(`已把「${ep?.label ?? endpointId}」从${purposeName(r.purpose)}移出`);
      },
    });
  };

  const probe = (ep: AiEndpointView) => {
    if (busy) return;
    setBusy(true);
    api.probeAiEndpoint(ep.id, ['connectivity', 'thinking', 'model_scope'])
      .then((r) => {
        setProbes((prev) => ({ ...prev, [ep.id]: r }));
        const bad = r.results.filter((x) => !x.ok);
        toast(bad.length
          ? `检测未通过：${bad.map((x) => `${probeName(x.kind)}(${x.error || '失败'})`).join('；')}`
          : '检测全部通过');
        load(); // 能力标记可能被回填
      })
      .catch(fail).finally(() => setBusy(false));
  };

  const fixDialect = (ep: AiEndpointView) =>
    run(api.updateAiEndpoint(ep.id, { label: ep.label, provider: ep.provider, dialect: ep.resolvedDialect }),
      `已固化方言：${dialectLabel(ep.resolvedDialect)}`);

  const del = (ep: AiEndpointView) => {
    setConfirmSpec({
      title: '删除接入点',
      desc: ep.usedByPurposes.length
        ? '它正在被下列用途引用，删除前必须先把那些用途改指到别的接入点。'
        : '没有任何用途在用它，可以安全删除。',
      echo: [
        { k: '展示名', v: ep.label },
        { k: 'model', v: ep.model || '—' },
        { k: '被谁引用', v: ep.usedByPurposes.map(purposeName).join('、') || '（无）' },
      ],
      warn: ep.usedByPurposes.length ? '正在被线上使用。' : undefined,
      confirmText: '删除接入点',
      danger: true,
      onConfirm: async () => { await api.delAiEndpoint(ep.id); after('已删除'); },
    });
  };

  const edit = (ep: AiEndpointView) => {
    setTest(null);
    setForm({
      id: ep.id, preset: '', provider: ep.provider, dialect: ep.dialect || '',
      label: ep.label, baseUrl: ep.baseUrl, model: ep.model, apiKey: '',
      temperature: ep.temperature, thinkingMode: ep.thinkingMode, thinkingBudget: ep.thinkingBudget,
      priceInput: ep.priceInput, priceOutput: ep.priceOutput,
      priceCachedInput: ep.priceCachedInput, priceCacheWrite: ep.priceCacheWrite,
      hasKey: ep.hasKey,
    });
  };

  /* ── 添加 / 编辑表单 ── */
  if (form) {
    const applyPreset = (id: string) => {
      setTest(null);
      const p = v2.presets.find((x) => x.id === id);
      if (!p) { set({ preset: '' }); return; }   // 自定义：只清预设标记，已填的地址/模型保留
      set({
        preset: p.id, provider: p.provider, dialect: '',
        label: form.label.trim() ? form.label : p.label, baseUrl: p.baseUrl, model: p.model,
      });
    };
    const gatewayField = modelGatewayField(form.provider);
    const showThinking = modelSupportsThinking(form.provider, form.model);
    const thinkingOn = form.thinkingMode !== 'disabled';
    const body = (): AiEndpointUpsert => ({
      label: form.label.trim(), provider: form.provider,
      baseUrl: form.baseUrl.trim(), model: form.model.trim(),
      dialect: form.dialect || null,
      temperature: Number(form.temperature),
      thinkingMode: form.thinkingMode, thinkingBudget: Number(form.thinkingBudget),
      priceInput: Number(form.priceInput) || 0, priceOutput: Number(form.priceOutput) || 0,
      priceCachedInput: Number(form.priceCachedInput) || 0, priceCacheWrite: Number(form.priceCacheWrite) || 0,
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
    });

    const testEndpoint = async () => {
      setBusy(true); setTest(null);
      try {
        const r = await api.testAiEndpoint({
          provider: form.provider, label: form.label, baseUrl: form.baseUrl, model: form.model,
          temperature: Number(form.temperature),
          thinkingMode: form.thinkingMode, thinkingBudget: Number(form.thinkingBudget),
          dialect: form.dialect || null,
          ...(form.apiKey ? { apiKey: form.apiKey } : {}), ...(form.id ? { endpointId: form.id } : {}),
        });
        setTest({ ok: r.ok, msg: r.ok ? `连通 · ${r.latencyMs}ms · ${r.model}${r.sample ? ' · 「' + r.sample + '」' : ''}` : (r.error || '未连通') });
      } catch (e) { setTest({ ok: false, msg: (e as Error)?.message || '测试请求失败' }); }
      setBusy(false);
    };

    const save = () => {
      if (!form.label.trim()) { toast('请填写展示名'); return; }
      if (form.provider !== 'mock' && !form.model.trim()) { toast('请填写模型 model'); return; }
      const p = form.id ? api.updateAiEndpoint(form.id, body()) : api.addAiEndpoint(body());
      setBusy(true);
      p.then((r) => {
        const warns = (r.issues ?? []).filter((i) => i.level !== 'error');
        setForm(null);
        after(warns.length ? `已保存，但有提醒：${warns.map((w) => w.message).join('；')}` : (form.id ? '已更新' : '已添加'));
      }).catch(fail).finally(() => setBusy(false));
    };

    return (
      <>
        <PageHead k="model" badge={form.id ? '编辑接入点' : '添加接入点'} />
        <div className="pad">
          <div className="ai-sub-h">
            <div className="b">
              <div className="t">{form.id ? '编辑接入点' : '添加接入点'}</div>
              <div className="s">{form.id ? '保存即生效——没有「拷贝到生效配置」这一步了' : '保存后到路由里指定它服务哪个用途'}</div>
            </div>
          </div>
          {/* 接入商 × 协议 —— 两个正交维度。预设本身就是「厂商 × 协议」（七牛占两条）。 */}
          <Field label="接入商">
            <select className="ai-input" value={form.preset} onChange={(e) => applyPreset(e.target.value)}>
              <option value="">自定义（手填网关地址）</option>
              {v2.presets.map((p) => <option key={p.id} value={p.id}>{p.label}{p.note ? ` · ${p.note}` : ''}</option>)}
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
            协议决定请求长什么样，不是模型名的属性——同一家厂商的两种协议是两个不同的网关地址，选错就是上线后 404/400。
          </div>

          {form.provider !== 'mock' && (
            <>
              <Field label="协议方言">
                <select className="ai-input" value={form.dialect} onChange={(e) => set({ dialect: e.target.value })}>
                  <option value="">跟随接入商自动判定</option>
                  {v2.dialects
                    .filter((d) => d.protocol === (form.provider === 'claude' ? 'anthropic' : 'openai_chat'))
                    .map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              </Field>
              <div className="ai-note" style={{ marginTop: 0, marginBottom: 12 }}>
                同一协议下各家的细节写法不同（关闭思考是省略字段还是显式发、能不能带思考预算）。
                留「自动判定」即按接入商推断；确认过就显式选定，这个端点从此不靠猜。
              </div>
            </>
          )}

          <Field label="展示名"><input className="ai-input" value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder="七牛 · Opus 主端点" /></Field>
          {gatewayField.visible && (
            <>
              <Field label={gatewayField.label}><input className="ai-input" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={gatewayField.placeholder} /></Field>
              {gatewayField.note && <div className="ai-note" style={{ marginTop: 0, marginBottom: 12 }}>{gatewayField.note}</div>}
            </>
          )}
          {form.provider !== 'mock' && (
            <Field label="模型 model"><input className="ai-input" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="claude-opus-4-6" /></Field>
          )}
          {form.provider !== 'mock' && (
            <>
              <Field label={`API Key${form.id && form.hasKey ? '（已配置，留空=不改）' : ''}`}>
                <input className="ai-input" type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={form.id && form.hasKey ? '••••••（留空保留现有）' : '粘贴 API Key'} />
              </Field>
              <div className="ai-note" style={{ marginTop: 0, marginBottom: 12 }}>
                填一把**已经用过的 Key**会自动复用同一条凭证——之后轮换只需在下方「凭证」里改一次，
                它下面所有接入点一起生效，不用一个个改。
              </div>
            </>
          )}

          <Field label={`配置温度 temperature · ${form.temperature}${thinkingOn ? '（思考请求实际为 1）' : ''}`}>
            <input className="ai-range" type="range" min={0} max={1} step={0.1} value={form.temperature} disabled={thinkingOn} onChange={(e) => set({ temperature: Number(e.target.value) })} />
          </Field>

          {showThinking && (
            <>
              <Field label="Thinking 思考模式">
                <div className="bill-seg">
                  {([['disabled', '关闭'], ['enabled', '手动预算'], ['adaptive', '自适应']] as const).map(([v, l]) => (
                    <button type="button" key={v} className={`bill-opt ${form.thinkingMode === v ? 'on' : ''}`} onClick={() => set({ thinkingMode: v })} aria-pressed={form.thinkingMode === v}>
                      <div className="bo-t">{l}</div>
                    </button>
                  ))}
                </div>
              </Field>
              {form.thinkingMode === 'enabled' && (
                <Field label="思考预算 budget_tokens（1024–7000）">
                  <input className="ai-input" type="number" min={1024} max={7000} step={256} value={form.thinkingBudget} onChange={(e) => set({ thinkingBudget: Number(e.target.value) })} />
                </Field>
              )}
              <div className="ai-note">
                开启后仅实际思考请求临时用 temperature=1，这里保留原配置值。结构化成果与多轮工具调用按
                Anthropic 限制自动关思考，用保留的配置温度。
              </div>
            </>
          )}

          {form.provider !== 'mock' && (
            <>
              <div className="ai-note" style={{ marginTop: 0, marginBottom: 8 }}>Token 单价（元 / 1M token）· 仅用于内部成本核算 · 输入价与输出价必须同时填，缺一档整个模型不校准（成本记 0）。</div>
              <Field label="输入单价"><NumInput className="ai-input" min={0} step={0.01} value={form.priceInput} onChange={(priceInput) => set({ priceInput })} /></Field>
              <Field label="输出单价"><NumInput className="ai-input" min={0} step={0.01} value={form.priceOutput} onChange={(priceOutput) => set({ priceOutput })} /></Field>
              <Field label="缓存读单价（0=同输入价）"><NumInput className="ai-input" min={0} step={0.01} value={form.priceCachedInput} onChange={(priceCachedInput) => set({ priceCachedInput })} /></Field>
              <Field label="缓存写单价（0=按输入价 ×1.25 推导）"><NumInput className="ai-input" min={0} step={0.01} value={form.priceCacheWrite} onChange={(priceCacheWrite) => set({ priceCacheWrite })} /></Field>
            </>
          )}

          {test && <div className={`ai-test ${test.ok ? 'ok' : 'err'}`}><Icon name={test.ok ? 'check' : 'alert'} size={13} /> {test.msg}</div>}
          <div className="ai-actions">
            <button className="ai-btn ghost" onClick={testEndpoint} disabled={busy}><Icon name="spark" size={14} /> 测试连接</button>
            <button className="ai-btn primary" onClick={save} disabled={busy}><Icon name="check" size={14} /> {form.id ? '保存' : '添加'}</button>
          </div>
          <div className="ai-actions" style={{ marginTop: 10 }}>
            <button className="ai-btn ghost" onClick={() => setForm(null)}>取消</button>
          </div>
        </div>
      </>
    );
  }

  /* ── 列表 ── */
  const embRoute = routeOf('embedding');
  const chatBaseUrl = activeEp?.baseUrl ?? '';
  const reuse = auxReuseBlock(activeEp?.provider ?? 'mock', chatBaseUrl);

  const endpointLine = (ep: AiEndpointView) => {
    const r = probes[ep.id];
    if (r) {
      const bad = r.results.filter((x) => !x.ok);
      return ` · 检测 ${bad.length ? `${bad.length} 项未过` : '全部通过'}`;
    }
    if (ep.lastProbeAt) return ` · 上次检测 ${new Date(ep.lastProbeAt).toLocaleString()} ${ep.lastProbeOk ? '通过' : '未过'}`;
    return ' · 从未检测';
  };

  return (
    <>
      <PageHead k="model" badge={`${v2.endpoints.length} 个接入点`} res={{ loading: false, reload: () => { load(); loadRouting(); }, updatedAt: 0 }} />
      {loadErr && <div className="pad"><ErrorState msg={loadErr} onRetry={load} /></div>}
      <div className="pad">
        {routingErr && <div className="ai-test err"><Icon name="alert" size={13} /> 冷却状态暂不可用：{routingErr}</div>}
        {/* 当前生效 */}
        <div className={`ai-status ${activeEp?.hasKey ? 'on' : 'off'}`}>
          <span className="dot" />
          <div className="b">
            <div className="t">{activeEp ? `${activeEp.label} · ${activeEp.model}` : '对话用途尚未指定接入点'}</div>
            <div className="s">
              {activeEp
                ? `${dialectLabel(activeEp.resolvedDialect)}${activeEp.hasKey ? '' : ' · 未配 Key，当前会降级本地模板'}`
                : '在下方「路由 · 对话」里选一个接入点设为生效'}
            </div>
          </div>
        </div>

        {/* ① 接入点 —— 一行一个上游，属性与操作都在这一行 */}
        <div className="ai-label">接入点 · {v2.endpoints.length} 个</div>
        {v2.endpoints.length === 0 && <div className="usage-meta" style={{ padding: '10px 0' }}>还没有接入点。点下方「添加接入点」接一个上游。</div>}
        {v2.endpoints.map((ep) => {
          const st = routing?.endpoints.find((x) => x.id === ep.id);
          const member = chat?.members.find((m) => m.endpointId === ep.id);
          const inPool = !!member && !member.primary;
          return (
            <div key={ep.id} className="mem-card">
              <span className="mi"><Icon name="insight" size={16} /></span>
              <div className="mb" style={{ cursor: 'pointer' }} onClick={() => edit(ep)}>
                <div className="mt">
                  {ep.label}
                  {ep.usedByPurposes.map((p) => <span key={p} className="tag" style={{ marginLeft: 6 }}>{purposeName(p)}</span>)}
                  {st?.cooling && <span className="tag off" style={{ marginLeft: 6 }}>冷却中</span>}
                  {!ep.hasKey && ep.provider !== 'mock' && <span className="tag" style={{ marginLeft: 6 }}>未配 Key</span>}
                </div>
                <div className="mm">
                  {ep.provider === 'claude' ? 'Anthropic 协议' : ep.provider === 'openai' ? 'OpenAI 兼容' : '本地模板'}
                  {' · '}{ep.model || '—'}
                  {modelSupportsThinking(ep.provider, ep.model) ? ` · Thinking:${ep.thinkingMode}` : ''}
                  {ep.provider !== 'mock' ? ` · 方言 ${dialectLabel(ep.resolvedDialect)}${ep.dialect ? '（已固化）' : '（推断中）'}` : ''}
                </div>
                <div className="mm">
                  凭证 {ep.credentialLabel}
                  {' · '}
                  {(ep.priceInput > 0 && ep.priceOutput > 0) ? `单价 入¥${ep.priceInput}/出¥${ep.priceOutput} 每1M` : '单价待配（成本记 0）'}
                  {endpointLine(ep)}
                  {st?.cooling && st.coolingUntil ? ` · ${st.coolingReason === 'rate_limited' ? '被限流' : '连续报错'}，${new Date(st.coolingUntil).toLocaleTimeString()} 后恢复` : ''}
                </div>
              </div>
              {!member?.primary && <button className="mini-btn" disabled={busy} title="把「对话」用途指到这个接入点" onClick={() => setPrimary('chat', ep)}>设为对话生效</button>}
              <button className="mini-btn" disabled={busy} title="跑连通性 / Thinking 写法 / 模型范围三项检测，结果回填能力标记" onClick={() => probe(ep)}>检测</button>
              {!ep.dialect && ep.provider !== 'mock' && (
                <button className="mini-btn" disabled={busy} title="把推断出的协议方言写死，之后请求组装不再靠推断" onClick={() => fixDialect(ep)}>固化方言</button>
            )}
              {!member?.primary && (
                <button className={`mini-btn ${inPool ? 'primary' : ''}`} disabled={busy} onClick={() => togglePool(ep)}
                  title={inPool ? '已在对话分流池内，点击移出' : '加入对话分流池，参与多路分流与故障转移'}>
                  {inPool ? '移出池' : '入池'}
                </button>
              )}
              <button className="mini-btn danger" onClick={() => del(ep)}>删除</button>
            </div>
          );
        })}
        <button className="add-btn full" onClick={() => { setTest(null); setForm({ ...BLANK }); }}>＋ 添加接入点</button>

        {/* ② 路由 —— 每个用途一行，结构同构 */}
        <div className="ai-label" style={{ marginTop: 18 }}>路由 · 哪个用途用哪些接入点</div>
        {v2.routes.filter((r) => r.purpose !== 'moderation').map((r) => (
          <RouteRow
            key={r.purpose} route={r} v2={v2} busy={busy}
            onPrimary={(id) => { const e = epById(id); if (e) setPrimary(r.purpose, e); }}
            onMode={(mode) => run(api.saveAiRoute(r.purpose, { mode }), `${purposeName(r.purpose)}已切到${mode === 'pool' ? '分流' : '单端点'}`)}
            onSticky={(sticky) => run(api.saveAiRoute(r.purpose, { sticky }), '已保存会话粘性')}
            onBudget={(patch) => {
              const next = { ...r.budget, ...patch };
              const budget = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as AiRouteBudget;
              run(api.saveAiRoute(r.purpose, { budget: Object.keys(budget).length ? budget : null }), `${purposeName(r.purpose)}请求预算已保存`);
            }}
            onMember={(endpointId, patch) => run(
              api.saveAiRoute(r.purpose, { members: r.members.map((m) => (m.endpointId === endpointId ? { ...m, ...patch } : m)) }),
              '已保存分流参数',
            )}
            onRemoveMember={(endpointId) => removeMember(r, endpointId)}
          />
        ))}
        {reuse.blocked && embRoute?.exists && (
          <div className="ai-test err" style={{ margin: '8px 0 0' }}>
            <Icon name="alert" size={13} />
            <span>{reuse.reason}嵌入用途必须指向单独的接入点，不能和对话共用。</span>
          </div>
        )}

        {/* ③ 凭证 —— 换 key 的唯一入口 */}
        <div className="ai-label" style={{ marginTop: 18 }}>凭证 · 换 Key 的唯一入口</div>
        <div className="ai-note" style={{ marginTop: 0, marginBottom: 8 }}>
          Key 挂在凭证上、不再每个接入点各存一份。改这里一次，它下面所有接入点一起生效——
          旧结构下轮换一把 Key 要挨个改，漏一个就是那个端点静默开始失败。
        </div>
        {v2.credentials.map((c) => (
          <div key={c.id} className="mem-card">
            <span className="mi"><Icon name="lock" size={16} /></span>
            <div className="mb">
              <div className="mt">
                {c.label}
                {c.needsReview && <span className="tag off" style={{ marginLeft: 6 }}>接入商待确认</span>}
                {!c.hasKey && <span className="tag" style={{ marginLeft: 6 }}>未配 Key</span>}
              </div>
              <div className="mm">接入商 {c.vendor} · 被 {c.endpointCount} 个接入点共用</div>
            </div>
            <button className="mini-btn" disabled={busy} onClick={() => setCredentialForm({ id: c.id, label: c.label, vendor: c.vendor, key: '' })}>
              {c.needsReview ? '确认接入商' : '编辑凭证'}
            </button>
          </div>
        ))}
        {credentialForm && (
          <div className="ai-sub">
            <Field label="凭证名称">
              <input className="ai-input" value={credentialForm.label}
                onChange={(e) => setCredentialForm({ ...credentialForm, label: e.target.value })} />
            </Field>
            <Field label="接入商">
              <select className="ai-input" value={credentialForm.vendor}
                onChange={(e) => setCredentialForm({ ...credentialForm, vendor: e.target.value })}>
                {v2.vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.label}</option>)}
              </select>
            </Field>
            <Field label="新 API Key（留空＝不轮换）">
              <input className="ai-input" type="password" value={credentialForm.key} placeholder="只改名称/接入商时留空"
                onChange={(e) => setCredentialForm({ ...credentialForm, key: e.target.value })} />
            </Field>
            <div className="ai-note">轮换 Key 会让这条凭证下面的所有接入点一起生效；确认接入商会清除迁移待复核标记。</div>
            <div className="ai-actions">
              <button className="ai-btn ghost" onClick={() => setCredentialForm(null)}>取消</button>
              <button className="ai-btn primary" disabled={busy || !credentialForm.label.trim() || !credentialForm.vendor}
                onClick={() => {
                  const value = credentialForm;
                  setCredentialForm(null);
                  run(api.updateAiCredential(value.id, {
                    label: value.label.trim(), vendor: value.vendor, ...(value.key.trim() ? { apiKey: value.key.trim() } : {}),
                  }), value.key.trim() ? '凭证与 Key 已更新，下面所有接入点已生效' : '凭证信息已更新');
                }}>
                <Icon name="check" size={14} /> 保存凭证
              </button>
            </div>
          </div>
        )}
      </div>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}

/** 一个用途的路由行。六个用途结构同构，所以只有一个组件——旧版嵌入/重排是另写的一套。 */
function RouteRow({ route, v2, busy, onPrimary, onMode, onSticky, onBudget, onMember, onRemoveMember }: {
  route: AiRouteView;
  v2: AiV2View;
  busy: boolean;
  onPrimary: (endpointId: string) => void;
  onMode: (mode: 'single' | 'pool') => void;
  onSticky: (sticky: boolean) => void;
  onBudget: (patch: Partial<AiRouteBudget>) => void;
  onMember: (endpointId: string, patch: { weight?: number; tier?: number; maxConcurrency?: number }) => void;
  onRemoveMember: (endpointId: string) => void;
}) {
  const meta = PURPOSE_META[route.purpose];
  const primary = route.members.find((m) => m.primary);
  const epById = (id: string) => v2.endpoints.find((e) => e.id === id);
  const primaryEp = primary ? epById(primary.endpointId) : undefined;
  const others = route.members.filter((m) => !m.primary);

  // 分流只对「对话 / 成果」有意义：抽取、嵌入、重排都是单端点调用，摊到多个端点没有收益。
  const poolable = route.purpose === 'chat' || route.purpose === 'deliverable';
  const [budget, setBudget] = useState({
    timeoutMs: route.budget.timeoutMs?.toString() ?? '',
    bodyMaxTokens: route.budget.bodyMaxTokens?.toString() ?? '',
    temperature: route.budget.temperature?.toString() ?? '',
  });
  useEffect(() => {
    setBudget({
      timeoutMs: route.budget.timeoutMs?.toString() ?? '',
      bodyMaxTokens: route.budget.bodyMaxTokens?.toString() ?? '',
      temperature: route.budget.temperature?.toString() ?? '',
    });
  }, [route.budget.timeoutMs, route.budget.bodyMaxTokens, route.budget.temperature]);
  const saveBudget = (field: keyof AiRouteBudget, raw: string) => {
    const value = raw.trim() === '' ? undefined : Number(raw);
    if (value === route.budget[field]) return;
    onBudget({ [field]: value });
  };

  return (
    <div className="ai-sub">
      <div className="ai-sub-h">
        <div className="b">
          <div className="t">{meta?.name ?? route.purpose}{!route.exists && <span className="tag" style={{ marginLeft: 6 }}>未配置</span>}</div>
          <div className="s">{meta?.desc}</div>
        </div>
      </div>
      <Field label="生效接入点">
        <select className="ai-input" value={primary?.endpointId ?? ''} disabled={busy}
          onChange={(e) => e.target.value && onPrimary(e.target.value)}>
          <option value="">— 未指定 —</option>
          {v2.endpoints.map((ep) => <option key={ep.id} value={ep.id}>{ep.label}{ep.model ? ` · ${ep.model}` : ''}</option>)}
        </select>
      </Field>
      <div className="usage-row">
        <div className="usage-name">请求预算<div className="usage-meta">留空沿用系统默认；按用途独立生效</div></div>
        <Field label="超时 ms">
          <input className="ai-input" type="number" min={1} value={budget.timeoutMs}
            onChange={(e) => setBudget({ ...budget, timeoutMs: e.target.value })}
            onBlur={() => saveBudget('timeoutMs', budget.timeoutMs)} />
        </Field>
        <Field label="正文 token">
          <input className="ai-input" type="number" min={1} value={budget.bodyMaxTokens}
            onChange={(e) => setBudget({ ...budget, bodyMaxTokens: e.target.value })}
            onBlur={() => saveBudget('bodyMaxTokens', budget.bodyMaxTokens)} />
        </Field>
        <Field label="温度">
          <input className="ai-input" type="number" min={0} max={2} step={0.1} value={budget.temperature}
            onChange={(e) => setBudget({ ...budget, temperature: e.target.value })}
            onBlur={() => saveBudget('temperature', budget.temperature)} />
        </Field>
      </div>
      {poolable && (
        <>
          <div className="ai-sub-h">
            <div className="b">
              <div className="t">多路分流</div>
              <div className="s">
                {route.mode === 'pool'
                  ? `分流中：${route.members.length} 个接入点。撞 429/5xx 自动转移并冷却该端点`
                  : '关＝只用上面那一个；开＝按权重分流，某个端点被限流时不会全站停摆'}
              </div>
            </div>
            <Switch checked={route.mode === 'pool'} onChange={(pool) => onMode(pool ? 'pool' : 'single')} label="多路分流" />
          </div>
          {route.mode === 'pool' && (
            <div className="ai-sub-h">
              <div className="b">
                <div className="t">会话粘性</div>
                <div className="s">同一会话固定落同一端点。上游提示词缓存按账号隔离，关掉会把缓存打散、成本上升</div>
              </div>
              <Switch checked={route.sticky} onChange={onSticky} label="会话粘性" />
            </div>
          )}
          {/* 非 primary 成员**不分模式**都要列出来。切换生效接入点会把被切走的那个留在路由里，
              只在分流开着时才显示等于让它隐形——运营看不见，也就没法在开分流之前把它清掉。 */}
          {others.length > 0 && route.mode !== 'pool' && (
            <div className="ai-note" style={{ marginTop: 0, marginBottom: 8 }}>
              下面这些接入点还挂在这个用途上。多路分流是关的，它们现在<strong>不接流量</strong>；
              但一开分流它们就参与，所以协议必须和生效接入点一致——不一致时分流开不起来，先把它们移出。
              （切换过生效接入点的话，被切走的那个就留在这儿当备胎。）
            </div>
          )}
          {others.map((m) => {
            const ep = epById(m.endpointId);
            const { sameProtocol } = routeMemberRow(m, ep, primaryEp, v2.dialects);
            return (
              <div key={m.endpointId} className="usage-row">
                <div className="usage-name">
                  {ep?.label ?? m.endpointId}
                  {!sameProtocol && <span className="tag off" style={{ marginLeft: 6 }}>协议与生效端点不同</span>}
                  <div className="usage-meta">{ep?.model || '—'}</div>
                </div>
                {route.mode === 'pool' && (
                  <>
                    <Field label="权重">
                      <input className="ai-input" type="number" min={1} defaultValue={m.weight}
                        onBlur={(e) => { const v = Math.max(1, Number(e.target.value) || 1); if (v !== m.weight) onMember(m.endpointId, { weight: v }); }} />
                    </Field>
                    <Field label="备份层">
                      <input className="ai-input" type="number" min={0} defaultValue={m.tier}
                        onBlur={(e) => { const v = Math.max(0, Number(e.target.value) || 0); if (v !== m.tier) onMember(m.endpointId, { tier: v }); }} />
                    </Field>
                    <Field label="并发/实例">
                      <input className="ai-input" type="number" min={0} defaultValue={m.maxConcurrency}
                        onBlur={(e) => { const v = Math.max(0, Number(e.target.value) || 0); if (v !== m.maxConcurrency) onMember(m.endpointId, { maxConcurrency: v }); }} />
                    </Field>
                  </>
                )}
                <button className="mini-btn danger" disabled={busy} title="把这个接入点从本用途移出（端点本身不删）"
                  onClick={() => onRemoveMember(m.endpointId)}>移出</button>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
