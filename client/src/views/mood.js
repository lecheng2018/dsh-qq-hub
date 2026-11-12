import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { Card, Row, Btn, Switch, Select, Range, Empty, ModOff } from '../ui/primitives.js'
import { useField } from '../ui/form.js'
import { setPath, timeAgo } from '../core/utils.js'
import { get, post } from '../core/http.js'
import { modOn } from '../domain/nav.js'

const SOURCE = { tool: '她自己记的', auto: '每日整理', diary: '空间日记', panel: '你加的', event: '她的经历', import: '导入的' }
function Mood({ st, draft, setDraft, toast }) {
  const f = useField(draft, setDraft)
  const [mem, setMem] = useState(null)
  const [stats, setStats] = useState(null)
  const [q, setQ] = useState('')
  const [ins, setIns] = useState(null)
  const [adding, setAdding] = useState({ text: '', aboutName: '', importance: 0.6 })
  const [browseOpen, setBrowseOpen] = useState(false) // 「翻一翻」默认收起：整页长度不再被几百条记忆拉爆
  const [health, setHealth] = useState(null)
  const [reloading, setReloading] = useState(false)
  const load = (query) => get('/memories?q=' + encodeURIComponent(query ?? q)).then((r) => { setMem(r.items || []); setStats(r.stats || null); setHealth(r.health || null) })
  const [styles, setStyles] = useState({})
  const loadIns = () => get('/insights').then((r) => { setIns(r.items || []); setStyles(r.styles || {}) })
  const times = draft.memory.consolidateTimes || []
  const setTime = (i, v) => { const t = times.slice(); t[i] = v; setDraft(setPath(draft, 'memory.consolidateTimes', t)) }
  const memOn = modOn(st, 'memory')
  useEffect(() => { if (memOn) { load(''); loadIns() } }, [memOn])
  useEffect(() => { if (!memOn) return; const t = setTimeout(() => load(q), 250); return () => clearTimeout(t) }, [q])
  const last = st.memory && st.memory.lastConsolidate
  if (!memOn) return h('div', { className: 'ab-grid' }, h(ModOff, { name: '记忆' }))
  return h('div', { className: 'ab-grid' },
    h(ProfilesCard, { toast }),
    h(Card, { title: '相处经验', desc: '她对每个人（和每个群）总结出来的相处之道：概括的、不琐碎的，比如「他累的时候不想多聊」。每次整理记忆时她会回顾一次，越来越懂你。聊天时只带上对当前这个人的那份。' },
      ins === null ? h(Empty, { icon: '⏳', text: '加载中…' }) : ins.length === 0 ? h(Empty, { icon: '🌱', text: '还没有总结出经验。多聊几天，整理记忆时她会慢慢总结。' }) :
        ins.map((p) => h(InsightCard, { key: p.key, p, toast, onSaved: loadIns, style: styles[p.key] || [] }))),
    h(Card, { title: '说话方式', desc: '聊久了潜移默化学到的：每个人的说话习惯（她会自然地贴近一点），和她自己慢慢养成的说法。不会变成另一个人，只是越来越像「你们的」大肥鱼。' },
      h(StyleEditor, { k: 'self', label: '她自己养成的说法', list: styles.self || [], toast, onSaved: loadIns }),
      Object.keys(styles).filter((k) => k !== 'self').length === 0 ? h('div', { className: 'ab-muted ab-small' }, '还没学到别人的说话习惯。整理记忆时会跟着相处经验一起总结（显示在上面每个人的相处经验下面）。') : null),
    h(Card, { title: '记忆库', right: f.sw('memory.enabled'), desc: '长期记忆：她聊天时自己记的、每天从聊天里整理出来的、写过的空间日记、你手动加的。每一轮回复前，她会按对方正在说的话翻出最相关的几条。' },
      h('div', { className: 'ab-grid ab-g4', style: { marginBottom: 12 } },
        h('div', { className: 'ab-card ab-stat' }, h('div', { className: 'n' }, stats ? stats.count : '–'), h('div', { className: 'l' }, '条长期记忆')),
        h('div', { className: 'ab-card ab-stat' }, h('div', { className: 'n' }, stats ? stats.auto : '–'), h('div', { className: 'l' }, '条来自每日整理' + (stats && stats.outdated ? '（另有 ' + stats.outdated + ' 条已过时）' : ''))),
        h('div', { className: 'ab-card ab-stat' }, h('div', { className: 'n', style: { fontSize: 16, paddingTop: 6 } }, last ? new Date(last.at).toLocaleString() : '还没整理过'), h('div', { className: 'l' }, '上次整理'))),
      health && !health.ok ? h('div', { className: 'ab-note err', role: 'alert' },
        h('b', null, '档案异常，自动整理已暂停。修复文件后点击「重新载入档案」。'),
        health.stateError ? h('div', null, health.stateError) : null,
        (health.brokenScopes || []).map((item) => h('div', { key: item.file }, item.file + '：' + item.error))) : null,
      h(Row, { label: '档案维护', hint: '手动修改 memory.md 后重新载入；在途整理会被取消，损坏档案不会被覆盖。' },
        h(Btn, { small: true, disabled: reloading, onClick: async () => {
          setReloading(true)
          try {
            const r = await post('/memory/reload', {})
            setHealth(r.health || null)
            toast(r.message, r.ok ? 'ok' : 'err')
            await Promise.all([load(), loadIns()])
          } catch (error) { toast(error.message, 'err') } finally { setReloading(false) }
        } }, reloading ? '正在载入…' : '重新载入档案')),
      h(Row, { label: '每天自动整理两次', hint: '把聊天流水提炼成长期记忆、相处经验和说话方式；第二次只处理新增部分。整理不删除共享流水，流水按保留天数另行清理；各会话上下文不受影响' },
        f.sw('memory.dailyConsolidate'), h('span', { className: 'ab-muted' }, '每天'),
        h('input', { className: 'ab-input sm', type: 'time', value: times[0] || '04:00', onChange: (e) => setTime(0, e.target.value) }),
        h('span', { className: 'ab-muted' }, '和'),
        h('input', { className: 'ab-input sm', type: 'time', value: times[1] || '16:00', onChange: (e) => setTime(1, e.target.value) }),
        h(Btn, { small: true, onClick: async () => { toast('正在整理，可能要一两分钟…'); const r = await post('/memory/extract', {}); toast(r.message); load(); loadIns() } }, '现在整理一次')),
      h(Row, { label: '每轮最多想起几条' }, f.range('memory.recallCount', 0, 12, 1, (v) => v + ' 条')),
      h(OwnerMigrate, { toast, onChanged: () => load() }),
      h('div', { className: 'ab-section-title' }, '手动加一条'),
      h('div', { className: 'ab-flex' },
        h('input', { className: 'ab-input', style: { flex: '2 1 260px' }, placeholder: '要她记住的事，例如：主人不吃香菜', value: adding.text, onChange: (e) => setAdding({ ...adding, text: e.target.value }) }),
        h('input', { className: 'ab-input', style: { flex: '1 1 120px' }, placeholder: '关于谁（可选）', value: adding.aboutName, onChange: (e) => setAdding({ ...adding, aboutName: e.target.value }) }),
        h(Select, { value: adding.importance, width: 120, onChange: (v) => setAdding({ ...adding, importance: v }), options: [{ value: 0.3, label: '随口一提' }, { value: 0.6, label: '比较重要' }, { value: 0.9, label: '非常重要' }] }),
        h(Btn, { small: true, kind: 'primary', disabled: !adding.text.trim(), onClick: async () => { const r = await post('/memory/add', adding); toast(r.ok ? '记住了' : r.message); setAdding({ text: '', aboutName: '', importance: 0.6 }); load() } }, '记住')),
      h('div', { className: 'ab-flex', style: { marginTop: 10, cursor: 'pointer' }, onClick: () => setBrowseOpen(!browseOpen) },
        h('div', { className: 'ab-section-title', style: { margin: 0 } }, (browseOpen ? '▾' : '▸') + ' 翻一翻'),
        h('span', { className: 'ab-muted ab-small' }, mem ? mem.length + ' 条记忆' : '')),
      browseOpen && h('input', { className: 'ab-input wide', placeholder: '搜索记忆，例如：白米饭、游戏、约定…', value: q, onChange: (e) => setQ(e.target.value) }),
      !browseOpen ? null : mem === null ? h(Empty, { icon: '⏳', text: '加载中…' }) : mem.length === 0 ? h(Empty, { icon: '🫧', text: q ? '没找到相关的记忆' : '还没有记住什么。' }) :
        h('div', null,
          h('div', { className: 'ab-flex', style: { marginBottom: 6 } },
            h('span', { className: 'ab-muted ab-small' }, mem.length + ' 条' + (mem.length >= 300 ? '（只显示最近 300 条，可搜索）' : ''))),
          // 收纳但不折叠：按时间分段小标题（今天/昨天/近几天/本周/本月/更早），每条照样全文平铺
          (() => {
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
            return h('div', { className: 'ab-list', style: { marginTop: 8 } },
              order.filter((k) => groups.has(k)).flatMap((k) => [
                h('div', { key: 's:' + k, className: 'ab-section-title', style: { margin: '10px 0 4px' } }, k, h('span', { className: 'ab-muted ab-small', style: { marginLeft: 6 } }, groups.get(k).length + ' 条')),
                ...groups.get(k).map((m) => h(MemoryRow, { key: m.id, m, onChanged: () => load(), toast })),
              ]))
          })())),
    h(RecallLog, null),
    h(MemoryImport, { toast, onDone: () => load() }),
  )
}

