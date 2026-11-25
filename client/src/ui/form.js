import { h } from '../core/react.js'
import { setPath, getPath, pct, cx } from '../core/utils.js'
import { Switch, Row, Select, Range, Btn, Choices, ListArea, NumInput } from './primitives.js'

function useField(draft, setDraft) {
  return {
    sw: (path, extra) => <Switch on={!!getPath(draft, path)} onChange={(v) => setDraft(setPath(draft, path, v))} {...(extra || {})} />,
    text: (path, props) => <input className={cx('ab-input', props && props.size)} value={getPath(draft, path) ?? ''} placeholder={props && props.placeholder} type={(props && props.type) || 'text'} onChange={(e) => setDraft(setPath(draft, path, e.target.value))} />,
    // 数字框：**没填就显示空的 + 占位提示「留空 = 沿用 N」**，不把默认值塞进框里。
    //
    // 关键点（2026-11-24 修）：旧实现把 fallback 当成 value 显示，于是用户删光后
    // 立刻又被默认值填回去 —— 「群里一条最长 / 私聊一条最长 / 一轮最多几条」这些框
    // 根本清不掉，看着像输入框坏了。清空要真的能清空，就得让「框里是空的」这个状态
    // 存在，默认值只作为占位提示出现（真正生效的是后端 normalize 的回落值）。
    //
    // 注意 `fallback` 只在**草稿里没有存过值**时才有提示意义：最小值由 min 兜住，
    // 清空后保存的是 ''，后端 num() 把 '' 当「没填」回落默认（见 core/config.js）。
    num: (path, props) => {
      const raw = getPath(draft, path)
      const fallback = props && props.fallback
      const empty = raw === undefined || raw === null || raw === ''
      return (
        <NumInput
          value={empty ? '' : raw}
          min={props && props.min}
          max={props && props.max}
          step={props && props.step}
          scale={props && props.scale}
          style={props && props.style}
          allowEmpty
          placeholder={fallback !== undefined
            ? '留空 = 沿用 ' + fallback
            : (props && props.placeholder)}
          onChange={(v) => setDraft(setPath(draft, path, v))}
        />
      )
    },
    percent: (path) => <Range min={0} max={100} value={pct(getPath(draft, path))} onChange={(v) => setDraft(setPath(draft, path, v / 100))} fmt={(v) => v + '%'} />,
    range: (path, min, max, step, fmt) => <Range min={min} max={max} step={step} value={getPath(draft, path)} onChange={(v) => setDraft(setPath(draft, path, v))} fmt={fmt} />,
    list: (path, props) => <ListArea value={getPath(draft, path) || []} placeholder={props && props.placeholder} numbers={props && props.numbers} onChange={(v) => setDraft(setPath(draft, path, v))} />,
    select: (path, options, props) => <Select value={getPath(draft, path) ?? ''} options={options} onChange={(v) => setDraft(setPath(draft, path, v))} {...(props || {})} />,
    area: (path, props) => <textarea className="ab-textarea" style={{ minHeight: (props && props.rows ? props.rows * 20 : 60) }} placeholder={props && props.placeholder} value={getPath(draft, path) ?? ''} onChange={(e) => setDraft(setPath(draft, path, e.target.value))} />,
    choices: (path, options) => <Choices value={getPath(draft, path)} options={options} onChange={(v) => setDraft(setPath(draft, path, v))} />,
  }
}

export { useField }
