import { useState, useEffect, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Select, Seg, Empty, ModOff } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { setPath, timeAgo } from '../core/utils.js'
import { get, post } from '../core/http.js'
import { modOn } from '../domain/nav.js'
// 记忆模块自己的设置（embeddings / rerank 地址与 Key）并入「整理与检索」卡，不再由外壳追加到页尾
import { ExtPage } from './modules.js'

const SOURCE = { tool: '她自己记的', auto: '每日整理', diary: '空间日记', panel: '你加的', event: '她的经历', import: '导入的' }

function Mood({ st, draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [mem, setMem] = useState(null)
  const [stats, setStats] = useState(null)
  const [q, setQ] = useState('')
  const [ins, setIns] = useState(null)
  const [adding, setAdding] = useState({ text: '', aboutName: '', importance: 0.6 })
  const [addOpen, setAddOpen] = useState(false) // 「手动加一条」收进按钮，默认不占版面
  const [browseOpen, setBrowseOpen] = useState(false) // 全部记忆默认收起，整页长度不再被几百条记忆拉爆
  const [personaTab, setPersonaTab] = useState('profiles') // 人物档案 / 相处经验 / 说话方式 三合一
  const [health, setHealth] = useState(null)
  const [reloading, setReloading] = useState(false)
  const [vec, setVec] = useState(null)
  const [vecBusy, setVecBusy] = useState(false)
  const [rerank, setRerank] = useState(null)
  const load = (query) => get('/memories?q=' + encodeURIComponent(query ?? q)).then((r) => { setMem(r.items || []); setStats(r.stats || null); setHealth(r.health || null) })
  const loadVec = () => get('/memory/vector').then((r) => { setVec(r.status || { enabled: false }); setRerank(r.rerank || { enabled: false }) }).catch(() => { setVec({ enabled: false }); setRerank({ enabled: false }) })
  const [styles, setStyles] = useState({})
  const [profileRev, setProfileRev] = useState(0)
  const loadIns = () => get('/insights').then((r) => { setIns(r.items || []); setStyles(r.styles || {}) })
  const times = draft.memory.consolidateTimes || []
  const setTime = (i, v) => { const t = times.slice(); t[i] = v; setDraft(setPath(draft, 'memory.consolidateTimes', t)) }
  const memOn = modOn(st, 'memory')
  useEffect(() => { if (memOn) { load(''); loadIns(); loadVec() } }, [memOn])
  useEffect(() => { if (!memOn) return; const t = setTimeout(() => load(q), 250); return () => clearTimeout(t) }, [q])
  const last = st.memory && st.memory.lastConsolidate
  if (!memOn) return <div className="ab-grid"><ModOff name="记忆" /></div>
  return (
    <div className="ab-grid">
      <Card title="记忆概览" desc="她记得多少、上次整理是什么时候；档案有问题会在这里冒红条。">
        <div className="ab-pills" style={{ marginTop: 0, marginBottom: 10 }}>
          <span className="ab-pill">{stats ? stats.count : '–'} 条长期记忆</span>
          <span className="ab-pill">{stats ? stats.auto : '–'} 条来自每日整理{stats && stats.outdated ? ' · 另有 ' + stats.outdated + ' 条已过时' : ''}</span>
          <span className="ab-pill">上次整理：{last ? new Date(last.at).toLocaleString() : '还没整理过'}</span>
        </div>
        {health && !health.ok ? (
          <div className="ab-note err" role="alert">
            <b>档案异常，自动整理已暂停。修复文件后点击「重新载入档案」。</b>
            {health.stateError ? <div>{health.stateError}</div> : null}
            {(health.brokenScopes || []).map((item) => <div key={item.file}>{item.file}：{item.error}</div>)}
          </div>
        ) : null}
        <div className="ab-flex">
          <Btn small kind="primary" onClick={async () => { toast('正在整理，可能要一两分钟…'); const r = await post('/memory/extract', {}); toast(r.message, r.ok ? 'ok' : 'err'); load(); loadIns(); setProfileRev((v) => v + 1) }}>现在整理一次</Btn>
          <Btn
            small disabled={reloading}
            onClick={async () => {
              setReloading(true)
              try {
                const r = await post('/memory/reload', {})
                setHealth(r.health || null)
                toast(r.message, r.ok ? 'ok' : 'err')
                await Promise.all([load(), loadIns()])
                setProfileRev((v) => v + 1)
              } catch (error) { toast(error.message, 'err') } finally { setReloading(false) }
            }}
          >
            {reloading ? '正在载入…' : '重新载入档案'}
          </Btn>
        </div>
      </Card>

      <Card title="记忆库" right={f.sw('memory.enabled')} desc="她聊天时自己记的、每天从聊天里整理出来的、你手动加的。每轮回复前，她会按对方正在说的话翻出最相关的几条。">
        <div className="ab-flex">
          <input className="ab-input" style={{ flex: '2 1 260px' }} placeholder="搜索记忆，例如：白米饭、游戏、约定…" value={q} onChange={(e) => { setQ(e.target.value); if (e.target.value) setBrowseOpen(true) }} />
          <Btn small onClick={() => setAddOpen(!addOpen)}>{addOpen ? '收起' : '＋ 手动加一条'}</Btn>
        </div>
        {addOpen ? (
          <div className="ab-flex" style={{ marginTop: 8 }}>
            <input className="ab-input" style={{ flex: '2 1 260px' }} placeholder="要她记住的事，例如：主人不吃香菜" value={adding.text} onChange={(e) => setAdding({ ...adding, text: e.target.value })} />
            <input className="ab-input" style={{ flex: '1 1 120px' }} placeholder="关于谁（可选）" value={adding.aboutName} onChange={(e) => setAdding({ ...adding, aboutName: e.target.value })} />
            <Select value={adding.importance} width={120} onChange={(v) => setAdding({ ...adding, importance: v })} options={[{ value: 0.3, label: '随口一提' }, { value: 0.6, label: '比较重要' }, { value: 0.9, label: '非常重要' }]} />
            <Btn small kind="primary" disabled={!adding.text.trim()} onClick={async () => { const r = await post('/memory/add', adding); toast(r.ok ? '记住了' : r.message); setAdding({ text: '', aboutName: '', importance: 0.6 }); setAddOpen(false); load() }}>记住</Btn>
          </div>
        ) : null}
        <div className="ab-flex" style={{ marginTop: 10, cursor: 'pointer' }} onClick={() => setBrowseOpen(!browseOpen)}>
          <div className="ab-section-title" style={{ margin: 0 }}>{(browseOpen ? '▾' : '▸') + ' 全部记忆'}</div>
          <span className="ab-muted ab-small">{mem ? mem.length + ' 条' : ''}</span>
        </div>
        {!browseOpen ? null : mem === null
          ? <Empty icon="⏳" text="加载中…" />
          : mem.length === 0 ? <Empty icon="🫧" text={q ? '没找到相关的记忆' : '还没有记住什么。'} />
            : (
              <div>
                <div className="ab-flex" style={{ marginBottom: 6 }}>
                  <span className="ab-muted ab-small">{mem.length + ' 条' + (mem.length >= 300 ? '（只显示最近 300 条，可搜索）' : '')}</span>
                </div>
                {/* 收纳但不折叠：按时间分段小标题（今天/昨天/近几天/本周/本月/更早），每条照样全文平铺 */}
                {(() => {
                  const secOf = (m) => {
                    const t = new Date(m.invalidAt || m.at); const now = new Date()
                    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
                    const diff = (day(now) - day(t)) / 86400000
                    if (diff <= 0) return '今天'
                    if (diff === 1) return '昨天'
                    if (diff <= 3) return '近几天'
                    if (diff <= 7) return '本周'
                    if (diff <= 31) return '本月'
                    return '更早'
                  }
                  const order = ['今天', '昨天', '近几天', '本周', '本月', '更早']
                  const groups = new Map()
                  for (const m of mem) { const k = secOf(m); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m) }
                  return (
                    <div className="ab-list" style={{ marginTop: 8 }}>
                      {order.filter((k) => groups.has(k)).flatMap((k) => [
                        <div key={'s:' + k} className="ab-section-title" style={{ margin: '10px 0 4px' }}>{k}<span className="ab-muted ab-small" style={{ marginLeft: 6 }}>{groups.get(k).length + ' 条'}</span></div>,
                        ...groups.get(k).map((m) => <MemoryRow key={m.id} m={m} onChanged={() => load()} toast={toast} />),
                      ])}
                    </div>
                  )
                })()}
              </div>
            )}
      </Card>

      <Card title="人物与相处" desc="她对每个人的印象、总结出的相处之道，以及潜移默化学到的说话方式。点开某一项才编辑。">
        <Seg value={personaTab} onChange={setPersonaTab} options={[{ value: 'profiles', label: '人物档案' }, { value: 'insights', label: '相处经验' }, { value: 'style', label: '说话方式' }]} />
        <div style={{ marginTop: 10 }}>
          {personaTab === 'profiles' ? <ProfilesList toast={toast} refreshKey={profileRev} /> : null}
          {personaTab === 'insights' ? (() => {
            if (ins === null) return <Empty icon="⏳" text="加载中…" />
            const byKey = new Map(ins.map((p) => [p.key, p]))
            for (const [k, list] of Object.entries(styles || {})) {
              if (k !== 'self' && Array.isArray(list) && list.length && !byKey.has(k)) {
                byKey.set(k, { key: k, name: '', list: [] })
              }
            }
            const rows = [...byKey.values()]
            return rows.length === 0
              ? <Empty icon="🌱" text="还没有总结出经验。多聊几天，整理记忆时她会慢慢总结。" />
              : rows.map((p) => <InsightRow key={p.key} p={p} toast={toast} onSaved={loadIns} style={styles[p.key] || []} />)
          })() : null}
          {personaTab === 'style' ? (
            <div>
              <StyleEditor k="self" label="她自己养成的说法" list={styles.self || []} toast={toast} onSaved={loadIns} />
              <div className="ab-muted ab-small" style={{ marginTop: 6 }}>每个人的说话习惯跟着上面的「相处经验」一起显示和编辑。</div>
            </div>
          ) : null}
        </div>
      </Card>

      <Card title="整理与检索" desc="每天什么时候整理、每轮想起几条；向量与精排的接口配置也在这一张卡里。">
        <Row label="每天自动整理两次" hint="把聊天流水提炼成长期记忆、相处经验和说话方式；第二次只处理新增部分。">
          {f.sw('memory.dailyConsolidate')}<span className="ab-muted">每天</span>
          <input className="ab-input sm" type="time" value={times[0] || '04:00'} onChange={(e) => setTime(0, e.target.value)} />
          <span className="ab-muted">和</span>
          <input className="ab-input sm" type="time" value={times[1] || '16:00'} onChange={(e) => setTime(1, e.target.value)} />
        </Row>
        <Row label="每轮最多想起几条">{f.range('memory.recallCount', 0, 12, 1, (v) => v + ' 条')}</Row>
        <Row label="语义召回（向量通道）" hint="BM25 检不出「没有共同字词」的提问时，用 embedding 语义兜底并融合排序。">
          {vec ? (
            vec.enabled ? (
              <span className="ab-flex">
                <span className="ab-small" style={{ color: 'var(--ab-ok)', flex: 1 }}>● {vec.model || '?'}（{vec.dim} 维）· 已向量 {vec.vectors || 0} 条{vec.pending ? '，待补全 ' + vec.pending + ' 个作用域' : ''}</span>
                <Btn small disabled={!!vecBusy} onClick={async () => { setVecBusy(true); try { const r = await post('/memory/vector/backfill', {}); toast(r.message || ('存量补全完成，这次向量化 ' + (r.embedded || 0) + ' 条'), r.ok ? 'ok' : 'err'); loadVec() } catch (error) { toast(error.message, 'err') } finally { setVecBusy(false) } }}>{vecBusy ? '补全中…' : '补全存量向量'}</Btn>
              </span>
            ) : <span className="ab-small" style={{ color: 'var(--ab-dim)' }}>未开启 —— 在下面「接口与阈值」里填 Embeddings 接口地址、API Key，打开「语义召回」</span>
          ) : '…'}
        </Row>
        <Row label="记忆精排（reranker）" hint="RRF 融合后用 cross-encoder 对候选精排，只重排、不扩可见性；失败自动退回 RRF 顺序。">
          {rerank ? (
            rerank.enabled ? (
              <span className="ab-small" style={{ color: 'var(--ab-ok)' }}>● {rerank.model || '?'} · 精排前 {rerank.topN || 20} 条{rerank.lastError ? ' · 上次失败已退回 RRF：' + rerank.lastError : ''}</span>
            ) : <span className="ab-small" style={{ color: 'var(--ab-dim)' }}>未开启 —— 需先开启语义召回，再在下面「接口与阈值」里填 Rerank API Key 并打开开关</span>
          ) : '…'}
        </Row>
        <div className="ab-section-title">接口与阈值</div>
        <ExtPage st={st} draft={draft} setDraft={setDraft} toast={toast} reload={loadVec} mod="memory" embedded />
      </Card>

      <RecallLog />
      <Card title="导入与迁移" desc="一次性操作：导入旧档案，或主人换号后把旧号名下的记忆整体搬过来。" collapse>
        <MemoryImport toast={toast} onDone={() => load()} />
        <OwnerMigrate toast={toast} onChanged={() => load()} />
      </Card>
    </div>
  )
}

