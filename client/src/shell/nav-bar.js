import { useState, useEffect, useRef, Fragment, h } from '../core/react.js'
import { navIcon } from '../ui/icons.js'
import { cx } from '../core/utils.js'
import { NAV_GROUPS, navGroupOf, navOrder, NAV_ALIAS } from '../domain/nav.js'

function NavBar({ tabs, cur, go, mark, dirtyOf, open, onClose, returnFocusRef }) {
  const [find, setFind] = useState('')
  const [finding, setFinding] = useState(false)
  const [hi, setHi] = useState(0)
  const drawerRef = useRef(null)
  const searchRef = useRef(null)
  const groups = NAV_GROUPS
    .map((g) => ({ ...g, list: tabs.filter((t) => navGroupOf(t).id === g.id).sort((a, b) => navOrder(g, a) - navOrder(g, b)) }))
    .filter((g) => g.list.length)
  const q = find.trim().toLowerCase()
  const hits = groups.flatMap((g) => g.list.map((t) => ({ t, g })))
    .filter(({ t, g }) => !q || [t.label, g.label, NAV_ALIAS[t.id] || '', t.id].join(' ').toLowerCase().includes(q))
  const pick = (t) => { setFinding(false); setFind(''); setHi(0); go(t.id) }
  const openFind = () => {
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 1023px)').matches) {
      // The parent owns drawer visibility; Alt+K inside the closed desktop tree is handled by the menu button.
      const button = returnFocusRef && returnFocusRef.current
      if (button) button.click()
    }
    setFinding(true)
    setHi(0)
  }
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openFind() }
      else if (e.key === 'Escape') { setFinding(false); if (open) onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  useEffect(() => {
    if (finding && searchRef.current) searchRef.current.focus()
  }, [finding, open])
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const root = drawerRef.current
    const first = root && root.querySelector('button, input')
    if (first) first.focus()
    const trap = (e) => {
      if (e.key !== 'Tab' || !root) return
      const items = Array.from(root.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')).filter((el) => el.offsetParent !== null)
      if (!items.length) return
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      if (e.shiftKey && document.activeElement === firstItem) { e.preventDefault(); lastItem.focus() }
      else if (!e.shiftKey && document.activeElement === lastItem) { e.preventDefault(); firstItem.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => {
      document.body.style.overflow = previous
      document.removeEventListener('keydown', trap)
      if (returnFocusRef && returnFocusRef.current) returnFocusRef.current.focus()
    }
  }, [open])
  useEffect(() => {
    const active = document.querySelector(open ? '.ab-nav-mobile .ab-nav-item.on' : '.ab-sidebar .ab-nav-item.on')
    if (active) active.scrollIntoView({ block: 'nearest' })
  }, [cur.id, open])
  const tabBtn = (t) => h('button', {
    key: t.id, type: 'button', 'aria-current': cur.id === t.id ? 'page' : undefined,
    className: cx('ab-nav-item', cur.id === t.id && 'on'), onClick: () => pick(t),
  }, h('span', { className: 'ab-nav-item-label' }, t.label), mark(t))
  const finder = (scope) => finding ? h('div', { className: 'ab-finder-inline' },
    h('input', {
      ref: searchRef, className: 'ab-input', placeholder: '搜索页面或功能', value: find, role: 'combobox', 'aria-expanded': true, 'aria-controls': 'ab-nav-results-' + scope,
      onChange: (e) => { setFind(e.target.value); setHi(0) },
      onKeyDown: (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setHi(Math.min(hi + 1, hits.length - 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math.max(hi - 1, 0)) }
        else if (e.key === 'Enter' && hits[hi]) { e.preventDefault(); pick(hits[hi].t) }
      },
    }),
    h('div', { className: 'ab-finder-list', role: 'listbox', id: 'ab-nav-results-' + scope }, hits.length
      ? hits.map(({ t, g }, i) => h('button', { key: t.id, type: 'button', role: 'option', 'aria-selected': i === hi, className: cx('ab-finder-item', i === hi && 'on'), onMouseEnter: () => setHi(i), onClick: () => pick(t) }, t.label, h('small', null, g.label)))
      : h('div', { className: 'ab-finder-empty' }, '没有匹配的功能'))) : null
  const tree = (scope) => h(Fragment, null,
    h('div', { className: 'ab-nav-search' },
      h('button', { type: 'button', className: 'ab-find-btn', 'aria-expanded': finding, onClick: () => { setFinding(!finding); setHi(0) } },
        navIcon('M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.2-4.2'), h('span', null, '查找设置'), h('span', { className: 'ab-kbd' }, 'Alt K'))),
    finder(scope),
    finding ? null : h('div', { className: 'ab-nav-tree' }, groups.map((g) => h('section', { className: 'ab-nav-group', key: g.id },
      h('div', { className: 'ab-nav-group-title' }, g.label, g.list.some((t) => dirtyOf(t.id)) ? h('i', { className: 'dirty', title: '这组有未保存修改' }) : null),
      g.list.map(tabBtn)))))
  return h(Fragment, null,
    h('aside', { className: 'ab-sidebar' }, h('nav', { className: 'ab-nav', 'aria-label': 'QQ Hub 功能' }, tree('desktop'))),
    open ? h('div', { className: 'ab-drawer-layer', role: 'presentation', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() } },
      h('div', { className: 'ab-drawer', role: 'dialog', 'aria-modal': true, 'aria-label': 'QQ Hub 功能菜单', ref: drawerRef },
        h('div', { className: 'ab-drawer-head' }, h('strong', null, '功能菜单'), h('button', { type: 'button', className: 'ab-drawer-close', 'aria-label': '关闭菜单', onClick: onClose }, navIcon('M6 6l12 12M18 6 6 18'))),
        h('nav', { className: 'ab-nav ab-nav-mobile', 'aria-label': 'QQ Hub 功能' }, tree('mobile')))) : null)
}

export { NavBar }
