import { React, useState, useEffect, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Switch, Select, Seg, Range, Empty, More } from '../ui/primitives.js'
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
  return (
    <div className="ab-grid">
      <Card
        title="本地接口"
        desc="想用自己电脑上的模型或服务（本地语音、画图、识别）？在这里生成一个脚本模板，照注释改；或者点「复制给 DSH 的话」粘给 DSH 让它帮你改。"
        more={'脚本放在插件数据目录的 local 文件夹里，插件升级不会覆盖；改完保存就生效，不用重启。每一项要打开开关才会用，出错时语音和识别会自动退回内置方式。'}
      >
        <div className="ab-flex">
          <code className="ab-small" style={{ wordBreak: 'break-all', flex: 1 }}>{st ? st.dir : '…'}</code>
          <Btn small onClick={() => post('/local/open').then((r) => toast(r.message))}>打开文件夹</Btn>
        </div>
      </Card>
      {!st ? <Empty icon="⏳" text="加载中…" /> : st.list.map((x) => (
        <Card key={x.slot} title={x.title + '（' + x.file + '）'} right={f.sw('local.' + x.slot)}>
          <div className="ab-flex" style={{ marginBottom: 8 }}>
            <span className="ab-small" style={{ color: x.active ? 'var(--ab-ok)' : 'var(--ab-dim)' }}>
              {x.active ? '● 正在由本地脚本接管' : !x.exists ? '还没有这个脚本' : !x.enabled ? '脚本已经有了，开关没开（用内置方式）' : '用内置方式'}
            </span>
            {x.last ? <span className="ab-small" style={{ color: x.last.ok ? 'var(--ab-ok)' : 'var(--ab-err)' }}> · 上次{x.last.ok ? '成功，' + x.last.message : '出错：' + x.last.message}</span> : null}
          </div>
          <div className="ab-flex">
            {x.exists ? null : <Btn small kind="primary" disabled={!!busy} onClick={() => act('/local/template', x.slot, 't')}>生成模板</Btn>}
            <Btn small onClick={() => { navigator.clipboard.writeText(x.prompt); toast('复制好了，粘给 DSH，再把【】里那句换成你的情况', 'ok') }}>复制给 DSH 的话</Btn>
            {x.exists && (x.slot === 'tts' || x.slot === 'image') ? <Btn small disabled={!!busy} onClick={() => act('/local/test', x.slot, 'x')}>{busy === x.slot + 'x' ? '正在试…' : '试一下'}</Btn> : null}
          </div>
          {x.slot === 'image' && img ? <img src={'data:image/png;base64,' + img} style={{ marginTop: 10, maxWidth: 240, borderRadius: 8 }} /> : null}
        </Card>
      ))}
    </div>
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
  return (
    <div className="ab-mod">
      <div className="main">
        <div className="nm">
          {m.name}
          <code>{m.id}</code>
          <span className={cx('ab-badge', s.cls)}>{s.text}</span>
          {m.outdated ? <span className="ab-badge warn" title={'你复制 / 替换时内置的是 ' + m.forkedFrom + '，现在是 ' + m.builtinVersion}>内置版本更新了</span> : null}
        </div>
        {m.description ? <div className="ds">{m.description}</div> : null}
        {what ? <div className="what">{what}</div> : null}
        {errs.length ? (
          <div className="ab-note err" style={{ marginTop: 6 }}>
            <div style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>{(open ? '▾ ' : '▸ ') + errs.length + ' 条报错：' + String(errs[0].message).split('\n')[0].slice(0, 120)}</div>
            {open ? <div className="ab-code">{errs.map((e) => (e.at ? new Date(e.at).toLocaleTimeString() + ' ' : '') + (e.label || '') + '：' + e.message).join('\n\n')}</div> : null}
          </div>
        ) : null}
        <div className="acts">
          {m.builtin && !m.hasUser ? <Btn small onClick={() => act('/modules/fork', { id: m.id }, '复制好了')} title={'把这个内置模块的源码复制到 modules/' + m.id + '/，改了就替换内置的'}>复制一份来改</Btn> : null}
          {m.hasUser ? <Btn small onClick={() => post('/modules/open?id=' + encodeURIComponent(m.id)).then((r) => toast(r.message))}>打开文件夹</Btn> : null}
          {m.hasUser ? <Btn small onClick={() => get('/modules/prompt?id=' + encodeURIComponent(m.id)).then((r) => copy(r.prompt, toast, '复制好了，粘给 DSH，把【】里那句换成你想要的'))}>复制给 DSH 的话</Btn> : null}
          {m.hasUser && !m.safeSkipped ? <Btn small onClick={() => act('/modules/reload', { id: m.id }, '重新加载好了')}>重新加载</Btn> : null}
        </div>
      </div>
      <div className="side">
        <Switch on={m.enabled} onChange={(v) => setMod({ enabled: v })} title={m.enabled ? '关掉这个模块' : '打开这个模块'} />
        {m.builtin && m.hasUser ? <label className="ab-small ab-muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>用内置的<Switch on={m.useBuiltin} onChange={(v) => setMod({ useBuiltin: v })} /></label> : null}
      </div>
    </div>
  )
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
  const sentList = (sent) => (sent && sent.length
    ? <div className="ab-code">{sent.map((s) => '→ ' + s.chatId + '：' + s.text).join('\n')}</div>
    : <div className="ab-small ab-muted" style={{ marginTop: 6 }}>没有发出任何消息</div>)
  return (
    <Card title="模拟测试" desc="不上 QQ 就能试模块：这里发出去的消息只截下来显示，不会真发到 QQ。">
      <More label="哪些副作用是真的">
        {'模块直接调 api.onebot 的操作（比如禁言、发空间）是真的会执行的；会改设置的内置命令不执行。'}
      </More>
      <Row label="假装是" hint="谁在说话、在哪儿说">
        <div className="ab-flex">
          <Seg value={as} options={[{ value: 'owner', label: '主人' }, { value: 'other', label: '别人' }]} onChange={setAs} />
          <Seg value={kind} options={[{ value: 'private', label: '私聊' }, { value: 'group', label: '群聊' }]} onChange={setKind} />
        </div>
      </Row>
      <Row label="发一条消息" hint="看哪个模块接管、命令回什么（/开头是命令）">
        <input className="ab-input" value={text} placeholder="比如：早安，或 /weather 北京" onChange={(e) => setText(e.target.value)} />
      </Row>
      <Row label="她的回复" hint="可选：假设她这样回，看经过各个模块改写后最后发出去什么（可以用 ||| 分条、<voice>…</voice>）">
        <input className="ab-input" value={reply} placeholder="比如：早呀|||今天也要加油" onChange={(e) => setReply(e.target.value)} />
      </Row>
      <div className="ab-flex"><Btn kind="primary" small disabled={!text.trim() && !reply.trim()} onClick={run}>模拟</Btn></div>
      {out ? <div style={{ marginTop: 8 }}>{out.steps.map((s, i) => <div key={i} className="ab-small">· {s}</div>)}{sentList(out.sent)}</div> : null}
      <div className="ab-section-title">调用工具</div>
      {tools.length ? (
        <div>
          <Row label="工具" hint={cur ? cur.description : ''}>
            <Select value={tool} options={tools.map((t) => ({ value: t.name, label: t.name }))} onChange={(v) => { setTool(v); setArgs('{}'); setTout(null) }} />
          </Row>
          {cur && cur.parameters && Object.keys(cur.parameters.properties || {}).length ? (
            <div className="ab-small ab-muted" style={{ margin: '0 0 6px' }}>参数：{Object.entries(cur.parameters.properties).map(([k, v]) => k + (v.description ? '（' + v.description + '）' : '')).join('；')}</div>
          ) : null}
          <textarea className="ab-textarea" style={{ minHeight: 50 }} value={args} onChange={(e) => setArgs(e.target.value)} />
          <div className="ab-flex" style={{ marginTop: 6 }}><Btn small onClick={call} disabled={!tool}>调用</Btn></div>
          {tout ? <div><div className="ab-code">{JSON.stringify(tout.result, null, 2)}</div>{sentList(tout.sent)}</div> : null}
        </div>
      ) : <div className="ab-small ab-muted">这个场合没有工具</div>}
    </Card>
  )
}

/** 模块市场（分发半套）：索引列表、安装/更新/卸载、进度、撤回提示。
 * 装模块 = 装进程内代码：capabilities 只展示不是安全边界；装前把来源/许可/校验和给用户看（R8）。 */
function Market({ st, toast, reload }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState('')
  const [prog, setProg] = useState(null)
  const load = () => get('/modules/market').then(setData).catch(() => setData({ ok: false, message: '市场加载失败', list: [] }))
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!busy) return undefined
    const t = setInterval(() => get('/modules/market/progress').then((r) => setProg(r.progress)).catch(() => {}), 700)
    return () => clearInterval(t)
  }, [busy])
  const enabled = st.config?.modules?.market?.enabled === true
  const toggle = async (v) => {
    const r = await post('/save', { modules: { market: { enabled: v } } })
    toast(v ? '模块市场开了' : '模块市场关了', 'ok')
    reload()
    load()
    return r
  }
  const install = async (e, confirmReplace = false) => {
    setBusy(e.id)
    try {
      let r = await post('/modules/market/install', { id: e.id, confirmReplace })
      if (r.needConfirm && window.confirm(r.message + '\n\n装模块等于装进程内代码，确认替换内置模块？')) {
        r = await post('/modules/market/install', { id: e.id, confirmReplace: true })
      }
      toast(r.message, r.ok ? 'ok' : 'err')
      if (r.ok) { load(); reload() }
    } finally { setBusy(''); setProg(null) }
  }
  const remove = async (e, purge) => {
    if (!window.confirm(purge ? `卸载「${e.name || e.id}」并清掉它的数据和设置？` : `卸载「${e.name || e.id}」？数据和设置会留着。`)) return
    setBusy(e.id)
    try {
      const r = await post('/modules/market/remove', { id: e.id, purge })
      toast(r.message, r.ok ? 'ok' : 'err')
      if (r.ok) { load(); reload() }
    } finally { setBusy('') }
  }
  const stageText = { index: '读索引…', download: '下载中', install: '校验安装…', start: '启动模块…' }
  return (
    <Card
      title="模块市场"
      desc="从社区模块库安装新本事。装模块等于装进程内代码：看清作者、许可和校验和再装；默认不自动更新。"
      more="索引支持多源（GitHub raw → jsdelivr 镜像），也可在配置 modules.market.indexUrls 里填自建/内网源。\n市场模块和内置一样：发送必经 Outbox 台账，记忆按会话隔离。"
      right={<Switch on={enabled} onChange={toggle} />}
    >
      {!enabled ? <div className="ab-note">市场没开。打开右上角开关后刷新列表。</div> : null}
      {enabled && !data ? <Empty icon="⏳" text="加载中…" /> : null}
      {enabled && data && !data.ok ? <div className="ab-note err">{data.message || '索引读不到'}（已装模块不受影响）</div> : null}
      {enabled && data && data.ok ? (
        <Fragment>
          {data.revoked && data.revoked.length ? <div className="ab-note warn">已装版本被撤回：{data.revoked.map((r) => `${r.id} ${r.version}（${r.reason}）`).join('；')}。建议卸载或更新。</div> : null}
          {prog && busy ? <div className="ab-note">{prog.name || prog.id}：{stageText[prog.stage] || prog.stage}{prog.stage === 'download' && prog.total ? ` ${Math.round(prog.received / 1024)} / ${Math.round(prog.total / 1024)} KB` : ''}</div> : null}
          {(data.list || []).length === 0 ? <Empty icon="📦" text="索引里还没有模块" /> : null}
          {(data.list || []).map((e) => (
            <div key={e.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--ab-line, rgba(127,127,127,.15))' }}>
              <div className="ab-flex" style={{ alignItems: 'center', gap: 8 }}>
                <b>{e.name || e.id}</b>
                <span className="ab-small ab-muted">{e.version}{e.installed ? `（已装 ${e.installed}）` : ''}</span>
                {e.update ? <span className="ab-pill ok">可更新</span> : null}
                {e.delisted ? <span className="ab-pill warn">已下架</span> : null}
                {e.foreign ? <span className="ab-pill warn">同名自有文件夹</span> : null}
                <span style={{ flex: 1 }} />
                {e.installed ? (
                  <Fragment>
                    {e.update && !e.blocked ? <Btn small kind="primary" disabled={busy === e.id} onClick={() => install(e)}>更新</Btn> : null}
                    <Btn small disabled={busy === e.id} onClick={() => remove(e, false)}>卸载</Btn>
                    <Btn small kind="ghost" disabled={busy === e.id} onClick={() => remove(e, true)}>卸载并清数据</Btn>
                  </Fragment>
                ) : (
                  <Btn small kind="primary" disabled={busy === e.id || Boolean(e.blocked) || e.foreign} onClick={() => install(e)}>安装</Btn>
                )}
              </div>
              {e.description ? <div className="ab-small" style={{ marginTop: 4 }}>{e.description}</div> : null}
              <div className="ab-small ab-muted" style={{ marginTop: 4 }}>
                {[e.author && `作者 ${e.author}`, e.license && `许可 ${e.license}`, e.category, e.minPluginVersion && `需插件 ≥${e.minPluginVersion}`, Array.isArray(e.capabilities) && e.capabilities.length && `能力声明：${e.capabilities.join('、')}（仅展示，不是安全边界）`].filter(Boolean).join(' · ')}
              </div>
              {e.sha256 ? <div className="ab-small ab-muted" style={{ marginTop: 2, wordBreak: 'break-all' }}>sha256: {e.sha256}{e.commit ? ` · commit ${String(e.commit).slice(0, 8)}` : ''}</div> : null}
              {e.blocked ? <div className="ab-note warn" style={{ marginTop: 4 }}>{e.blocked}</div> : null}
            </div>
          ))}
          <div className="ab-flex" style={{ marginTop: 8 }}>
            <Btn small kind="ghost" onClick={async () => { setData(null); await load() }}>刷新列表</Btn>
            {data.source ? <span className="ab-small ab-muted">索引源：{data.source}</span> : null}
          </div>
        </Fragment>
      ) : null}
    </Card>
  )
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
  if (!data) return <Empty icon="⏳" text="加载中…" />
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
  return (
    <div className="ab-grid">
      <Card
        title="扩展"
        desc="她的每项本事都是一个模块：能单独关掉；能复制一份来改，改了就替换内置的；也能自己写新模块。"
        more={'自己写的东西放在下面这个文件夹，插件升级不会动；改完保存几秒内自动生效，不用重启。\n不会写代码？点「复制给 DSH 的话」，粘给 DSH，说你想要什么。'}
      >
        <div className="ab-flex">
          <code className="ab-small" style={{ wordBreak: 'break-all', flex: 1 }}>{data.dir}</code>
          <Btn small onClick={() => post('/modules/open').then((r) => toast(r.message))}>打开文件夹</Btn>
          <Btn small onClick={() => copy(data.prompt, toast, '复制好了，粘给 DSH，把【】里那句换成你想要的')}>复制给 DSH 的话</Btn>
          <Btn small kind="ghost" onClick={async () => { const r = await post('/modules/reload', {}); setModules(r.list); toast(r.message) }}>重新检查</Btn>
        </div>
        <Row label="安全模式" hint="打开后你写的模块一个都不加载，内置的全部恢复。出了问题先开它，看是不是你的模块引起的。">
          <Switch on={st.config.safeMode} onChange={async (v) => { const r = await post('/save', { safeMode: v }); toast(v ? '安全模式开了：只跑内置模块' : '安全模式关了', 'ok'); setModules(r.modules); reload() }} />
        </Row>
        {st.config.safeMode ? <div className="ab-note warn">安全模式开着：你写的模块现在都没加载。</div> : null}
      </Card>
      <Card title="新建一个模块" desc="从模板建一个能直接跑的例子（关键词自动回复 + 一个命令 + 一个工具），在它上面改。id 用小写英文，比如 weather。">
        <div className="ab-flex">
          <input className="ab-input" style={{ maxWidth: 180 }} placeholder="id，如 weather" value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase())} />
          <input className="ab-input" placeholder="名字，如 查天气" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Btn kind="primary" small disabled={!newId.trim()} onClick={create}>新建</Btn>
        </div>
      </Card>
      {mine.length ? <Card title={'自己写的（' + mine.length + '）'}>{mine.map((m) => <ModuleRow key={m.id} m={m} {...props} />)}</Card> : null}
      <Card title={'内置模块（' + builtin.length + '）'} desc="关掉的模块：她就没有这项本事，相关的标签页也会藏起来。连接、权限、人格、聊天这些是核心，不能关。">
        {builtin.map((m) => <ModuleRow key={m.id} m={m} {...props} />)}
      </Card>
      <Market st={st} toast={toast} reload={reload} />
      <Simulate toast={toast} />
    </div>
  )
}

