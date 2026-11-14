import { useState, useEffect, useRef, Fragment, h } from '../core/react.js'
import { navIcon } from '../ui/icons.js'
import { cx } from '../core/utils.js'
import { NAV_GROUPS, navGroupOf, navOrder, NAV_ALIAS } from '../domain/nav.js'

/* 两层导航：
 *  - 桌面（>720px）：sticky 卡片，上面一排分组、下面一排当前组的页面；Alt+K 查找。
 *  - 移动端（≤720px）：sticky 卡片整个藏掉，改为「当前组的页面 chips 横滚」+
 *    底部固定栏（五个分组，拇指可达）。Alt+K 查找在触屏上没意义，随卡片一起隐藏。
 * 每组记住上次看的那页：点分组时回到那页（qq-hub.navlast）。 */

function NavBar({ tabs, cur, go, mark, dirtyOf, subRef }) {
  const [last, setLast] = useState(() => { try { return JSON.parse(localStorage.getItem('qq-hub.navlast') || '{}') || {} } catch (e) { return {} } })
  const [find, setFind] = useState(null) // null = 没开；字符串 = 正在搜的字
  const [hi, setHi] = useState(0)
  const box = useRef(null)
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
  const openGroup = (g) => go((g.list.find((t) => t.id === last[g.id]) || g.list[0]).id)
  const toggleFind = () => { setFind((f) => (f === null ? '' : null)); setHi(0) }
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'k') { e.preventDefault(); toggleFind() }
      else if (e.key === 'Escape') setFind(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // 点到查找框外面就收起
  useEffect(() => {
    if (find === null) return
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setFind(null) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [find === null])
  const q = (find || '').trim().toLowerCase()
  const hits = find === null ? [] : groups.flatMap((g) => g.list.map((t) => ({ t, g })))
    .filter(({ t, g }) => !q || [t.label, g.label, NAV_ALIAS[t.id] || '', t.id].join(' ').toLowerCase().includes(q))
  const pick = (t) => { setFind(null); go(t.id) }
  const tabBtn = (t) => (
    <button key={t.id} type="button" role="tab" aria-selected={cur.id === t.id} className={cx('ab-tab', cur.id === t.id && 'on')} onClick={() => go(t.id)}>
      {t.label}
      {mark(t)}
    </button>
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
                {g.list.some((t) => dirtyOf(t.id)) ? <i className="dirty" title="这组里有没保存的改动" /> : null}
              </button>
            ))}
          </div>
          <button type="button" className="ab-find-btn" aria-expanded={find !== null} title="查找功能（Alt+K）" onClick={toggleFind}>
            {navIcon('M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.2-4.2')}
            <span className="t">查找</span>
            <span className="ab-kbd">Alt K</span>
          </button>
        </div>
        {curGroup && curGroup.list.length > 1 ? <div className="ab-nav-sub" role="tablist" aria-label={curGroup.label} ref={subRef}>{curGroup.list.map(tabBtn)}</div> : null}
        {find !== null ? (
          <div className="ab-finder">
            <input
              className="ab-input" autoFocus placeholder="找功能：语音、抖音、白名单…" value={find}
              onChange={(e) => { setFind(e.target.value); setHi(0) }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHi(Math.min(hi + 1, hits.length - 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math.max(hi - 1, 0)) }
                else if (e.key === 'Enter' && hits[hi]) { e.preventDefault(); pick(hits[hi].t) }
              }}
            />
            <div className="ab-finder-list" role="listbox">
              {hits.length
                ? hits.map(({ t, g }, i) => (
                  <button key={t.id} type="button" role="option" aria-selected={i === hi} className={cx('ab-finder-item', i === hi && 'on')} onMouseEnter={() => setHi(i)} onClick={() => pick(t)}>
                    {t.label}<small>{g.label}</small>
                  </button>
                ))
                : <div className="ab-finder-empty">没找到，换个说法试试：语音、抖音、白名单</div>}
            </div>
          </div>
        ) : null}
      </nav>
      {/* 移动端：当前组的页面 chips（横滚）+ 底部分组栏 */}
      {curGroup ? <div className="ab-chips" role="tablist" aria-label={curGroup.label}>{curGroup.list.map(tabBtn)}</div> : null}
      <div className="ab-mobilebar" role="tablist" aria-label="功能分组">
        {groups.map((g) => (
          <button
            key={g.id} type="button" role="tab" aria-selected={g.id === curGroup.id} className={cx('ab-mgrp', g.id === curGroup.id && 'on')}
            onClick={() => openGroup(g)}
          >
            {navIcon(g.icon)}
            <span>{g.label}</span>
            {g.list.some((t) => dirtyOf(t.id)) ? <i className="dirty" title="这组里有没保存的改动" /> : null}
          </button>
        ))}
      </div>
    </Fragment>
  )
}

export { NavBar }
