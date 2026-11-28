import { useState, useEffect, Fragment, h } from '../core/react.js'
import { Card, Btn, Empty, More } from '../ui/primitives.js'
import { navIcon } from '../ui/icons.js'
import { cx, copy } from '../core/utils.js'
import { get, post } from '../core/http.js'

function UpdateNotes({ st, toast }) {
  const [upd, setUpd] = useState(null)
  const [notes, setNotes] = useState(null)
  useEffect(() => {
    get('/update/check').then(setUpd).catch(() => {})
    let seen = null
    try { seen = localStorage.getItem('qq-hub.seenVersion') } catch (e) {}
    if (seen && seen !== st.version) get('/changelog').then((r) => r.notes && setNotes(r.notes))
    // 第一次打开（新安装）不弹更新说明，直接记下当前版本
    else if (!seen) { try { localStorage.setItem('qq-hub.seenVersion', st.version) } catch (e) {} }
  }, [st.version])
  const dismiss = () => { try { localStorage.setItem('qq-hub.seenVersion', st.version) } catch (e) {} setNotes(null) }
  return (
    <Fragment>
      {notes ? (
        <div className="ab-note">
          <div className="ab-flex"><b>已更新到 v{st.version}</b><div className="ab-spacer" /><Btn small kind="ghost" onClick={dismiss}>知道了</Btn></div>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{notes}</div>
        </div>
      ) : null}
      {upd && upd.newer ? (
        <div className="ab-note warn">
          <div><b>有新版本 v{upd.latest}</b>（现在是 v{upd.current}）。在 PowerShell 里运行下面这行，然后重启 DSH；设置、人格、记忆都会保留。</div>
          <div className="ab-flex" style={{ marginTop: 6 }}>
            <code style={{ flex: '1 1 220px', minWidth: 0, fontSize: 11.5, wordBreak: 'break-all' }}>{upd.command}</code>
            <Btn small onClick={() => copy(upd.command, toast, '复制好了')}>复制</Btn>
          </div>
        </div>
      ) : null}
    </Fragment>
  )
}

const STATS = [
  ['今天收到', 'received', 'M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5M12 4v10M8.5 10.5 12 14l3.5-3.5'],
  ['今天发出', 'sent', 'M20 4 11 13M20 4l-6 16-3-7-7-3 16-6z'],
  ['语音条', 'voice', 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6'],
  ['表情包', 'stickers', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 14.2s1.2 1.8 3 1.8 3-1.8 3-1.8M9.5 10h.01M14.5 10h.01'],
]

function Overview({ st, toast, go }) {
  const cfg = st.config
  const s = st.stats || {}
  const conn = st.onebot.state === 'connected'
  const quick = (p, body) => async () => { const r = await post(p, body); toast(r.message || (r.ok ? '好了' : '没成功')) }
  const sessionCount = Object.keys(st.sessions || {}).filter((k) => !k.startsWith('system:')).length
  return (
    <div className="ab-grid">
      <UpdateNotes st={st} toast={toast} />
      {!cfg.enabled ? <div className="ab-note warn">总开关是关着的：她现在不会收也不会发任何 QQ 消息。准备好了就在右上角打开。</div> : null}
      {cfg.enabled && cfg.dryRun ? <div className="ab-note">现在是试运行：她会照常思考回复，但只写进日志，不会真的发到 QQ。确认没问题后在右上角关掉「试运行」。</div> : null}
      {cfg.enabled && !conn ? (
        <div className="ab-note err">
          还没连上 QQ 网关{st.onebot.problem ? '：' + st.onebot.problem + '。' : '。看看 SnowLuma 有没有装好、启动没有。'}{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); go('connect') }}>去连接 →</a>
        </div>
      ) : null}
      <div className="ab-grid ab-g4">
        {STATS.map(([label, key, icon]) => (
          <div key={label} className="ab-card ab-stat">
            <div className="ab-stat-top">
              <div className="l">{label}</div>
              <span className="ic" aria-hidden="true">{navIcon(icon)}</span>
            </div>
            <div className="n">{s[key] || 0}</div>
          </div>
        ))}
      </div>
      <div className="ab-grid ab-g2">
        <Card title="她现在">
          <div className="ab-kv">
            <span>表情库</span><span>{st.stickers.count} 张</span>
            <span>下一篇日记</span><span>{cfg.diary.enabled ? (st.diary.next || '今天写完了') : '没开'}</span>
            <span>人格</span><span>{(st.personas.find((p) => p.id === cfg.persona.current) || {}).name || cfg.persona.current}</span>
            <span>QQ 会话</span><span>{sessionCount} 个 · 侧栏「QQ Hub」</span>
          </div>
        </Card>
        <Card title="快捷操作" desc="实际发到 QQ（试运行时只写日志）。">
          <div className="ab-actions">
            <Btn kind="primary" onClick={quick('/test-send')}>给主人发一条自测</Btn>
            <Btn onClick={quick('/speakup/fire')}>让她现在来找你</Btn>
            <Btn onClick={quick('/diary/run', { visibility: 'self' })}>写一篇日记（仅自己可见）</Btn>
          </div>
          <More label="怎么看她和谁聊了什么">
            {'点 DSH 侧栏「QQ Hub」工作区里对应的会话，可以看到她和每个人聊了什么、调了什么工具，也可以直接在会话里插话。'}
          </More>
          <div className="ab-card-foot">
            <Btn
              small kind="ghost"
              onClick={async () => {
                if (!confirm('把现在所有 QQ 会话归档、让她从头开始聊？（旧会话在侧栏的归档里还能找到）')) return
                const r = await post('/sessions/reset'); toast(r.message)
              }}
            >
              重新开始所有 QQ 会话
            </Btn>
          </div>
        </Card>
      </div>
      <RecentLogs go={go} />
    </div>
  )
}

function RecentLogs({ go }) {
  const [items, setItems] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => get('/logs?limit=8&level=info').then((r) => alive && setItems(r.entries || []))
    load()
    const t = setInterval(load, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return (
    <Card title="最近动态" right={<Btn kind="ghost" small onClick={() => go('logs')}>全部日志 →</Btn>}>
      {items === null
        ? <Empty icon="⏳" text="加载中…" />
        : items.length === 0 ? <Empty text="还没有动静" />
          : <div className="ab-logs" style={{ maxHeight: 240 }}>{items.slice().reverse().map((e, i) => <LogLine key={i} e={e} />)}</div>}
    </Card>
  )
}

function LogLine({ e }) {
  return <div className={cx('ab-log', e.level)}><span className="t">{e.time}</span><span className="a">{e.area}</span><span className="m">{e.text}</span></div>
}

export { Overview, UpdateNotes, RecentLogs, LogLine }
