// 定价 —— 爱速拍一共十个数：六档生成 + 四档克隆。
//
// 放在同一屏上：运营心里的问题是「爱速拍怎么收费」，分两屏只会让人以为看全了。
//
// 两组的真源不同，但今天**都能在后台改**：
//   六档生成  AIStar 的 clip_pricing 单行表（2026-09-11 从 Spring 配置搬进库）
//   四档克隆  军师的 FeatureFlag 单行（services/video/pricing.ts）
// 两组都遵守同一条铁律：对外定价数据归运营后台，代码只给「还没核定」时的兜底值。
import { useCallback, useEffect, useState } from 'react';
import { api, type ClipClonePricing, type ClipGenerationPricing } from '../api';
import { Confirm, View, useResource, type ConfirmSpec } from '../components';

/** 单价上限。挡住多打一个 0 把用户余额一次清空。 */
const MAX = 1_000_000;

const GEN: { k: keyof ClipGenerationPricingDraft; t: string; unit: string; hint?: string }[] = [
  { k: 'creditPerAvatarSecond', t: '数字人出镜', unit: '钻 / 秒' },
  { k: 'creditPerKChar', t: '配音', unit: '钻 / 千字', hint: '全片一次取整，不按镜摊 —— 按镜摊十个短镜头能把同样字数收成十倍' },
  { k: 'creditPerAssemble', t: '合成整片', unit: '钻 / 次' },
  { k: 'creditPerImage', t: '文生图', unit: '钻 / 张' },
  { k: 'creditPerT2vSecond', t: '文生视频', unit: '钻 / 秒' },
  { k: 'creditPerI2vSecond', t: '图生视频', unit: '钻 / 秒' },
];

type ClipGenerationPricingDraft = Omit<ClipGenerationPricing, 'configured'>;

const CLONE: { k: keyof ClipClonePricingDraft; t: string; hint?: string }[] = [
  { k: 'voiceCreate', t: '新建声音', hint: '供应商侧最贵的单次动作' },
  { k: 'voiceRetrain', t: '重训声音', hint: '必须明显低于新建，否则用户没动力走这条省供应商权益的路径' },
  { k: 'avatarVideo', t: '视频训数字人' },
  { k: 'avatarImage', t: '图片训数字人', hint: '成本远低于视频训练，作为低成本入口，价格必须低于上一档' },
];

type ClipClonePricingDraft = Omit<ClipClonePricing, 'configured'>;

/** 数字输入：空串和非法值都算 0，但**不允许负数**（负单价 = 花钱倒给钻石）。 */
const num = (v: string): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX) : 0;
};

export function PricingView({ toast, isSuper, onAuthLost }: {
  toast: (m: string) => void; isSuper: boolean; onAuthLost: () => void;
}) {
  const [spec, setSpec] = useState<ConfirmSpec | null>(null);
  return (
    <>
      <div className="head">
        <h1>定价</h1>
        <span className="sub">六档生成 + 四档克隆，一共十个数</span>
      </div>
      <GenerationBlock toast={toast} isSuper={isSuper} onAuthLost={onAuthLost} ask={setSpec} />
      <CloneBlock toast={toast} isSuper={isSuper} onAuthLost={onAuthLost} ask={setSpec} />
      {spec && <Confirm spec={spec} onClose={() => setSpec(null)} />}
    </>
  );
}

