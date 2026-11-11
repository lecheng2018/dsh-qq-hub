import { h } from '../core/react.js'
import { setPath, getPath, pct, cx } from '../core/utils.js'
import { Switch, Row, Select, Range, Btn, Choices, ListArea } from './primitives.js'

function useField(draft, setDraft) {
  return {
    sw: (path, extra) => h(Switch, { on: !!getPath(draft, path), onChange: (v) => setDraft(setPath(draft, path, v)), ...(extra || {}) }),
    text: (path, props) => h('input', { className: cx('ab-input', props && props.size), value: getPath(draft, path) ?? '', placeholder: props && props.placeholder, type: (props && props.type) || 'text', onChange: (e) => setDraft(setPath(draft, path, e.target.value)) }),
    // 数字框要有兜底：draft 里没存过值时，显示扩展模块 defaults 里的默认值，
    // 否则「每次最多带几条」这类框一片空白，看着像没配置。
    // allowEmpty：0 或留空有「沿用默认」含义的字段（如目的引擎每日上限）允许清空——
    // 空值原样保存为 ''，后端按「未覆写」处理；清空瞬间不能被 fallback 顶回来，否则永远清不掉。
    num: (path, props) => {
      const raw = getPath(draft, path)
      const fallback = props && props.fallback
      const empty = raw === undefined || raw === null || raw === ''
      const shown = empty && fallback !== undefined && !(props && props.allowEmpty) ? fallback : (raw ?? '')
      const sanitize = (v) => {
        // 非数字内容自动过滤（正整数语义）；小数取整数部分——
        // 注意不能先无条件滤掉非数字：'3.7' 会变 '37'（2026-11-06 复核发现），先按小数点切。
        if (v === '') return (props && props.allowEmpty) ? '' : v
        let s = String(v).trim()
        const dot = s.indexOf('.')
        let head = (dot >= 0 ? s.slice(0, dot) : s).replace(/[^\d]/g, '')
        let frac = dot >= 0 ? s.slice(dot + 1).replace(/[^\d]/g, '') : ''
        if (!head && !frac) return (props && props.allowEmpty) ? '' : v
        let n = Number(head || '0')
        if (props && props.min !== undefined && props.min >= 0) n = Math.floor(n) // 正整数语义：3.7 → 3
        if (props && props.max !== undefined && n > props.max) n = props.max
        if (props && props.min !== undefined && n < props.min) n = props.min
        return n
      }
      return h('input', { className: 'ab-input sm', type: 'number', min: props && props.min, max: props && props.max, step: (props && props.step) || 1, value: shown, placeholder: (props && props.allowEmpty && empty && fallback !== undefined) ? '留空 = 沿用 ' + fallback : undefined, onChange: (e) => setDraft(setPath(draft, path, sanitize(e.target.value))) })
    },
    percent: (path) => h(Range, { min: 0, max: 100, value: pct(getPath(draft, path)), onChange: (v) => setDraft(setPath(draft, path, v / 100)), fmt: (v) => v + '%' }),
    range: (path, min, max, step, fmt) => h(Range, { min, max, step, value: getPath(draft, path), onChange: (v) => setDraft(setPath(draft, path, v)), fmt }),
    list: (path, props) => h(ListArea, { value: getPath(draft, path) || [], placeholder: props && props.placeholder, numbers: props && props.numbers, onChange: (v) => setDraft(setPath(draft, path, v)) }),
    select: (path, options, props) => h(Select, { value: getPath(draft, path) ?? '', options, onChange: (v) => setDraft(setPath(draft, path, v)), ...(props || {}) }),
    choices: (path, options) => h(Choices, { value: getPath(draft, path), options, onChange: (v) => setDraft(setPath(draft, path, v)) }),
  }
}

// ---------------- 标签页 ----------------

export { useField }