/** 人物小档案：她对每个人的一段印象。列表只显示摘要，点「编辑」再改。 */
function ProfilesList({ toast, refreshKey = 0 }) {
  const [list, setList] = useState(null)
  const load = () => get('/profiles').then((r) => setList(r.list || []))
  useEffect(() => { load() }, [refreshKey])
  if (list === null) return <Empty icon="⏳" text="加载中…" />
  if (list.length === 0) return <Empty icon="🌱" text="还没有。关于一个人记住 3 条以上的事后，整理记忆时会写出来。" />
  return <div className="ab-list">{list.map((p) => <ProfileRow key={p.key || `${p.qq}@${p.scope}`} p={p} toast={toast} onChanged={load} />)}</div>
}

function ProfileRow({ p, toast, onChanged }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(p.text)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => { setText(p.text) }, [p.text])
  // 档案按「QQ+作用域」存，同一 QQ 可能有多份；删哪份必须带上 scope，
  // 只传 qq 会把 global 那份误删（profiles/save 走的就是这个键）。
  const del = async () => { const r = await post('/profiles/delete', { qq: p.qq, scope: p.scope }); toast(r.message, r.ok ? 'ok' : 'err'); onChanged() }
  const scopeLabel = p.scope === 'global' ? '通用' : p.scope.startsWith('group:') ? '群 ' + p.scope.slice(6) : '私聊'
  return (
    <div className="ab-li" style={{ alignItems: 'flex-start' }}>
      <div className="meta">
        <b>{p.name || p.qq}</b><br />
        <span className="ab-small">{p.qq}</span><br />
        {/* 蓝底胶囊必须显式白字：.ab-pill 默认 color 是 var(--ab-sub)（深灰），压在 --ab-sea 上几乎看不见 */}
        <span className="ab-pill" style={{ padding: '0 6px', fontSize: 11, background: p.scope === 'global' ? 'var(--ab-sea, #35506b)' : 'rgba(0,0,0,.18)', color: p.scope === 'global' ? '#fff' : 'var(--ab-sub)' }}>
          {scopeLabel}
        </span><br />
        <span className="ab-small">{timeAgo(p.at)}</span>
      </div>
      {open
        ? <textarea className="ab-input wide" rows={3} value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1 }} />
        : <div className="body ab-small" style={{ flex: 1, whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.text}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Btn small onClick={() => setOpen(!open)}>{open ? '收起' : '编辑'}</Btn>
        {open ? <Btn small kind="primary" disabled={text === p.text} onClick={async () => { const r = await post('/profiles/save', { qq: p.qq, text, scope: p.scope }); toast(r.message, r.ok ? 'ok' : 'err'); if (r.ok) onChanged() }}>保存</Btn> : null}
        {open ? (
          <Btn
            small kind="ghost" disabled={busy}
            onClick={async () => { setBusy(true); const r = await post('/profiles/rebuild', { qq: p.qq, scope: p.scope }); setBusy(false); toast(r.message, r.ok ? 'ok' : 'err'); onChanged() }}
          >
            {busy ? '重写中…' : '按记忆重写'}
          </Btn>
        ) : null}
        {open ? (confirming
          ? <Btn small kind="ghost" onClick={() => { setConfirming(false); del() }}>确认删除</Btn>
          : <Btn small kind="ghost" onClick={() => setConfirming(true)}>删除</Btn>) : null}
      </div>
    </div>
  )
}