function GenerationBlock({ toast, isSuper, onAuthLost, ask }: {
  toast: (m: string) => void; isSuper: boolean; onAuthLost: () => void; ask: (s: ConfirmSpec) => void;
}) {
  const res = useResource(useCallback(() => api.generationPricing(), []), [], onAuthLost);
  const [d, setD] = useState<ClipGenerationPricingDraft | null>(null);
  // 服务端回包是唯一真源：加载完 / 保存完都用它重置草稿，
  // 运营不会对着一份「本地以为改上了」的数字操作。
  useEffect(() => {
    if (!res.data) return;
    const { configured, ...rest } = res.data;
    void configured;
    setD(rest);
  }, [res.data]);

  const save = () => {
    if (!d || !res.data) return;
    ask({
      title: res.data.configured ? '改生成单价' : '首次核定生成单价',
      desc: res.data.configured
        ? '保存后约一分钟内对所有用户生效（上游读缓存），不用发版。'
        : '这六个数现在还是代码兜底价，没有商务结论背书。保存之后它们就是对外承诺的价格。',
      echo: GEN.map((g) => ({ k: g.t, v: `${d[g.k]} ${g.unit}` })),
      warn: '端上按这组数算报价、服务端按同一组核对，差一个数就会让用户的提交被拒（409）。所以六档一起提交。',
      confirmText: res.data.configured ? '保存' : '核定',
      onConfirm: async () => {
        const saved = await api.saveGenerationPricing(d);
        res.setData(saved);
        toast('生成单价已保存 · 约一分钟内生效');
      },
    });
  };

  return (
    <section style={{ marginBottom: 22 }}>
      <div className="head" style={{ marginBottom: 8 }}>
        <h1 style={{ fontSize: 14 }}>六档生成</h1>
        {res.data && (
          <span className={`tag ${res.data.configured ? 'ok' : 'warn'}`}>
            {res.data.configured ? '已核定' : '兜底价 · 未核定'}
          </span>
        )}
      </div>
      <View res={res} skeleton={2}>
        {() => !d ? null : (
          <div className="row">
            {GEN.map((g) => (
              <label key={g.k} className="f">
                <span className="k">{g.t}（{g.unit}）</span>
                <input
                  className="i" type="number" min={0} max={MAX} inputMode="numeric"
                  disabled={!isSuper}
                  value={d[g.k]}
                  onChange={(e) => setD({ ...d, [g.k]: num(e.target.value) })}
                />
                {g.hint && <span className="hint">{g.hint}</span>}
              </label>
            ))}
            {isSuper ? (
              <button type="button" className="btn primary lg" onClick={save}>保存这六档</button>
            ) : (
              <div className="note">改价是营收动作，只有超管能做。你现在是只读。</div>
            )}
          </div>
        )}
      </View>
    </section>
  );
}

function CloneBlock({ toast, isSuper, onAuthLost, ask }: {
  toast: (m: string) => void; isSuper: boolean; onAuthLost: () => void; ask: (s: ConfirmSpec) => void;
}) {
  const res = useResource(useCallback(() => api.clonePricing(), []), [], onAuthLost);
  const [d, setD] = useState<ClipClonePricingDraft | null>(null);
  useEffect(() => {
    if (!res.data) return;
    const { configured, ...rest } = res.data;
    void configured;
    setD(rest);
  }, [res.data]);

  // 不做成硬校验：运营有正当理由把某一档临时打低（新建声音限时特价）。
  // 要的是「你正在反转一条我们自己写下的定价原则，确认一下」。
  const warnings = (x: ClipClonePricingDraft): string[] => {
    const out: string[] = [];
    if (x.voiceRetrain >= x.voiceCreate) out.push(`重训（${x.voiceRetrain}）不低于新建（${x.voiceCreate}）：用户没有动力走省供应商权益的重训路径`);
    if (x.avatarImage >= x.avatarVideo) out.push(`图片训练（${x.avatarImage}）不低于视频训练（${x.avatarVideo}）：低成本入口比完整能力还贵`);
    return out;
  };

  const save = () => {
    if (!d || !res.data) return;
    const w = warnings(d);
    ask({
      title: res.data.configured ? '改克隆定价' : '首次核定克隆定价',
      desc: '数字人形象与专属声音的训练单价。保存即生效，不用发版。',
      echo: CLONE.map((c) => ({ k: c.t, v: `${d[c.k]} 钻` })),
      warn: w.length ? w.join('；') : undefined,
      confirmText: res.data.configured ? '保存' : '核定',
      onConfirm: async () => {
        const saved = await api.saveClonePricing(d);
        res.setData(saved);
        toast('克隆定价已保存');
      },
    });
  };

  return (
    <section>
      <div className="head" style={{ marginBottom: 8 }}>
        <h1 style={{ fontSize: 14 }}>四档克隆</h1>
        {res.data && (
          <span className={`tag ${res.data.configured ? 'ok' : 'warn'}`}>
            {res.data.configured ? '已核定' : '兜底价 · 未核定'}
          </span>
        )}
      </div>
      <View res={res} skeleton={2}>
        {() => !d ? null : (
          <div className="row">
            {CLONE.map((c) => (
              <label key={c.k} className="f">
                <span className="k">{c.t}（钻）</span>
                <input
                  className="i" type="number" min={0} max={MAX} inputMode="numeric"
                  disabled={!isSuper}
                  value={d[c.k]}
                  onChange={(e) => setD({ ...d, [c.k]: num(e.target.value) })}
                />
                {c.hint && <span className="hint">{c.hint}</span>}
              </label>
            ))}
            {isSuper ? (
              <button type="button" className="btn primary lg" onClick={save}>保存这四档</button>
            ) : (
              <div className="note">改价是营收动作，只有超管能做。你现在是只读。</div>
            )}
          </div>
        )}
      </View>
    </section>
  );
}
