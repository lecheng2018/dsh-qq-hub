import { useState, useEffect, useRef, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Select, Seg, Empty } from '../ui/primitives.js'
import { navIcon } from '../ui/icons.js'
import { setPath, cx } from '../core/utils.js'
import { get, post } from '../core/http.js'
import {
  planPersonaRow, pickAvatar, avatarSrc,
  PSEC_SUGGEST, PSEC_COLORS, psec, splitPersona, joinPersona, autoRows
} from '../domain/persona.js'

function AvatarCard({ st, toast, reload }) {
  const custom = st.avatar && st.avatar.custom
  return (
    <div className="ab-card" style={{ padding: 14 }}>
      <div className="ab-flex" style={{ alignItems: 'center', gap: 12 }}>
        <img className="ab-avatar" src={avatarSrc(st)} alt="头像" style={{ width: 52, height: 52 }} />
        <div><b>头像</b><div className="ab-muted ab-small">{custom ? '用的是你上传的图片' : '默认的大肥鱼'}</div></div>
      </div>
      <div className="ab-flex" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        <Btn small kind="primary" onClick={() => pickAvatar(toast, reload)}>换一张</Btn>
        {custom ? <Btn small kind="ghost" onClick={async () => { const r = await post('/avatar/reset'); toast(r.message, 'ok'); reload() }}>恢复默认</Btn> : null}
        <Btn
          small kind="ghost"
          onClick={async () => { if (!confirm('把这张图设成机器人号的 QQ 头像？')) return; const r = await post('/avatar/sync-qq'); toast(r.message, r.ok ? 'ok' : 'err') }}
        >
          同步成 QQ 头像
        </Btn>
      </div>
      <div className="ab-muted ab-small" style={{ marginTop: 6 }}>这是面板里显示的头像；点「同步成 QQ 头像」才会改机器人号在 QQ 上的头像。</div>
    </div>
  )
}

// 人格按【标题】分节：面板里拆开逐节编辑，保存时按原来的写法拼回一整段（文件格式不变）

function PersonaSection({ sec, lead, first, last, onChange, onMove, onDelete, onPolish, pending, onPick, onFlip }) {
  const showing = pending ? (pending.view === 'new' ? pending.text : sec.text) : sec.text
  const color = lead ? 'var(--ab-sea)' : PSEC_COLORS[sec.k % PSEC_COLORS.length]
  return (
    <div className={cx('ab-psec', lead && 'lead', pending && 'cmp')} style={{ '--c': color }}>
      <div className="ab-psec-head">
        {lead
          ? <div className="ab-psec-fixed">开场<small>她是谁，一两段话</small></div>
          : <input className="ab-psec-title" value={sec.title} placeholder="这一节叫什么" maxLength={30} onChange={(e) => onChange({ title: e.target.value.replace(/[【】\n]/g, '') })} />}
        <span className="ab-psec-n">{showing.length} 字</span>
        <div className="ab-psec-act">
          {lead ? null : <button type="button" className="ab-ibtn" title="往上移" disabled={first || !!pending} onClick={() => onMove(-1)}>{navIcon('M12 19V5M6 11l6-6 6 6')}</button>}
          {lead ? null : <button type="button" className="ab-ibtn" title="往下移" disabled={last || !!pending} onClick={() => onMove(1)}>{navIcon('M12 5v14M6 13l6 6 6-6')}</button>}
          {lead ? null : <button type="button" className="ab-ibtn danger" title="删掉这一节" disabled={!!pending} onClick={onDelete}>{navIcon('M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12')}</button>}
        </div>
        {pending ? null : <AiButton onClick={onPolish} empty={!sec.text.trim()} />}
      </div>
      <textarea
        value={showing} rows={autoRows(showing)} readOnly={!!pending}
        placeholder={lead ? '你是「…」，一个真实存在的人，正在用手机 QQ 和对面聊天。' : '- 一条一行，短句就好'}
        onChange={(e) => onChange({ text: e.target.value })}
      />
      {pending ? (
        <div className="ab-compare">
          <span className="ab-compare-tag">{pending.view === 'new' ? 'AI 润色版' : '原版'}</span>
          <span className="ab-muted ab-small">{pending.view === 'new' ? '和原版比：' + (pending.text.length - sec.text.length >= 0 ? '多 ' : '少 ') + Math.abs(pending.text.length - sec.text.length) + ' 字' : '还没改过的样子'}</span>
          <div className="ab-spacer" />
          <button type="button" className="ab-chip solid" onClick={onFlip}>{pending.view === 'new' ? '看原版' : '看润色版'}</button>
          <Btn small kind="primary" onClick={() => onPick(pending.view)}>{pending.view === 'new' ? '用润色版' : '保留原版'}</Btn>
        </div>
      ) : null}
    </div>
  )
}

