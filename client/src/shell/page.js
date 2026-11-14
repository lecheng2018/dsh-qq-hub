import { useState, useEffect, useRef, useCallback, useMemo, h } from '../core/react.js'
import { clone, setPath, getPath, cx } from '../core/utils.js'

import { useStyle } from '../styles/use-style.js'
import { Switch, Btn, Empty, TabBoundary } from '../ui/primitives.js'
import { NavBar } from './nav-bar.js'
import { navIcon } from '../ui/icons.js'

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
  const [navOpen, setNavOpen] = useState(false)
  const toastTimer = useRef(null)
  const menuRef = useRef(null)
  const dirtyRef = useRef(false)
  const saveRef = useRef(null)
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
  const go = (id) => {
    setTab(id)
    setNavOpen(false)
    try {
      localStorage.setItem('qq-hub.tab', id)
      const recent = [id, ...JSON.parse(localStorage.getItem('qq-hub.recentTabs') || '[]').filter((x) => x !== id)].slice(0, 3)
      localStorage.setItem('qq-hub.recentTabs', JSON.stringify(recent))
    } catch (e) {}
  }
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
  const quickToggle = async (path, v) => {
    await save(setPath(dirtyRef.current ? draft : clone(st.config), path, v))
  }
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
    return h('div', { className: 'ab-root' }, h('div', { className: 'ab-wrap' }, err ? h('div', { className: 'ab-note err' }, '面板读不到插件：', err, '。如果刚装好插件，重启一次 DSH 试试。') : h(Empty, { icon: '🐋', text: '正在读取 QQ Hub…' })))
  }
  const cfg = st.config
  const conn = st.onebot.state === 'connected'
  const status = !cfg.enabled ? { cls: '', text: '已停用' } : !conn ? { cls: 'err', text: 'QQ 未连接' } : cfg.dryRun ? { cls: 'warn', text: '试运行' } : { cls: 'ok', text: '运行中' }
  const persona = st.personas.find((p) => p.id === cfg.persona.current)
  const props = { st, draft, setDraft: setD, toast, reload, go, openWizard: () => setWizardOpen(true) }
  const showWizard = !cfg.setupDone || wizardOpen
  const mods = st.modules || []
  const running = (id) => { const m = mods.find((x) => x.id === id); return Boolean(m && m.running) }
  const hasUi = (m) => Boolean(m.running) && ((m.settings || []).length > 0 || m.panel)
  const TAB_ALIAS = { mood: 'memory' }
  const tabOf = (m) => TAB_ALIAS[m.tab] || m.tab
  const intoTab = (m) => Boolean(m.tab && TABS.some((t) => t.id === tabOf(m)))
  const extTabs = mods.filter((m) => hasUi(m) && !intoTab(m)).map((m) => ({ id: 'ext:' + m.id, label: m.name, ext: m.id }))
  const tabs = TABS.filter((t) => !TAB_MODS[t.id] || TAB_MODS[t.id].some(running))
  tabs.splice(tabs.findIndex((t) => t.id === 'logs'), 0, ...extTabs)
  const curTab = tabs.find((t) => t.id === tab) || tabs[0]
  const body = curTab.ext ? ExtPage : {
    overview: Overview, connect: Connect, persona: Persona, access: Access, group: Group, model: Model, voice: Voice,
    stickers: Stickers, imagegen: ImageGen, diary: Diary, speakup: SpeakUp, memory: Mood, bili: Bili, douyin: Douyin, heybox: Heybox, multiParser: MultiParser, local: LocalApi, modules: Modules, logs: Logs,
  }[curTab.id] || Overview
  const tabDirty = (id) => {
    if (!dirty) return false
    if (id.startsWith('ext:')) { const k = id.slice(4); return JSON.stringify((draft.ext || {})[k]) !== JSON.stringify((cfg.ext || {})[k]) }
    return (TAB_KEYS[id] || []).some((k) => JSON.stringify(draft[k]) !== JSON.stringify(cfg[k]))
  }
  return h('div', { className: cx('ab-root', dirty && 'has-dirty') },
    h('div', { className: 'ab-shell' },
      h('header', { className: 'ab-appbar' },
        h('div', { className: 'ab-appbar-main' },
          !showWizard ? h('button', { ref: menuRef, type: 'button', className: 'ab-menu-btn', 'aria-label': '打开功能菜单', 'aria-expanded': navOpen, onClick: () => setNavOpen(true) }, navIcon('M4 7h16M4 12h16M4 17h16')) : null,
          h('button', { type: 'button', className: 'ab-brand-avatar', title: '更换面板头像', onClick: () => pickAvatar(toast, reload) }, h('img', { src: avatarSrc(st), alt: '大肥鱼头像' })),
          h('div', { className: 'ab-appbar-title' },
            h('h1', null, showWizard ? 'QQ Hub 初始化' : curTab.label),
            h('div', { className: 'ab-appbar-sub' }, ((st.onebot.login && st.onebot.login.nickname) || '大肥鱼') + ' · ' + (persona ? persona.name : '默认人格')))),
        h('div', { className: 'ab-runtime' },
          h('span', { className: cx('ab-status', status.cls) }, h('i', { className: cx('ab-dot', status.cls) }), status.text),
          h('label', { className: 'ab-quick-toggle' }, h('span', null, '总开关'), h(Switch, { on: cfg.enabled, onChange: (v) => quickToggle('enabled', v), title: '总开关' })),
          h('label', { className: 'ab-quick-toggle secondary' }, h('span', null, '试运行'), h(Switch, { on: cfg.dryRun, onChange: (v) => quickToggle('dryRun', v), title: '试运行：只写日志，不发送到 QQ' })))),
      showWizard ? h('main', { className: 'ab-wizard-main' }, h(Wizard, { st, draft, setDraft: setD, save, toast, reload, onClose: () => setWizardOpen(false) })) : h('div', { className: 'ab-layout' },
        h(NavBar, {
          tabs, cur: curTab, go, dirtyOf: tabDirty, open: navOpen, onClose: () => setNavOpen(false), returnFocusRef: menuRef,
          mark: (t) => {
            if (tabDirty(t.id)) return h('i', { className: 'dirty', title: '有未保存的改动' })
            if (!t.flag) return null
            const flag = t.flag === 'group' ? cfg.allow.groups.length > 0 : getPath(cfg, t.flag)
            return h('i', { className: cx('ab-dot', flag && 'ok'), title: flag ? '已开启' : '已关闭' })
          },
        }),
        h('main', { className: 'ab-main', id: 'qq-hub-main' },
          h(TabBoundary, { key: curTab.id, onHome: () => go('overview') }, h(body, { ...props, mod: curTab.ext })),
          curTab.ext ? null : mods.filter((m) => hasUi(m) && tabOf(m) === curTab.id && m.id !== 'multi-parser').map((m) => h('div', { key: 'embed-' + m.id, className: 'ab-embedded' }, h(ExtPage, { ...props, mod: m.id, embedded: true }))))),
      dirty && !showWizard ? h('div', { className: 'ab-savebar', role: 'region', 'aria-label': '保存设置' },
        h('span', { className: 'msg' }, '有未保存的修改'),
        h('span', { className: 'ab-save-shortcut' }, h('span', { className: 'ab-kbd' }, 'Ctrl'), ' + ', h('span', { className: 'ab-kbd' }, 'S')),
        h(Btn, { kind: 'ghost', onClick: () => setDraft(clone(st.config)) }, '撤销'),
        h(Btn, { kind: 'primary', onClick: () => save() }, '保存设置')) : null,
    ),
    toastMsg ? h('div', { className: cx('ab-toast', toastMsg.kind), role: 'status' }, toastMsg.text) : null,
  )
}

export { QQHubPage }
