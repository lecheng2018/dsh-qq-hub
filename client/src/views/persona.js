import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Select, Seg, Empty, Switch } from '../ui/primitives.js'
import { navIcon } from '../ui/icons.js'
import { setPath, cx } from '../core/utils.js'
import { get, post } from '../core/http.js'
import {
  planPersonaRow, pickAvatar, avatarSrc,
  PSEC_SUGGEST, PSEC_COLORS, psec, splitPersona, joinPersona, autoRows
} from '../domain/persona.js'

function AvatarCard({ st, toast, reload }) {
  const custom = st.avatar && st.avatar.custom
  return h('div', { className: 'ab-card', style: { marginTop: 12, padding: 14 } },
    h('div', { className: 'ab-flex', style: { alignItems: 'center', gap: 12 } },
      h('img', { src: avatarSrc(st), alt: '头像', style: { width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', objectPosition: '50% 18%', border: '2px solid var(--ab-line)' } }),
      h('div', null, h('b', null, '头像'), h('div', { className: 'ab-muted ab-small' }, custom ? '用的是你上传的图片' : '默认的大肥鱼'))),
    h('div', { className: 'ab-flex', style: { marginTop: 10, flexWrap: 'wrap' } },
      h(Btn, { small: true, kind: 'primary', onClick: () => pickAvatar(toast, reload) }, '换一张'),
      custom ? h(Btn, { small: true, kind: 'ghost', onClick: async () => { const r = await post('/avatar/reset'); toast(r.message, 'ok'); reload() } }, '恢复默认') : null,
      h(Btn, { small: true, kind: 'ghost', onClick: async () => { if (!confirm('把这张图设成机器人号的 QQ 头像？')) return; const r = await post('/avatar/sync-qq'); toast(r.message, r.ok ? 'ok' : 'err') } }, '同步成 QQ 头像')),
    h('div', { className: 'ab-muted ab-small', style: { marginTop: 6 } }, '这是面板里显示的头像；点「同步成 QQ 头像」才会改机器人号在 QQ 上的头像。'))
}

// 人格按【标题】分节：面板里拆开逐节编辑，保存时按原来的写法拼回一整段（文件格式不变）


function PersonaSection({ sec, lead, first, last, onChange, onMove, onDelete, onPolish, pending, onPick, onFlip }) {
  const showing = pending ? (pending.view === 'new' ? pending.text : sec.text) : sec.text
  const color = lead ? 'var(--ab-sea)' : PSEC_COLORS[sec.k % PSEC_COLORS.length]
  return h('div', { className: cx('ab-psec', lead && 'lead', pending && 'cmp'), style: { '--c': color } },
    h('div', { className: 'ab-psec-head' },
      lead
        ? h('div', { className: 'ab-psec-fixed' }, '开场', h('small', null, '她是谁，一两段话'))
        : h('input', { className: 'ab-psec-title', value: sec.title, placeholder: '这一节叫什么', maxLength: 30, onChange: (e) => onChange({ title: e.target.value.replace(/[【】\n]/g, '') }) }),
      h('span', { className: 'ab-psec-n' }, showing.length + ' 字'),
      h('div', { className: 'ab-psec-act' },
        lead ? null : h('button', { type: 'button', className: 'ab-ibtn', title: '往上移', disabled: first || !!pending, onClick: () => onMove(-1) }, navIcon('M12 19V5M6 11l6-6 6 6')),
        lead ? null : h('button', { type: 'button', className: 'ab-ibtn', title: '往下移', disabled: last || !!pending, onClick: () => onMove(1) }, navIcon('M12 5v14M6 13l6 6 6-6')),
        lead ? null : h('button', { type: 'button', className: 'ab-ibtn danger', title: '删掉这一节', disabled: !!pending, onClick: onDelete }, navIcon('M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12'))),
      pending
        ? null
        : h(AiButton, { onClick: onPolish, empty: !sec.text.trim() })),
    h('textarea', {
      value: showing, rows: autoRows(showing), readOnly: !!pending,
      placeholder: lead ? '你是「…」，一个真实存在的人，正在用手机 QQ 和对面聊天。' : '- 一条一行，短句就好',
      onChange: (e) => onChange({ text: e.target.value }),
    }),
    pending ? h('div', { className: 'ab-compare' },
      h('span', { className: 'ab-compare-tag' }, pending.view === 'new' ? 'AI 润色版' : '原版'),
      h('span', { className: 'ab-muted ab-small' }, pending.view === 'new' ? '和原版比：' + (pending.text.length - sec.text.length >= 0 ? '多 ' : '少 ') + Math.abs(pending.text.length - sec.text.length) + ' 字' : '还没改过的样子'),
      h('div', { className: 'ab-spacer' }),
      h('button', { type: 'button', className: 'ab-chip solid', onClick: onFlip }, pending.view === 'new' ? '看原版' : '看润色版'),
      h(Btn, { small: true, kind: 'primary', onClick: () => onPick(pending.view) }, pending.view === 'new' ? '用润色版' : '保留原版')) : null)
}
function AiButton({ onClick, empty }) {
  const [busy, setBusy] = useState(false)
  return h('button', {
    type: 'button', className: 'ab-aibtn', disabled: busy, title: empty ? '让 AI 按这一节的标题先写一版' : '让 AI 把这一节改得更具体、更像真人',
    onClick: async () => { setBusy(true); try { await onClick() } finally { setBusy(false) } },
  },
  busy ? h('i', { className: 'ab-spin' }) : navIcon('M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'),
  h('span', null, busy ? '润色中' : empty ? 'AI 写一版' : 'AI 润色'))
}



function Persona({ st, draft, setDraft, toast, reload }) {
  // 机器人见过的群和私聊：用于「按聊天换人设」直接选，不用手打号码
  const [chats, setChats] = useState([])
  useEffect(() => {
    let alive = true
    get('/panel/chats').then((r) => { if (alive && r && r.ok && Array.isArray(r.chats)) setChats(r.chats) }).catch(() => {})
    return () => { alive = false }
  }, [])
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
  const load = async (id) => {
    const r = await get('/persona/get?id=' + encodeURIComponent(id))
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
  const patch = (p) => { setEdit({ ...edit, ...p }); setDirty(true) }
  const setSecs = (secs) => patch({ secs })
  const updSec = (k, p) => setSecs(edit.secs.map((s) => (s.k === k ? { ...s, ...p } : s)))
  const moveSec = (i, d) => { const n = edit.secs.slice(); const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setSecs(n) }
  const delSec = (s) => { if (s.text.trim() && !confirm('删掉「' + (s.title || '未命名') + '」这一节？')) return; setSecs(edit.secs.filter((x) => x.k !== s.k)) }
  const addSec = (title) => setSecs([...edit.secs, psec(title, '')])
  const polish = async (s) => {
    const r = await post('/persona/polish', { name: edit.name, title: s.title === null ? '' : s.title, text: s.text, others: edit.secs.filter((x) => x.k !== s.k).map((x) => (x.title === null ? '开场' : x.title)) })
    if (!r.ok) { toast(r.message || '润色没成功', 'err'); return }
    if (!s.text.trim()) { updSec(s.k, { text: r.text }); toast('写好了，不满意就接着改', 'ok'); return }
    setPending({ ...pending, [s.k]: { text: r.text, view: 'new' } })
  }
  const pick = (s, view) => {
    const next = { ...pending }
    delete next[s.k]
    setPending(next)
    if (view === 'new') updSec(s.k, { text: pending[s.k].text })
  }
  const flip = (s) => setPending({ ...pending, [s.k]: { ...pending[s.k], view: pending[s.k].view === 'new' ? 'old' : 'new' } })
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
      return h('div', { key: id, className: 'ab-flex', style: { marginBottom: 6 } },
        h('input', {
          className: 'ab-input', style: { width: 240 }, value: shown,
          placeholder: wantKind === 'group' ? '填群号' : '填 QQ 号',
          inputMode: 'numeric',
          // 敲的时候只进暂存，不逐字改配置里的 key（否则整行被重建、光标丢失）
          onChange: (e) => {
            const v = e.target.value.replace(/\D/g, '')
            setTyping((t) => ({ ...t, [id]: v }))
          },
          onKeyDown: (e) => { if (e.key === 'Enter') commitRow(e.currentTarget.value) },
          onBlur: (e) => commitRow(e.currentTarget.value),
        }),
      h(Select, { value: pid, width: 200, options: personaOpts('选人格'), onChange: (v) => {
        // 同样必须函数式更新，别用旧的 m 重建
        setDraft((prev) => {
          const cur2 = (prev && prev.persona && prev.persona[mapKey]) || {}
          const m2 = { ...cur2 }
          if (v) m2[id] = v; else delete m2[id]
          return setPath(prev, 'persona.' + mapKey, m2)
        })
      } }),
      h(Btn, { small: true, kind: 'danger', onClick: () => {
        setTyping((t) => { const n = { ...t }; delete n[id]; return n })
        setDraft((prev) => {
          const cur2 = (prev && prev.persona && prev.persona[mapKey]) || {}
          const m2 = { ...cur2 }
          delete m2[id]
          return setPath(prev, 'persona.' + mapKey, m2)
        })
      } }, '删'))
    })
    // 现在只用手输，不再依赖「机器人聊过哪些群」，所以没有「没候选」这回事
    const noMore = false
    return h(Card, { title, desc: hint,
      // 永远可点：没候选时也要能加一行手输号码。这里以前 disabled={noMore}，
      // 一旦 /panel/chats 没返回数据，按钮就是死的，用户看到的就是「点了添加没反应」。
      right: h(Btn, { small: true, onClick: () => setDraft((prev) => {
        // 函数式更新：新行加在「最新」的分行表上，而不是渲染时的旧快照
        const cur2 = (prev && prev.persona && prev.persona[mapKey]) || {}
        return setPath(prev, 'persona.' + mapKey, { ...cur2, ['#new' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)]: '' })
      }) }, '＋ 添加') },
      rows.length ? rows : h('div', { className: 'ab-muted ab-small' }, noMore ? '机器人还没在' + (wantKind === 'group' ? '群里说过话' : '私聊过') + '，点「＋ 添加」手输号码就行。' : '还没单独指定'),
      h('div', { style: { marginTop: 10 } }, h(Row, { label: '默认' }, h(Select, { value: pm[mapKey === 'groups' ? 'groupDefault' : 'privateDefault'] || '', width: 200, options: personaOpts('跟随全局人设'), onChange: (v) => setPm(mapKey === 'groups' ? 'groupDefault' : 'privateDefault', v) }))))
  }
  return h('div', null,
   h('div', { className: 'ab-persona' },
    h('div', { className: 'ab-plist' },
      list.map((p) => h('button', { key: p.id, type: 'button', className: cx('ab-pitem', sel === p.id && 'on'), onClick: () => setSel(p.id) },
        h('div', { className: 'nm' }, p.name, p.id === current ? h('span', { className: 'ab-badge' }, '正在用') : null),
        h('div', { className: 'tg' }, (p.tags || []).join(' · ') || p.id + ' · ' + p.chars + ' 字'))),
      h(Btn, { kind: 'ghost', onClick: () => { const id = 'persona-' + Date.now().toString(36); setEdit({ id, name: '新人格', tags: '', secs: splitPersona('你是……\n\n【打字习惯】\n- 短句、口语，一次只说一两句。') }); setSel(id); setDirty(true); setPending({}) } }, '＋ 新建人格'),
      h(AvatarCard, { st, toast, reload }),
    ),
    edit ? h(Card, { title: '编辑人格', desc: '人格写在系统提示词的最前面，按节写更好改。保存后，大肥鱼下一轮回复起就按新的来。',
      right: h('div', { className: 'ab-flex' },
        edit.id !== current ? h(Btn, { small: true, onClick: async () => { const r = await post('/persona/use', { id: edit.id }); toast(r.message); refresh(); reload() } }, '设为当前') : null,
        edit.id !== current ? h(Btn, { small: true, kind: 'danger', onClick: async () => { if (!confirm('删掉这个人格？')) return; const r = await post('/persona/delete', { id: edit.id }); if (r.ok) { setList(r.list); setSel(current) } else toast(r.message) } }, '删除') : null) },
      h(Row, { label: '名字' }, h('input', { className: 'ab-input', value: edit.name, onChange: (e) => patch({ name: e.target.value }) })),
      h(Row, { label: '标签', hint: '用逗号隔开' }, h('input', { className: 'ab-input', value: edit.tags, onChange: (e) => patch({ tags: e.target.value }) })),
      h('div', { className: 'ab-flex', style: { marginTop: 14 } },
        h(Seg, { value: whole ? 'whole' : 'secs', onChange: (v) => setMode(v === 'whole'), options: [{ value: 'secs', label: '分节' }, { value: 'whole', label: '整段' }] }),
        h('div', { className: 'ab-spacer' }),
        h('span', { className: 'ab-muted ab-small' }, (edit.secs.length - 1) + ' 节 · ' + body.length + ' 字')),
      whole
        ? h('textarea', { className: 'ab-textarea', style: { minHeight: 380, marginTop: 12 }, value: body, onChange: (e) => setSecs(splitPersona(e.target.value)) })
        : h('div', { className: 'ab-psecs' },
          edit.secs.map((s, i) => h(PersonaSection, {
            key: s.k, sec: s, lead: s.title === null, first: i <= 1, last: i === edit.secs.length - 1, pending: pending[s.k],
            onChange: (p) => updSec(s.k, p), onMove: (d) => moveSec(i, d), onDelete: () => delSec(s),
            onPolish: () => polish(s), onPick: (v) => pick(s, v), onFlip: () => flip(s),
          })),
          h('div', { className: 'ab-psec-add' },
            h('span', { className: 'ab-muted ab-small' }, '加一节：'),
            suggest.map((t) => h('button', { key: t, type: 'button', className: 'ab-chip', onClick: () => addSec(t) }, t)),
            h('button', { type: 'button', className: 'ab-chip solid', onClick: () => addSec('') }, '＋ 自己起名'))),
      h('div', { className: 'ab-flex', style: { marginTop: 14 } },
        waiting ? h('span', { className: 'ab-muted ab-small' }, '还有 ' + waiting + ' 节 AI 润色没选定，选好再保存') : null,
        h('div', { className: 'ab-spacer' }),
        h(Btn, { kind: 'primary', disabled: !dirty || !!waiting, onClick: save }, dirty ? '保存人格' : '已保存')),
    ) : h(Card, null, h(Empty, { icon: '⏳', text: '加载中…' })),
  ),
   h('div', { style: { height: 12 } }),
   specific('groups', '按群换人设', '指定某个群用哪个人格；没指定的群用「默认」。优先级和聊天模型一致：具体群号 > 群默认 > 全局人设。'),
   h('div', { style: { height: 12 } }),
   specific('privates', '按人换人设（私聊）', '指定某个人私聊时用哪个人格；没指定的用「默认」。'),
  )
}


export { Persona, AvatarCard, PersonaSection, AiButton }
