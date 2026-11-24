import { React, useState, useEffect, useRef, Fragment, h } from '../core/react.js'
import { cx, parsePct } from '../core/utils.js'

/* 基础控件层：所有视图与内置模块面板共用的组件。
 * 注意：ExtPanel 会把 Card/Btn/Switch/Row/Empty/Select/Seg/Range 这些名字原样传给
 * 模块的自定义 panel.js，导出名是隐形契约，只加不改。 */

function Switch({ on, onChange, disabled, title, label }) {
  return <button type="button" className={cx('ab-switch', on && 'on')} onClick={() => !disabled && onChange(!on)} disabled={disabled} title={title} aria-label={label || title} role="switch" aria-checked={!!on} />
}

/** 字段行：左边是 label + hint，右边是控件；窄屏自动改成上下两行（纯开关行保持左右对齐，节省留白）。 */
function Row({ label, hint, children }) {
  const isSwitchOnly = React.isValidElement(children) && children.type === Switch
  return (
    <div className={cx('ab-row', isSwitchOnly && 'ab-row-sw')}>
      <div className="ab-label">
        <b>{label}</b>
        {hint ? <small>{hint}</small> : null}
      </div>
      <div className="ab-ctl">{children}</div>
    </div>
  )
}

function Card({ title, desc, icon, right, more, collapse, children, className }) {
  // collapse：默认收起的长卡片（标题行可点展开）。描述保留在收起态，帮助决定要不要展开。
  const [open, setOpen] = useState(!collapse)
  if (!collapse) {
    return (
      <div className={cx('ab-card', className)}>
        {title ? (
          <div className="ab-card-head" style={{ marginBottom: desc || more ? 0 : 12 }}>
            <h3>{icon || null}{title}</h3>
            <div className="ab-spacer" />
            {right ? <div className="ab-card-right">{right}</div> : null}
          </div>
        ) : null}
        {desc ? <p className="ab-desc">{desc}</p> : null}
        {more ? <More>{more}</More> : null}
        {children}
      </div>
    )
  }
  return (
    <div className={cx('ab-card ab-fold', !open && 'closed', className)}>
      <div className="ab-fold-bar" style={{ marginBottom: desc || open ? 6 : 0 }}>
        <div
          className="ab-fold-head" role="button" tabIndex={0} aria-expanded={open}
          onClick={() => setOpen(!open)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open) } }}
        >
          <span className={cx('ab-fold-chev', open && 'open')} aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 3 7.5 6 4.5 9" /></svg>
          </span>
          <h3>{icon || null}{title}</h3>
        </div>
        {right ? <div className="ab-card-right">{right}</div> : null}
      </div>
      {desc ? <p className="ab-desc">{desc}</p> : null}
      {open ? children : null}
      {open && more ? <More>{more}</More> : null}
    </div>
  )
}

/** 卡内可折叠小节：低频/高级配置默认收起，标题行可点开。 */
function FoldSection({ title, desc, right, defaultOpen = false, children, style }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="ab-fold-section" style={style}>
      <div className="ab-fold-bar">
        <div
          className="ab-fold-head" role="button" tabIndex={0} aria-expanded={open}
          onClick={() => setOpen(!open)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open) } }}
        >
          <span className={cx('ab-fold-chev', open && 'open')} aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 3 7.5 6 4.5 9" /></svg>
          </span>
          <span className="ab-fold-title">{title}</span>
        </div>
        {right ? <div className="ab-card-right">{right}</div> : null}
      </div>
      {desc ? <p className="ab-fold-section-desc">{desc}</p> : null}
      {open ? <div className="ab-fold-section-body">{children}</div> : null}
    </div>
  )
}

function Btn({ kind, small, onClick, disabled, children, title, className }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button" title={title} className={cx('ab-btn', kind, small && 'sm', className)} disabled={disabled || busy}
      onClick={async () => { if (!onClick) return; setBusy(true); try { await onClick() } finally { setBusy(false) } }}
    >
      {busy ? [<i key="s" className="ab-spin" />, ' 处理中'] : children}
    </button>
  )
}

