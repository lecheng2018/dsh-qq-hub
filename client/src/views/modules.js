import { React, useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Switch, Select, Range, Seg, Empty, ModOff } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { API } from '../core/api-base.js'
import { clone, setPath, getPath, timeAgo, copy, cx } from '../core/utils.js'
import { get, post } from '../core/http.js'

function LocalApi({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState('')
  const [img, setImg] = useState('')
  const load = () => get('/local/status').then(setSt)
  useEffect(() => { load() }, [])
  const act = async (path, slot, label) => { setBusy(slot + label); const r = await post(path, { slot }); setBusy(''); toast(r.message, r.ok ? 'ok' : 'err'); if (r.image) setImg(r.image); load() }
  return h('div', { className: 'ab-grid' },
    h(Card, { title: '本地接口', desc: '想用自己电脑上的模型或服务（GPT-SoVITS 语音、SD WebUI / ComfyUI 画图、自己训练的 so-vits-svc 音色、本地语音识别……）？在这里生成一个脚本模板，照注释改，或者点「复制给 DSH 的话」粘给 DSH，让它帮你改。脚本放在插件数据目录的 local 文件夹里，插件升级不会覆盖；改完保存就生效，不用重启。每一项要打开开关才会用，出错时语音和识别会自动退回内置方式。' },
      h('div', { className: 'ab-flex' },
        h('code', { className: 'ab-small', style: { wordBreak: 'break-all', flex: 1 } }, st ? st.dir : '…'),
        h(Btn, { small: true, onClick: () => post('/local/open').then((r) => toast(r.message)) }, '打开文件夹'))),
    !st ? h(Empty, { icon: '⏳', text: '加载中…' }) : st.list.map((x) => h(Card, { key: x.slot, title: x.title + '（' + x.file + '）', right: f.sw('local.' + x.slot) },
      h('div', { className: 'ab-flex', style: { marginBottom: 8 } },
        h('span', { className: 'ab-small', style: { color: x.active ? 'var(--ab-ok)' : 'var(--ab-muted)' } },
          x.active ? '● 正在由本地脚本接管' : !x.exists ? '还没有这个脚本' : !x.enabled ? '脚本已经有了，开关没开（用内置方式）' : '用内置方式'),
        x.last ? h('span', { className: 'ab-small', style: { color: x.last.ok ? 'var(--ab-ok)' : 'var(--ab-err)' } }, ' · 上次' + (x.last.ok ? '成功，' + x.last.message : '出错：' + x.last.message)) : null),
      h('div', { className: 'ab-flex' },
        x.exists ? null : h(Btn, { small: true, kind: 'primary', disabled: !!busy, onClick: () => act('/local/template', x.slot, 't') }, '生成模板'),
        h(Btn, { small: true, onClick: () => { navigator.clipboard.writeText(x.prompt); toast('复制好了，粘给 DSH，再把【】里那句换成你的情况', 'ok') } }, '复制给 DSH 的话'),
        x.exists && (x.slot === 'tts' || x.slot === 'image') ? h(Btn, { small: true, disabled: !!busy, onClick: () => act('/local/test', x.slot, 'x') }, busy === x.slot + 'x' ? '正在试…' : '试一下') : null),
      x.slot === 'image' && img ? h('img', { src: 'data:image/png;base64,' + img, style: { marginTop: 10, maxWidth: 240, borderRadius: 8 } }) : null)),
  )
}

// ---------------- 扩展：模块 ----------------
const MOD_STATE = (m) => {
  if (m.safeSkipped) return { cls: 'dim', text: '安全模式，没加载' }
  if (!m.enabled) return { cls: 'dim', text: '关着' }
  if (m.running === 'user' && m.builtin) return { cls: 'mine', text: '用的是你的版本' }
  if (m.running === 'user') return { cls: 'mine', text: '在跑' }
  if (m.running === 'builtin' && m.fallback) return { cls: 'warn', text: '你的版本没加载成功，先用内置的' }
  if (m.running === 'builtin') return { cls: '', text: '在跑' }
  return { cls: 'err', text: m.error ? '没加载成功' : '没在跑' }
}

/** 一个模块一行：开关、状态、报错，能复制来改 / 用回内置的 / 重新加载。 */
function ModuleRow({ m, draft, setModules, toast, reload }) {
  const s = MOD_STATE(m)
  const [open, setOpen] = useState(false)
  const setMod = async (patch) => {
    const r = await post('/save', { modules: { [m.id]: { ...((draft.modules || {})[m.id] || {}), ...patch } } })
    if (r.ok === false) return toast(r.message, 'err')
    toast(patch.enabled === false ? `「${m.name}」关掉了` : patch.enabled ? `「${m.name}」打开了` : '好了', 'ok')
    setModules(r.modules)
    reload()
  }
  const act = async (path, body, okMsg) => {
    const r = await post(path, body)
    toast(r.message || okMsg, r.ok === false ? 'err' : 'ok')
    if (r.list) setModules(r.list)
    if (r.prompt && r.ok) copy(r.prompt, toast)
    reload()
    return r
  }
  const what = [m.tools.length ? '工具：' + m.tools.join('、') : '', m.commands.length ? '命令：' + m.commands.map((c) => '/' + c).join(' ') : ''].filter(Boolean).join('　')
  const errs = (m.error ? [{ label: '加载', message: m.error }] : []).concat(m.errors || [])
  return h('div', { className: 'ab-mod' },
    h('div', { className: 'main' },
      h('div', { className: 'nm' }, m.name, h('code', null, m.id),
        h('span', { className: cx('ab-badge', s.cls) }, s.text),
        m.outdated ? h('span', { className: 'ab-badge warn', title: '你复制 / 替换时内置的是 ' + m.forkedFrom + '，现在是 ' + m.builtinVersion }, '内置版本更新了') : null),
      m.description ? h('div', { className: 'ds' }, m.description) : null,
      what ? h('div', { className: 'what' }, what) : null,
      errs.length ? h('div', { className: 'ab-note err', style: { marginTop: 6 } },
        h('div', { style: { cursor: 'pointer' }, onClick: () => setOpen(!open) }, (open ? '▾ ' : '▸ ') + errs.length + ' 条报错：' + String(errs[0].message).split('\n')[0].slice(0, 120)),
        open ? h('div', { className: 'ab-code' }, errs.map((e) => (e.at ? new Date(e.at).toLocaleTimeString() + ' ' : '') + (e.label || '') + '：' + e.message).join('\n\n')) : null) : null,
      h('div', { className: 'acts' },
        m.builtin && !m.hasUser ? h(Btn, { small: true, onClick: () => act('/modules/fork', { id: m.id }, '复制好了'), title: '把这个内置模块的源码复制到 modules/' + m.id + '/，改了就替换内置的' }, '复制一份来改') : null,
        m.hasUser ? h(Btn, { small: true, onClick: () => post('/modules/open?id=' + encodeURIComponent(m.id)).then((r) => toast(r.message)) }, '打开文件夹') : null,
        m.hasUser ? h(Btn, { small: true, onClick: () => get('/modules/prompt?id=' + encodeURIComponent(m.id)).then((r) => copy(r.prompt, toast, '复制好了，粘给 DSH，把【】里那句换成你想要的')) }, '复制给 DSH 的话') : null,
        m.hasUser && !m.safeSkipped ? h(Btn, { small: true, onClick: () => act('/modules/reload', { id: m.id }, '重新加载好了') }, '重新加载') : null)),
    h('div', { className: 'side' },
      h(Switch, { on: m.enabled, onChange: (v) => setMod({ enabled: v }), title: m.enabled ? '关掉这个模块' : '打开这个模块' }),
      m.builtin && m.hasUser ? h('label', { className: 'ab-small ab-muted', style: { display: 'flex', alignItems: 'center', gap: 6 } }, '用内置的', h(Switch, { on: m.useBuiltin, onChange: (v) => setMod({ useBuiltin: v }) })) : null))
}

/** 模拟测试：不上 QQ 试模块。发出去的只截下来看，不真发。 */
function Simulate({ toast }) {
  const [as, setAs] = useState('owner')
  const [kind, setKind] = useState('private')
  const [text, setText] = useState('')
  const [reply, setReply] = useState('')
  const [out, setOut] = useState(null)
  const [tools, setTools] = useState([])
  const [tool, setTool] = useState('')
  const [args, setArgs] = useState('{}')
  const [tout, setTout] = useState(null)
  useEffect(() => { get('/modules/tools?as=' + as + '&kind=' + kind).then((r) => { const l = r.list || []; setTools(l); if (!l.some((t) => t.name === tool)) setTool(l[0] ? l[0].name : '') }) }, [as, kind])
  const cur = tools.find((t) => t.name === tool)
  const run = async () => { const r = await post('/modules/simulate', { as, kind, text, reply }); if (r.ok === false) return toast(r.message, 'err'); setOut(r) }
  const call = async () => {
    let a
    try { a = JSON.parse(args || '{}') } catch (e) { return toast('参数要是 JSON，比如 {"city":"北京"}', 'err') }
    const r = await post('/modules/tool', { as, kind, name: tool, args: a })
    if (r.ok === false) return toast(r.message, 'err')
    setTout(r)
  }
  const sentList = (sent) => (sent && sent.length ? h('div', { className: 'ab-code' }, sent.map((s) => '→ ' + s.chatId + '：' + s.text).join('\n')) : h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '没有发出任何消息'))
  return h(Card, { title: '模拟测试', desc: '不用上 QQ 就能试模块：这里发出去的消息只截下来显示，不会真发到 QQ。（模块直接调 api.onebot 的操作，比如禁言、发空间，是真的会执行的；会改设置的内置命令不执行。）' },
    h(Row, { label: '假装是', hint: '谁在说话、在哪儿说' },
      h('div', { className: 'ab-flex' },
        h(Seg, { value: as, options: [{ value: 'owner', label: '主人' }, { value: 'other', label: '别人' }], onChange: setAs }),
        h(Seg, { value: kind, options: [{ value: 'private', label: '私聊' }, { value: 'group', label: '群聊' }], onChange: setKind }))),
    h(Row, { label: '发一条消息', hint: '看哪个模块接管、命令回什么（/开头是命令）' },
      h('input', { className: 'ab-input', value: text, placeholder: '比如：早安，或 /weather 北京', onChange: (e) => setText(e.target.value) })),
    h(Row, { label: '她的回复', hint: '可选：假设她这样回，看经过各个模块改写后最后发出去什么（可以用 ||| 分条、<voice>…</voice>）' },
      h('input', { className: 'ab-input', value: reply, placeholder: '比如：早呀|||今天也要加油', onChange: (e) => setReply(e.target.value) })),
    h('div', { className: 'ab-flex' }, h(Btn, { kind: 'primary', small: true, disabled: !text.trim() && !reply.trim(), onClick: run }, '模拟')),
    out ? h('div', { style: { marginTop: 8 } }, out.steps.map((s, i) => h('div', { key: i, className: 'ab-small' }, '· ' + s)), sentList(out.sent)) : null,
    h('div', { className: 'ab-section-title' }, '调用工具'),
    tools.length ? h('div', null,
      h(Row, { label: '工具', hint: cur ? cur.description : '' }, h(Select, { value: tool, options: tools.map((t) => ({ value: t.name, label: t.name })), onChange: (v) => { setTool(v); setArgs('{}'); setTout(null) } })),
      cur && cur.parameters && Object.keys(cur.parameters.properties || {}).length ? h('div', { className: 'ab-small ab-muted', style: { margin: '0 0 6px' } }, '参数：' + Object.entries(cur.parameters.properties).map(([k, v]) => k + (v.description ? '（' + v.description + '）' : '')).join('；')) : null,
      h('textarea', { className: 'ab-textarea', style: { minHeight: 50, fontFamily: 'ui-monospace,Consolas,monospace' }, value: args, onChange: (e) => setArgs(e.target.value) }),
      h('div', { className: 'ab-flex', style: { marginTop: 6 } }, h(Btn, { small: true, onClick: call, disabled: !tool }, '调用')),
      tout ? h('div', null, h('div', { className: 'ab-code' }, JSON.stringify(tout.result, null, 2)), sentList(tout.sent)) : null)
      : h('div', { className: 'ab-small ab-muted' }, '这个场合没有工具'))
}