/** 人物小档案：她对每个人的一小段印象，聊天时常驻；整理记忆时按新记忆重写，也可以手改。 */
function ProfilesCard({ toast }) {
  const [list, setList] = useState(null)
  const load = () => get('/profiles').then((r) => setList(r.list || []))
  useEffect(() => { load() }, [])
  return h(Card, { title: '人物小档案', desc: '她对每个人的印象：是谁、什么关系、喜好、最近在忙什么。和谁聊天就带上谁的那份（群里带上正在说话的几个人），不用等对方提到关键词她才想起来。每次整理记忆时，记忆有变化的人会按新记忆重写；你也可以直接改。' },
    list === null ? h(Empty, { icon: '⏳', text: '加载中…' }) : list.length === 0 ? h(Empty, { icon: '🌱', text: '还没有。关于一个人记住 3 条以上的事后，整理记忆时会写出来。' }) :
      h('div', { className: 'ab-list' }, list.map((p) => h(ProfileRow, { key: p.key || `${p.qq}@${p.scope}`, p, toast, onChanged: load }))))
}

function ProfileRow({ p, toast, onChanged }) {
  const [text, setText] = useState(p.text)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => { setText(p.text) }, [p.text])
  // 档案按「QQ+作用域」存，同一 QQ 可能有多份；删哪份必须带上 scope，
  // 只传 qq 会把 global 那份误删（profiles/save 走的就是这个键）。
  const del = async () => { const r = await post('/profiles/delete', { qq: p.qq, scope: p.scope }); toast(r.message, r.ok ? 'ok' : 'err'); onChanged() }
  return h('div', { className: 'ab-li', style: { alignItems: 'flex-start' } },
    h('div', { className: 'meta' }, h('b', null, p.name || p.qq), h('br'), h('span', { className: 'ab-small' }, p.qq), h('br'),
      h('span', { className: 'ab-pill', style: { padding: '0 6px', fontSize: 11, background: p.scope === 'global' ? 'var(--ab-sea, #35506b)' : 'rgba(0,0,0,.18)' } },
        p.scope === 'global' ? '通用' : p.scope.startsWith('group:') ? '群 ' + p.scope.slice(6) : '私聊'),
      h('br'), h('span', { className: 'ab-small' }, timeAgo(p.at))),
    h('textarea', { className: 'ab-input wide', rows: 3, value: text, onChange: (e) => setText(e.target.value), style: { flex: 1 } }),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      h(Btn, { small: true, kind: 'primary', disabled: text === p.text, onClick: async () => { const r = await post('/profiles/save', { qq: p.qq, text, scope: p.scope }); toast(r.message, 'ok'); onChanged() } }, '保存'),
      h(Btn, { small: true, kind: 'ghost', disabled: busy, onClick: async () => { setBusy(true); const r = await post('/profiles/rebuild', { qq: p.qq, scope: p.scope }); setBusy(false); toast(r.message, r.ok ? 'ok' : 'err'); onChanged() } }, busy ? '重写中…' : '按记忆重写'),
      confirming
        ? h(Btn, { small: true, kind: 'ghost', onClick: () => { setConfirming(false); del() } }, '确认删除')
        : h(Btn, { small: true, kind: 'ghost', onClick: () => setConfirming(true) }, '删除')))
}

