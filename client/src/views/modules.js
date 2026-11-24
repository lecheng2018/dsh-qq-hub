import { React, useState, useEffect, Fragment, h } from '../core/react.js'
import { Card, FoldSection, Row, Btn, Switch, Select, Seg, Range, Empty, More } from '../ui/primitives.js'
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
  const list = (st && st.list) || []
  const taken = list.filter((x) => x.active).length
  const failed = list.filter((x) => x.last && !x.last.ok).length
  const missing = list.filter((x) => !x.exists).length
  return (
    <div className="ab-grid">
      <Card
        title="本地接口"
        desc="用自己电脑上的模型或服务（本地语音、画图、识别）：生成脚本模板，照注释改，或者复制那段话让 DSH 帮你改。"
        more={'脚本放在插件数据目录的 local 文件夹里，插件升级不会覆盖；改完保存就生效，不用重启。每一项要打开开关才会用，出错时语音和识别会自动退回内置方式。'}
      >
        <div className="ab-pills">
          <span className={cx('ab-pill', taken && 'ok')}>{taken ? '本地接管 ' + taken + ' 项' : '全部走内置方式'}</span>
          {failed ? <span className="ab-pill err">{'出错 ' + failed + ' 项'}</span> : null}
          {missing ? <span className="ab-pill">{'还没生成 ' + missing + ' 项'}</span> : null}
        </div>
        <div className="ab-dirrow" style={{ marginTop: 10 }}>
          <code className="ab-small" style={{ flex: '1 1 220px', minWidth: 0, wordBreak: 'break-all' }}>{st ? st.dir : '…'}</code>
          <Btn small onClick={() => post('/local/open').then((r) => toast(r.message))}>打开文件夹</Btn>
        </div>
      </Card>
      {!st ? <Empty icon="⏳" text="加载中…" /> : list.map((x) => (
        <Card key={x.slot} title={x.title + '（' + x.file + '）'} right={f.sw('local.' + x.slot)}>
          <div className="ab-flex" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            <span className="ab-small" style={{ color: x.active ? 'var(--ab-ok)' : 'var(--ab-dim)' }}>
              {x.active ? '● 正在由本地脚本接管' : !x.exists ? '还没有这个脚本' : !x.enabled ? '脚本已经有了，开关没开（用内置方式）' : '用内置方式'}
            </span>
            {x.last ? <span className="ab-small" style={{ color: x.last.ok ? 'var(--ab-ok)' : 'var(--ab-err)' }}> · 上次{x.last.ok ? '成功，' + x.last.message : '出错：' + x.last.message}</span> : null}
          </div>
          <div className="ab-flex" style={{ flexWrap: 'wrap', gap: 6 }}>
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

/** 一个模块一行：开关、状态、报错，能复制来改 / 用回内置的 / 重新加载。
 *  compact：扩展页内置分组用——默认只露名称/状态/开关，描述截断，工具与操作收进「详情」；
 *  报错始终可见（不因收起而藏掉）。 */
function ModuleRow({ m, draft, setModules, toast, reload, compact = false }) {
  const s = MOD_STATE(m)
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState(!compact)
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
  // 模块状态可能缺 tools/commands（老版本或手工 mock）：这里一律容错，缺字段不能让整页崩
  const tools = m.tools || []
  const commands = m.commands || []
  const what = [tools.length ? '工具：' + tools.join('、') : '', commands.length ? '命令：' + commands.map((c) => '/' + c).join(' ') : ''].filter(Boolean).join('　')
  const errs = (m.error ? [{ label: '加载', message: m.error }] : []).concat(m.errors || [])
  return (
    <div className={cx('ab-mod', compact && 'compact')}>
      <div className="main">
        <div className="nm">
          {m.name}
          <code>{m.id}</code>
          <span className={cx('ab-badge', s.cls)}>{s.text}</span>
          {m.market ? <span className="ab-badge mine" title="从模块市场安装（.qqhub-source.json）">市场</span> : null}
          {m.outdated ? <span className="ab-badge warn" title={'你复制 / 替换时内置的是 ' + m.forkedFrom + '，现在是 ' + m.builtinVersion}>内置版本更新了</span> : null}
          {compact ? <span style={{ marginLeft: 'auto' }}><Btn small kind="ghost" onClick={() => setDetail(!detail)}>{detail ? '收起' : '详情'}</Btn></span> : null}
        </div>
        {m.description ? <div className={cx('ds', compact && !detail && 'clip')}>{m.description}</div> : null}
        {detail && what ? <div className="what">{what}</div> : null}
        {errs.length ? (
          <div className="ab-note err" style={{ marginTop: 6 }}>
            <div
              role="button" tabIndex={0} aria-expanded={open} style={{ cursor: 'pointer' }}
              onClick={() => setOpen(!open)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open) } }}
            >
              {(open ? '▾ ' : '▸ ') + errs.length + ' 条报错：' + String(errs[0].message).split('\n')[0].slice(0, 120)}
            </div>
            {open ? <div className="ab-code">{errs.map((e) => (e.at ? new Date(e.at).toLocaleTimeString() + ' ' : '') + (e.label || '') + '：' + e.message).join('\n\n')}</div> : null}
          </div>
        ) : null}
        {detail ? (
          <div className="acts">
            {m.builtin && !m.hasUser ? <Btn small onClick={() => act('/modules/fork', { id: m.id }, '复制好了')} title={'把这个内置模块的源码复制到 modules/' + m.id + '/，改了就替换内置的'}>复制一份来改</Btn> : null}
            {m.hasUser ? <Btn small onClick={() => post('/modules/open?id=' + encodeURIComponent(m.id)).then((r) => toast(r.message))}>打开文件夹</Btn> : null}
            {m.hasUser ? <Btn small onClick={() => get('/modules/prompt?id=' + encodeURIComponent(m.id)).then((r) => copy(r.prompt, toast, '复制好了，粘给 DSH，把【】里那句换成你想要的'))}>复制给 DSH 的话</Btn> : null}
            {m.hasUser && !m.safeSkipped ? <Btn small onClick={() => act('/modules/reload', { id: m.id }, '重新加载好了')}>重新加载</Btn> : null}
          </div>
        ) : null}
      </div>
      <div className="side">
        <Switch on={m.enabled} onChange={(v) => setMod({ enabled: v })} title={m.enabled ? '关掉这个模块' : '打开这个模块'} />
        {m.builtin && m.hasUser ? <label className="ab-small ab-muted" style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>用内置的<Switch on={m.useBuiltin} onChange={(v) => setMod({ useBuiltin: v })} /></label> : null}
      </div>
    </div>
  )
}

/** 模拟测试：不上 QQ 试模块。发出去的只截下来看，不真发。 */
function Simulate({ toast }) {
  const [open, setOpen] = useState(false) // 高级工具：默认收起，展开才注册模拟表单
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
    <Card title="模拟测试" desc="不上 QQ 就能试模块：这里发出去的消息只截下来显示，不会真发到 QQ。" right={<Btn small kind="ghost" onClick={() => setOpen(!open)}>{open ? '收起' : '展开'}</Btn>}>
      {open ? <Fragment>
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
      </Fragment> : null}
    </Card>
  )
}

