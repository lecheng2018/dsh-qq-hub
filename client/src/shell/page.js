import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { clone, setPath, getPath, cx } from '../core/utils.js'

import { useStyle } from '../styles/use-style.js'
import { WhaleIcon, navIcon } from '../ui/icons.js'
import { Switch, Btn, Empty, TabBoundary, Pill } from '../ui/primitives.js'
import { NavBar, SEARCH_ICON } from './nav-bar.js'

import { get, post } from '../core/http.js'
import { pickAvatar, avatarSrc } from '../domain/persona.js'
import { TABS, TAB_MODS, TAB_KEYS } from '../domain/nav.js'

import { Overview } from '../views/overview.js'
import { Connect } from '../views/connect.js'
import { Persona } from '../views/persona.js'
import { Access } from '../views/access.js'
import { Group } from '../views/group.js'
import { Browser } from '../views/browser.js'
import { Model } from '../views/model.js'
import { Token } from '../views/token.js'
import { Voice } from '../views/voice.js'
import { Stickers } from '../views/stickers.js'
import { Diary } from '../views/diary.js'
import { SpeakUp } from '../views/speakup.js'
import { Memory } from '../views/memory.js'
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
  const [find, setFind] = useState(null)
  const rootRef = useRef(null)
  const toastTimer = useRef(null)
  // 配置修订号：save() 自增，轮询回包对不上就丢（防旧轮询把刚保存的配置写回去）
  const revRef = useRef(0)
  // 卸载标志：轮询 / 定时器回调回来时组件可能已经没了，别再 setState
  const aliveRef = useRef(true)
  const dirtyRef = useRef(false)
  const saveRef = useRef(null)
  const stJsonRef = useRef(null)
  // kind：ok / err / 不填 = 普通
  const toast = (m, kind) => {
    const text = String(m || '')
    const k = kind || (/失败|出错|没成功|不能|读不到|连不上/.test(text) ? 'err' : '')
    setToastMsg({ text, kind: k })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(null), 3200)
  }
  const reload = useCallback(async () => {
    // 发出前记下修订号：save() 会把它加一，于是「保存前发出、保存后才回来」的那一包
    // 一定对不上号、直接丢弃。否则 5 秒轮询会用旧配置把刚保存的改动静默覆盖回去。
    const rev = revRef.current
    const r = await get('/state')
    if (!aliveRef.current || rev !== revRef.current) return
    if (!r || r.ok === false) { setErr(r && r.message ? r.message : '读不到插件状态'); return }
    setErr('')
    // 5 秒轮询绝大多数时候内容没变：直接跳过 setSt，省掉一次全页重渲染（点按掉帧的大头之一）。
    // 序列化两次（各 ~20KB）远比重渲染整棵组件树便宜。
    const json = JSON.stringify(r)
    if (stJsonRef.current === json) return
    stJsonRef.current = json
    setSt(r)
    if (!dirtyRef.current) setDraft(clone(r.config))
  }, [])
  useEffect(() => {
    aliveRef.current = true
    reload()
    const t = setInterval(reload, 5000)
    return () => {
      // 卸载：停轮询、置死标志，并把还在倒计时的 toast 计时器清掉 ——
      // 那个 timer 到点会 setToastMsg，对已卸载组件 setState 是实打实的泄漏。
      aliveRef.current = false
      clearInterval(t)
      clearTimeout(toastTimer.current)
      toastTimer.current = null
    }
  }, [reload])
  const scrollTop = () => {
    const el = rootRef.current
    if (!el) return
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior: 'smooth' })
    else el.scrollTop = 0
  }
  const go = (id) => {
    setTab(id)
    try { localStorage.setItem('qq-hub.tab', id) } catch (e) {}
    if (rootRef.current) rootRef.current.scrollTop = 0
  }
  // 标签多、一屏放不下：滚轮横着滚，选中的标签自动滚进视野
  const tabsRef = useRef(null)
  const hasNav = Boolean(st && st.config && st.config.setupDone && !wizardOpen)
  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    const onWheel = (e) => { if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { el.scrollLeft += e.deltaY; e.preventDefault() } }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [tab, hasNav])
  useEffect(() => { tabsRef.current?.querySelector('.ab-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [tab])
  const dirty = useMemo(() => !!(st && draft) && JSON.stringify(draft) !== JSON.stringify(st.config), [st, draft])
  dirtyRef.current = dirty
  const setD = (d) => setDraft(d)
  const save = async (override) => {
    const body = override || draft
    revRef.current += 1 // 让还在路上的轮询回包作废，别拿旧配置覆盖这次保存
    const r = await post('/save', body)
    if (r.ok === false) { toast(r.message || '保存失败', 'err'); return false }
    dirtyRef.current = false
    stJsonRef.current = JSON.stringify(r)
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
    return (
      <div className="ab-root">
        <div className="ab-wrap">
          {err
            ? <div className="ab-note err">面板读不到插件：{err}。如果刚装好插件，重启一次 DSH 试试。</div>
            : <Empty icon="🐋" text="大肥鱼正在游过来…" />}
        </div>
      </div>
    )
  }
  const cfg = st.config
  const conn = st.onebot.state === 'connected'
  const status = !cfg.enabled
    ? { cls: '', text: '休息中（总开关关着）' }
    : !conn ? { cls: 'err', text: 'QQ 没连上' }
      : cfg.dryRun ? { cls: 'warn', text: '在线 · 试运行' }
        : { cls: 'ok', text: '在线' }
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
  // 老扩展若还写着「心情」页的旧 tab 名，归一成 memory（别名兜底）；
  // 心情系统 1.4.0 已删除，这个别名只为兼容第三方扩展里遗留的 tab: 'mood'。
  const TAB_ALIAS = { mood: 'memory' }
  const tabOf = (m) => TAB_ALIAS[m.tab] || m.tab
  const intoTab = (m) => Boolean(m.tab && TABS.some((t) => t.id === tabOf(m)))
  const extTabs = mods.filter((m) => hasUi(m) && !intoTab(m)).map((m) => ({ id: 'ext:' + m.id, label: m.name, ext: m.id }))
  const tabs = TABS.filter((t) => !TAB_MODS[t.id] || TAB_MODS[t.id].some(running))
  tabs.splice(tabs.findIndex((t) => t.id === 'logs'), 0, ...extTabs)
  const curTab = tabs.find((t) => t.id === tab) || tabs[0]
  const body = curTab.ext ? ExtPage : {
    overview: Overview, connect: Connect, persona: Persona, access: Access, group: Group, model: Model, voice: Voice,
    stickers: Stickers, imagegen: ImageGen, diary: Diary, speakup: SpeakUp, memory: Memory, bili: Bili, douyin: Douyin, heybox: Heybox, multiParser: MultiParser, browser: Browser, token: Token, local: LocalApi, modules: Modules, logs: Logs,
  }[curTab.id] || Overview
  // 哪些标签有没保存的改动
  const tabDirty = (id) => {
    if (!dirty) return false
    if (id.startsWith('ext:')) { const k = id.slice(4); return JSON.stringify((draft.ext || {})[k]) !== JSON.stringify((cfg.ext || {})[k]) }
    return (TAB_KEYS[id] || []).some((k) => JSON.stringify(draft[k]) !== JSON.stringify(cfg[k]))
  }
  const mark = (t) => {
    if (tabDirty(t.id)) return <i className="dirty" title="有没保存的改动" aria-hidden="true" />
    if (!t.flag) return null
    const flag = t.flag === 'group' ? cfg.allow.groups.length > 0 : getPath(cfg, t.flag)
    return <i className={cx('ab-dot', flag && 'ok')} title={flag ? '开着' : '关着'} aria-hidden="true" />
  }
  const gwText = cfg.gateway === 'onebot'
    ? 'OneBot'
    : 'SnowLuma ' + (st.snowluma.installed ? (st.snowluma.running ? '运行中' : '没启动') : '未安装')
  return (
    <div className="ab-root" ref={rootRef}>
      <div className="ab-wrap">
        {/* 简约顶栏：左侧身份与在线态，右侧主控开关组 */}
        <header className="ab-topbar">
          <div className="ab-topbar-id">
            <button type="button" className="ab-avatar-btn" title="点击换头像" onClick={() => pickAvatar(toast, reload)}>
              <img className="ab-avatar" src={avatarSrc(st)} alt="头像" />
              <span className="ab-avatar-tip">换头像</span>
            </button>
            <div className="ab-topbar-main">
              <div className="ab-topbar-title">
                <h1>{(st.onebot.login && st.onebot.login.nickname) || '大肥鱼'}</h1>
                <Pill kind={status.cls}><i className={cx('ab-dot', status.cls)} />{status.text}</Pill>
              </div>
              <div className="ab-meta">
                <span>QQ {cfg.botQQ || '未填'}</span>
                <span className="ab-meta-sep" aria-hidden="true">·</span>
                <span>{persona ? persona.name : '默认人格'}</span>
                <span className="ab-meta-sep" aria-hidden="true">·</span>
                <span>{gwText}</span>
                <span className="ab-meta-sep" aria-hidden="true">·</span>
                <span>v{st.version}</span>
              </div>
            </div>
            {!showWizard ? (
              <button type="button" className="ab-mfind-trigger" aria-label="查找功能" title="查找功能" onClick={() => setFind('')}>
                {navIcon(SEARCH_ICON)}
              </button>
            ) : null}
          </div>
          <div className="ab-topbar-side">
            <div className="ab-switch-row"><span>总开关</span><Switch on={cfg.enabled} onChange={(v) => quickToggle('enabled', v)} /></div>
            <span className="ab-topbar-div" aria-hidden="true" />
            <div className="ab-switch-row"><span className="ab-muted">试运行</span><Switch on={cfg.dryRun} onChange={(v) => quickToggle('dryRun', v)} title="开着时只写日志，不真的发到 QQ" /></div>
          </div>
        </header>
        {showWizard ? <Wizard st={st} draft={draft} setDraft={setD} save={save} toast={toast} reload={reload} onClose={() => setWizardOpen(false)} /> : null}
        {showWizard ? null : <NavBar tabs={tabs} cur={curTab} go={go} onScrollTop={scrollTop} mark={mark} dirtyOf={tabDirty} subRef={tabsRef} find={find} setFind={setFind} />}
        {showWizard ? null : (
          <div className="ab-page-body">
            <TabBoundary key={curTab.id} onHome={() => go('overview')}>{h(body, { ...props, mod: curTab.ext })}</TabBoundary>
            {curTab.ext
              ? null
              // memory 模块的设置由「记忆」页自己在「整理与检索」卡里渲染（不再自动追加到页尾）；
              // multi-parser 保留在扩展页设置，别的模块照旧嵌在所属标签页。
              : mods.filter((m) => hasUi(m) && tabOf(m) === curTab.id && m.id !== 'multi-parser' && !(curTab.id === 'memory' && m.id === 'memory')).map((m) => (
                <div key={'embed-' + m.id} className="ab-embed-wrap"><ExtPage {...props} mod={m.id} embedded /></div>
              ))}
          </div>
        )}
        {dirty && !showWizard ? (
          <div className="ab-savebar">
            <span className="msg">有改动还没保存</span>
            <span className="ab-muted ab-small ab-savebar-kbd"><span className="ab-kbd">Ctrl</span> + <span className="ab-kbd">S</span></span>
            <div className="ab-savebar-acts">
              <Btn kind="ghost" onClick={() => setDraft(clone(st.config))}>撤销</Btn>
              <Btn kind="primary" onClick={() => save()}>保存设置</Btn>
            </div>
          </div>
        ) : null}
      </div>
      {toastMsg ? <div className={cx('ab-toast', toastMsg.kind)} role="status">{toastMsg.text}</div> : null}
    </div>
  )
}

export { QQHubPage }
