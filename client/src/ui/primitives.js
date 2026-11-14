import { React, useState, useEffect, useRef, Fragment, h } from '../core/react.js'
import { cx } from '../core/utils.js'
import { navIcon } from './icons.js'

function Switch({ on, onChange, disabled, title }) {
  return h('button', { type: 'button', className: cx('ab-switch', on && 'on'), onClick: () => !disabled && onChange(!on), disabled, title, 'aria-label': title || '切换开关', role: 'switch', 'aria-checked': !!on })
}
function HelpDisclosure({ label = '了解详细规则', children }) {
  const [open, setOpen] = useState(false)
  const id = useRef('ab-help-' + Math.random().toString(36).slice(2))
  return h('div', { className: cx('ab-help', open && 'open') },
    h('button', { type: 'button', className: 'ab-help-toggle', 'aria-expanded': open, 'aria-controls': id.current, onClick: () => setOpen(!open) }, navIcon(open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'), label),
    open ? h('div', { className: 'ab-help-body', id: id.current }, children) : null)
}
function Row({ label, hint, description, details, children, error, layout = 'auto' }) {
  return h('div', { className: cx('ab-row', layout === 'stacked' && 'stacked', error && 'has-error') },
    h('div', { className: 'ab-label' }, h('b', null, label), hint || description ? h('small', null, description || hint) : null),
    h('div', { className: 'ab-ctl' }, children, error ? h('div', { className: 'ab-field-error', role: 'alert' }, error) : null, details ? h(HelpDisclosure, null, details) : null))
}
function Card({ title, desc, summary, icon, right, children, className, collapsible = false, defaultOpen = true, tone = 'default', id }) {
  const [open, setOpen] = useState(defaultOpen)
  return h('section', { className: cx('ab-card', tone === 'danger' && 'danger', className), id },
    title ? h('div', { className: 'ab-card-head' },
      collapsible ? h('button', { type: 'button', className: 'ab-card-collapse', 'aria-expanded': open, onClick: () => setOpen(!open) }, navIcon(open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'), h('h3', null, icon || null, title)) : h('h3', null, icon || null, title),
      h('div', { className: 'ab-spacer' }), right || null) : null,
    desc || summary ? h('p', { className: 'ab-desc' }, summary || desc) : null,
    collapsible && !open ? null : children)
}
function Btn({ kind, small, onClick, disabled, children, title, className }) {
  const [busy, setBusy] = useState(false)
  return h('button', {
    type: 'button', title, className: cx('ab-btn', kind, small && 'sm', className), disabled: disabled || busy,
    onClick: async () => { if (!onClick) return; setBusy(true); try { await onClick() } finally { setBusy(false) } },
  }, busy ? [h('i', { key: 's', className: 'ab-spin' }), ' 处理中'] : children)
}

function useMedia(query) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false)
  useEffect(() => {
    if (!window.matchMedia) return
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener ? media.addEventListener('change', update) : media.addListener(update)
    return () => media.removeEventListener ? media.removeEventListener('change', update) : media.removeListener(update)
  }, [query])
  return matches
}
function useModal(open, ref, onClose) {
  useEffect(() => {
    if (!open) return
    const oldOverflow = document.body.style.overflow
    const oldFocus = document.activeElement
    document.body.style.overflow = 'hidden'
    const root = ref.current
    const focusable = () => root ? Array.from(root.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')).filter((el) => el.offsetParent !== null) : []
    const items = focusable()
    if (items[0]) items[0].focus()
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key !== 'Tab') return
      const list = focusable()
      if (!list.length) return
      if (e.shiftKey && document.activeElement === list[0]) { e.preventDefault(); list[list.length - 1].focus() }
      else if (!e.shiftKey && document.activeElement === list[list.length - 1]) { e.preventDefault(); list[0].focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = oldOverflow
      document.removeEventListener('keydown', onKey)
      if (oldFocus && oldFocus.focus) oldFocus.focus()
    }
  }, [open])
}
function BottomSheet({ title, children, onClose, className }) {
  const ref = useRef(null)
  useModal(true, ref, onClose)
  return h('div', { className: 'ab-sheet-layer', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() } },
    h('section', { className: cx('ab-sheet', className), role: 'dialog', 'aria-modal': true, 'aria-label': title || '操作', ref },
      h('div', { className: 'ab-sheet-head' }, h('strong', null, title || ''), h('button', { type: 'button', className: 'ab-sheet-close', 'aria-label': '关闭', onClick: onClose }, navIcon('M6 6l12 12M18 6 6 18'))), children))
}
function Dialog({ title, children, onClose, className }) {
  const ref = useRef(null)
  useModal(true, ref, onClose)
  return h('div', { className: 'ab-dialog-layer', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() } },
    h('section', { className: cx('ab-dialog', className), role: 'dialog', 'aria-modal': true, 'aria-label': title || '操作', ref },
      h('div', { className: 'ab-sheet-head' }, h('strong', null, title || ''), h('button', { type: 'button', className: 'ab-sheet-close', 'aria-label': '关闭', onClick: onClose }, navIcon('M6 6l12 12M18 6 6 18'))), children))
}