/** 模块市场（分发半套）：索引列表、安装/更新/卸载、进度、撤回提示。
 * 装模块 = 装进程内代码：capabilities 只展示不是安全边界；装前把来源/许可/校验和给用户看（R8）。 */
function Market({ st, toast, reload }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState('')
  const [prog, setProg] = useState(null)
  const [httpProxy, setHttpProxy] = useState(st.config?.modules?.market?.httpProxy || '')
  const [indexText, setIndexText] = useState((st.config?.modules?.market?.indexUrls || []).join('\n'))
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
  const saveProxy = async () => {
    const wanted = httpProxy.trim()
    const r = await post('/save', { modules: { market: { httpProxy: wanted } } })
    const saved = r.config?.modules?.market?.httpProxy || ''
    setHttpProxy(saved)
    toast(wanted && !saved ? '代理地址不合法，已清空' : '市场代理已保存', wanted && !saved ? 'err' : 'ok')
    reload()
    setData(null)
    await load()
  }
  const saveSources = async () => {
    const wanted = indexText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const r = await post('/save', { modules: { market: { indexUrls: wanted } } })
    const saved = r.config?.modules?.market?.indexUrls || []
    setIndexText(saved.join('\n'))
    const filtered = wanted.length !== saved.length
    const message = filtered ? '含非 HTTPS 地址，已过滤；其余加速源已保存' : wanted.length ? '加速源已保存' : '已恢复默认索引源'
    toast(message, filtered ? 'err' : 'ok')
    reload()
    setData(null)
    await load()
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
  const customNet = Boolean(httpProxy.trim() || indexText.trim())
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
          {(data.list || []).length ? (
            <div className="ab-mkt-list">
              {(data.list || []).map((e) => {
                const verifyLines = [
                  Array.isArray(e.capabilities) && e.capabilities.length ? `能力声明：${e.capabilities.join('、')}（仅展示，不是安全边界）` : '',
                  e.sha256 ? `sha256: ${e.sha256}${e.commit ? ` · commit ${String(e.commit).slice(0, 8)}` : ''}` : '',
                ].filter(Boolean)
                return (
                  <div key={e.id} className="ab-mkt">
                    <div className="ab-mkt-head">
                      <div className="ab-mkt-info">
                        <b>{e.name || e.id}</b>
                        <span className="ab-small ab-muted">{e.version}{e.installed ? `（已装 ${e.installed}）` : ''}</span>
                        {e.update ? <span className="ab-pill ok">可更新</span> : null}
                        {e.delisted ? <span className="ab-pill warn">已下架</span> : null}
                        {e.foreign ? <span className="ab-pill warn">同名自有文件夹</span> : null}
                      </div>
                      {e.installed
                        ? (e.update && !e.blocked ? <Btn small kind="primary" disabled={busy === e.id} onClick={() => install(e)}>更新</Btn> : <span className="ab-badge dim">已装</span>)
                        : <Btn small kind="primary" disabled={busy === e.id || Boolean(e.blocked) || e.foreign} onClick={() => install(e)}>安装</Btn>}
                    </div>
                    {e.description ? <div className="ab-mkt-desc">{e.description}</div> : null}
                    <div className="ab-mkt-meta">
                      {[e.author && `作者 ${e.author}`, e.license && `许可 ${e.license}`, e.category, e.minPluginVersion && `需插件 ≥${e.minPluginVersion}`].filter(Boolean).join(' · ')}
                    </div>
                    {e.blocked ? <div className="ab-note warn" style={{ marginTop: 6 }}>{e.blocked}</div> : null}
                    {e.installed ? (
                      <div className="ab-mkt-acts">
                        <Btn small disabled={busy === e.id} onClick={() => remove(e, false)}>卸载</Btn>
                        <Btn small kind="ghost" disabled={busy === e.id} onClick={() => remove(e, true)}>卸载并清数据</Btn>
                      </div>
                    ) : null}
                    {verifyLines.length ? <More label="校验与能力声明">{verifyLines.join('\n')}</More> : null}
                  </div>
                )
              })}
            </div>
          ) : null}
          <div className="ab-card-foot">
            <Btn small kind="ghost" onClick={async () => { setData(null); await load() }}>刷新列表</Btn>
            {data.source ? <span className="ab-small ab-muted" style={{ wordBreak: 'break-all' }}>索引源：{data.source}</span> : null}
          </div>
        </Fragment>
      ) : null}
      <FoldSection
        title="索引源与代理设置"
        desc="国内网络拉不动 GitHub 时可配加速源或 HTTP 代理。"
        right={customNet ? <span className="ab-badge dim">已自定义</span> : null}
      >
        <div style={{ marginTop: 8, marginBottom: 12 }}>
          <div className="ab-small ab-muted" style={{ marginBottom: 4 }}>索引/加速源：每行一个完整 HTTPS 索引地址，按顺序尝试；清空后保存可恢复默认双源。</div>
          <textarea className="ab-textarea" rows={3} value={indexText} placeholder="例如 https://ghfast.top/https://raw.githubusercontent.com/lecheng2018/dsh-qq-hub-mods/registry/index.json" onChange={(e) => setIndexText(e.target.value)} />
          <div className="ab-flex" style={{ marginTop: 6, justifyContent: 'flex-end' }}><Btn small onClick={saveSources}>保存加速源</Btn></div>
        </div>
        <div>
          <div className="ab-small ab-muted" style={{ marginBottom: 4 }}>市场 HTTP 代理（可选）：只影响索引和安装包，不影响模型等其他请求。</div>
          <div className="ab-flex">
            <input className="ab-input" style={{ flex: '1 1 200px' }} value={httpProxy} placeholder="例如 http://127.0.0.1:7890，留空直连" onChange={(e) => setHttpProxy(e.target.value)} />
            <Btn small onClick={saveProxy}>保存代理</Btn>
          </div>
        </div>
      </FoldSection>
    </Card>
  )
}