/** 自己写的模块的面板：自动表单 + 模块自己的 panel.js。 */
class PanelBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() { return this.state.error ? <div className="ab-note err">这个模块的面板出错了：{String((this.state.error && this.state.error.message) || this.state.error)}</div> : this.props.children }
}

// draft / setDraft：模块 panel 想直接改整份配置草稿时用（比如订阅类模块的源列表）。
// 只加 props 不改行为：原来只用 settings/draftSettings 的模块完全不受影响。
function ExtPanel({ m, settings, draftSettings, setSettings, toast, reload, draft, setDraft }) {
  const [Comp, setComp] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    fetch(API + '/modules/panel?id=' + encodeURIComponent(m.id) + '&t=' + Date.now(), { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('读不到 panel.js'))))
      .then((src) => {
        // 内置模块的路由在 /qq-hub/api/ 下（没有 /ext/ 前缀），用户自己写的才在 /ext/<id> 下
        const base = m.builtin && m.running === 'builtin' ? '' : '/ext/' + m.id
        const call = (p, body) => (body === undefined ? get(base + p) : post(base + p, body))
        const ui = { Card, Btn, Switch, Row, Empty, Select, Seg, Range }
        const C = new Function('React', 'h', 'ui', 'call', src)(React, h, ui, call)
        if (typeof C !== 'function') throw new Error('panel.js 最后要 return 一个组件（函数）')
        if (alive) setComp(() => C)
      })
      .catch((e) => alive && setErr(e.message))
    return () => { alive = false }
  }, [m.id, m.startedAt])
  if (err) return <div className="ab-note err">面板加载失败：{err}</div>
  if (!Comp) return <Empty icon="⏳" text="加载中…" />
  const save = async (patch) => { const r = await post('/save', { ext: { [m.id]: patch } }); toast(r.ok === false ? r.message : '保存好了', r.ok === false ? 'err' : 'ok'); reload() }
  return <PanelBoundary><Comp settings={settings} draftSettings={draftSettings} setSettings={setSettings} save={save} toast={toast} reload={reload} draft={draft} setDraft={setDraft} /></PanelBoundary>
}

