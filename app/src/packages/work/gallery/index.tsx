// 作品库 · 历史生成资产（v1 = 海报成品图网格 + 文字成果分区入口）。
//
// 解的痛点：此前海报只能从「产出它的那张成果卡」点进去，而成果卡只记得**最近一次**出图 ——
// 用户离开详情页后，早期版本得顺着 parentJobId 一层层往上翻。这里把 GET /creative/posters
// 的平铺列表做成可浏览的网格，每一版都是一格。
//
// 报告 / 方案维度**不重复建设**：方案与历史版本早有成熟入口（锦囊 tab「报告」子页 + 我的方案库），
// 本页只放一个分区入口跳过去，不再抄一份列表出来（两份列表必然漂移）。
//
// §7.2 相关约定：Icon import 在 SafeHeader 之前；组件定义在文件顶层（不在 render 里）；
// 页面用原生滚动（无输入框、无全屏弹层，不套 ScrollView）；catch 一律有落点，不写裸 catch。
import { useEffect, useRef, useState } from 'react';
import { View, Text, Image } from '@tarojs/components';
import Taro, { useDidHide, useDidShow } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import AsyncState from '../../../components/AsyncState';
import { useStore } from '../../../hooks/useStore';
import { navTo, switchTo } from '../../../services/nav';
import { api, type CreativePosterListItem } from '../../../services/api';
import { absoluteCreativeUrl, getCreativeStatus, progressText } from '../../../services/creative';
import './index.scss';

const PAGE_SIZE = 20;
/** 有在途任务时的对账节奏。比详情页慢得多：这里只是网格角标，不需要秒级跟进。 */
const POLL_MS = 6000;

function isInFlight(status: string): boolean {
  return status === 'pending' || status === 'running';
}

