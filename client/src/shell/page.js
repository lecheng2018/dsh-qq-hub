import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { clone, setPath, getPath, cx } from '../core/utils.js'

import { useStyle } from '../styles/use-style.js'
import { WhaleIcon } from '../ui/icons.js'
import { Switch, Btn, Empty, TabBoundary } from '../ui/primitives.js'
import { NavBar } from './nav-bar.js'

import { get, post } from '../core/http.js'
import { pickAvatar, avatarSrc } from '../domain/persona.js'
import { TABS, TAB_MODS, TAB_KEYS } from '../domain/nav.js'

import { Overview } from '../views/overview.js'
import { Connect } from '../views/connect.js'
import { Persona } from '../views/persona.js'
import { Access } from '../views/access.js'
import { Group } from '../views/group.js'
import { Model } from '../views/model.js'
import { Voice } from '../views/voice.js'
import { Stickers } from '../views/stickers.js'
import { Diary } from '../views/diary.js'
import { SpeakUp } from '../views/speakup.js'
import { Mood } from '../views/mood.js'
import { LocalApi, Modules, ExtPage } from '../views/modules.js'
import { Bili } from '../views/platforms/bili.js'
import { Douyin } from '../views/platforms/douyin.js'
import { Heybox } from '../views/platforms/heybox.js'
import { RssPage } from '../views/platforms/rss.js'
import { MultiParser } from '../views/platforms/multiparser.js'
import { ImageGen } from '../views/imagegen.js'
import { Logs } from '../views/logs.js'
import { Wizard } from '../views/wizard.js'

