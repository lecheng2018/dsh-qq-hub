import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { navIcon } from '../ui/icons.js'
import { cx } from '../core/utils.js'
import { NAV_GROUPS, navGroupOf, navOrder, NAV_ALIAS } from '../domain/nav.js'

function NavBar({ tabs, cur, go, mark, dirtyOf, subRef }) {
  const [last, setLast] = useState(() => { try { return JSON.parse(localStorage.getItem('qq-hub.navlast') || '{}') || {} } catch (e) { return {} } })
  const [find, setFind] = useState(null) // null = 没开；字符串 = 正在搜的字
  const [hi, setHi] = useState(0)
  const box = useRef(null)
  const groups = NAV_GROUPS
    .map((g) => ({ ...g, list: tabs.filter((t) => navGroupOf(t).id === g.id).sort((a, b) => navOrder(g, a) - navOrder(g, b)) }))
    .filter((g) => g.list.length)
  const curGroup = groups.find((g) => g.list.some((t) => t.id === cur.id)) || groups[0]
  // 记住每组最后看的那页：点分组时回到那页
  useEffect(() => {
    if (!curGroup || last[curGroup.id] === cur.id) return
    const next = { ...last, [curGroup.id]: cur.id }
    setLast(next)
    try { localStorage.setItem('qq-hub.navlast', JSON.stringify(next)) } catch (e) {}
  }, [cur.id])
  const openGroup = (g) => go((g.list.find((t) => t.id === last[g.id]) || g.list[0]).id)
  const toggleFind = () => { setFind((f) => (f === null ? '' : null)); setHi(0) }
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'k') { e.preventDefault(); toggleFind() }
      else if (e.key === 'Escape') setFind(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // 点到查找框外面就收起
  useEffect(() => {
    if (find === null) return
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setFind(null) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [find === null])
  const q = (find || '').trim().toLowerCase()
  const hits = find === null ? [] : groups.flatMap((g) => g.list.map((t) => ({ t, g })))
    .filter(({ t, g }) => !q || [t.label, g.label, NAV_ALIAS[t.id] || '', t.id].join(' ').toLowerCase().includes(q))
  const pick = (t) => { setFind(null); go(t.id) }
  const tabBtn = (t) => h('button', { key: t.id, type: 'button', role: 'tab', 'aria-selected': cur.id === t.id, className: cx('ab-tab', cur.id === t.id && 'on'), onClick: () => go(t.id) }, t.label, mark(t))
  return h('nav', { className: 'ab-nav', ref: box, 'aria-label': 'QQ Hub 功能' },
    h('div', { className: 'ab-nav-top' },
      h('div', { className: 'ab-nav-groups', role: 'tablist', 'aria-label': '功能分组' }, groups.map((g) => h('button', {
        key: g.id, type: 'button', role: 'tab', 'aria-selected': g.id === curGroup.id, className: cx('ab-grp', g.id === curGroup.id && 'on'),
        title: g.list.map((t) => t.label).join(' · '), onClick: () => openGroup(g),
      }, navIcon(g.icon), h('span', null, g.label), g.list.some((t) => dirtyOf(t.id)) ? h('i', { className: 'dirty', title: '这组里有没保存的改动' }) : null))),
      h('button', { type: 'button', className: 'ab-find-btn', 'aria-expanded': find !== null, title: '查找功能（Alt+K）', onClick: toggleFind },
        navIcon('M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.2-4.2'), h('span', { className: 't' }, '查找'), h('span', { className: 'ab-kbd' }, 'Alt K'))),
    curGroup && curGroup.list.length > 1 ? h('div', { className: 'ab-nav-sub', role: 'tablist', 'aria-label': curGroup.label, ref: subRef }, curGroup.list.map(tabBtn)) : null,
    find !== null ? h('div', { className: 'ab-finder' },
      h('input', {
        className: 'ab-input', autoFocus: true, placeholder: '找功能：语音、抖音、白名单…', value: find,
        onChange: (e) => { setFind(e.target.value); setHi(0) },
        onKeyDown: (e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi(Math.min(hi + 1, hits.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math.max(hi - 1, 0)) }
          else if (e.key === 'Enter' && hits[hi]) { e.preventDefault(); pick(hits[hi].t) }
        },
      }),
      h('div', { className: 'ab-finder-list', role: 'listbox' }, hits.length
        ? hits.map(({ t, g }, i) => h('button', { key: t.id, type: 'button', role: 'option', 'aria-selected': i === hi, className: cx('ab-finder-item', i === hi && 'on'), onMouseEnter: () => setHi(i), onClick: () => pick(t) }, t.label, h('small', null, g.label)))
        : h('div', { className: 'ab-finder-empty' }, '没找到，换个说法试试：语音、抖音、白名单'))) : null)
}

export { NavBar }