/** 扩展页：所有模块（内置的 + 自己写的）、新建、安全模式。 */
function Modules({ st, draft, toast, reload }) {
  const [data, setData] = useState(null)
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const load = () => get('/modules').then(setData)
  useEffect(() => { load() }, [])
  useEffect(() => { if (data && st.modules) setData((d) => ({ ...d, list: st.modules })) }, [JSON.stringify(st.modules)])
  const setModules = (list) => list && setData((d) => ({ ...d, list }))
  if (!data) return h(Empty, { icon: '⏳', text: '加载中…' })
  const list = data.list || []
  const builtin = list.filter((m) => m.builtin)
  const mine = list.filter((m) => !m.builtin)
  const props = { draft, setModules, toast, reload: () => { reload(); load() } }
  const create = async () => {
    const r = await post('/modules/create', { id: newId.trim(), name: newName.trim() })
    if (!r.ok) return toast(r.message, 'err')
    setNewId(''); setNewName('')
    setModules(r.list)
    copy(r.prompt, toast, '建好了，「复制给 DSH 的话」已经复制好，粘给 DSH 让它帮你写')
    reload()
  }
  return h('div', { className: 'ab-grid' },
    h(Card, { title: '扩展', desc: '她的每项本事都是一个模块：能单独关掉；能复制一份来改，改了就替换内置的；也能自己写新模块，让她学会你想要的任何事。自己写的东西放在下面这个文件夹，插件升级不会动；改完保存几秒内自动生效，不用重启。不会写代码？点「复制给 DSH 的话」，粘给 DSH，说你想要什么。' },
      h('div', { className: 'ab-flex' },
        h('code', { className: 'ab-small', style: { wordBreak: 'break-all', flex: 1 } }, data.dir),
        h(Btn, { small: true, onClick: () => post('/modules/open').then((r) => toast(r.message)) }, '打开文件夹'),
        h(Btn, { small: true, onClick: () => copy(data.prompt, toast, '复制好了，粘给 DSH，把【】里那句换成你想要的') }, '复制给 DSH 的话'),
        h(Btn, { small: true, kind: 'ghost', onClick: async () => { const r = await post('/modules/reload', {}); setModules(r.list); toast(r.message) } }, '重新检查')),
      h(Row, { label: '安全模式', hint: '打开后你写的模块一个都不加载，内置的全部恢复。出了问题先开它，看是不是你的模块引起的。' },
        h(Switch, { on: st.config.safeMode, onChange: async (v) => { const r = await post('/save', { safeMode: v }); toast(v ? '安全模式开了：只跑内置模块' : '安全模式关了', 'ok'); setModules(r.modules); reload() } })),
      st.config.safeMode ? h('div', { className: 'ab-note warn' }, '安全模式开着：你写的模块现在都没加载。') : null),
    h(Card, { title: '新建一个模块', desc: '从模板建一个能直接跑的例子（关键词自动回复 + 一个命令 + 一个工具），在它上面改。id 用小写英文，比如 weather。想改内置的本事，用下面内置模块那一行的「复制一份来改」。' },
      h('div', { className: 'ab-flex' },
        h('input', { className: 'ab-input', style: { maxWidth: 180 }, placeholder: 'id，如 weather', value: newId, onChange: (e) => setNewId(e.target.value.toLowerCase()) }),
        h('input', { className: 'ab-input', placeholder: '名字，如 查天气', value: newName, onChange: (e) => setNewName(e.target.value) }),
        h(Btn, { kind: 'primary', small: true, disabled: !newId.trim(), onClick: create }, '新建'))),
    mine.length ? h(Card, { title: '自己写的（' + mine.length + '）' }, h('div', null, mine.map((m) => h(ModuleRow, { key: m.id, m, ...props })))) : null,
    h(Card, { title: '内置模块（' + builtin.length + '）', desc: '关掉的模块：她就没有这项本事，相关的标签页也会藏起来。连接、权限、人格、聊天这些是核心，不能关。' },
      h('div', null, builtin.map((m) => h(ModuleRow, { key: m.id, m, ...props })))),
    h(Simulate, { toast }),
  )
}

