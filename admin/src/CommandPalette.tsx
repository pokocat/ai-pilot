// 命令面板（⌘K / Ctrl+K）——本次改版最直接的可用性杠杆。
//
// 运营日常里出现频率最高的两个动作，旧版都很贵：
//   ① 「去某一屏」：22 个目的地平铺在横滚底栏里，得先想它归谁管、再横滑找；
//   ② 「找某个用户」：用户页一次性渲染全部用户、没有搜索框，客服拿到一个手机号
//      只能靠浏览器 Ctrl+F 在长列表里翻。
// 现在两件事都是一次键盘操作：⌘K → 打字 → 回车。用户命中直接跳到该用户详情。

import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { api, type AdminUserItem } from './api';
import { useDialogFocus } from './components';
import { NAV_GROUPS, NAV_SECTIONS, scoreSection, type NavSection } from './nav';

type Row =
  | { kind: 'section'; section: NavSection }
  | { kind: 'user'; user: AdminUserItem };

const USER_LIMIT = 6;

export default function CommandPalette({ isOwner, onClose, onGo, onOpenUser }: {
  isOwner: boolean;
  onClose: () => void;
  onGo: (key: string) => void;
  onOpenUser: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [userState, setUserState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [userError, setUserError] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useDialogFocus(onClose, inputRef);

  const loadUsers = () => {
    setUserState('loading');
    setUserError('');
    api.users()
      .then((u) => { setUsers(u); setUserState('ready'); })
      .catch((e) => {
        setUserState('error');
        setUserError((e as Error)?.message || '用户名单加载失败');
      });
  };

  // 用户名单懒加载：只在真的开始搜时拉一次（面板打开但只用来跳页面时不浪费请求）。
  useEffect(() => {
    if (!q.trim() || userState !== 'idle') return;
    loadUsers();
  }, [q, userState]);

  const sections = useMemo(
    () => NAV_SECTIONS.filter((s) => !s.ownerOnly || isOwner),
    [isOwner],
  );

  const rows = useMemo<Row[]>(() => {
    const query = q.trim();
    const secRows: Row[] = sections
      .map((s) => ({ s, score: scoreSection(s, query) }))
      .filter((x): x is { s: NavSection; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((x) => ({ kind: 'section' as const, section: x.s }));

    if (!query) return secRows;

    const needle = query.toLowerCase();
    const userRows: Row[] = users
      .filter((u) =>
        u.name?.toLowerCase().includes(needle) ||
        u.phone?.includes(needle) ||
        u.id.toLowerCase().startsWith(needle))
      .slice(0, USER_LIMIT)
      .map((u) => ({ kind: 'user' as const, user: u }));

    // 手机号/纯数字更像在找人 → 用户排前面；否则页面跳转优先。
    const digitish = /^\d{3,}$/.test(query);
    return digitish ? [...userRows, ...secRows] : [...secRows, ...userRows];
  }, [q, sections, users]);

  // 结果集变化时把光标收回首项，避免停在已消失的行上。
  useEffect(() => { setCursor(0); }, [q]);

  const pick = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'section') onGo(row.section.key);
    else onOpenUser(row.user.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(rows.length - 1, c + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return; }
    if (e.key === 'Enter') { e.preventDefault(); pick(rows[cursor]); }
  };

  // 键盘移动光标时把选中项滚进可视区。
  useEffect(() => {
    listRef.current?.querySelector('.pal-i.on')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const groupLabel = (k: string) => NAV_GROUPS.find((g) => g.key === k)?.label ?? '';
  const searching = !!q.trim() && (userState === 'idle' || userState === 'loading');
  const activeId = rows[cursor] ? `palette-option-${cursor}` : undefined;

  return (
    <div className="pal-scrim" onClick={onClose}>
      <div ref={dialogRef} className="pal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="命令面板" tabIndex={-1}>
        <div className="pal-top">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="pal-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="跳转到某一屏，或按姓名 / 手机号找用户…"
            aria-label="搜索页面或用户"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={activeId}
          />
          <span className="kbd">esc</span>
        </div>

        <div className="pal-list" ref={listRef} id="palette-results" role="listbox" aria-label="搜索结果" aria-busy={searching}>
          {userState === 'error' && q.trim() && (
            <div className="pal-error" role="alert">
              <span>用户搜索失败：{userError}</span>
              <button type="button" className="mini-btn" onClick={loadUsers}>重试</button>
            </div>
          )}
          {rows.length === 0 && (
            <div className="pal-empty">{searching ? '搜索中…' : `没有匹配「${q}」的页面或用户`}</div>
          )}
          {rows.map((row, i) => {
            const on = i === cursor;
            if (row.kind === 'section') {
              return (
                <button
                  key={`s:${row.section.key}`}
                  id={`palette-option-${i}`}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`pal-i ${on ? 'on' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(row)}
                >
                  <span className="pal-i-ic"><Icon name={row.section.icon} size={15} /></span>
                  <span className="pal-i-b">
                    <span className="pal-i-t">{row.section.label}</span>
                    <span className="pal-i-s">{row.section.hint}</span>
                  </span>
                  <span className="pal-i-k">{groupLabel(row.section.group)}</span>
                </button>
              );
            }
            const u = row.user;
            return (
              <button
                key={`u:${u.id}`}
                id={`palette-option-${i}`}
                type="button"
                role="option"
                aria-selected={on}
                className={`pal-i ${on ? 'on' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(row)}
              >
                <span className="pal-i-ic"><Icon name="user" size={15} /></span>
                <span className="pal-i-b">
                  <span className="pal-i-t">{u.name || '（未命名）'}</span>
                  <span className="pal-i-s">{u.phone} · {u.planName ?? '未分配套餐'} · 余额 {u.creditBalance}</span>
                </span>
                <span className="pal-i-k">用户</span>
              </button>
            );
          })}
        </div>

        <div className="pal-foot">
          <span><span className="kbd">↑↓</span> 选择</span>
          <span><span className="kbd">↵</span> 打开</span>
          <span>输入手机号直接定位用户</span>
        </div>
      </div>
    </div>
  );
}