/** 长文案收纳：一句话摘要 + 可展开的详细说明（details/summary，无 JS 状态）。
 * 面板「文字长又扎堆」的主出口：操作说明、踩坑背景这类内容收进这里。 */
function More({ label = '详细说明', children }) {
  return (
    <details className="ab-more">
      <summary>{label}</summary>
      <div className="ab-more-body">{children}</div>
    </details>
  )
}

/** 状态徽章（模块行、pill 里用）。kind: dim/warn/err/mine */
function Badge({ kind, title, children }) {
  return <span className={cx('ab-badge', kind)} title={title}>{children}</span>
}

/** 状态胶囊（顶栏状态、小信息位）。kind: ok/warn/err/不填 */
function Pill({ kind, title, children }) {
  return <span className={cx('ab-pill', kind)} title={title}>{children}</span>
}

/** 自定义下拉：替代系统自带的蓝白 select。options: [{value, label, desc?, group?}] */
function Select({ value, options, onChange, placeholder, width }) {
  const [open, setOpen] = useState(false)
  const [act, setAct] = useState(-1)
  const [pos, setPos] = useState({ up: false, alignR: false })
  const ref = useRef(null)
  const btnRef = useRef(null)
  const popRef = useRef(null)
  const cur = options.find((o) => o.value === value)
  useEffect(() => {
    if (!open) return undefined
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus() } }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  useEffect(() => {
    if (open) popRef.current?.querySelector('.ab-sel-opt.act')?.scrollIntoView({ block: 'nearest' })
  }, [open, act])
  const pick = (o) => { onChange(o.value); setOpen(false) }
  const openAt = () => {
    if (ref.current && typeof window !== 'undefined') {
      const r = ref.current.getBoundingClientRect()
      const spaceBelow = window.innerHeight - r.bottom
      const spaceAbove = r.top
      const spaceRight = window.innerWidth - r.left
      setPos({
        up: spaceBelow < 240 && spaceAbove > spaceBelow,
        alignR: spaceRight < 260 && r.right > 200,
      })
    }
    setOpen(true)
    setAct(Math.max(0, options.indexOf(cur)))
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { setOpen(false); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!options.length) return
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
    if (o.group && o.group !== lastGroup) items.push(<div key={'g' + i} className="ab-sel-group">{o.group}</div>)
    lastGroup = o.group || lastGroup
    items.push(
      <div key={'o' + i} role="option" aria-selected={o.value === value} className={cx('ab-sel-opt', o.value === value && 'on', i === act && 'act')} onMouseEnter={() => setAct(i)} onClick={() => pick(o)}>
        <span className="ck">{o.value === value ? '✓' : ''}</span>
        <span className="tx">{o.label}{o.desc ? <span className="ds">{o.desc}</span> : null}</span>
      </div>,
    )
  })
  return (
    <div className={cx('ab-sel', open && 'open', pos.up && 'up', pos.alignR && 'align-r')} ref={ref} style={width ? { '--ab-sel-w': typeof width === 'number' ? width + 'px' : width } : null}>
      <button ref={btnRef} type="button" className="ab-sel-btn" onClick={() => (open ? setOpen(false) : openAt())} onKeyDown={onKey} aria-haspopup="listbox" aria-expanded={open}>
        <span className="v">{cur ? cur.label : <span className="ab-muted">{placeholder || '请选择'}</span>}</span>
        <svg className="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
      </button>
      {open ? <div ref={popRef} className="ab-sel-pop" role="listbox">{items}</div> : null}
    </div>
  )
}

/** 卡片式单选：选项少、需要解释时用。 */
function Choices({ value, options, onChange }) {
  return (
    <div className="ab-choices" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={cx('ab-choice', o.value === value && 'on')} onClick={() => onChange(o.value)}>
          <b>{o.icon || null}{o.label}</b>
          {o.desc ? <small>{o.desc}</small> : null}
        </button>
      ))}
    </div>
  )
}

/** 滑块 + 数值，比纯数字框直观。 */
function Range({ value, min, max, step, onChange, fmt }) {
  return (
    <div className="ab-range">
      <input type="range" min={min} max={max} step={step || 1} value={value ?? min} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="val">{fmt ? fmt(value) : value}</span>
    </div>
  )
}