/** 自定义下拉：桌面使用弹层，窄屏使用底部 Sheet；options 结构保持不变。 */
function Select({ value, options = [], onChange, placeholder, width, disabled = false }) {
  const mobile = useMedia('(max-width: 640px)')
  const [open, setOpen] = useState(false)
  const [act, setAct] = useState(-1)
  const [query, setQuery] = useState('')
  const [up, setUp] = useState(false)
  const ref = useRef(null)
  const listRef = useRef(null)
  const cur = options.find((o) => o.value === value)
  const shown = mobile && query.trim() ? options.filter((o) => (String(o.label) + ' ' + String(o.desc || '') + ' ' + String(o.group || '')).toLowerCase().includes(query.trim().toLowerCase())) : options
  useEffect(() => {
    if (!open || mobile) return
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open, mobile])
  useEffect(() => {
    if (!open) return
    const active = listRef.current && listRef.current.querySelector('.act, .on')
    if (active) active.scrollIntoView({ block: 'nearest' })
  }, [open, act])
  const close = () => { setOpen(false); setQuery('') }
  const pick = (o) => { onChange(o.value); close() }
  const openAt = () => {
    if (disabled || !options.length) return
    if (!mobile && ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setUp(typeof window !== 'undefined' && window.innerHeight - rect.bottom < 280 && rect.top > 320)
    }
    setAct(Math.max(0, options.indexOf(cur)))
    setOpen(true)
  }
  const onKey = (e) => {
    if (disabled) return
    if (e.key === 'Escape') { close(); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return openAt()
      setAct((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
    }
    if (e.key === 'Home' && open) { e.preventDefault(); setAct(0) }
    if (e.key === 'End' && open) { e.preventDefault(); setAct(options.length - 1) }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (open && options[act]) pick(options[act])
      else openAt()
    }
  }
  let lastGroup = null
  const items = []
  shown.forEach((o) => {
    const i = options.indexOf(o)
    if (o.group && o.group !== lastGroup) items.push(h('div', { key: 'g' + i, className: 'ab-sel-group' }, o.group))
    lastGroup = o.group || lastGroup
    items.push(h(mobile ? 'button' : 'div', { key: 'o' + i, type: mobile ? 'button' : undefined, role: 'option', 'aria-selected': o.value === value, className: cx('ab-sel-opt', o.value === value && 'on', i === act && 'act'), onMouseEnter: () => setAct(i), onMouseDown: mobile ? undefined : (e) => { e.preventDefault(); pick(o) }, onClick: mobile ? () => pick(o) : undefined },
      h('span', { className: 'ck' }, o.value === value ? '✓' : ''),
      h('span', { className: 'tx' }, o.label, o.desc ? h('span', { className: 'ds' }, o.desc) : null)))
  })
  const list = h('div', { className: 'ab-sel-pop', role: 'listbox', ref: listRef }, items.length ? items : h('div', { className: 'ab-finder-empty' }, '没有匹配选项'))
  return h(Fragment, null,
    h('div', { className: cx('ab-sel', open && 'open', up && 'up'), ref, style: width ? { minWidth: width } : null },
      h('button', { type: 'button', className: 'ab-sel-btn', disabled, onClick: () => (open ? close() : openAt()), onKeyDown: onKey, 'aria-haspopup': 'listbox', 'aria-expanded': open },
        h('span', { className: 'v' }, cur ? cur.label : h('span', { className: 'ab-muted' }, placeholder || '请选择')),
        h('svg', { className: 'chev', width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }, h('path', { d: 'M3 4.5 6 7.5 9 4.5' }))),
      open && !mobile ? list : null),
    open && mobile ? h(BottomSheet, { title: '选择' + (cur ? '（当前：' + cur.label + '）' : ''), onClose: close, className: 'ab-select-sheet' },
      options.length > 8 ? h('input', { className: 'ab-input ab-sheet-search', autoFocus: true, placeholder: '搜索选项', value: query, onChange: (e) => setQuery(e.target.value) }) : null,
      list) : null)
}

function Choices({ value, options, onChange, compact = false }) {
  const selected = options.find((o) => o.value === value)
  return h('div', { className: 'ab-choice-wrap' },
    h('div', { className: cx('ab-choices', compact && 'compact'), role: 'radiogroup' }, options.map((o) => h('button', { key: o.value, type: 'button', role: 'radio', 'aria-checked': o.value === value, className: cx('ab-choice', o.value === value && 'on'), onClick: () => onChange(o.value) },
      h('b', null, o.icon || null, o.label), !compact && o.desc ? h('small', null, o.desc) : null))),
    compact && selected && selected.desc ? h('div', { className: 'ab-choice-current-desc' }, selected.desc) : null)
}
function Range({ value, min, max, step, onChange, fmt }) {
  return h('div', { className: 'ab-range' },
    h('input', { type: 'range', min, max, step: step || 1, value: value ?? min, onChange: (e) => onChange(Number(e.target.value)) }),
    h('span', { className: 'val' }, fmt ? fmt(value) : value))
}
function Seg({ value, options, onChange, disabled }) {
  return h('div', { className: 'ab-seg' + (disabled ? ' off' : ''), role: 'group' }, options.map((o) => h('button', { key: o.value, type: 'button', 'aria-pressed': value === o.value, className: value === o.value ? 'on' : '', disabled: !!disabled, onClick: () => { if (!disabled) onChange(o.value) } }, o.label)))
}
function Empty({ icon, text }) {
  return h('div', { className: 'ab-empty' }, icon ? h('div', { className: 'big' }, icon) : null, text)
}
function SectionNav({ items }) {
  return h('nav', { className: 'ab-section-nav', 'aria-label': '页内分区' }, items.map((item) => h('button', { key: item.id, type: 'button', onClick: () => { const el = document.getElementById(item.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }) } }, item.label)))
}
function CopyText({ value, label = '复制', secret = false }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = String(value || '')
  return h('div', { className: 'ab-copy-text' },
    h('code', { className: cx(!open && 'truncate') }, secret && !open ? '••••••••' : text),
    h('div', { className: 'ab-copy-actions' },
      text.length > 80 || secret ? h(Btn, { small: true, kind: 'ghost', onClick: () => setOpen(!open) }, open ? '收起' : '展开') : null,
      h(Btn, { small: true, kind: 'ghost', onClick: async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600) } }, copied ? '已复制' : label)))
}
function DataTable({ columns, rows, rowKey, empty = '暂无数据' }) {
  if (!rows.length) return h(Empty, { text: empty })
  return h(Fragment, null,
    h('div', { className: 'ab-data-table-desktop' }, h('table', { className: 'ab-table' }, h('thead', null, h('tr', null, columns.map((c) => h('th', { key: c.key }, c.label)))), h('tbody', null, rows.map((row, i) => h('tr', { key: rowKey ? rowKey(row) : i }, columns.map((c) => h('td', { key: c.key }, c.render(row, i)))))))),
    h('div', { className: 'ab-data-cards' }, rows.map((row, i) => h('div', { className: 'ab-data-card', key: rowKey ? rowKey(row) : i }, columns.map((c) => h('div', { className: 'ab-data-field', key: c.key }, h('span', { className: 'ab-data-label' }, c.label), h('div', { className: 'ab-data-value' }, c.render(row, i))))))))
}
function DangerZone({ title, description, actionLabel, onConfirm, confirmText }) {
  const [open, setOpen] = useState(false)
  return h(Card, { title, desc: description, tone: 'danger', collapsible: true, defaultOpen: false },
    h(Btn, { kind: 'danger', small: true, onClick: () => setOpen(true) }, actionLabel),
    open ? h(Dialog, { title, onClose: () => setOpen(false) },
      h('p', { className: 'ab-dialog-copy' }, description),
      confirmText ? h('p', { className: 'ab-note warn' }, confirmText) : null,
      h('div', { className: 'ab-dialog-actions' }, h(Btn, { onClick: () => setOpen(false) }, '取消'), h(Btn, { kind: 'danger', onClick: async () => { await onConfirm(); setOpen(false) } }, actionLabel))) : null)
}