/** 最近几轮她想起了什么、因为哪些词想起来的。 */
function RecallLog() {
  const [list, setList] = useState(null)
  const load = () => get('/memory/recalls').then((r) => setList(r.list || []))
  useEffect(() => { load() }, [])
  return (
    <Card title="最近想起了什么" desc="每次回复前她会按对方说的话翻记忆。这里能看到最近几次想起了哪几条、是因为哪几个词；想不起来的那次也会列出来。" right={<Btn small kind="ghost" onClick={load}>刷新</Btn>} collapse>
      {!list
        ? <Empty icon="⏳" text="加载中…" />
        : list.length === 0 ? <Empty icon="🫧" text="还没有记录（重启后从头记）。" />
          : (
            <div className="ab-list">
              {list.slice(0, 10).map((r, i) => (
                <div key={i} className="ab-li">
                  <div className="meta">{timeAgo(r.at)}<br /><span className="ab-small">{String(r.where || '').replace(/^private:/, '私聊 ').replace(/^group:/, '群 ')}</span></div>
                  <div className="body">
                    <div className="ab-muted ab-small">「{r.query.slice(0, 60)}{r.query.length > 60 ? '…' : ''}」</div>
                    {r.hits.length
                      ? r.hits.map((x) => <div key={x.id} style={{ marginTop: 3 }}>· {x.text}<span className="ab-muted ab-small">  ← {(x.why.join('、') || '—')} · {x.score}</span></div>)
                      : <div className="ab-muted" style={{ marginTop: 3 }}>这次什么都没想起来</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
    </Card>
  )
}

/** 主人换号迁移：旧 QQ 号名下的私聊记忆整体搬到新号。 */
function OwnerMigrate({ toast, onChanged }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const doMove = async () => {
    if (!/^\d{5,}$/.test(from) || !/^\d{5,}$/.test(to)) { toast('两边都要填 QQ 号'); return }
    if (!confirm('把 ' + from + ' 名下的私聊记忆全部搬给 ' + to + '？')) return
    const r = await post('/memory/reassign-owner', { from, to })
    toast(r.message || (r.ok ? '搬好了' : '没搬成'))
    if (r.ok) { setFrom(''); setTo(''); onChanged() }
  }
  return (
    <div>
      <div className="ab-section-title">主人换号迁移</div>
      <div className="ab-flex" style={{ alignItems: 'center' }}>
        <input className="ab-input sm" placeholder="旧 QQ 号" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="ab-muted">→</span>
        <input className="ab-input sm" placeholder="新 QQ 号" value={to} onChange={(e) => setTo(e.target.value)} />
        <Btn small disabled={!from || !to} onClick={doMove}>迁移记忆</Btn>
      </div>
      <div className="ab-muted ab-small" style={{ marginTop: 4 }}>换了 QQ 号用这个：旧号私聊里的记忆（包括记在你名下的小档案）会整体搬到新号，一次就好。</div>
    </div>
  )
}

/** 导入旧档案：粘贴或上传文字，模型挑出值得记的，勾选后存进记忆库。 */
function MemoryImport({ toast, onDone }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [cands, setCands] = useState(null)
  const [pick, setPick] = useState({})
  const [scope, setScope] = useState('private')
  const readFile = () => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = '.txt,.md,.markdown,.json'
    inp.onchange = () => { const f = inp.files && inp.files[0]; if (!f) return; const fr = new FileReader(); fr.onload = () => setText(String(fr.result || '').slice(0, 30000)); fr.readAsText(f) }
    inp.click()
  }
  const scan = async () => {
    setBusy(true); setCands(null)
    const r = await post('/memory/import', { text })
    setBusy(false)
    if (!r.ok) return toast(r.message, 'err')
    setCands(r.list); setPick(Object.fromEntries(r.list.map((_, i) => [i, true])))
  }
  const commit = async () => {
    const items = cands.filter((_, i) => pick[i])
    const r = await post('/memory/import/commit', { items, scope })
    toast(r.message, 'ok'); setCands(null); setText(''); onDone()
  }
  return (
    <div>
      <div className="ab-section-title">导入旧档案</div>
      <div className="ab-muted ab-small" style={{ marginBottom: 8 }}>以前写过的设定、聊天笔记、别的机器人的记忆文件，贴进来或上传。她会挑出值得记的，你勾选后再存；和已有记忆重复的会自动去掉。</div>
      <textarea className="ab-textarea" style={{ minHeight: 110 }} placeholder="把旧档案的文字粘贴到这里（最多 3 万字）" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="ab-flex" style={{ marginTop: 8 }}>
        <Btn small onClick={readFile}>选择文件</Btn>
        <Btn small kind="primary" disabled={busy || !text.trim()} onClick={scan}>{busy ? <Fragment><i className="ab-spin" /> 正在挑…</Fragment> : '挑出值得记的'}</Btn>
        <span className="ab-muted ab-small">{text ? text.length + ' 字' : ''}</span>
      </div>
      {cands ? (cands.length === 0
        ? <div className="ab-muted" style={{ marginTop: 10 }}>没挑出新的可记的东西（或者都已经记过了）。</div>
        : (
          <div style={{ marginTop: 10 }}>
            <div className="ab-list">
              {cands.map((c, i) => (
                <label key={i} className="ab-li" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!pick[i]} onChange={(e) => setPick({ ...pick, [i]: e.target.checked })} style={{ accentColor: 'var(--ab-sea)', marginTop: 3 }} />
                  <div className="body">{c.aboutName ? <b>[{c.aboutName}] </b> : null}{c.text}{c.importance >= 0.8 ? ' ★' : ''}</div>
                </label>
              ))}
            </div>
            <div className="ab-flex" style={{ marginTop: 8 }}>
              <label className="ab-small" style={{ cursor: 'pointer' }}>
                <input type="radio" checked={scope === 'private'} onChange={() => setScope('private')} style={{ accentColor: 'var(--ab-sea)' }} />
                {' 只在她的私聊里想起（默认）'}
              </label>
              <label className="ab-small" style={{ cursor: 'pointer', marginLeft: 12 }}>
                <input type="radio" checked={scope === 'global'} onChange={() => setScope('global')} style={{ accentColor: 'var(--ab-sea)' }} />
                {' 所有聊天都能想起（她自己的设定选这个）'}
              </label>
            </div>
            <div className="ab-flex" style={{ marginTop: 8 }}>
              <Btn small kind="primary" onClick={commit} disabled={!Object.values(pick).some(Boolean)}>存进记忆库（{Object.values(pick).filter(Boolean).length} 条）</Btn>
              <Btn small kind="ghost" onClick={() => setCands(null)}>取消</Btn>
            </div>
          </div>
        )) : null}
    </div>
  )
}

function StyleEditor({ k, label, list, toast, onSaved }) {
  const joined = list.join('\n')
  const [text, setText] = useState(joined)
  useEffect(() => setText(joined), [joined])
  const changed = text !== joined
  const saveStyle = async () => {
    const clean = text.split('\n').map((t) => t.trim()).filter(Boolean)
    const r = await post('/style/save', { key: k, list: clean })
    toast(r.message, r.ok ? 'ok' : 'err')
    if (r.ok) { setText(clean.slice(0, k === 'self' ? 6 : 5).map((t) => t.slice(0, 40)).join('\n')); onSaved() }
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div className="ab-flex" style={{ marginBottom: 4 }}>
        <span className="ab-small" style={{ color: 'var(--ab-sub)' }}>{label}</span>
        <div className="ab-spacer" />
        {changed ? <Btn small kind="primary" onClick={saveStyle}>保存</Btn> : null}
      </div>
      <textarea className="ab-textarea" style={{ minHeight: 50, fontFamily: 'inherit' }} value={text} onChange={(e) => setText(e.target.value)} placeholder="一行一条，例如：消息很短，常一句话分几条发" />
    </div>
  )
}

/** 某个人的相处经验：默认只显示一行摘要，点「编辑」展开条目与编辑器。 */
function InsightRow({ p, toast, onSaved, style }) {
  const [open, setOpen] = useState(false)
  const joined = p.list.map((x) => x.text).join('\n')
  const [text, setText] = useState(joined)
  useEffect(() => setText(joined), [joined])
  const changed = text !== joined
  const who = p.key.startsWith('group:') ? '群 ' + p.key.slice(6)
    : p.key.startsWith('qq:') ? (p.name ? p.name + '（' + p.key.slice(3) + '）' : p.key.slice(3))
      : p.key === 'global' ? '通用经验' : (p.name || p.key)
  // 单条删除：textarea 是「一行一条」，按行号找到对应条目的 id 再删
  const delOne = async (lineIdx) => {
    const item = p.list[lineIdx]
    if (!item) return
    const r = await post('/insights/delete', { key: p.key, id: item.id })
    toast(r.message, r.ok ? 'ok' : 'err')
    if (r.ok) onSaved()
  }
  const saveIns = async () => {
    const clean = text.split('\n').map((t) => t.trim()).filter(Boolean)
    const r = await post('/insights/save', { key: p.key, list: clean })
    toast(r.message, r.ok ? 'ok' : 'err')
    if (r.ok) { setText(clean.slice(0, 8).join('\n')); onSaved() }
  }
  return (
    <div style={{ marginBottom: open ? 12 : 4, borderTop: '1px solid var(--ab-line)', paddingTop: 8 }}>
      <div className="ab-flex" style={{ marginBottom: open ? 6 : 0 }}>
        <b>{who}</b>
        <span className="ab-muted ab-small">{p.list.length + ' 条'}</span>
        <div className="ab-spacer" />
        {open && changed ? <Btn small kind="primary" onClick={saveIns}>保存</Btn> : null}
        <Btn small kind="ghost" onClick={() => setOpen(!open)}>{open ? '收起' : '编辑'}</Btn>
      </div>
      {open ? (
        <Fragment>
          {p.list.length ? (
            <div className="ab-list" style={{ marginBottom: 6 }}>
              {p.list.map((x, i) => (
                <div key={x.id || i} className="ab-li" style={{ padding: '4px 0' }}>
                  <div className="body ab-small">{x.text}</div>
                  <Btn small kind="ghost" onClick={() => { if (window.confirm('删掉这条相处经验？\n\n' + x.text.slice(0, 60))) delOne(i) }}>删</Btn>
                </div>
              ))}
            </div>
          ) : null}
          <textarea className="ab-textarea" style={{ minHeight: 70, fontFamily: 'inherit' }} value={text} onChange={(e) => setText(e.target.value)} placeholder="一行一条经验" />
          <StyleEditor k={p.key} label="说话方式" list={style || []} toast={toast} onSaved={onSaved} />
        </Fragment>
      ) : null}
    </div>
  )
}

function MemoryRow({ m, onChanged, toast }) {
  const [edit, setEdit] = useState(false)
  const [text, setText] = useState(m.text)
  if (m.invalidAt) {
    return (
      <div className="ab-li" style={{ opacity: 0.6 }}>
        <div className="meta">{timeAgo(m.invalidAt)}<br /><span className="ab-pill" style={{ padding: '0 6px', fontSize: 11 }}>已过时</span></div>
        <div className="body">
          <s>{(m.aboutName ? '[' + m.aboutName + '] ' : '') + m.text}</s>
          {m.supersededText ? <div className="ab-muted ab-small">→ 现在是：{m.supersededText}</div> : null}
        </div>
        <Btn small kind="ghost" onClick={async () => { await post('/memory/restore', { id: m.id }); toast('恢复了', 'ok'); onChanged() }}>恢复</Btn>
        <Btn small kind="ghost" onClick={async () => { await post('/memory/delete', { id: m.id }); onChanged() }}>删掉</Btn>
      </div>
    )
  }
  return (
    <div className="ab-li">
      <div className="meta">{timeAgo(m.at)}<br /><span className="ab-pill" style={{ padding: '0 6px', fontSize: 11 }}>{SOURCE[m.source] || '记忆'}</span></div>
      {edit
        ? <input
            className="ab-input wide" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') { await post('/memory/update', { id: m.id, text }); setEdit(false); toast('改好了', 'ok'); onChanged() }
              if (e.key === 'Escape') setEdit(false)
            }}
          />
        : <div className="body">{m.aboutName ? <b>[{m.aboutName}] </b> : null}{m.text}{m.importance >= 0.8 ? <span title="很重要"> ★</span> : null}</div>}
      <Btn small kind="ghost" onClick={() => setEdit(!edit)}>{edit ? '取消' : '改一下'}</Btn>
      <Btn small kind="ghost" onClick={async () => { await post('/memory/delete', { id: m.id }); onChanged() }}>忘掉</Btn>
    </div>
  )
}

export {
  Mood, ProfilesList, ProfileRow, RecallLog, OwnerMigrate, MemoryImport,
  StyleEditor, InsightRow, MemoryRow, SOURCE
}