/** 自己写的模块的面板：自动表单 + 模块自己的 panel.js。 */
class PanelBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() { return this.state.error ? h('div', { className: 'ab-note err' }, '这个模块的面板出错了：' + String((this.state.error && this.state.error.message) || this.state.error)) : this.props.children }
}
// draft / setDraft：模块 panel 想直接改整份配置草稿时用（比如资讯池的订阅列表）。
// 只加 props 不改行为：原来只用 settings/draftSettings 的模块完全不受影响。
function ExtPanel({ m, settings, draftSettings, setSettings, toast, reload, draft, setDraft }) {
  const [Comp, setComp] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    fetch(API + '/modules/panel?id=' + encodeURIComponent(m.id) + '&t=' + Date.now(), { cache: 'no-store' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error('读不到 panel.js')))).then((src) => {
      // 内置模块的路由在 /qq-hub/api/ 下（没有 /ext/ 前缀），用户自己写的才在 /ext/<id> 下
      const base = m.builtin && m.running === 'builtin' ? '' : '/ext/' + m.id
      const call = (p, body) => (body === undefined ? get(base + p) : post(base + p, body))
      const ui = { Card, Btn, Switch, Row, Empty, Select, Seg, Range }
      const C = new Function('React', 'h', 'ui', 'call', src)(React, h, ui, call)
      if (typeof C !== 'function') throw new Error('panel.js 最后要 return 一个组件（函数）')
      if (alive) setComp(() => C)
    }).catch((e) => alive && setErr(e.message))
    return () => { alive = false }
  }, [m.id, m.startedAt])
  if (err) return h('div', { className: 'ab-note err' }, '面板加载失败：' + err)
  if (!Comp) return h(Empty, { icon: '⏳', text: '加载中…' })
  const save = async (patch) => { const r = await post('/save', { ext: { [m.id]: patch } }); toast(r.ok === false ? r.message : '保存好了', r.ok === false ? 'err' : 'ok'); reload() }
  return h(PanelBoundary, null, h(Comp, { settings, draftSettings, setSettings, save, toast, reload, draft, setDraft }))
}
function ExtPage({ st, draft, setDraft, toast, reload, mod, embedded }) {
  const m = (st.modules || []).find((x) => x.id === mod)
  const f = useField(draft, setDraft)
  if (!m) return h(Empty, { icon: '🧩', text: '这个模块没在跑了' })
  const base = 'ext.' + m.id + '.'
  const settings = { ...(m.defaults || {}), ...((st.config.ext || {})[m.id] || {}) }
  const draftSettings = { ...(m.defaults || {}), ...((draft.ext || {})[m.id] || {}) }
  const setSettings = (patch) => setDraft((previous) => ({ ...previous, ext: { ...previous.ext, [m.id]: { ...(previous.ext || {})[m.id], ...patch } } }))
  const field = (s) => {
    const p = base + s.key
    if (s.type === 'switch') return f.sw(p)
    // allowEmpty：模块声明了 min:0 的数字框允许清空（0/空 = 沿用默认，比如目的引擎每日上限）。
    // 模块自己没声明可空就不要给——普通数字框空着保存还是老行为。
    if (s.type === 'number') return f.num(p, { min: s.min, max: s.max, step: s.step, fallback: (m.defaults || {})[s.key], allowEmpty: Number(s.min) === 0 && s.key === 'maxPerDay' })
    if (s.type === 'select') return f.select(p, (s.options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o)))
    if (s.type === 'textarea') return h('textarea', { className: 'ab-textarea', value: getPath(draft, p) ?? '', placeholder: s.placeholder, onChange: (e) => setDraft(setPath(draft, p, e.target.value)) })
    if (s.type === 'password') return f.text(p, { type: 'password', placeholder: getPath(draft, p + 'Set') ? '已保存（不改就留空）' : s.placeholder || '' })
    return f.text(p, { placeholder: s.placeholder })
  }
  return h('div', { className: 'ab-grid' },
    ((m.settings || []).length || (m.errors || []).length || !m.panel) ? h(Card, { title: m.name, desc: m.description, right: h('span', { className: 'ab-badge mine' }, embedded ? '扩展模块 · ' + m.id : m.id) },
      (m.settings || []).map((s) => h(Row, { key: s.key, label: s.label || s.key, hint: s.hint }, field(s))),
      (m.settings || []).length ? h('div', { className: 'ab-small ab-muted' }, '改完点下面的「保存设置」。') : null,
      (m.errors || []).length ? h('div', { className: 'ab-note err', style: { marginTop: 8 } }, '最近的报错：' + m.errors[0].message) : null) : null,
    m.panel ? h(ExtPanel, { m, settings, draftSettings, setSettings, toast, reload, draft, setDraft }) : null)
}


export { LocalApi, ModuleRow, Simulate, Modules, ExtPanel, ExtPage }