function ExtPage({ st, draft, setDraft, toast, reload, mod, embedded }) {
  const m = (st.modules || []).find((x) => x.id === mod)
  const f = useField(draft, setDraft)
  if (!m) return <Empty icon="🧩" text="这个模块没在跑了" />
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
    if (s.type === 'textarea') return <textarea className="ab-textarea" value={getPath(draft, p) ?? ''} placeholder={s.placeholder} onChange={(e) => setDraft(setPath(draft, p, e.target.value))} />
    if (s.type === 'password') return f.text(p, { type: 'password', placeholder: getPath(draft, p + 'Set') ? '已保存（不改就留空）' : s.placeholder || '' })
    return f.text(p, { placeholder: s.placeholder })
  }
  return (
    <div className="ab-grid">
      {((m.settings || []).length || (m.errors || []).length || !m.panel) ? (
        <Card title={m.name} desc={m.description} right={<span className="ab-badge mine">{embedded ? '扩展模块 · ' + m.id : m.id}</span>}>
          {(m.settings || []).map((s) => <Row key={s.key} label={s.label || s.key} hint={s.hint}>{field(s)}</Row>)}
          {(m.settings || []).length ? <div className="ab-small ab-muted">改完点下面的「保存设置」。</div> : null}
          {(m.errors || []).length ? <div className="ab-note err" style={{ marginTop: 8 }}>最近的报错：{m.errors[0].message}</div> : null}
        </Card>
      ) : null}
      {m.panel ? <ExtPanel m={m} settings={settings} draftSettings={draftSettings} setSettings={setSettings} toast={toast} reload={reload} draft={draft} setDraft={setDraft} /> : null}
    </div>
  )
}

export { LocalApi, ModuleRow, Simulate, Modules, ExtPanel, ExtPage }