function ListArea({ value, onChange, placeholder, numbers }) {
  const parse = (t) => t.split(numbers ? /[\n,，;；\s]+/ : /[\n,，;；]+/).map((s) => s.trim()).filter(Boolean)
  const [text, setText] = useState(value.join('\n'))
  useEffect(() => { if (parse(text).join('\n') !== value.join('\n')) setText(value.join('\n')) }, [value.join('\n')])
  return h('textarea', { className: 'ab-textarea', style: { minHeight: 60 }, placeholder, value: text,
    onChange: (e) => { setText(e.target.value); onChange(parse(e.target.value)) },
    onBlur: () => setText(parse(text).join('\n')) })
}
function ListInput({ value, onChange, placeholder, numbers, style }) {
  const parse = (t, { strict } = {}) => {
    const parts = String(t).split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean)
    if (!numbers) return parts
    const cleaned = parts.map((s) => s.replace(/\D/g, ''))
    return strict ? cleaned.filter((s) => s.length >= 4) : cleaned.filter(Boolean)
  }
  const [text, setText] = useState(value.join(', '))
  useEffect(() => { if (parse(text, { strict: true }).join(',') !== value.join(',')) setText(value.join(', ')) }, [value.join(',')])
  return h('input', { className: 'ab-input', style: { width: '100%', ...(style || {}) }, placeholder, value: text,
    onChange: (e) => { setText(e.target.value); onChange(parse(e.target.value, { strict: true })) },
    onBlur: () => { const t = parse(text, { strict: true }).join(', '); setText(t); onChange(parse(t, { strict: true })) } })
}
function PercentRow({ label, value, fallback, write, remove }) {
  const shown = () => Math.round((Number(value !== undefined && value !== null && value !== '' ? value : (fallback ?? 0)) || 0) * 100)
  const [text, setText] = useState(String(shown()))
  useEffect(() => { const s = String(shown()); if (parsePct(text) !== shown()) setText(s) }, [shown()])
  const parsePct = (t) => { const n = Number(String(t).trim()); if (!Number.isFinite(n) || n < 0) return 0; return Math.round(Math.min(n, 100)) }
  const commit = () => { const p = parsePct(text); setText(String(p)); write(p / 100) }
  return h(Row, { label },
    h('input', { className: 'ab-input sm', type: 'number', min: 0, max: 100, value: text,
      onChange: (e) => setText(e.target.value), onBlur: commit,
      onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } } }),
    h('span', { className: 'ab-muted' }, '% 插话'),
    remove ? h(Btn, { small: true, kind: 'ghost', onClick: remove }, '移除') : null)
}
function ModOff({ name }) {
  return h(Card, { title: name }, h('div', { className: 'ab-muted ab-small' }, '「' + name + '」模块已关闭。需要使用时，请到「扩展」页开启。'))
}
class TabBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error) { try { localStorage.setItem('qq-hub.tab', 'overview') } catch (e) {} }
  render() {
    if (!this.state.error) return this.props.children
    return h(Card, { title: '这一页出错了' },
      h('div', { className: 'ab-note err' }, String((this.state.error && this.state.error.message) || this.state.error)),
      h('div', { className: 'ab-small ab-muted', style: { margin: '8px 0' } }, '其他页面不受影响。可以把报错信息发给作者。'),
      h('div', { className: 'ab-flex' },
        h(Btn, { small: true, kind: 'primary', onClick: () => this.props.onHome && this.props.onHome() }, '回到概览'),
        h(Btn, { small: true, kind: 'ghost', onClick: () => this.setState({ error: null }) }, '再试一次')))
  }
}

export {
  Switch, Row, Card, Btn, Select, Choices, Range, Seg, Empty, ListArea, ListInput, PercentRow, ModOff, TabBoundary,
  HelpDisclosure, SectionNav, CopyText, DataTable, Dialog, BottomSheet, DangerZone,
}