function Seg({ value, options, onChange, disabled }) {
  return (
    <div className={'ab-seg' + (disabled ? ' off' : '')} role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} disabled={!!disabled} onClick={() => { if (!disabled) onChange(o.value) }}>{o.label}</button>
      ))}
    </div>
  )
}

function Empty({ icon, text }) {
  return <div className="ab-empty"><div className="big">{icon || '🐋'}</div>{text}</div>
}

/** 一行一个的列表框：输入时保留原文（含正在敲的空行），只把解析结果交给草稿。 */
function ListArea({ value, onChange, placeholder, numbers }) {
  const parse = (t) => t.split(numbers ? /[\n,，;；\s]+/ : /[\n,，;；]+/).map((s) => s.trim()).filter(Boolean)
  const [text, setText] = useState(value.join('\n'))
  // 外面改了（保存、撤销、重新载入）而且和框里内容对不上时才覆盖
  useEffect(() => { if (parse(text).join('\n') !== value.join('\n')) setText(value.join('\n')) }, [value.join('\n')])
  return (
    <textarea
      className="ab-textarea" style={{ minHeight: 60 }} placeholder={placeholder} value={text}
      onChange={(e) => { setText(e.target.value); onChange(parse(e.target.value)) }}
      onBlur={() => setText(parse(text).join('\n'))}
    />
  )
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
  return (
    <input
      className="ab-input" style={{ width: '100%', ...(style || {}) }} placeholder={placeholder} value={text}
      onChange={(e) => { setText(e.target.value); onChange(parse(e.target.value, { strict: true })) }}
      onBlur={() => { const t = parse(text, { strict: true }).join(', '); setText(t); onChange(parse(t, { strict: true })) }}
    />
  )
}

/** 百分数行：输入过程保留原始字符串（打 0、0.、065 都不会被强行回写），失焦才解析写回。
 * 解析口径在 core/utils.js 的 parsePct（敲 1 = 1%，不把 ≤1 当小数）。 */
function PercentRow({ label, value, fallback, write, remove }) {
  const shown = () => Math.round((Number(value !== undefined && value !== null && value !== '' ? value : (fallback ?? 0)) || 0) * 100)
  const [text, setText] = useState(String(shown()))
  useEffect(() => { const s = String(shown()); if (parsePct(text) !== shown()) setText(s) }, [shown()])
  const commit = () => {
    const p = parsePct(text)
    setText(String(p))
    write(p / 100)
  }
  return (
    <Row label={label}>
      <input className="ab-input sm" type="number" min={0} max={100} value={text}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }} />
      <span className="ab-muted">% 插话</span>
      {remove ? <Btn small kind="ghost" onClick={remove}>移除</Btn> : null}
    </Row>
  )
}

// 绑定到草稿配置的控件


function ModOff({ name }) {
  return <Card title={name}><div className="ab-muted ab-small">「{name}」模块关着，这部分用不了。要用的话去「扩展」页把它打开。</div></Card>
}

/** 一个标签页出错时只坏这一页：显示原因和「回到概览」，不会整个面板白屏（也不会因为记住了这一页而一直白）。 */
class TabBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error) { try { localStorage.setItem('qq-hub.tab', 'overview') } catch (e) {} }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <Card title="这一页出错了">
        <div className="ab-note err">{String((this.state.error && this.state.error.message) || this.state.error)}</div>
        <div className="ab-small ab-muted" style={{ margin: '8px 0' }}>别的页面不受影响。把这段报错截图发给作者就行。</div>
        <div className="ab-flex">
          <Btn small kind="primary" onClick={() => this.props.onHome && this.props.onHome()}>回到概览</Btn>
          <Btn small kind="ghost" onClick={() => this.setState({ error: null })}>再试一次</Btn>
        </div>
      </Card>
    )
  }
}

export {
  Switch, Row, Card, FoldSection, Btn, More, Badge, Pill, Select, Choices, Range, Seg, Empty, ListArea, ListInput, PercentRow, ModOff, TabBoundary
}
