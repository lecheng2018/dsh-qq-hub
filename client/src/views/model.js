import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Switch, Select, ListInput, Seg, Empty } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { setPath, clone } from '../core/utils.js'
import { get, post } from '../core/http.js'

function ChatModels({ draft, setDraft, list }) {
  const cm = draft.chatModels || { privateDefault: {}, groupDefault: {}, privates: {}, groups: {} }
  const [open, setOpen] = useState(false)
  const [add, setAdd] = useState({ kind: 'private', id: '', sel: '' })
  const key = (m) => m.provider + '::' + m.model
  const val = (s) => (s && s.provider && s.model ? s.provider + '::' + s.model : '')
  const toSel = (v) => { const [p, ...m] = v.split('::'); return v ? { provider: p, model: m.join('::'), reasoningEffort: '' } : { provider: '', model: '', reasoningEffort: '' } }
  // 同 Model 页：只有真正同名不同模型（hy3 / hy3-x）才缀上 id 区分
  const nameCount = {}
  for (const m of (list || [])) nameCount[m.name] = (nameCount[m.name] || 0) + 1
  const labelOf = (m) => (nameCount[m.name] > 1 ? m.name + '（' + m.model + '）' : m.name)
  const descOf = (m) => m.provider
  const base = [{ value: '', label: '跟随全局模型', desc: '上面「聊天用的模型」' }].concat((list || []).map((m) => ({ value: key(m), label: labelOf(m), desc: descOf(m), group: m.provider })))
  const optsFor = (v) => (v && !base.some((o) => o.value === v) ? base.concat([{ value: v, label: v.split('::').slice(1).join('::'), desc: '（DSH 里没找到）' }]) : base)
  const setCm = (patch) => setDraft(setPath(draft, 'chatModels', { ...cm, ...patch }))
  const rows = [['private', cm.privates || {}], ['group', cm.groups || {}]].flatMap(([kind, m]) => Object.entries(m).map(([id, sel]) => ({ kind, id, sel })))
  const label = (sel) => { const v = val(sel); const hit = (list || []).find((m) => key(m) === v); return hit ? hit.name : sel.model }
  const addRow = () => {
    if (!add.id || !add.sel) return
    const field = add.kind === 'private' ? 'privates' : 'groups'
    setCm({ [field]: { ...(cm[field] || {}), [add.id]: toSel(add.sel) } })
    setAdd({ ...add, id: '' })
  }
  const remove = (kind, id) => { const field = kind === 'private' ? 'privates' : 'groups'; const n = { ...(cm[field] || {}) }; delete n[id]; setCm({ [field]: n }) }
  return h(Card, { title: '按聊天选模型', desc: '顺序：这个私聊 > 这个群 > 所有私聊 / 所有群的默认 > 上面的全局模型。没选的一级就用下一级；选的模型在 DSH 里找不到时也自动退回。只有你能在这里改，聊天里的人换不了。换了之后从那个聊天的下一条消息起生效。' },
    h(Row, { label: '私聊默认模型' }, h(Select, { value: val(cm.privateDefault), width: 280, options: optsFor(val(cm.privateDefault)), onChange: (v) => setCm({ privateDefault: toSel(v) }) })),
    h(Row, { label: '群聊默认模型' }, h(Select, { value: val(cm.groupDefault), width: 280, options: optsFor(val(cm.groupDefault)), onChange: (v) => setCm({ groupDefault: toSel(v) }) })),
    h('div', { style: { marginTop: 8 } }, h(Btn, { small: true, kind: 'ghost', onClick: () => setOpen(!open) }, (open ? '收起' : '展开') + '单个 QQ / 群的例外（' + rows.length + '）')),
    open ? h('div', { style: { marginTop: 8 } },
      rows.length === 0 ? h('div', { className: 'ab-muted', style: { marginBottom: 10 } }, '还没有单独设置的 QQ 或群。') :
        rows.map((r) => h(Row, { key: r.kind + r.id, label: (r.kind === 'private' ? '私聊 ' : '群 ') + r.id }, h('span', { className: 'ab-muted' }, label(r.sel)), h(Btn, { small: true, kind: 'ghost', onClick: () => remove(r.kind, r.id) }, '移除'))),
      h('div', { className: 'ab-flex' },
        h(Seg, { value: add.kind, onChange: (v) => setAdd({ ...add, kind: v }), options: [{ value: 'private', label: '私聊' }, { value: 'group', label: '群' }] }),
        h('input', { className: 'ab-input', placeholder: add.kind === 'private' ? 'QQ 号' : '群号', value: add.id, onChange: (e) => setAdd({ ...add, id: e.target.value.replace(/\D/g, '') }) }),
        h(Select, { value: add.sel, width: 220, options: base.filter((o) => o.value), placeholder: '选模型', onChange: (v) => setAdd({ ...add, sel: v }) }),
        h(Btn, { small: true, disabled: !add.id || !add.sel, onClick: addRow }, '添加'))) : null)
}