/** 时间：今天只给时分，今年省年份，跨年补年份。 */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `今天 ${hm}`;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}年${md}`;
}

// 定义在组件外：定义在 render 里每次渲染都是新组件类型，子树会卸载重挂（§7.2）。
function Tile({ item, accent, onOpen, onImgError }: {
  item: CreativePosterListItem;
  accent: string;
  onOpen: () => void;
  onImgError: () => void;
}) {
  const making = isInFlight(item.status);
  const url = absoluteCreativeUrl(item.poster?.previewUrl);
  return (
    <View className="gl-tile card" onClick={onOpen}>
      <View className="gl-thumb">
        {making ? (
          <View className="gl-making">
            <View className="gl-spin" style={{ borderTopColor: accent }} />
            <Text className="gl-making-t">{progressText(item.progress)}</Text>
          </View>
        ) : url ? (
          // showMenuByLongpress：长按直接存图，省一次进详情页（详情页仍有「保存相册」正路）。
          <Image className="gl-img" src={url} mode="aspectFill" showMenuByLongpress onError={onImgError} />
        ) : (
          <View className="gl-making"><Text className="gl-making-t">预览链接已过期</Text></View>
        )}
        <View className="gl-badge" style={making ? { background: accent } : {}}>
          <Text className="gl-badge-t">{making ? '制作中' : '已完成'}</Text>
        </View>
        {item.parentJobId ? <View className="gl-tag"><Text className="gl-tag-t">改版</Text></View> : null}
      </View>
      <Text className="gl-t">{item.headline || '未命名海报'}</Text>
      <Text className="gl-m">{fmtTime(item.createdAt)}</Text>
    </View>
  );
}

export default function GalleryPage() {
  const s = useStore();
  const accent = s.color().vars['--accent'];

  const [items, setItems] = useState<CreativePosterListItem[]>([]);
  const [cursor, setCursor] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  // 出图能力关着时不给「去出一张」的引导（§16 降级口径：不露按钮再让用户点到 403）；
  // 但**历史作品照旧可浏览** —— 这是回看入口，不是出图入口。
  const [canCreate, setCanCreate] = useState(false);

  const aliveRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 翻过页之后不再自动对账：轮询只重取第一页，会把用户已经翻出来的后续页面截掉。
  const pagedRef = useRef(false);
  // 签名 URL 过期（图片加载失败）只自动重取一次，避免「拉不到 → onError → 再拉」打成死循环。
  const urlRetriedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  /** 取第一页（进页 / 回前台 / 重试 / 签名过期都走这里）。 */
  const loadFirst = async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) { setLoading(true); setFailed(false); }
    try {
      const r = await api.creativePosters({ limit: PAGE_SIZE });
      if (!aliveRef.current) return;
      setItems(r.items);
      setCursor(r.nextCursor ?? '');
      setFailed(false);
      pagedRef.current = false;
      urlRetriedRef.current = false;
      schedulePoll(r.items);
    } catch (e) {
      if (!aliveRef.current) return;
      // 401 已由 request() 全局打断到重新登录；这里只处理网络/服务异常，且不吞掉后果（页面显式失败态）。
      setFailed(true);
      s.handleApiError(e, { silent: true });
    } finally {
      if (aliveRef.current && !opts.silent) setLoading(false);
    }
  };

  /** 只在「仍有在途任务 + 用户没往下翻页」时对账一次下一轮。 */
  const schedulePoll = (list: CreativePosterListItem[]) => {
    clearTimer();
    if (pagedRef.current || !list.some((it) => isInFlight(it.status))) return;
    timerRef.current = setTimeout(() => { void loadFirst({ silent: true }); }, POLL_MS);
  };

  const loadMore = async () => {
    if (more || !cursor) return;
    setMore(true);
    try {
      const r = await api.creativePosters({ cursor, limit: PAGE_SIZE });
      if (!aliveRef.current) return;
      pagedRef.current = true;
      clearTimer();
      // 去重：翻页期间新出的图会把整体往后挤，同一条可能落进两页。
      setItems((cur) => {
        const seen = new Set(cur.map((x) => x.jobId));
        return [...cur, ...r.items.filter((x) => !seen.has(x.jobId))];
      });
      setCursor(r.nextCursor ?? '');
    } catch (e) {
      if (!aliveRef.current) return;
      s.handleApiError(e, { fallbackTitle: '没能加载更多，请重试' });
    } finally {
      if (aliveRef.current) setMore(false);
    }
  };

  // 每次回到本页都重取第一页：签名预览链接只有 600 秒，离开期间在途任务也可能已经出图。
  useDidShow(() => {
    aliveRef.current = true;
    void loadFirst({ silent: items.length > 0 });
    void getCreativeStatus().then((st) => { if (aliveRef.current) setCanCreate(!!st?.enabled); });
  });
  useDidHide(() => { aliveRef.current = false; clearTimer(); });
  // 卸载兜底：useDidHide 不覆盖「页面被销毁」这条路径，定时器不停会在页面没了之后继续 setState。
  useEffect(() => () => { aliveRef.current = false; clearTimer(); }, []);

  /** 图片加载失败先当签名过期处理，重取一次换新链接。 */
  const onImgError = () => {
    if (urlRetriedRef.current) return;
    urlRetriedRef.current = true;
    void loadFirst({ silent: true });
  };

  const openJob = (jobId: string) => {
    const ok = navTo(`/packages/work/posterJob/index?jobId=${encodeURIComponent(jobId)}`, {
      fail: () => Taro.showToast({ title: '成品图页面加载失败，请重试', icon: 'none' }),
    });
    if (!ok) Taro.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
  };
  const goLibrary = () => {
    const ok = navTo('/packages/work/library/index', {
      fail: () => Taro.showToast({ title: '方案库加载失败，请重试', icon: 'none' }),
    });
    if (!ok) Taro.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
  };
  const goPosterDesigner = () => { switchTo('/pages/studio/index'); };

  return (
    <View className={`page gallery ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="我的作品库" onBack={() => Taro.navigateBack()} titleClassName="gl-title" />

      <View className="pad" style={{ paddingTop: '12px' }}>
        <Text className="gl-hint">出过的每一版海报都留在这里，点开可保存相册、分享好友或改文字重排。</Text>

        <View className="gl-sec">
          <Text className="gl-sec-t">海报成品图</Text>
          {items.length ? <Text className="gl-sec-n">{`${items.length} 张`}</Text> : null}
        </View>

        <AsyncState
          loading={loading && items.length === 0}
          error={failed && items.length === 0}
          onRetry={() => void loadFirst()}
          skeletonRows={3}
        >
          {items.length === 0 ? (
            <View className="gl-empty">
              <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="image" size={22} color={accent} /></View>
              <Text className="et">还没有成品图</Text>
              <Text className="es">
                {canCreate
                  ? '在对话里让海报设计师出方案，再点「生成成品图」，出好的每一版都会沉淀在这里。'
                  : '成品图能力当前未开启，已出过的作品仍会保留在这里。'}
              </Text>
              {canCreate ? (
                <View className="es-btn" style={{ background: accent }} onClick={goPosterDesigner}>
                  <Text>去找海报设计师</Text>
                </View>
              ) : null}
            </View>
          ) : (
            <>
              <View className="gl-grid">
                {items.map((it) => (
                  <Tile
                    key={it.jobId}
                    item={it}
                    accent={accent}
                    onOpen={() => openJob(it.jobId)}
                    onImgError={onImgError}
                  />
                ))}
              </View>
              {cursor ? (
                <View className="gl-more" onClick={() => void loadMore()}>
                  <Text>{more ? '加载中…' : '加载更多'}</Text>
                </View>
              ) : (
                <Text className="gl-end">已经到底了</Text>
              )}
            </>
          )}
        </AsyncState>

        {/* 文字成果不在本页重做一份列表：方案与历史版本的真源是方案库 / 报告页，这里只给入口。 */}
        <View className="gl-sec">
          <Text className="gl-sec-t">文字成果</Text>
        </View>
        <View className="gl-row card" onClick={goLibrary}>
          <View className="gl-row-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="layers" size={18} color={accent} /></View>
          <View className="gl-row-b">
            <Text className="gl-row-t">我的方案库</Text>
            <Text className="gl-row-s">对话产出的方案与报告，按版本沉淀</Text>
          </View>
          <Text className="gl-row-go">›</Text>
        </View>
      </View>
    </View>
  );
}