/** 最近几轮她想起了什么、因为哪些词想起来的。 */
function RecallLog() {
  const [list, setList] = useState(null)
  const load = () => get('/memory/recalls').then((r) => setList(r.list || []))
  useEffect(() => { load() }, [])
  return h(Card, { title: '最近想起了什么', desc: '每次回复前她会按对方说的话翻记忆。这里能看到最近几次想起了哪几条、是因为哪几个词想起来的；想不起来的那次也会列出来。', right: h(Btn, { small: true, kind: 'ghost', onClick: load }, '刷新') },
    !list ? h(Empty, { icon: '⏳', text: '加载中…' }) : list.length === 0 ? h(Empty, { icon: '🫧', text: '还没有记录（重启后从头记）。' }) :
      h('div', { className: 'ab-list' }, list.slice(0, 10).map((r, i) => h('div', { key: i, className: 'ab-li' },
        h('div', { className: 'meta' }, timeAgo(r.at), h('br'), h('span', { className: 'ab-small' }, String(r.where || '').replace(/^private:/, '私聊 ').replace(/^group:/, '群 '))),
        h('div', { className: 'body' },
          h('div', { className: 'ab-muted ab-small' }, '「' + r.query.slice(0, 60) + (r.query.length > 60 ? '…' : '') + '」'),
          r.hits.length ? r.hits.map((x) => h('div', { key: x.id, style: { marginTop: 3 } }, '· ' + x.text, h('span', { className: 'ab-muted ab-small' }, '  ← ' + (x.why.join('、') || '—') + ' · ' + x.score))) : h('div', { className: 'ab-muted', style: { marginTop: 3 } }, '这次什么都没想起来'))))))
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
  return h('div', null,
    h('div', { className: 'ab-section-title' }, '主人换号迁移'),
    h('div', { className: 'ab-flex', style: { alignItems: 'center' } },
      h('input', { className: 'ab-input sm', placeholder: '旧 QQ 号', value: from, onChange: (e) => setFrom(e.target.value) }),
      h('span', { className: 'ab-muted' }, '→'),
      h('input', { className: 'ab-input sm', placeholder: '新 QQ 号', value: to, onChange: (e) => setTo(e.target.value) }),
      h(Btn, { small: true, disabled: !from || !to, onClick: doMove }, '迁移记忆')),
    h('div', { className: 'ab-muted ab-small', style: { marginTop: 4 } }, '换了 QQ 号用这个：旧号私聊里的记忆（包括记在你名下的小档案）会整体搬到新号，一次就好。'))
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
  return h(Card, { title: '导入旧档案', desc: '以前写过的设定、聊天笔记、别的机器人的记忆文件（txt / md），贴进来或者上传。她会挑出值得记的，你勾选以后再存进记忆库；和已有记忆重复的会自动去掉。' },
    h('textarea', { className: 'ab-textarea', style: { minHeight: 110 }, placeholder: '把旧档案的文字粘贴到这里（最多 3 万字）', value: text, onChange: (e) => setText(e.target.value) }),
    h('div', { className: 'ab-flex', style: { marginTop: 8 } },
      h(Btn, { small: true, onClick: readFile }, '选择文件'),
      h(Btn, { small: true, kind: 'primary', disabled: busy || !text.trim(), onClick: scan }, busy ? h(Fragment, null, h('i', { className: 'ab-spin' }), ' 正在挑…') : '挑出值得记的'),
      h('span', { className: 'ab-muted ab-small' }, text ? text.length + ' 字' : '')),
    cands ? (cands.length === 0 ? h('div', { className: 'ab-muted', style: { marginTop: 10 } }, '没挑出新的可记的东西（或者都已经记过了）。') :
      h('div', { style: { marginTop: 10 } },
        h('div', { className: 'ab-list' }, cands.map((c, i) => h('label', { key: i, className: 'ab-li', style: { cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: !!pick[i], onChange: (e) => setPick({ ...pick, [i]: e.target.checked }), style: { accentColor: 'var(--ab-sea)', marginTop: 3 } }),
          h('div', { className: 'body' }, c.aboutName ? h('b', null, '[' + c.aboutName + '] ') : null, c.text, c.importance >= 0.8 ? ' ★' : '')))),
        h('div', { className: 'ab-flex', style: { marginTop: 8 } },
          h('label', { className: 'ab-small', style: { cursor: 'pointer' } },
            h('input', { type: 'radio', checked: scope === 'private', onChange: () => setScope('private'), style: { accentColor: 'var(--ab-sea)' } }),
            ' 只在她的私聊里想起（默认）'),
          h('label', { className: 'ab-small', style: { cursor: 'pointer', marginLeft: 12 } },
            h('input', { type: 'radio', checked: scope === 'global', onChange: () => setScope('global'), style: { accentColor: 'var(--ab-sea)' } }),
            ' 所有聊天都能想起（她自己的设定选这个）')),
        h('div', { className: 'ab-flex', style: { marginTop: 8 } },
          h(Btn, { small: true, kind: 'primary', onClick: commit, disabled: !Object.values(pick).some(Boolean) }, '存进记忆库（' + Object.values(pick).filter(Boolean).length + ' 条）'),
          h(Btn, { small: true, kind: 'ghost', onClick: () => setCands(null) }, '取消')))) : null)
}

