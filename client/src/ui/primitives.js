import { React, useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { cx, pct } from '../core/utils.js'

function Switch({ on, onChange, disabled, title }) {
  return h('button', { type: 'button', className: cx('ab-switch', on && 'on'), onClick: () => !disabled && onChange(!on), disabled, title, role: 'switch', 'aria-checked': !!on })
}
function Row({ label, hint, children }) {
  return h('div', { className: 'ab-row' }, h('div', { className: 'ab-label' }, h('b', null, label), hint ? h('small', null, hint) : null), h('div', { className: 'ab-ctl' }, children))
}
function Card({ title, desc, icon, right, children, className }) {
  return h('div', { className: cx('ab-card', className) },
    title ? h('div', { className: 'ab-flex', style: { marginBottom: desc ? 0 : 10 } }, h('h3', null, icon || null, title), h('div', { className: 'ab-spacer' }), right || null) : null,
    desc ? h('p', { className: 'ab-desc' }, desc) : null,
    children)
}
function Btn({ kind, small, onClick, disabled, children, title, className }) {
  const [busy, setBusy] = useState(false)
  return h('button', {
    type: 'button', title, className: cx('ab-btn', kind, small && 'sm', className), disabled: disabled || busy,
    onClick: async () => { if (!onClick) return; setBusy(true); try { await onClick() } finally { setBusy(false) } },
  }, busy ? [h('i', { key: 's', className: 'ab-spin' }), ' 处理中'] : children)
}

/** 自定义下拉：替代系统自带的蓝白 select。options: [{value, label, desc?, group?}] */
function Select({ value, options, onChange, placeholder, width }) {
  const [open, setOpen] = useState(false)
  const [act, setAct] = useState(-1)
  const ref = useRef(null)
  const cur = options.find((o) => o.value === value)
  useEffect(() => {
    if (!open) return
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const pick = (o) => { onChange(o.value); setOpen(false) }
  const openAt = () => { setOpen(true); setAct(Math.max(0, options.indexOf(cur))) }
  const onKey = (e) => {
    if (e.key === 'Escape') { setOpen(false); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return openAt()
      setAct((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (open && options[act]) pick(options[act])
      else openAt()
    }
  }
  let lastGroup = null
  const items = []
  options.forEach((o, i) => {
    if (o.group && o.group !== lastGroup) items.push(h('div', { key: 'g' + i, className: 'ab-sel-group' }, o.group))
    lastGroup = o.group || lastGroup
    items.push(h('div', { key: 'o' + i, role: 'option', 'aria-selected': o.value === value, className: cx('ab-sel-opt', o.value === value && 'on', i === act && 'act'), onMouseEnter: () => setAct(i), onMouseDown: (e) => { e.preventDefault(); pick(o) } },
      h('span', { className: 'ck' }, o.value === value ? '✓' : ''),
      h('span', { className: 'tx' }, o.label, o.desc ? h('span', { className: 'ds' }, o.desc) : null)))
  })
  return h('div', { className: cx('ab-sel', open && 'open'), ref, style: width ? { minWidth: width } : null },
    h('button', { type: 'button', className: 'ab-sel-btn', onClick: () => (open ? setOpen(false) : openAt()), onKeyDown: onKey, 'aria-haspopup': 'listbox', 'aria-expanded': open },
      h('span', { className: 'v' }, cur ? cur.label : h('span', { className: 'ab-muted' }, placeholder || '请选择')),
      h('svg', { className: 'chev', width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }, h('path', { d: 'M3 4.5 6 7.5 9 4.5' }))),
    open ? h('div', { className: 'ab-sel-pop', role: 'listbox' }, items) : null)
}

/** 卡片式单选：选项少、需要解释时用。 */
function Choices({ value, options, onChange }) {
  return h('div', { className: 'ab-choices', role: 'radiogroup' }, options.map((o) => h('button', { key: o.value, type: 'button', role: 'radio', 'aria-checked': o.value === value, className: cx('ab-choice', o.value === value && 'on'), onClick: () => onChange(o.value) },
    h('b', null, o.icon || null, o.label), o.desc ? h('small', null, o.desc) : null)))
}

/** 滑块 + 数值，比纯数字框直观。 */
function Range({ value, min, max, step, onChange, fmt }) {
  return h('div', { className: 'ab-range' },
    h('input', { type: 'range', min, max, step: step || 1, value: value ?? min, onChange: (e) => onChange(Number(e.target.value)) }),
    h('span', { className: 'val' }, fmt ? fmt(value) : value))
}
function Seg({ value, options, onChange, disabled }) {
  return h('div', { className: 'ab-seg' + (disabled ? ' off' : '') }, options.map((o) => h('button', { key: o.value, type: 'button', className: value === o.value ? 'on' : '', disabled: !!disabled, onClick: () => { if (!disabled) onChange(o.value) } }, o.label)))
}
function Empty({ icon, text }) {
  return h('div', { className: 'ab-empty' }, h('div', { className: 'big' }, icon || '🐋'), text)
}

/** 一行一个的列表框：输入时保留原文（含正在敲的空行），只把解析结果交给草稿。 */
function ListArea({ value, onChange, placeholder, numbers }) {
  const parse = (t) => t.split(numbers ? /[\n,，;；\s]+/ : /[\n,，;；]+/).map((s) => s.trim()).filter(Boolean)
  const [text, setText] = useState(value.join('\n'))
  // 外面改了（保存、撤销、重新载入）而且和框里内容对不上时才覆盖
  useEffect(() => { if (parse(text).join('\n') !== value.join('\n')) setText(value.join('\n')) }, [value.join('\n')])
  return h('textarea', { className: 'ab-textarea', style: { minHeight: 60 }, placeholder, value: text,
    onChange: (e) => { setText(e.target.value); onChange(parse(e.target.value)) },
    onBlur: () => setText(parse(text).join('\n')) })
}

/** 单行版 ListArea：输入过程保留原文（逗号、空格都能敲进去），失焦才解析成列表写回。
 * 原来直接在 onChange 里 split+filter，敲分隔符的瞬间前半段就被处理掉、光标乱跳，
 * 没法正常输入「a, b」这样的内容。numbers=true 时只保留数字（QQ 号名单用）。 */
function ListInput({ value, onChange, placeholder, numbers, style }) {
  const parse = (t, { strict } = {}) => {
    const parts = String(t).split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean)
    if (!numbers) return parts
    // numbers=true：敲到一半的短数字（"123"）先留着——失焦才校验，不然输入框像键盘坏了。
    // 提交（失焦/保存）时 strict=true，仍不足 4 位的无效片段才丢掉。
    const cleaned = parts.map((s) => s.replace(/\D/g, ''))
    return strict ? cleaned.filter((s) => s.length >= 4) : cleaned.filter(Boolean)
  }
  const [text, setText] = useState(value.join(', '))
  useEffect(() => { if (parse(text, { strict: true }).join(',') !== value.join(',')) setText(value.join(', ')) }, [value.join(',')])
  return h('input', { className: 'ab-input', style: { width: '100%', ...(style || {}) }, placeholder, value: text,
    onChange: (e) => { setText(e.target.value); onChange(parse(e.target.value, { strict: true })) },
    onBlur: () => { const t = parse(text, { strict: true }).join(', '); setText(t); onChange(parse(t, { strict: true })) } })
}

/** 百分数行：输入过程保留原始字符串（打 0、0.、065 都不会被强行回写），
 * 失焦时才解析写回。原来的受控 number input 每敲一键就 Number() 一次：
 * 敲「0.」被归一成 0、光标跳到末尾，再敲就变成 065；清空时 Number('')=0
 * 和残留的旧值打架，保存出来是 100。清空 + 失焦 = 稳定写 0。 */
function PercentRow({ label, value, fallback, write, remove }) {
  const shown = () => Math.round((Number(value !== undefined && value !== null && value !== '' ? value : (fallback ?? 0)) || 0) * 100)
  const [text, setText] = useState(String(shown()))
  useEffect(() => { const s = String(shown()); if (parsePct(text) !== shown()) setText(s) }, [shown()])
  const parsePct = (t) => { const n = Number(String(t).trim()); if (!Number.isFinite(n) || n < 0) return 0; const v = n > 1 ? n / 100 : n; return Math.round(Math.min(v, 1) * 100) }
  const commit = () => {
    const p = parsePct(text)
    setText(String(p))
    write(p / 100)
  }
  return h(Row, { label },
    h('input', { className: 'ab-input sm', type: 'number', min: 0, max: 100, value: text,
      onChange: (e) => setText(e.target.value), onBlur: commit,
      onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } } }),
    h('span', { className: 'ab-muted' }, '% 插话'),
    remove ? h(Btn, { small: true, kind: 'ghost', onClick: remove }, '移除') : null)
}

// 绑定到草稿配置的控件


function ModOff({ name }) {
  return h(Card, { title: name }, h('div', { className: 'ab-muted ab-small' }, '「' + name + '」模块关着，这部分用不了。要用的话去「扩展」页把它打开。'))
}
/** 一个标签页出错时只坏这一页：显示原因和「回到概览」，不会整个面板白屏（也不会因为记住了这一页而一直白）。 */
class TabBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error) { try { localStorage.setItem('qq-hub.tab', 'overview') } catch (e) {} }
  render() {
    if (!this.state.error) return this.props.children
    return h(Card, { title: '这一页出错了' },
      h('div', { className: 'ab-note err' }, String((this.state.error && this.state.error.message) || this.state.error)),
      h('div', { className: 'ab-small ab-muted', style: { margin: '8px 0' } }, '别的页面不受影响。把这段报错截图发给作者就行。'),
      h('div', { className: 'ab-flex' },
        h(Btn, { small: true, kind: 'primary', onClick: () => this.props.onHome && this.props.onHome() }, '回到概览'),
        h(Btn, { small: true, kind: 'ghost', onClick: () => this.setState({ error: null }) }, '再试一次')))
  }
}

export {
  Switch, Row, Card, Btn, Select, Choices, Range, Seg, Empty, ListArea, ListInput, PercentRow, ModOff, TabBoundary
}
