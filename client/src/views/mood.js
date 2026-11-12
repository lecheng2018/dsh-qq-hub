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
  // 蒸馏用模型选择器（1.3.66）：蒸馏要纯 JSON 输出，思考型模型容易写成报告正文。
  // 选项来自 /models（和模型页同一份清单），空值 = 跟随主模型。
  const [modelList, setModelList] = useState(null)
  const modelKey = (m) => m.provider + '::' + m.model
  const distillModelValue = () => {
    const dm = (draft.memory && draft.memory.distillModel) || {}
    return dm.provider && dm.model ? dm.provider + '::' + dm.model : ''
  }
  const distillModelOptions = () => {
    const base = [{ value: '', label: '跟随主模型', desc: '上面「聊天用的模型」' }]
    const nameCount = {}
    for (const m of (modelList || [])) nameCount[m.name] = (nameCount[m.name] || 0) + 1
    const opts = base.concat((modelList || []).map((m) => ({
      value: modelKey(m),
      label: nameCount[m.name] > 1 ? m.name + '（' + m.model + '）' : m.name,
      desc: m.provider,
      group: m.provider,
    })))
    const cur = distillModelValue()
    return cur && !opts.some((o) => o.value === cur)
      ? opts.concat([{ value: cur, label: cur.split('::').slice(1).join('::'), desc: '（DSH 里没找到）' }])
      : opts
  }
  const memOn = modOn(st, 'memory')
  useEffect(() => { if (memOn) { load(''); loadIns() } }, [memOn])
  useEffect(() => { if (!memOn) return; get('/models').then((r) => setModelList(r.list || [])).catch(() => setModelList([])) }, [memOn])
  useEffect(() => { if (!memOn) return; const t = setTimeout(() => load(q), 250); return () => clearTimeout(t) }, [q])
  const last = st.memory && st.memory.lastConsolidate
  const moodCard = !modOn(st, 'mood') ? h(ModOff, { name: '心情' }) : h(Card, { title: '心情', right: f.sw('mood.enabled'), desc: '被夸、被哄、被凶都会影响她的心情（对她说的话、主人的话影响更大），过一阵子慢慢回到平常。心情好时她话多、更爱发表情和语音、回得快、群里更爱插话；心情差时话少、回得慢、少发表情，还会带点小脾气。' },
      h('div', { className: 'ab-flex', style: { marginBottom: 8 } }, h('b', null, st.mood.label), h('span', { className: 'ab-muted' }, st.mood.value + ' / 100'), st.mood.reason ? h('span', { className: 'ab-muted ab-small' }, '· 因为' + st.mood.reason) : null),
      h('div', { className: 'ab-mood' }, h('i', { style: { width: Math.max(4, st.mood.value) + '%' } })),
      h('div', { style: { marginTop: 10 } },
        h(Row, { label: '多久回到平常', hint: '半衰期' }, f.range('mood.halfLifeHours', 0.5, 24, 0.5, (v) => v + ' 小时')),
        h(Row, { label: '用模型判断心情', hint: '每轮聊完用模型判一次（能分清开玩笑和真骂、她主动找你时的心意），更准；每轮多一次很短的模型调用。关着就按关键词' }, f.sw('mood.judge'))),
      (st.mood.history || []).length ? h('div', { className: 'ab-list', style: { marginTop: 8 } }, st.mood.history.slice(0, 6).map((x, i) => h('div', { key: i, className: 'ab-li' },
        h('div', { className: 'meta' }, timeAgo(x.at)),
        h('div', { className: 'body' }, (x.to >= x.from ? '↑ ' : '↓ ') + x.from + ' → ' + x.to, h('span', { className: 'ab-muted ab-small' }, '  ' + x.reason))))) : null,
    )
  if (!memOn) return h('div', { className: 'ab-grid' }, moodCard, h(ModOff, { name: '记忆' }))
  return h('div', { className: 'ab-grid' },
    moodCard,
    h(ProfilesCard, { toast }),
    h(Card, { title: '相处经验', desc: '她对每个人（和每个群）总结出来的相处之道：概括的、不琐碎的，比如「他累的时候不想多聊」。每次整理记忆时她会回顾一次，越来越懂你。聊天时只带上对当前这个人的那份。' },
      ins === null ? h(Empty, { icon: '⏳', text: '加载中…' }) : ins.length === 0 ? h(Empty, { icon: '🌱', text: '还没有总结出经验。多聊几天，整理记忆时她会慢慢总结。' }) :
        ins.map((p) => h(InsightCard, { key: p.key, p, toast, onSaved: loadIns, style: styles[p.key] || [] }))),
    h(Card, { title: '蒸馏群友（学一个人的说话样子）', desc: '指定某个群里的某一个人当数据源，学他的说话方式、性格、语气。加完可以点「从历史学」立刻从他**过去说过的话**里提炼（DSH 会话记录里存着群友原话，比聊天流水留得久），不用干等他再聊；以后每次整理记忆也会拿他最近的原话更新画像。**学成后自动生成一张该群专属的「语感人设卡」**＝她原来的人设底卡 + 借来的说话方式段（人设页可见；你的底卡一个字不动，那群你手动指定过别人设卡的话蒸馏不抢槽位）。借的是说话方式，不冒充人；他近期原话不足 15 句就不学。' },
      h(DistillPanel, { toast, onChanged: () => { load() } }),
      h(Row, { label: '蒸馏用模型', hint: '留空跟随主模型。蒸馏要输出结构化 JSON：思考型模型（思考关不掉的那种）会把额度花在分析正文上，回包变成 Markdown 报告。主模型是这类、又老是学到空画像时，在这儿换一个非思考的模型。' },
        h(Select, { value: distillModelValue(), width: 260, options: distillModelOptions(), onChange: (v) => {
          const [p, ...m] = v.split('::')
          setDraft(setPath(draft, 'memory.distillModel', v ? { provider: p, model: m.join('::') } : { provider: '', model: '' }))
        } }))),
    h(Card, { title: '群黑话本（学一个群在用什么词）', right: f.sw('memory.slang'), desc: '和上面不同：这个学的是**词**，不是人。从每个群的聊天里找这个群在用的黑话、梗、圈内称呼——词频统计挑候选（不花钱），模型判断哪些真是黑话、什么意思（每群每天一次调用）。她和这个群聊天时会看到黑话本，听懂了就用，不会硬套。' },
      (st.config.memory || {}).slang !== true ? h('div', { className: 'ab-muted ab-small' }, '开关关着：现在只统计、不判断也不写库。打开后下次整理记忆时开始学。') : null,
      h(SlangBook, { toast, onChanged: () => { load() } })),
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

/** 群黑话本（1.3.58）：每个群一份，和相处经验分开存、分开管。
 *  一行一条「词＝意思」，可直接改、直接删；整理时自动学到的也落在这里。 */
function SlangBook({ toast, onChanged }) {
  const [groups, setGroups] = useState(null)   // 全部群（含没学到词的）
  const [err, setErr] = useState('')           // 接口失败的原因（空态文案要分清是谁的锅）
  const [sel, setSel] = useState('')           // 当前选中的群号
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState({})   // gid → 编辑中的文本
  const load = () => get('/slang').then((r) => {
    setErr('')
    setGroups(r.groups || [])
    setSel((cur) => cur || (r.groups || []).find((g) => g.list.length)?.gid || (r.groups || [])[0]?.gid || '')
  }).catch((e) => { setErr(e.message || String(e)); setGroups([]) })
  useEffect(() => { load() }, [])
  const cur = (groups || []).find((g) => String(g.gid) === String(sel))
  const label = (g) => (g.name ? g.name + '（' + g.gid + '）' : '群 ' + g.gid)
  const textOf = (gid, list) => editing[gid] !== undefined ? editing[gid] : list.map((x) => x.word + '＝' + x.meaning).join('\n')
  const saveOne = async (gid, list) => {
    setBusy('save')
    try {
      const r = await post('/slang/save', { gid, text: textOf(gid, list) })
      toast(r.message || '保存好了', r.ok ? 'ok' : 'err')
      setEditing({ ...editing, [gid]: undefined })
      await load(); onChanged && onChanged()
    } finally { setBusy('') }
  }
  const delOne = async (gid, item) => {
    if (!window.confirm('删掉这条黑话？\n\n' + item.word + '＝' + item.meaning)) return
    setBusy('del')
    try {
      const r = await post('/slang/delete', { gid, id: item.id })
      toast(r.message || '删掉了', r.ok ? 'ok' : 'err')
      await load(); onChanged && onChanged()
    } finally { setBusy('') }
  }
  if (groups === null) return h('div', { className: 'ab-muted ab-small' }, '黑话本读着呢…')
  if (err) return h('div', { className: 'ab-note err' }, '黑话本读不到：' + err + '。多半是插件代码刚更新但还没重启——重启 dsh web 后强刷本页。')
  if (!groups.length) return h('div', { className: 'ab-muted ab-small' }, '群白名单是空的，先在「权限」页加群。')
  return h('div', null,
    // 群选择器：白名单 + 已学过词的群（去重）
    h(Row, { label: '选群' },
      h('select', { className: 'ab-input', style: { maxWidth: 260 }, value: sel, onChange: (e) => setSel(e.target.value) },
        groups.map((g) => h('option', { key: g.gid, value: g.gid }, label(g) + (g.list.length ? '（' + g.list.length + ' 词）' : '（还没学词）'))))),
    !cur ? null : h('div', { style: { marginTop: 4 } },
      cur.list.length
        ? h('div', { className: 'ab-list', style: { marginBottom: 6 } }, cur.list.map((x) => h('div', { key: x.id, className: 'ab-li', style: { padding: '3px 0' } },
            h('div', { className: 'body ab-small' }, h('b', null, x.word), ' ＝ ', x.meaning),
            h(Btn, { small: true, kind: 'ghost', disabled: busy === 'del', onClick: () => delOne(cur.gid, x) }, '删'))))
        : h('div', { className: 'ab-muted ab-small', style: { marginBottom: 6 } }, '这个群还没学到词。打开开关后聊几天，整理时她会挑；也可以直接在下面手填。'),
      h('div', { className: 'ab-flex', style: { alignItems: 'flex-start', gap: 8 } },
        h('textarea', {
          className: 'ab-textarea', style: { minHeight: 56, fontFamily: 'inherit', flex: 1 },
          value: textOf(cur.gid, cur.list),
          placeholder: '一行一个词，写成「词＝意思」，例如：面包片＝新出的平民配装',
          onChange: (e) => setEditing({ ...editing, [cur.gid]: e.target.value }),
        }),
        h(Btn, { small: true, kind: 'primary', disabled: busy === 'save', onClick: () => saveOne(cur.gid, cur.list) }, busy === 'save' ? '…' : '保存'))))
}

/** 蒸馏群友（1.3.59）：指定某个群的某个人当数据源，学他的说话方式/性格/语气。
 *  和「群黑话本」不同——那个学词，这个学人。 */
function DistillPanel({ toast, onChanged }) {
  const [list, setList] = useState(null)
  const [busy, setBusy] = useState('')
  const [form, setForm] = useState({ gid: '', uid: '', name: '' })
  const [hist, setHist] = useState(null)   // 会话历史扫描结果
  const [histErr, setHistErr] = useState('')
  const load = () => get('/distill/list').then((r) => setList(r.list || [])).catch(() => setList([]))
  useEffect(() => { load() }, [])
  const add = async () => {
    setBusy('add')
    try {
      const r = await post('/distill/add', form)
      toast(r.message || '加上了', r.ok ? 'ok' : 'err')
      if (r.ok) { setForm({ gid: '', uid: '', name: '' }); await load(); onChanged && onChanged() }
    } finally { setBusy('') }
  }
  const scanHist = async () => {
    setBusy('scan')
    try {
      const r = await get('/distill/history' + (form.gid ? '?group=' : ''))
      setHistErr(r.ok === false ? (r.message || '读不到') : '')
      setHist(r.ok === false ? null : r)
    } catch (e) { setHistErr(e.message || String(e)); setHist(null) } finally { setBusy('') }
  }
  const learnHist = async (t) => {
    setBusy('hist:' + t.gid + t.uid)
    try {
      const r = await post('/distill/from-history', { gid: t.gid, uid: t.uid, name: t.name })
      toast(r.message || '学完了', r.ok ? 'ok' : 'err')
      if (r.ok) { await load(); onChanged && onChanged() }
    } finally { setBusy('') }
  }
  const remove = async (t) => {
    if (!window.confirm('不再学「' + (t.name || t.uid) + '」了？学到的画像也会一起清掉。')) return
    setBusy('rm:' + t.gid + t.uid)
    try {
      const r = await post('/distill/remove', { gid: t.gid, uid: t.uid })
      toast(r.message || '去掉了', r.ok ? 'ok' : 'err')
      await load(); onChanged && onChanged()
    } finally { setBusy('') }
  }
  const line = (label, arr) => (arr && arr.length)
    ? h('div', { style: { marginBottom: 3 } }, h('span', { className: 'ab-muted ab-small' }, label + '：'), h('span', { className: 'ab-small' }, arr.join('；')))
    : null
  // 1.3.63 起画像字段换成 exchanges/syntax/catchphrases/rhetoric/never，
  // 旧渲染只看 style/tone/avoid/samples，导致面板上「只剩性格一行」（1.3.66 修）。
  // 这里新字段优先、旧字段兜底：老存量画像照旧能看，新学的一个都不漏。
  const block = (label, arr) => (arr && arr.length)
    ? h('div', { style: { marginBottom: 4 } },
        h('div', { className: 'ab-muted ab-small', style: { marginBottom: 2 } }, label + '：'),
        ...arr.map((x, i) => h('div', { key: i, className: 'ab-small', style: { whiteSpace: 'pre-wrap', marginLeft: 8 } }, '· ' + x)))
    : null
  // 原话：旧存量在 samples；新画像的逐字原话藏在 exchanges 的「答：」里，取出来顶上，
  // 否则新学成的画像在面板上连一句原话都看不到（1.3.66 修）。用纯字符串切分，不做正则执行。
  const ANSWER_MARK = '答：'
  const rawQuotes = (p) => {
    if (!p) return []
    if (Array.isArray(p.samples) && p.samples.length) return p.samples
    const out = []
    for (const x of p.exchanges || []) {
      const s = String(x || '')
      const at = s.indexOf(ANSWER_MARK)
      if (at < 0) continue
      let q = s.slice(at + ANSWER_MARK.length).trim()
      if (q.length > 1 && q[0] === '“') q = q.slice(1)
      if (q.length && q[q.length - 1] === '”') q = q.slice(0, -1)
      q = q.split(/\s+/).join(' ').trim().slice(0, 80)
      if (q) out.push(q)
    }
    return out.slice(0, 3)
  }
  return h('div', null,
    h('div', { className: 'ab-flex', style: { marginBottom: 8, gap: 6, flexWrap: 'wrap' } },
      h('input', { className: 'ab-input sm', style: { width: 110 }, placeholder: '群号', value: form.gid, onChange: (e) => setForm({ ...form, gid: e.target.value.replace(/\D/g, '') }) }),
      h('input', { className: 'ab-input sm', style: { width: 110 }, placeholder: '他的 QQ 号', value: form.uid, onChange: (e) => setForm({ ...form, uid: e.target.value.replace(/\D/g, '') }) }),
      h('input', { className: 'ab-input sm', style: { width: 110 }, placeholder: '怎么称呼（可选）', value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }) }),
      h(Btn, { small: true, kind: 'primary', disabled: busy === 'add' || !form.gid || !form.uid, onClick: add }, busy === 'add' ? '…' : '开始学'),
      h(Btn, { small: true, kind: 'ghost', disabled: busy === 'card', onClick: async () => {
        setBusy('card')
        try { const r = await post('/distill/card/refresh', { gid: form.gid || (list || [])[0]?.gid }); toast(r.ok ? `已写成群人设卡（${r.cardId}），人设页可查；底卡没动` : (r.message || '没写成'), r.ok ? 'ok' : 'err') } finally { setBusy('') }
      } }, busy === 'card' ? '…' : '写进群人设卡')),
    h('div', { className: 'ab-flex', style: { marginBottom: 8, gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      h(Btn, { small: true, kind: 'ghost', disabled: busy === 'scan', onClick: scanHist }, busy === 'scan' ? '翻着呢…' : '翻一翻聊天历史'),
      hist ? h('span', { className: 'ab-muted ab-small' },
        '历史里 ' + hist.total + ' 条发言' +
        (hist.chatlogDays ? '（' + hist.chatlogDays + ' 天聊天流水 ' + hist.chatlogLines + ' 条 + ' : '（') + hist.sessions + ' 个会话' +
        (hist.from ? '，' + new Date(hist.from).toLocaleDateString() + ' → ' + new Date(hist.to).toLocaleDateString() : '') + '）' +
        (hist.speakers && hist.speakers.length ? '；说得最多的：' + hist.speakers.slice(0, 3).map((x) => (x.name || x.uid) + ' ' + x.count + ' 句').join('、') : '')) : null,
      histErr ? h('span', { className: 'ab-small', style: { color: '#e08a8a' } }, histErr) : null),
    list === null ? h('div', { className: 'ab-muted ab-small' }, '读着呢…')
      : list.length === 0 ? h('div', { className: 'ab-muted ab-small' }, '还没有指定要学的人。填群号和 QQ 号，下次整理记忆时开始学他说话的样子（他当天说得太少就不学）。')
        : list.map((t) => h('div', { key: t.gid + t.uid, className: 'ab-li', style: { padding: '8px 0' } },
            h('div', { className: 'ab-flex', style: { marginBottom: 4 } },
              h('b', { className: 'ab-small' }, t.name || t.uid),
              h('span', { className: 'ab-muted ab-small' }, ' 群 ' + t.gid + ' · QQ ' + t.uid),
              h('div', { className: 'ab-spacer' }),
              h(Btn, { small: true, kind: 'ghost', disabled: busy === 'hist:' + t.gid + t.uid, onClick: () => learnHist(t) },
                busy === 'hist:' + t.gid + t.uid ? '学呢…' : '从历史学'),
              h(Btn, { small: true, kind: 'ghost', disabled: busy === 'rm:' + t.gid + t.uid, onClick: () => remove(t) }, '不学了')),
            t.profile
              ? h('div', null,
                  (t.profile.samples || []).length
                    ? h('div', { style: { marginBottom: 3 } },
                        h('span', { className: 'ab-muted ab-small' }, '他的原话：'),
                        h('span', { className: 'ab-small' }, t.profile.samples.map((x) => '「' + x + '」').join(' ')))
                    : rawQuotes(t.profile).length
                      ? h('div', { style: { marginBottom: 3 } },
                          h('span', { className: 'ab-muted ab-small' }, '他的原话：'),
                          h('span', { className: 'ab-small' }, rawQuotes(t.profile).map((x) => '「' + x + '」').join(' ')))
                      : null,
                  // 新画像（1.3.63+）：最强信号排在前面，顺序与注入/人设卡渲染一致
                  block('他怎么接话', t.profile.exchanges),
                  line('口头禅', t.profile.catchphrases),
                  line('句子架构', t.profile.syntax),
                  line('修辞招式', t.profile.rhetoric),
                  block('性格', t.profile.persona),
                  line('他从不', t.profile.never),
                  // 旧画像兜底（老存量，新学习不再产出）
                  line('说话方式', t.profile.style),
                  line('语气', t.profile.tone),
                  line('他不会', t.profile.avoid),
                  h('div', { className: 'ab-muted ab-small' }, '依据 ' + (t.profile.evidenceCount != null ? t.profile.evidenceCount : (typeof t.profile.samples === 'number' ? t.profile.samples : (t.profile.samples || []).length)) + ' 句原话 · ' + (t.profile.updatedAt ? new Date(t.profile.updatedAt).toLocaleString() : '')))
              : h('div', { className: 'ab-muted ab-small' }, '还没学到。等他这个群聊够一天，整理记忆时会自动学。'))))
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
  StyleEditor, InsightCard, SlangBook, DistillPanel, MemoryRow, SOURCE
}