function StyleEditor({ k, label, list, toast, onSaved }) {
  const [text, setText] = useState(list.join('\n'))
  useEffect(() => setText(list.join('\n')), [list.join('\n')])
  const changed = text !== list.join('\n')
  return h('div', { style: { marginTop: 8 } },
    h('div', { className: 'ab-flex', style: { marginBottom: 4 } }, h('span', { className: 'ab-small', style: { color: 'var(--ab-sub)' } }, label), h('div', { className: 'ab-spacer' }),
      changed ? h(Btn, { small: true, kind: 'primary', onClick: async () => { const r = await post('/style/save', { key: k, list: text.split('\n') }); toast(r.message, 'ok'); onSaved() } }, '保存') : null),
    h('textarea', { className: 'ab-textarea', style: { minHeight: 50, fontFamily: 'inherit' }, value: text, onChange: (e) => setText(e.target.value), placeholder: '一行一条，例如：消息很短，常一句话分几条发' }))
}

function InsightCard({ p, toast, onSaved, style }) {
  const [text, setText] = useState(p.list.map((x) => x.text).join('\n'))
  const changed = text !== p.list.map((x) => x.text).join('\n')
  const who = p.key.startsWith('group:') ? '群 ' + p.key.slice(6) : (p.name ? p.name + '（' + p.key.slice(3) + '）' : p.key.slice(3))
  // 单条删除：textarea 是「一行一条」，按行号找到对应条目的 id 再删
  const delOne = async (lineIdx) => {
    const item = p.list[lineIdx]
    if (!item) return
    const r = await post('/insights/delete', { key: p.key, id: item.id })
    toast(r.message, r.ok ? 'ok' : 'err')
    onSaved()
  }
  return h('div', { style: { marginBottom: 12 } },
    h('div', { className: 'ab-flex', style: { marginBottom: 6 } }, h('b', null, who), h('span', { className: 'ab-muted ab-small' }, p.list.length + ' 条'), h('div', { className: 'ab-spacer' }),
      changed ? h(Btn, { small: true, kind: 'primary', onClick: async () => { const r = await post('/insights/save', { key: p.key, list: text.split('\n') }); toast(r.message, 'ok'); onSaved() } }, '保存') : null),
    p.list.length ? h('div', { className: 'ab-list', style: { marginBottom: 6 } }, p.list.map((x, i) => h('div', { key: x.id || i, className: 'ab-li', style: { padding: '4px 0' } },
      h('div', { className: 'body ab-small' }, x.text),
      h(Btn, { small: true, kind: 'ghost', onClick: () => { if (window.confirm('删掉这条相处经验？\n\n' + x.text.slice(0, 60))) delOne(i) } }, '删')))) : null,
    h('textarea', { className: 'ab-textarea', style: { minHeight: 70, fontFamily: 'inherit' }, value: text, onChange: (e) => setText(e.target.value), placeholder: '一行一条经验' }),
    h(StyleEditor, { k: p.key, label: '说话方式', list: style || [], toast, onSaved }))
}


