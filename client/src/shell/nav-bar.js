import { useState, useEffect, useRef, Fragment, h } from '../core/react.js'
import { navIcon } from '../ui/icons.js'
import { cx } from '../core/utils.js'
import { NAV_GROUPS, navGroupOf, navOrder, NAV_ALIAS } from '../domain/nav.js'

const SEARCH_ICON = 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.2-4.2'

/* 两层导航：
 *  - 桌面（>720px）：sticky 卡片，上面一排分组、下面一排当前组的页面；Alt+K 查找。
 *  - 移动端（≤720px）：顶部横滚胶囊 chips（当前组多于 1 页时显示，随页面滚走不遮挡内容）+
 *    底部固定分组栏（五个分组，拇指可达；再点当前分组平滑回到顶部）+ 顶栏搜索触发的快捷查找弹层。
 * 每组记住上次看的那页：点分组时回到那页（qq-hub.navlast）。 */

function NavBar({ tabs, cur, go, onScrollTop, mark, dirtyOf, subRef, find: extFind, setFind: extSetFind }) {
  const [last, setLast] = useState(() => { try { return JSON.parse(localStorage.getItem('qq-hub.navlast') || '{}') || {} } catch (e) { return {} } })
  const [localFind, setLocalFind] = useState(null)
  const find = extFind !== undefined ? extFind : localFind
  const setFind = extSetFind || setLocalFind
  const [hi, setHi] = useState(0)
  const [isMobile, setIsMobile] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 720px)').matches : false))
  const box = useRef(null)
  const chipsRef = useRef(null)
  const findBtnRef = useRef(null)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const mq = window.matchMedia('(max-width: 720px)')
    const onChange = (e) => setIsMobile(e.matches)
    setIsMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  const groups = NAV_GROUPS
    .map((g) => ({ ...g, list: tabs.filter((t) => navGroupOf(t).id === g.id).sort((a, b) => navOrder(g, a) - navOrder(g, b)) }))
    .filter((g) => g.list.length)
  const curGroup = groups.find((g) => g.list.some((t) => t.id === cur.id)) || groups[0]
  // 记住每组最后看的那页：点分组时回到那页
  useEffect(() => {
    if (!curGroup || last[curGroup.id] === cur.id) return
    const next = { ...last, [curGroup.id]: cur.id }
    setLast(next)
    try { localStorage.setItem('qq-hub.navlast', JSON.stringify(next)) } catch (e) {}
  }, [cur.id])
  // 移动端切换页面时把当前胶囊自动滚进视野中央
  useEffect(() => {
    chipsRef.current?.querySelector('.ab-chipbtn.on')?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [cur.id])
  // 每次打开查找框重置高亮行
  useEffect(() => { if (find !== null) setHi(0) }, [find === null])
  const openGroup = (g) => {
    if (curGroup && g.id === curGroup.id) {
      if (onScrollTop) onScrollTop()
      return
    }
    go((g.list.find((t) => t.id === last[g.id]) || g.list[0]).id)
  }
  const toggleFind = () => setFind((f) => (f === null ? '' : null))
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyK' || e.key.toLowerCase() === 'k')) { e.preventDefault(); toggleFind() }
      else if (e.key === 'Escape') {
        setFind((prev) => {
          if (prev !== null && !isMobile) setTimeout(() => findBtnRef.current?.focus(), 0)
          return null
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMobile])
  // 桌面端：点到查找框外面就收起（pointerdown 兼容触屏/鼠标）
  useEffect(() => {
    if (find === null || isMobile) return undefined
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setFind(null) }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [find === null, isMobile])
  const q = (find || '').trim().toLowerCase()
  const hits = find === null ? [] : groups.flatMap((g) => g.list.map((t) => ({ t, g })))
    .filter(({ t, g }) => !q || [t.label, g.label, NAV_ALIAS[t.id] || '', t.id].join(' ').toLowerCase().includes(q))
  const pick = (t) => { setFind(null); go(t.id) }
  const onFindKey = (e) => {
    if (!hits.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(Math.min(hi + 1, hits.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math.max(hi - 1, 0)) }
    else if (e.key === 'Enter' && hits[hi]) { e.preventDefault(); pick(hits[hi].t) }
  }
  const tabBtn = (t) => (
    <button key={t.id} type="button" role="tab" aria-selected={cur.id === t.id} className={cx('ab-tab', cur.id === t.id && 'on')} onClick={() => go(t.id)}>
      {t.label}
      {mark(t)}
    </button>
  )
  const chipBtn = (t) => (
    <button key={t.id} type="button" role="tab" aria-selected={cur.id === t.id} className={cx('ab-chipbtn', cur.id === t.id && 'on')} onClick={() => go(t.id)}>
      {t.label}
      {mark(t)}
    </button>
  )
  const finderList = (
    <div className="ab-finder-list" role="listbox">
      {hits.length
        ? hits.map(({ t, g }, i) => (
          <button key={t.id} type="button" role="option" aria-selected={i === hi} className={cx('ab-finder-item', i === hi && 'on')} onMouseEnter={() => setHi(i)} onClick={() => pick(t)}>
            {t.label}<small>{g.label}</small>
          </button>
        ))
        : <div className="ab-finder-empty">没找到，换个说法试试：语音、抖音、白名单</div>}
    </div>
  )
  return (
    <Fragment>
      <nav className="ab-nav" ref={box} aria-label="QQ Hub 功能">
        <div className="ab-nav-top">
          <div className="ab-nav-groups" role="tablist" aria-label="功能分组">
            {groups.map((g) => (
              <button
                key={g.id} type="button" role="tab" aria-selected={g.id === curGroup.id} className={cx('ab-grp', g.id === curGroup.id && 'on')}
                title={g.list.map((t) => t.label).join(' · ')} onClick={() => openGroup(g)}
              >
                {navIcon(g.icon)}
                <span>{g.label}</span>
                {g.list.some((t) => dirtyOf(t.id)) ? <i className="dirty" title="这组里有没保存的改动" aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
          <button ref={findBtnRef} type="button" className="ab-find-btn" aria-expanded={find !== null} title="查找功能（Alt+K）" onClick={toggleFind}>
            {navIcon(SEARCH_ICON)}
            <span className="t">查找</span>
            <span className="ab-kbd">Alt K</span>
          </button>
        </div>
        {curGroup && curGroup.list.length > 1 ? <div className="ab-nav-sub" role="tablist" aria-label={curGroup.label} ref={subRef}>{curGroup.list.map(tabBtn)}</div> : null}
        {find !== null && !isMobile ? (
          <div className="ab-finder">
            <input
              className="ab-input" autoFocus placeholder="找功能：语音、抖音、白名单…" value={find}
              onChange={(e) => { setFind(e.target.value); setHi(0) }}
              onKeyDown={onFindKey}
            />
            {finderList}
          </div>
        ) : null}
      </nav>
      {/* 移动端：吸顶横滚胶囊（本组多于 1 页时显示）+ 底部五分组导航 + 快捷查找弹层 */}
      {curGroup && curGroup.list.length > 1 ? (
        <div className="ab-chips" ref={chipsRef} role="tablist" aria-label={curGroup.label}>{curGroup.list.map(chipBtn)}</div>
      ) : null}
      {find !== null && isMobile ? (
        <div
          className="ab-mfinder-mask"
          onPointerDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); e.stopPropagation(); setFind(null) } }}
        >
          <div className="ab-mfinder-sheet" role="dialog" aria-modal="true" aria-label="查找功能">
            <div className="ab-mfinder-head">
              <input
                className="ab-input" autoFocus placeholder="找功能：语音、抖音、白名单…" value={find}
                onChange={(e) => { setFind(e.target.value); setHi(0) }}
                onKeyDown={onFindKey}
              />
              <button type="button" className="ab-btn sm ghost" onClick={() => setFind(null)}>取消</button>
            </div>
            {finderList}
          </div>
        </div>
      ) : null}
      <div className="ab-mobilebar" role="tablist" aria-label="功能分组">
        {groups.map((g) => (
          <button
            key={g.id} type="button" role="tab" aria-selected={g.id === curGroup.id} className={cx('ab-mgrp', g.id === curGroup.id && 'on')}
            onClick={() => openGroup(g)}
          >
            <span className="ab-mgrp-ic">{navIcon(g.icon)}</span>
            <span>{g.label}</span>
            {g.list.some((t) => dirtyOf(t.id)) ? <i className="dirty" title="这组里有没保存的改动" aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
    </Fragment>
  )
}

export { NavBar, SEARCH_ICON }