function QQHubPage() {
  useStyle()
  const [st, setSt] = useState(null)
  const [err, setErr] = useState('')
  const [draft, setDraft] = useState(null)
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('qq-hub.tab') || 'overview' } catch (e) { return 'overview' } })
  const [toastMsg, setToastMsg] = useState(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const toastTimer = useRef(null)
  const dirtyRef = useRef(false)
  const saveRef = useRef(null)
  // kind：ok / err / 不填 = 普通
  const toast = (m, kind) => {
    const text = String(m || '')
    const k = kind || (/失败|出错|没成功|不能|读不到|连不上/.test(text) ? 'err' : '')
    setToastMsg({ text, kind: k })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(null), 3200)
  }
  const reload = useCallback(async () => {
    const r = await get('/state')
    if (!r || r.ok === false) { setErr(r && r.message ? r.message : '读不到插件状态'); return }
    setErr('')
    setSt(r)
    if (!dirtyRef.current) setDraft(clone(r.config))
  }, [])
  useEffect(() => { reload(); const t = setInterval(reload, 5000); return () => clearInterval(t) }, [reload])
  const go = (id) => { setTab(id); try { localStorage.setItem('qq-hub.tab', id) } catch (e) {} }
  // 标签多、一屏放不下：滚轮横着滚，选中的标签自动滚进视野
  const tabsRef = useRef(null)
  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    const onWheel = (e) => { if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { el.scrollLeft += e.deltaY; e.preventDefault() } }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })
  useEffect(() => { tabsRef.current?.querySelector('.ab-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [tab])
  const dirty = useMemo(() => !!(st && draft) && JSON.stringify(draft) !== JSON.stringify(st.config), [st, draft])
  dirtyRef.current = dirty
  const setD = (d) => setDraft(d)
  const save = async (override) => {
    const body = override || draft
    const r = await post('/save', body)
    if (r.ok === false) { toast(r.message || '保存失败', 'err'); return false }
    dirtyRef.current = false
    setSt(r)
    setDraft(clone(r.config))
    toast(r.message || '保存好了', 'ok')
    return true
  }
  saveRef.current = save
  // 右上角的开关立刻生效；有没保存的改动时连同改动一起保存，不会把它们冲掉
  const quickToggle = async (path, v) => {
    await save(setPath(dirtyRef.current ? draft : clone(st.config), path, v))
  }
  // Ctrl/⌘ + S 保存
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && dirtyRef.current) {
        e.preventDefault()
        saveRef.current && saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!st || !draft) {
    return h('div', { className: 'ab-root' }, h('div', { className: 'ab-wrap' }, err ? h('div', { className: 'ab-note err' }, '面板读不到插件：', err, '。如果刚装好插件，重启一次 DSH 试试。') : h(Empty, { icon: '🐋', text: '大肥鱼正在游过来…' })))
  }
  const cfg = st.config
  const conn = st.onebot.state === 'connected'
  const status = !cfg.enabled ? { cls: '', text: '休息中（总开关关着）' } : !conn ? { cls: 'err', text: 'QQ 没连上' } : cfg.dryRun ? { cls: 'warn', text: '在线 · 试运行' } : { cls: 'ok', text: '在线' }
  const persona = st.personas.find((p) => p.id === cfg.persona.current)
  const props = { st, draft, setDraft: setD, toast, reload, go, openWizard: () => setWizardOpen(true) }
  const showWizard = !cfg.setupDone || wizardOpen
  // 标签页：内置的按模块在不在跑决定显示；自己写的模块有设置或面板的各占一页
  const mods = st.modules || []
  const running = (id) => { const m = mods.find((x) => x.id === id); return Boolean(m && m.running) }
  // 内置模块也要算「有界面」：它们和用户模块一样有 settings / panel，只是运行时 running 是 'builtin'。
  // 老条件 m.running === 'user' 把内置模块全挡掉了 —— 这正是「五个面板一片空白、配置项一个都不出现」的根因。
  const hasUi = (m) => Boolean(m.running) && ((m.settings || []).length > 0 || m.panel)
  // 写了 tab 的模块嵌进那个内置标签页；没写（或写的页不存在）的单独一页
  // 老扩展若还写着心情页的旧 tab 名，归一成 memory（别名兜底）
  const TAB_ALIAS = { mood: 'memory' }
  const tabOf = (m) => TAB_ALIAS[m.tab] || m.tab
  const intoTab = (m) => Boolean(m.tab && TABS.some((t) => t.id === tabOf(m)))
  const extTabs = mods.filter((m) => hasUi(m) && !intoTab(m)).map((m) => ({ id: 'ext:' + m.id, label: m.name, ext: m.id }))
  const tabs = TABS.filter((t) => !TAB_MODS[t.id] || TAB_MODS[t.id].some(running))
  tabs.splice(tabs.findIndex((t) => t.id === 'logs'), 0, ...extTabs)
  const curTab = tabs.find((t) => t.id === tab) || tabs[0]
  const body = curTab.ext ? ExtPage : {
    overview: Overview, connect: Connect, persona: Persona, access: Access, group: Group, model: Model, voice: Voice,
    stickers: Stickers, imagegen: ImageGen, diary: Diary, speakup: SpeakUp, memory: Mood, bili: Bili, douyin: Douyin, heybox: Heybox, multiParser: MultiParser, rss: RssPage, local: LocalApi, modules: Modules, logs: Logs,
  }[curTab.id] || Overview
  // 哪些标签有没保存的改动
  const TAB_KEYS = { connect: ['snowluma', 'botQQ'], access: ['ownerQQ', 'ownerName', 'ownerLevel', 'longTasks', 'profilePerms', 'allow'], group: ['group', 'merge', 'reply'], model: ['model', 'chatModels'], voice: ['voice'], stickers: ['stickers'], imagegen: ['imageGen'], diary: ['diary', 'qzoneSocial'], speakup: ['speakUp'], memory: ['memory'], bili: ['bili'], douyin: ['douyin'], heybox: ['heybox'], multiParser: ['multiParser'], rss: ['rss'], local: ['local'] }
  const tabDirty = (id) => {
    if (!dirty) return false
    if (id.startsWith('ext:')) { const k = id.slice(4); return JSON.stringify((draft.ext || {})[k]) !== JSON.stringify((cfg.ext || {})[k]) }
    return (TAB_KEYS[id] || []).some((k) => JSON.stringify(draft[k]) !== JSON.stringify(cfg[k]))
  }
  return h('div', { className: 'ab-root' },
    h('div', { className: 'ab-wrap' },
      h('div', { className: 'ab-hero' },
        h('button', { type: 'button', className: 'ab-avatar-btn', title: '点击换头像', onClick: () => pickAvatar(toast, reload) }, h('img', { className: 'ab-avatar', src: avatarSrc(st), alt: '头像' }), h('span', { className: 'ab-avatar-tip' }, '换头像')),
        h('div', { className: 'ab-hero-main' },
          h('h1', null, (st.onebot.login && st.onebot.login.nickname) || '大肥鱼'),
          h('div', { className: 'ab-sub' }, 'QQ ' + cfg.botQQ + ' · ' + (persona ? persona.name : '默认人格')),
          h('div', { className: 'ab-pills' },
            h('span', { className: 'ab-pill' }, h('i', { className: cx('ab-dot', status.cls) }), status.text),
            h('span', { className: 'ab-pill' }, 'SnowLuma ' + (st.snowluma.installed ? (st.snowluma.running ? '运行中' : '没启动') : '未安装')),
            h('span', { className: 'ab-pill' }, 'QQ Hub v' + st.version))),
        h('div', { className: 'ab-hero-side' },
          h('div', { className: 'ab-switch-row' }, h('span', null, '总开关'), h(Switch, { on: cfg.enabled, onChange: (v) => quickToggle('enabled', v) })),
          h('div', { className: 'ab-switch-row' }, h('span', { className: 'ab-muted' }, '试运行'), h(Switch, { on: cfg.dryRun, onChange: (v) => quickToggle('dryRun', v), title: '开着时只写日志，不真的发到 QQ' })))),
      showWizard ? h(Wizard, { st, draft, setDraft: setD, save, toast, reload, onClose: () => setWizardOpen(false) }) : null,
      showWizard ? null : h(NavBar, {
        tabs, cur: curTab, go, dirtyOf: tabDirty, subRef: tabsRef,
        mark: (t) => {
          if (tabDirty(t.id)) return h('i', { className: 'dirty', title: '有没保存的改动' })
          if (!t.flag) return null
          const flag = t.flag === 'group' ? cfg.allow.groups.length > 0 : getPath(cfg, t.flag)
          return h('i', { className: cx('ab-dot', flag && 'ok'), title: flag ? '开着' : '关着' })
        },
      }),
      showWizard ? null : h(TabBoundary, { key: curTab.id, onHome: () => go('overview') }, h(body, { ...props, mod: curTab.ext })),
      showWizard || curTab.ext ? null : mods.filter((m) => hasUi(m) && tabOf(m) === curTab.id && m.id !== 'multi-parser').map((m) => h('div', { key: 'embed-' + m.id, style: { marginTop: 14 } }, h(ExtPage, { ...props, mod: m.id, embedded: true }))),
      dirty && !showWizard ? h('div', { className: 'ab-savebar' }, h('span', { className: 'msg' }, '有改动还没保存'),
        h('span', { className: 'ab-muted ab-small' }, h('span', { className: 'ab-kbd' }, 'Ctrl'), ' + ', h('span', { className: 'ab-kbd' }, 'S')),
        h(Btn, { kind: 'ghost', onClick: () => setDraft(clone(st.config)) }, '撤销'),
        h(Btn, { kind: 'primary', onClick: () => save() }, '保存设置')) : null,
    ),
    toastMsg ? h('div', { className: cx('ab-toast', toastMsg.kind), role: 'status' }, toastMsg.text) : null,
  )
}


export { QQHubPage }