function Model({ draft, setDraft, toast }) {
  const [list, setList] = useState(null)
  const [ping, setPing] = useState({})
  // 「立刻应用到所有会话」的忙碌态
  const [applying, setApplying] = useState(false)
  useEffect(() => { get('/models').then((r) => setList(r.list || [])) }, [])
  const key = (m) => m.provider + '::' + m.model
  // 后端已把「基础版 / 视觉版」（fan 与 fan-vision 这类同模型双 provider）合并成一条，
  // 所以这里只会剩一类重名：同一个 provider 下显示名相同、但确实是不同模型
  // （hy3 和 hy3-x 都叫 Hy3）。这种重名才需要把 model id 缀上，否则真的选不了。
  // 不再给每一行都加「能看图」——之前那样每个模型都带一句，反而像「全都能看图」。
  const nameCount = {}
  for (const m of (list || [])) nameCount[m.name] = (nameCount[m.name] || 0) + 1
  const labelOf = (m) => (nameCount[m.name] > 1 ? m.name + '（' + m.model + '）' : m.name)
  const descOf = (m) => m.provider
  const cur = draft.model.provider && draft.model.model ? draft.model.provider + '::' + draft.model.model : ''
  const curModel = cur && list ? list.find((m) => key(m) === cur) : null
  // reasoning === null 表示 DSH 明确说这个模型不支持思考强度（本地 Ollama 之类）
  const noReasoning = Boolean(curModel && curModel.reasoning === null)
  // 视觉能力：自动时把 DSH 的声明显示出来，主人一眼能看出会不会降级
  const autoVision = curModel ? curModel.vision : undefined
  const visionHint = draft.model.vision === 'on'
    ? '强制当「能看图」；模型其实看不了的话，带图的那一轮会报错'
    : draft.model.vision === 'off'
      ? '强制当「看不懂」：收到图片只给一行文字提示，不会把图塞给模型'
      : autoVision === true
        ? '自动：DSH 说这个模型支持看图'
        : autoVision === false
          ? '自动：DSH 说这个模型看不了图，会自动降级成文字提示'
          : '自动：DSH 没声明，默认照发；真看不了就手动选「不支持」'
  const test = async (m) => {
    setPing({ ...ping, [key(m)]: '测速中…' })
    const r = await post('/model/ping', { provider: m.provider, model: m.model })
    setPing((p) => ({ ...p, [key(m)]: r.ok ? (r.ms / 1000).toFixed(1) + ' 秒' : '失败：' + (r.message || '') }))
  }
  return h('div', { className: 'ab-grid' },
    h(Card, { title: '聊天用的模型', desc: '新建的 QQ 会话按这里的设置来；已有会话也可以在 DSH 里点开单独切换。聊天对速度很敏感，可以先点「测速」挑个快的。' },
      h(Row, { label: '思考强度', hint: noReasoning ? '这个模型不支持思考强度，会自动忽略' : '聊天建议「低」，回得快' }, h(Seg, { value: draft.model.reasoningEffort || 'low', disabled: noReasoning, onChange: (v) => setDraft(setPath(draft, 'model.reasoningEffort', v)), options: [{ value: 'low', label: '低' }, { value: 'high', label: '高' }, { value: 'max', label: '最高' }] })),
      h(Row, { label: '视觉能力', hint: visionHint }, h(Seg, {
        value: draft.model.vision || 'auto',
        onChange: (v) => setDraft(setPath(draft, 'model.vision', v)),
        options: [{ value: 'auto', label: '自动' }, { value: 'on', label: '支持' }, { value: 'off', label: '不支持' }],
      })),
      h(Row, {
        label: '辅助看图模型',
        hint: '主模型看不了图时，先让这个模型看一眼、转成文字再交给主模型。主模型自己能看图时不走这条，不额外花钱。',
      }, h(Switch, {
        // Switch 用的是 on 不是 value：写错了 on 永远是 undefined，
        // 点了只会触发 onChange(true)，显示状态不变，看起来就是「开关点了没反应」
        on: !!draft.visionHelper.enabled,
        onChange: (v) => setDraft(setPath(draft, 'visionHelper.enabled', v)),
      })),
      draft.visionHelper.enabled ? h(Row, { label: '用哪个模型看图' },
        h(Select, {
          value: draft.visionHelper.provider && draft.visionHelper.model ? draft.visionHelper.provider + '::' + draft.visionHelper.model : '',
          width: 280,
          options: [{ value: '', label: '选一个能看图的模型', desc: '要和聊天用的模型不同' }].concat((list || []).map((m) => ({ value: key(m), label: labelOf(m), desc: descOf(m), group: m.provider }))),
          onChange: (v) => {
            const [p, ...m] = v.split('::')
            let d = setPath(setPath(draft, 'visionHelper.provider', v ? p : ''), 'visionHelper.model', v ? m.join('::') : '')
            setDraft(d)
          },
        })
      ) : null,
      h(Row, { label: '模型' },
        h(Select, {
          value: cur, width: 280,
          options: [{ value: '', label: '跟随 DSH 默认', desc: '和你在 DSH 里平时用的一样' }].concat((list || []).map((m) => ({ value: key(m), label: labelOf(m), desc: descOf(m), group: m.provider }))),
          onChange: (v) => { const [p, ...m] = v.split('::'); setDraft(setPath(setPath(draft, 'model.provider', v ? p : ''), 'model.model', v ? m.join('::') : '')) },
        }),
        cur ? h(Btn, { small: true, onClick: () => test({ provider: draft.model.provider, model: draft.model.model }) }, '测速') : null,
        cur && ping[cur] ? h('span', { className: 'ab-muted ab-small' }, ping[cur]) : null),
    ),
    h(ChatModels, { draft, setDraft, list }),
    // 模型配置默认「等对方发下一条消息才切」，冷群可能几小时不动。
    // 这个按钮主动把配置抹平到所有已有会话，省得去 DSH 会话里一个个换。
    h(Card, { title: '应用到现有会话', desc: '这里的模型设置默认要等对方发下一条消息才生效（冷群可能几小时都不动）。点这里立刻把所有已有 QQ 会话切过去 —— 保存设置之后点。' },
      h(Btn, { small: true, disabled: applying, onClick: async () => {
        setApplying(true)
        try {
          const r = await post('/models/apply', {})
          toast(r?.ok ? (r.message || '切好了') : (r?.message || '没切成'), r?.ok ? 'ok' : 'err')
        } finally { setApplying(false) }
      } }, applying ? '切着呢…' : '立刻应用到所有会话'),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } }, '只改这个插件管的 QQ 会话，不动你在 DSH 里其他对话的模型。')),
    h(Card, { title: '可用的模型', desc: '点「测速」会真的问一次模型（花一点点额度），看它回一句话要多久。' },
      list === null ? h(Empty, { icon: '⏳', text: '加载中…' }) : list.length === 0 ? h(Empty, { text: 'DSH 没有列出模型' }) :
        h('table', { className: 'ab-table' }, h('tbody', null, list.map((m) => h('tr', { key: key(m) },
          h('td', null, labelOf(m)), h('td', { className: 'ab-muted' }, m.provider),
          h('td', null, ping[key(m)] || ''),
          h('td', { style: { textAlign: 'right' } }, h(Btn, { small: true, kind: 'ghost', onClick: () => test(m) }, '测速'), h(Btn, { small: true, kind: 'ghost', onClick: () => { setDraft(setPath(setPath(draft, 'model.provider', m.provider), 'model.model', m.model)); toast('选好了，记得保存') } }, '用这个')))))),
    ),
  )
}


export { Model, ChatModels }