function AiButton({ onClick, empty }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button" className="ab-aibtn" disabled={busy} title={empty ? '让 AI 按这一节的标题先写一版' : '让 AI 把这一节改得更具体、更像真人'}
      onClick={async () => { setBusy(true); try { await onClick() } finally { setBusy(false) } }}
    >
      {busy ? <i className="ab-spin" /> : navIcon('M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z')}
      <span>{busy ? '润色中' : empty ? 'AI 写一版' : 'AI 润色'}</span>
    </button>
  )
}

/**
 * 人设生效自检。
 *
 * 为什么要放在面板上：人设是**建会话那一刻**渲染进系统提示词的，DSH 之后不重算。
 * 于是「面板改了」和「模型实际拿到什么」是两回事，用户只能看后者 ——
 * 以前只能靠翻会话文件才能知道哪个群还挂着旧正文（2026-11-23 排查花了半小时）。
 * 这里把「预期卡 / 会话里的卡 / 需不需要重建 / 期望值来自哪一层」一次摊开。
 */
function PersonaAudit({ toast }) {
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    setBusy(true)
    const r = await get('/persona/audit')
    setBusy(false)
    if (!r.ok) { toast(r.message || '自检没成功', 'err'); return }
    setRows(r.rows || [])
  }
  const rebuild = async () => {
    if (!confirm('把挂着旧人设的会话归档、下一条消息重新开始？\n（它们的上下文会清空）')) return
    setBusy(true)
    const r = await post('/persona/rebuild-stale', { dryRun: false })
    setBusy(false)
    toast(r.message || (r.ok ? '好了' : '没成功'), r.ok ? 'ok' : 'err')
    load()
  }
  const levelText = (src) => {
    if (!src) return ''
    if (src.level === 'group') return '按群指定'
    if (src.level === 'private') return '按人指定'
    if (src.level === 'groupDefault') return src.emptyRow ? '该群那行是空值 → 跟随群默认' : '群默认'
    if (src.level === 'privateDefault') return src.emptyRow ? '该人那行是空值 → 跟随私聊默认' : '私聊默认'
    return '跟随全局'
  }
  const staleCount = (rows || []).filter((r) => r.stale === true).length
  return (
    <Card title="人设生效自检" right={<div className="ab-flex" style={{ gap: 8 }}>
      <Btn small onClick={load} disabled={busy}>{busy ? '查…' : rows ? '刷新' : '看一下'}</Btn>
      {rows && staleCount > 0 ? <Btn small kind="danger" onClick={rebuild} disabled={busy}>重建 {staleCount} 个过期会话</Btn> : null}
    </div>}>
      <div className="ab-muted ab-small" style={{ marginBottom: 8 }}>
        人设是在建会话那一刻烧进系统提示词的，之后不会自己重算 —— 所以「面板改了」不等于「模型拿到了」。
        这里逐聊天列出：按现在的配置**该用哪张卡**、会话里**实际是哪个版本**、下一条消息会不会重建。
      </div>
      {!rows ? <div className="ab-muted ab-small">点右上角「看一下」。</div> : (
        rows.length === 0 ? <div className="ab-muted ab-small">还没有任何会话。</div> : (
          <div className="ab-table-wrap">
            <table className="ab-table">
              <thead><tr><th>聊天</th><th>该用的卡</th><th>会话里固化的</th><th>状态</th><th>期望来自</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.chatId}>
                    <td>{r.chatId}{r.chatName ? <div className="ab-muted ab-small">{r.chatName}</div> : null}</td>
                    <td>{r.expected?.name || r.expected?.id || '—'}<div className="ab-muted ab-small">{r.expected?.hash || '（无卡）'}</div></td>
                    <td>{r.live ? (r.live.id || '—') : <span className="ab-muted">还没有会话</span>}<div className="ab-muted ab-small">{r.live?.hash || ''}</div></td>
                    <td>{r.stale === null ? <span className="ab-muted">—</span> : r.stale ? <span style={{ color: 'var(--ab-err)' }}>旧人设，会重建</span> : <span style={{ color: 'var(--ab-ok)' }}>是这版</span>}</td>
                    <td className="ab-small">{levelText(r.source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </Card>
  )
}

function Persona({ st, draft, setDraft, toast, reload }) {
  const [list, setList] = useState(st.personas)
  // 「按聊天换人设」里手输号码的暂存：key 是那一行的行标识，值是正在敲的文本。
  // 不能每敲一个字就改配置里的 key —— 那样 key 一变这一行就会被重建，
  // 光标丢失、而且 #newxxx 这种占位 key 被 replace(/\D/g,'') 洗过会变成
  // 纯数字（用户看到的「03」就是这么来的）。改成敲完（回车或失焦）才落盘。
  const [typing, setTyping] = useState({})
  const [current, setCurrent] = useState(st.config.persona.current)
  const [sel, setSel] = useState(st.config.persona.current)
  const [edit, setEdit] = useState(null) // { id, name, tags, secs }
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState({}) // 节的 k → { text, view: 'new' | 'old' } AI 润色还没选定的
  const [whole, setWhole] = useState(() => { try { return localStorage.getItem('qq-hub.persona.whole') === '1' } catch (e) { return false } })
  // 请求序号 + 当前选中 ID：人格列表点得快时，A 的慢回包会盖掉刚选中的 B
  // （页面上写着 B 的名字、里面却是 A 的正文）。只认最后一次请求。
  const loadSeq = useRef(0)
  const selRef = useRef(sel)
  selRef.current = sel
  const load = async (id) => {
    const seq = ++loadSeq.current
    const r = await get('/persona/get?id=' + encodeURIComponent(id))
    if (seq !== loadSeq.current || id !== selRef.current) return
    if (r.ok) { setEdit({ id: r.persona.id, name: r.persona.name, tags: (r.persona.tags || []).join('，'), secs: splitPersona(r.persona.body) }); setDirty(false); setPending({}) }
  }
  useEffect(() => { load(sel) }, [sel])
  const refresh = async () => { const r = await get('/personas'); if (r.ok) { setList(r.list); setCurrent(r.current) } }
  const body = edit ? joinPersona(edit.secs) : ''
  const waiting = Object.keys(pending).length
  const save = async () => {
    const r = await post('/persona/save', { id: edit.id, name: edit.name, tags: edit.tags.split(/[,，\s]+/).filter(Boolean), body })
    toast(r.message || (r.ok ? '保存好了' : '没保存成功'))
    if (r.ok) { setDirty(false); refresh() }
  }
  // 函数式更新：润色/保存这些 await 之后的写入不能基于发起时的旧 edit，
  // 否则回包晚到就会把期间用户敲进去的文字盖掉。
  const patch = (p) => { setEdit((prev) => (prev ? { ...prev, ...p } : prev)); setDirty(true) }
  const setSecs = (secs) => patch({ secs })
  const updSec = (k, p) => {
    setEdit((prev) => (prev ? { ...prev, secs: prev.secs.map((s) => (s.k === k ? { ...s, ...p } : s)) } : prev))
    setDirty(true)
  }
  const moveSec = (i, d) => { const n = edit.secs.slice(); const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setSecs(n) }
  const delSec = (s) => { if (s.text.trim() && !confirm('删掉「' + (s.title || '未命名') + '」这一节？')) return; setSecs(edit.secs.filter((x) => x.k !== s.k)) }
  const addSec = (title) => setSecs([...edit.secs, psec(title, '')])
  // 润色请求同样排队：连点两节的「润色」时，先发的慢回包不许盖掉后发的。
  const polishSeq = useRef(0)
  const polish = async (s) => {
    const seq = ++polishSeq.current
    const r = await post('/persona/polish', { name: edit.name, title: s.title === null ? '' : s.title, text: s.text, others: edit.secs.filter((x) => x.k !== s.k).map((x) => (x.title === null ? '开场' : x.title)) })
    if (seq !== polishSeq.current) return
    if (!r.ok) { toast(r.message || '润色没成功', 'err'); return }
    if (!s.text.trim()) { updSec(s.k, { text: r.text }); toast('写好了，不满意就接着改', 'ok'); return }
    setPending((prev) => ({ ...prev, [s.k]: { text: r.text, view: 'new' } }))
  }
  const pick = (s, view) => {
    const chosen = pending[s.k]
    setPending((prev) => { const next = { ...prev }; delete next[s.k]; return next })
    if (view === 'new' && chosen) updSec(s.k, { text: chosen.text })
  }
  const flip = (s) => setPending((prev) => (prev[s.k] ? { ...prev, [s.k]: { ...prev[s.k], view: prev[s.k].view === 'new' ? 'old' : 'new' } } : prev))
  const setMode = (w) => { if (w && waiting) { toast('先把 AI 润色的那几节选定一版', 'err'); return } setWhole(w); try { localStorage.setItem('qq-hub.persona.whole', w ? '1' : '0') } catch (e) {} }
  const titles = edit ? edit.secs.map((s) => s.title) : []
  const suggest = PSEC_SUGGEST.filter((t) => !titles.includes(t))
  // 按聊天换人设：私聊默认 / 群默认 / 具体某个号
  // 必须读 draft 而不是 st.config：st 是「服务端已保存」的状态，draft 才是正在编辑的。
  // 以前读 st.config，点「＋ 添加」改的是 draft，渲染却看 st，所以永远不显示新行 ——
  // 用户看到的就是「点了添加没有输入框也没有选择框」。
  const pm = (draft && draft.persona) || st.config.persona || {}
  const setPm = (k, v) => {
    setDraft((prev) => (prev ? setPath(prev, 'persona.' + k, v) : prev))
  }
  const personaOpts = (emptyLabel) => [{ value: '', label: emptyLabel }].concat(list.map((p) => ({ value: p.id, label: p.name })))
  const specific = (mapKey, title, hint) => {
    const m = pm[mapKey] || {}
    const wantKind = mapKey === 'groups' ? 'group' : 'private'
    const rows = Object.entries(m).map(([id, pid]) => {
      const isNew = id.startsWith('#new')
      const cur = isNew ? '' : id
      // 用户明确要求：这里只要输入框，不要选群下拉。
      // 下拉看着方便，实际上既拿不全群（只列聊过的），选中后还会因为
      // 拿旧配置重建 map 把刚填的号码冲掉，不如直接手输来得可靠。
      // 空值行（添加了但没选卡）：实际会走「默认」，必须在行上说出来，
      // 否则面板看着配过、模型一直用默认卡（2026-11-23 真机：某个群就是空值行）。
      const fallbackName = (() => {
        const defId = mapKey === 'groups' ? pm.groupDefault : pm.privateDefault
        const hit = list.find((p) => p.id === defId)
        return hit ? hit.name : ''
      })()
      const typed = typing[id]
      const shown = typed !== undefined ? typed : cur
      /**
       * 把这一行的号码落成新的 key。
       *
       * 关键点（这里踩过两次）：
       *   1. 只看用户敲的内容，绝不去 replace(/\D/g,'') 一个占位 key，
       *      否则 '#newm5k03ab' 会被洗成 '503'，界面莫名冒出一行「03」。
       *   2. 必须用 setDraft 的函数式更新。以前写 setDraft(setPath(draft, ...))，
       *      draft 是渲染时的旧快照，紧接着另一个控件的 onChange 也用旧快照重建，
       *      后写的那次就把刚填的群号抹掉了 —— 这就是「离开输入框字样就消失」。
       */
      const commitRow = (raw) => {
        const plan = planPersonaRow({ map: m, id, raw })
        setTyping((t) => { const n = { ...t }; delete n[id]; return n })
        if (plan.action === 'keep') return
        setDraft((prev) => {
          const cur2 = (prev && prev.persona && prev.persona[mapKey]) || {}
          const m2 = { ...cur2 }
          const keep = m2[id] === undefined ? '' : m2[id]
          if (plan.action === 'clear') {
            // 清空了：占位行原地保留；已成立的群号/号码退回占位行，避免把删掉的旧号码留住
            if (id.startsWith('#new')) {
              m2[id] = keep
            } else {
              delete m2[id]
              m2['#new' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)] = keep
            }
            return setPath(prev, 'persona.' + mapKey, m2)
          }
          // 目标位被别的行占了：本行原地保留，不顶掉别人
          if (plan.key !== id && m2[plan.key] !== undefined) {
            m2[id] = keep
            return setPath(prev, 'persona.' + mapKey, m2)
          }
          delete m2[id]
          m2[plan.key] = keep
          return setPath(prev, 'persona.' + mapKey, m2)
        })
      }
      return (
        <div key={id} className="ab-flex" style={{ marginBottom: 8 }}>
          <input
            className="ab-input" value={shown}
            placeholder={wantKind === 'group' ? '填群号' : '填 QQ 号'}
            inputMode="numeric"
            // 敲的时候只进暂存，不逐字改配置里的 key（否则整行被重建、光标丢失）
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '')
              setTyping((t) => ({ ...t, [id]: v }))
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRow(e.currentTarget.value) }}
            onBlur={(e) => commitRow(e.currentTarget.value)}
          />
          <Select
            value={pid} width={200} options={personaOpts('选人格')}
            onChange={(v) => {
              // 同样必须函数式更新，别用旧的 m 重建
              setDraft((prev) => {
                const cur2 = (prev && prev.persona && prev.persona[mapKey]) || {}
                const m2 = { ...cur2 }
                if (v) m2[id] = v; else delete m2[id]
                return setPath(prev, 'persona.' + mapKey, m2)
              })
            }}
          />
          <Btn
            small kind="danger"
            onClick={() => {
              setTyping((t) => { const n = { ...t }; delete n[id]; return n })
              setDraft((prev) => {
                const cur2 = (prev && prev.persona && prev.persona[mapKey]) || {}
                const m2 = { ...cur2 }
                delete m2[id]
                return setPath(prev, 'persona.' + mapKey, m2)
              })
            }}
          >
            删
          </Btn>
          {!isNew && !String(cur || '').trim()
            ? <span className="ab-muted ab-small">没有选卡 → 跟随{(mapKey === 'groups' ? '群' : '私聊')}默认{fallbackName ? `（现=${fallbackName}）` : ''}</span>
            : null}
        </div>
      )
    })
    // 现在只用手输，不再依赖「机器人聊过哪些群」，所以没有「没候选」这回事
    const noMore = false
    return (
      <Card
        title={title} desc={hint}
        // 永远可点：没候选时也要能加一行手输号码。这里以前 disabled={noMore}，
        // 一旦 /panel/chats 没返回数据，按钮就是死的，用户看到的就是「点了添加没反应」。
        right={(
          <Btn
            small
            onClick={() => setDraft((prev) => {
              // 函数式更新：新行加在「最新」的分行表上，而不是渲染时的旧快照
              const cur2 = (prev && prev.persona && prev.persona[mapKey]) || {}
              return setPath(prev, 'persona.' + mapKey, { ...cur2, ['#new' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)]: '' })
            })}
          >
            ＋ 添加
          </Btn>
        )}
      >
        {rows.length ? rows : <div className="ab-muted ab-small">{noMore ? '机器人还没在' + (wantKind === 'group' ? '群里说过话' : '私聊过') + '，点「＋ 添加」手输号码就行。' : '还没单独指定'}</div>}
        <div style={{ marginTop: 10 }}>
          <Row label="默认">
            <Select
              value={pm[mapKey === 'groups' ? 'groupDefault' : 'privateDefault'] || ''} width={200}
              options={personaOpts('跟随全局人设')}
              onChange={(v) => setPm(mapKey === 'groups' ? 'groupDefault' : 'privateDefault', v)}
            />
          </Row>
        </div>
      </Card>
    )
  }
  return (
    <div className="ab-grid">
      <div className="ab-persona">
        <div className="ab-plist">
          <div className="ab-pitems">
            {list.map((p) => (
              <button key={p.id} type="button" className={cx('ab-pitem', sel === p.id && 'on')} onClick={() => setSel(p.id)}>
                <div className="nm">{p.name}{p.id === current ? <span className="ab-badge">正在用</span> : null}</div>
                <div className="tg">{(p.tags || []).join(' · ') || p.id + ' · ' + p.chars + ' 字'}</div>
              </button>
            ))}
          </div>
          <Btn
            kind="ghost"
            onClick={() => { const id = 'persona-' + Date.now().toString(36); setEdit({ id, name: '新人格', tags: '', secs: splitPersona('你是……\n\n【打字习惯】\n- 短句、口语，一次只说一两句。') }); setSel(id); setDirty(true); setPending({}) }}
          >
            ＋ 新建人格
          </Btn>
          <AvatarCard st={st} toast={toast} reload={reload} />
        </div>
        {edit ? (
          <Card
            title="编辑人格" desc="人格写在系统提示词的最前面，按节写更好改。保存后，下一轮回复起就按新的来。"
            right={(
              <div className="ab-flex">
                {edit.id !== current ? <Btn small onClick={async () => { const r = await post('/persona/use', { id: edit.id }); toast(r.message); refresh(); reload() }}>设为当前</Btn> : null}
                {edit.id !== current ? <Btn small kind="danger" onClick={async () => { if (!confirm('删掉这个人格？')) return; const r = await post('/persona/delete', { id: edit.id }); if (r.ok) { setList(r.list); setSel(current) } else toast(r.message) }}>删除</Btn> : null}
              </div>
            )}
          >
            <Row label="名字"><input className="ab-input" value={edit.name} onChange={(e) => patch({ name: e.target.value })} /></Row>
            <Row label="标签" hint="用逗号隔开"><input className="ab-input" value={edit.tags} onChange={(e) => patch({ tags: e.target.value })} /></Row>
            <div className="ab-flex" style={{ marginTop: 14 }}>
              <Seg value={whole ? 'whole' : 'secs'} onChange={(v) => setMode(v === 'whole')} options={[{ value: 'secs', label: '分节' }, { value: 'whole', label: '整段' }]} />
              <div className="ab-spacer" />
              <span className="ab-muted ab-small">{(edit.secs.length - 1) + ' 节 · ' + body.length + ' 字'}</span>
            </div>
            {whole
              ? <textarea className="ab-textarea" style={{ minHeight: 380, marginTop: 12 }} value={body} onChange={(e) => setSecs(splitPersona(e.target.value))} />
              : (
                <div className="ab-psecs">
                  {edit.secs.map((s, i) => (
                    <PersonaSection
                      key={s.k} sec={s} lead={s.title === null} first={i <= 1} last={i === edit.secs.length - 1} pending={pending[s.k]}
                      onChange={(p) => updSec(s.k, p)} onMove={(d) => moveSec(i, d)} onDelete={() => delSec(s)}
                      onPolish={() => polish(s)} onPick={(v) => pick(s, v)} onFlip={() => flip(s)}
                    />
                  ))}
                  <div className="ab-psec-add">
                    <span className="ab-muted ab-small">加一节：</span>
                    {suggest.map((t) => <button key={t} type="button" className="ab-chip" onClick={() => addSec(t)}>{t}</button>)}
                    <button type="button" className="ab-chip solid" onClick={() => addSec('')}>＋ 自己起名</button>
                  </div>
                </div>
              )}
            <div className="ab-flex" style={{ marginTop: 14 }}>
              {waiting ? <span className="ab-muted ab-small">还有 {waiting} 节 AI 润色没选定，选好再保存</span> : null}
              <div className="ab-spacer" />
              <Btn kind="primary" disabled={!dirty || !!waiting} onClick={save}>{dirty ? '保存人格' : '已保存'}</Btn>
            </div>
          </Card>
        ) : <Card><Empty icon="⏳" text="加载中…" /></Card>}
      </div>
      {specific('groups', '按群换人设', '指定某个群用哪个人格；没指定的群用「默认」。优先级和聊天模型一致：具体群号 > 群默认 > 全局人设。')}
      {specific('privates', '按人换人设（私聊）', '指定某个人私聊时用哪个人格；没指定的用「默认」。')}
      <PersonaAudit toast={toast} />
    </div>
  )
}

export { Persona, AvatarCard, PersonaSection, AiButton }