// ---- 扩展页：内置模块分组（按能力，不按代码顺序）----
// 商店模块未安装时不在这里（它们在「已安装的扩展」）；新内置模块没归组会落到「其他」，不会丢。
const EXT_GROUPS = [
  { id: 'express', label: '表达与内容', ids: ['voice', 'stickers', 'imagegen', 'diary', 'qzone-social'] },
  { id: 'platform', label: '平台', ids: ['bili', 'douyin', 'heybox', 'multi-parser'] },
  { id: 'memory', label: '记忆与主动', ids: ['memory', 'reflection', 'style', 'memory-privacy', 'speakup', 'purpose'] },
  { id: 'govern', label: '治理与工具', ids: ['token-guardian', 'token-billing', 'complete-guard', 'group-admin', 'qq-tools', 'profile', 'contacts', 'affective-graph'] },
]
const EXT_OTHER = { id: 'other', label: '其他', ids: [] }
// 核心页面不是模块：始终显示，不随模块开关变化
const CORE_PAGES = ['连接', '权限', '人格', '聊天', '模型', '记忆', '本地接口']
const GROUP_OPEN_KEY = 'qq-hub:ext-groups:v1'

const groupBuiltins = (list) => {
  const buckets = new Map([...EXT_GROUPS, EXT_OTHER].map((g) => [g.id, []]))
  for (const m of list) {
    const g = EXT_GROUPS.find((x) => x.ids.includes(m.id))
    buckets.get(g ? g.id : EXT_OTHER.id).push(m)
  }
  return [...EXT_GROUPS, EXT_OTHER].map((g) => ({ ...g, list: buckets.get(g.id) })).filter((g) => g.list.length)
}
const groupNeedsAttention = (g) => g.list.some((m) => m.error || (m.errors || []).length || m.outdated)
const loadGroupOpen = () => { try { return JSON.parse(localStorage.getItem(GROUP_OPEN_KEY) || '{}') || {} } catch { return {} } }