function MemoryRow({ m, onChanged, toast }) {
  const [edit, setEdit] = useState(false)
  const [text, setText] = useState(m.text)
  if (m.invalidAt) {
    return h('div', { className: 'ab-li', style: { opacity: 0.6 } },
      h('div', { className: 'meta' }, timeAgo(m.invalidAt), h('br'), h('span', { className: 'ab-pill', style: { padding: '0 6px', fontSize: 11 } }, '已过时')),
      h('div', { className: 'body' }, h('s', null, (m.aboutName ? '[' + m.aboutName + '] ' : '') + m.text), m.supersededText ? h('div', { className: 'ab-muted ab-small' }, '→ 现在是：' + m.supersededText) : null),
      h(Btn, { small: true, kind: 'ghost', onClick: async () => { await post('/memory/restore', { id: m.id }); toast('恢复了', 'ok'); onChanged() } }, '恢复'),
      h(Btn, { small: true, kind: 'ghost', onClick: async () => { await post('/memory/delete', { id: m.id }); onChanged() } }, '删掉'))
  }
  return h('div', { className: 'ab-li' },
    h('div', { className: 'meta' }, timeAgo(m.at), h('br'), h('span', { className: 'ab-pill', style: { padding: '0 6px', fontSize: 11 } }, SOURCE[m.source] || '记忆')),
    edit ? h('input', { className: 'ab-input wide', value: text, onChange: (e) => setText(e.target.value), onKeyDown: async (e) => { if (e.key === 'Enter') { await post('/memory/update', { id: m.id, text }); setEdit(false); toast('改好了', 'ok'); onChanged() } if (e.key === 'Escape') setEdit(false) } })
      : h('div', { className: 'body' }, m.aboutName ? h('b', null, '[' + m.aboutName + '] ') : null, m.text, m.importance >= 0.8 ? h('span', { title: '很重要' }, ' ★') : null),
    h(Btn, { small: true, kind: 'ghost', onClick: () => setEdit(!edit) }, edit ? '取消' : '改一下'),
    h(Btn, { small: true, kind: 'ghost', onClick: async () => { await post('/memory/delete', { id: m.id }); onChanged() } }, '忘掉'))
}

/** 导入音色：把 .zip / .pth / .index 拖进来或点选，自动识别；下面列出已有的音色，可以删。 */

export {
  Mood, ProfilesCard, ProfileRow, RecallLog, OwnerMigrate, MemoryImport,
  StyleEditor, InsightCard, MemoryRow, SOURCE
}
