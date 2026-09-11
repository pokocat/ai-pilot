// 模板货架 —— 爱速拍首页用户看到的那一排，就是这里的 published。
//
// 两个动作：
//   上架 / 下架  最高频，一次点击
//   存为模板      把自己在小程序里做顺的一条草稿沉淀成模板（照搬 ip studio 的 publish-as-demo）
//
// **不做整体编辑表单。** 模板的主体是 scriptSkeleton / timeline，那是内容创作，
// 在后台拿表单编等于做一个半吊子的编辑器；要改就回小程序里改那条草稿，再存一版。
import { useCallback, useState } from 'react';
import { api, type ClipAdminTemplate } from '../api';
import { Confirm, View, useResource, type ConfirmSpec } from '../components';

export function TemplatesView({ toast, isSuper, onAuthLost }: {
  toast: (m: string) => void; isSuper: boolean; onAuthLost: () => void;
}) {
  const res = useResource(useCallback(() => api.templates(), []), [], onAuthLost);
  const [spec, setSpec] = useState<ConfirmSpec | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const toggle = (t: ClipAdminTemplate) => {
    const next = t.status === 'published' ? 'draft' : 'published';
    setSpec({
      title: next === 'published' ? '上架这套模板' : '下架这套模板',
      desc: next === 'published'
        ? '上架后，所有打开爱速拍首页的用户都会看到它。'
        : '下架后新用户看不到它；已经用它开过的草稿不受影响，照常出片。',
      echo: [{ k: '模板', v: t.name }, { k: '分段', v: `${t.segmentCount} 段 · 约 ${t.estDurationSec} 秒` }],
      confirmText: next === 'published' ? '上架' : '下架',
      danger: next === 'draft',
      onConfirm: async () => {
        await api.setTemplateStatus(t.id, next);
        toast(next === 'published' ? `「${t.name}」已上架` : `「${t.name}」已下架`);
        res.reload();
      },
    });
  };

  return (
    <>
      <div className="head">
        <h1>模板货架</h1>
        <span className="sub">首页那一排</span>
        <span className="spacer" />
        {isSuper && <button type="button" className="btn primary" onClick={() => setSaveOpen(true)}>把草稿存成模板</button>}
      </div>

      <View res={res} skeleton={3}>
        {(list) => list.length === 0 ? (
          <div className="empty">还没有模板</div>
        ) : (
          <div className="rows">
            {list.map((t) => (
              <div key={t.id} className="row">
                <div className="row-h">
                  <span className="row-t">{t.name}</span>
                  <span className={`tag ${t.status === 'published' ? 'ok' : ''}`}>
                    {t.status === 'published' ? '已上架' : '草稿'}
                  </span>
                  {t.ownerScope === 'official' && <span className="tag brand">官方</span>}
                </div>
                <div className="row-m">
                  {t.industry} · {t.themeKey} · {t.segmentCount} 段 · 约 {t.estDurationSec} 秒
                  {typeof t.creditHint === 'number' ? ` · 约 ${t.creditHint} 钻` : ''}
                  <br />
                  {t.description}
                </div>
                {isSuper && (
                  <div className="row-act">
                    <button type="button" className="btn" onClick={() => toggle(t)}>
                      {t.status === 'published' ? '下架' : '上架'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </View>

      {!isSuper && (
        <div className="note" style={{ marginTop: 14 }}>
          上下架直接改变小程序首页看得到什么，与改价同级，只有超管能做。你现在是只读。
        </div>
      )}

      {saveOpen && <SaveFromDraft toast={toast} onClose={() => setSaveOpen(false)} onSaved={() => { setSaveOpen(false); res.reload(); }} />}
      {spec && <Confirm spec={spec} onClose={() => setSpec(null)} />}
    </>
  );
}

/**
 * 把一条草稿存成模板。
 *
 * 草稿属主 = **当前后台账号绑定的那个小程序账号**（军师后台「运营账户」里的 linkedUserId）。
 * 服务端只认那一列、不看请求体，所以存不了别人的草稿 —— 也因此，没绑定就用不了这个功能。
 *
 * 存进去的只有「怎么讲」：分段的角色、时长、画面提示。
 * 数字人、声音、自己上传的空镜全部剥掉 —— 不剥的话，每个用这套模板的人做出来的片子
 * 都顶着运营那张脸、那把嗓子，还会看到一堆自己没权限的素材位。
 */
function SaveFromDraft({ toast, onClose, onSaved }: {
  toast: (m: string) => void; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({ projectId: '', name: '', industry: '', themeKey: '', description: '' });
  const [keepText, setKeepText] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async () => {
    for (const [k, label] of [['projectId', '草稿 id'], ['name', '模板名'], ['industry', '行业'], ['themeKey', '主题'], ['description', '说明']] as const) {
      if (!f[k].trim()) { setErr(`${label}不能为空`); return; }
    }
    setBusy(true); setErr('');
    try {
      const t = await api.templateFromProject({ ...f, keepText });
      // 一律存成草稿：存模板和上架是两个决定，存完先自己看一眼分段对不对、素材剥干净没有
      toast(`已存成草稿模板「${t.name}」，确认无误后再上架`);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '存不成');
    } finally { setBusy(false); }
  };

  return (
    <div className="mask" onClick={() => !busy && onClose()}>
      <div className="dlg" role="dialog" aria-modal="true" aria-label="把草稿存成模板" onClick={(e) => e.stopPropagation()}>
        <h2>把草稿存成模板</h2>
        <p className="sub">
          只能存<b>你自己的</b>草稿 —— 属主按这个后台账号绑定的小程序账号认，请求里传别人的没用。
          存进去的是「怎么讲」：分段角色、时长、画面提示。数字人、声音、你自己传的空镜都会剥掉。
        </p>
        <label className="f">
          <span className="k">草稿 id</span>
          <input className="i" value={f.projectId} onChange={set('projectId')} placeholder="cp_…" />
          <span className="hint">在小程序里打开那条草稿，地址里的 id。</span>
        </label>
        <label className="f">
          <span className="k">模板名</span>
          <input className="i" value={f.name} onChange={set('name')} placeholder="门店故事" />
        </label>
        <label className="f">
          <span className="k">行业</span>
          <input className="i" value={f.industry} onChange={set('industry')} placeholder="实体商家" />
        </label>
        <label className="f">
          <span className="k">主题</span>
          <input className="i" value={f.themeKey} onChange={set('themeKey')} placeholder="daily" />
        </label>
        <label className="f">
          <span className="k">说明</span>
          <textarea className="i" value={f.description} onChange={set('description')} placeholder="这套模板适合谁、讲什么" />
        </label>
        <label className="f" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={keepText} onChange={(e) => setKeepText(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <span className="k" style={{ marginBottom: 2 }}>保留正文</span>
            <span className="hint">
              勾上 = 连你写的示范文案一起存（多数时候要勾，那份文案本身就是模板的价值）。
              取消 = 只留骨架，正文清空，字数和时长照留当写作约束。
            </span>
          </span>
        </label>
        {err && <div className="err">{err}</div>}
        <div className="dlg-act">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="btn primary" disabled={busy} onClick={submit}>{busy ? '存…' : '存成草稿模板'}</button>
        </div>
      </div>
    </div>
  );
}