/** 扩展页：概览 → 核心页面 → 市场 → 已安装扩展 → 内置模块（分组/搜索/默认折叠）→ 模拟测试（收起）。 */
function Modules({ st, draft, toast, reload }) {
  const [data, setData] = useState(null)
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const [openGroups, setOpenGroups] = useState(loadGroupOpen)
  const [marketUpdates, setMarketUpdates] = useState(0)
  const load = () => get('/modules').then(setData)
  useEffect(() => { load() }, [])
  useEffect(() => { if (data && st.modules) setData((d) => ({ ...d, list: st.modules })) }, [JSON.stringify(st.modules)])
  const setModules = (list) => list && setData((d) => ({ ...d, list }))
  // 市场可更新数（市场开着才查；失败静默，不影响页面）
  const marketOn = st.config?.modules?.market?.enabled === true
  useEffect(() => {
    if (!marketOn) { setMarketUpdates(0); return undefined }
    let alive = true
    get('/modules/market').then((r) => { if (alive && r?.ok) setMarketUpdates((r.list || []).filter((e) => e.update).length) }).catch(() => {})
    return () => { alive = false }
  }, [marketOn])
  if (!data) return <Empty icon="⏳" text="加载中…" />
  const list = data.list || []
  const builtin = list.filter((m) => m.builtin)
  const mine = list.filter((m) => !m.builtin)
  const running = builtin.filter((m) => m.running).length
  const off = builtin.filter((m) => !m.enabled).length
  const errCount = list.filter((m) => m.error || (m.errors || []).length).length
  const groups = groupBuiltins(builtin)
  const qn = q.trim().toLowerCase()
  const hit = (m) => !qn || [m.name, m.id, m.description, ...(m.tools || []), ...(m.commands || [])].some((x) => String(x || '').toLowerCase().includes(qn))
  const isOpen = (g) => (qn ? true : openGroups[g.id] === undefined ? groupNeedsAttention(g) : openGroups[g.id] === true)
  const toggleGroup = (g) => {
    const next = { ...loadGroupOpen(), [g.id]: !isOpen(g) }
    setOpenGroups(next)
    try { localStorage.setItem(GROUP_OPEN_KEY, JSON.stringify(next)) } catch {}
  }
  const props = { draft, setModules, toast, reload: () => { reload(); load() } }
  const create = async () => {
    const r = await post('/modules/create', { id: newId.trim(), name: newName.trim() })
    if (!r.ok) return toast(r.message, 'err')
    setNewId(''); setNewName(''); setCreating(false)
    setModules(r.list)
    copy(r.prompt, toast, '建好了，「复制给 DSH 的话」已经复制好，粘给 DSH 让它帮你写')
    reload()
  }
  const matched = groups.some((g) => g.list.some(hit))
  return (
    <div className="ab-grid">
      <Card
        title="扩展"
        desc="她的每项本事都是一个模块：能单独关掉；能复制一份来改，改了就替换内置的；也能自己写新模块。"
        more={'自己写的东西放在下面这个文件夹，插件升级不会动；改完保存几秒内自动生效，不用重启。\n不会写代码？点「复制给 DSH 的话」，粘给 DSH，说你想要什么。'}
      >
        <div className="ab-pills" style={{ marginTop: 0, marginBottom: 8 }}>
          <span className="ab-pill">内置 {builtin.length}</span>
          <span className="ab-pill ok">运行 {running}</span>
          {off ? <span className="ab-pill warn">关闭 {off}</span> : null}
          {errCount ? <span className="ab-pill err">异常 {errCount}</span> : null}
          <span className="ab-pill">扩展 {mine.length}</span>
          {marketOn && marketUpdates ? <span className="ab-pill ok">市场可更新 {marketUpdates}</span> : null}
        </div>
        <div className="ab-flex ab-dirrow">
          <code className="ab-small" style={{ wordBreak: 'break-all', flex: '1 1 220px', minWidth: 0 }}>{data.dir}</code>
          <Btn small onClick={() => post('/modules/open').then((r) => toast(r.message))}>打开文件夹</Btn>
          <Btn small onClick={() => copy(data.prompt, toast, '复制好了，粘给 DSH，把【】里那句换成你想要的')}>复制给 DSH 的话</Btn>
          <Btn small kind="ghost" onClick={async () => { const r = await post('/modules/reload', {}); setModules(r.list); toast(r.message) }}>重新检查</Btn>
        </div>
        <Row label="安全模式" hint="打开后你写的模块一个都不加载，内置的全部恢复。出了问题先开它，看是不是你的模块引起的。">
          <Switch on={st.config.safeMode} onChange={async (v) => { const r = await post('/save', { safeMode: v }); toast(v ? '安全模式开了：只跑内置模块' : '安全模式关了', 'ok'); setModules(r.modules); reload() }} />
        </Row>
        {st.config.safeMode ? <div className="ab-note warn">安全模式开着：你写的模块现在都没加载。</div> : null}
      </Card>
      <Card title="核心页面" desc="这些页面是插件本体，始终显示、不能关；模块开关只影响它自己的标签页。">
        <div className="ab-pills" style={{ marginTop: 0 }}>
          {CORE_PAGES.map((t) => <span key={t} className="ab-pill">{t}</span>)}
        </div>
      </Card>
      <Market st={st} toast={toast} reload={reload} />
      <Card
        title={'已安装的扩展（' + mine.length + '）'}
        desc="自己写的或从模块市场安装的模块；和内置一样走统一发送出口，数据和设置按模块隔离。"
        right={<Btn small onClick={() => setCreating((v) => !v)}>{creating ? '取消' : '＋ 新建'}</Btn>}
      >
        {creating ? (
          <div className="ab-flex" style={{ marginBottom: 10 }}>
            <input className="ab-input" style={{ flex: '1 1 140px' }} placeholder="id，如 weather" value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase())} />
            <input className="ab-input" style={{ flex: '2 1 160px' }} placeholder="名字，如 查天气" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Btn kind="primary" small disabled={!newId.trim()} onClick={create}>新建</Btn>
          </div>
        ) : null}
        {mine.length ? mine.map((m) => <ModuleRow key={m.id} m={m} {...props} />) : <Empty icon="🧩" text="还没有自己写的或从市场安装的扩展" />}
      </Card>
      <Card
        title={'内置模块（' + builtin.length + '）'}
        desc="关掉的模块：她就没有这项本事，相关的标签页也会藏起来；核心页面不受影响。"
        right={<input className="ab-input ab-search" placeholder="搜索模块…" value={q} onChange={(e) => setQ(e.target.value)} />}
      >
        {groups.map((g) => {
          const items = g.list.filter(hit)
          if (qn && !items.length) return null
          const open = isOpen(g)
          return (
            <div key={g.id} className="ab-modgroup">
              <button type="button" className="ab-modgroup-head" onClick={() => toggleGroup(g)} aria-expanded={open}>
                <span className={cx('ab-modgroup-chev', open && 'open')}>›</span>
                <span className="ab-modgroup-name">{g.label}</span>
                <span className="ab-modgroup-meta">（{g.list.length}）· 运行 {g.list.filter((m) => m.running).length}</span>
                {groupNeedsAttention(g) ? <span className="ab-badge warn">有情况</span> : null}
                <span style={{ flex: 1 }} />
                <span className="ab-modgroup-meta">{open ? '收起' : '展开'}</span>
              </button>
              {open ? <div className="ab-modgroup-body">{items.map((m) => <ModuleRow key={m.id} m={m} {...props} compact />)}</div> : null}
            </div>
          )
        })}
        {qn && !matched ? <Empty icon="🔍" text={'没有匹配「' + q.trim() + '」的模块'} /> : null}
      </Card>
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
