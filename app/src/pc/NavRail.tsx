import { useStore } from '../hooks/useStore';
import RailIcon, { type RailIconName } from './RailIcon';
import { promptLogin } from './authBridge';
import type { PcState, PcTab } from './state';

// 命名与移动端底栏保持一致（2026-08-10 三端统一：军情→沙盘、军令→点兵、老板→主公）。
// title 是设计稿里给的一句话说明，桌面端用原生 tooltip 承接。
const ITEMS: { key: PcTab; icon: RailIconName; text: string; hint: string }[] = [
  { key: 'sessions', icon: 'sessions', text: '问策', hint: '有事问军师' },
  { key: 'sand', icon: 'sand', text: '沙盘', hint: '看今日判断' },
  { key: 'exec', icon: 'exec', text: '点兵', hint: '做今天的事' },
  { key: 'think', icon: 'think', text: '锦囊', hint: '存你的家底' },
  { key: 'lord', icon: 'lord', text: '主公', hint: '你自己' },
];

export default function NavRail({ st }: { st: PcState }) {
  const s = useStore();
  const me = s.me();
  const unread = s.badgeUnread();
  const reviewDue = s.reviewDue();
  const avatar = me?.user.avatarUrl || '';
  const initial = (me?.user.name || '主').slice(0, 1);

  return (
    <nav className="pc-rail">
      <div className="pc-rail-logo">军</div>

      {ITEMS.map((it) => (
        <button
          key={it.key}
          type="button"
          title={it.hint}
          className={`pc-rail-btn${st.tab === it.key ? ' pc-on' : ''}`}
          onClick={() => st.go(it.key)}
        >
          <span className="pc-rail-ic">
            <RailIcon name={it.icon} />
            {it.key === 'sessions' && unread > 0 && (
              <span className="pc-rail-badge">{unread > 99 ? '99+' : unread}</span>
            )}
            {it.key === 'exec' && reviewDue && <span className="pc-rail-dot" />}
          </span>
          {st.railLabels && <span className="pc-rail-label">{it.text}</span>}
        </button>
      ))}

      <div className="pc-rail-spacer" />
      <div className="pc-rail-sep" />
      <button
        type="button"
        className="pc-rail-me"
        title={me ? `${me.user.name || '主公'}${me.tenant.name ? ` · ${me.tenant.name}` : ''}` : '点此登录'}
        style={avatar ? { backgroundImage: `url(${avatar})` } : undefined}
        onClick={() => (s.isAuthed() ? st.go('lord') : promptLogin('profile'))}
      >
        {avatar ? '' : s.isAuthed() ? initial : '登'}
      </button>
    </nav>
  );
}
