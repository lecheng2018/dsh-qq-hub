import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { WhaleIcon } from '../ui/icons.js'
import { Card, Row, Btn, Empty } from '../ui/primitives.js'
import { timeAgo, copy, cx } from '../core/utils.js'
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
  return h(Fragment, null,
    notes ? h('div', { className: 'ab-note' },
      h('div', { className: 'ab-flex' }, h('b', null, '已更新到 v' + st.version), h('div', { className: 'ab-spacer' }), h(Btn, { small: true, kind: 'ghost', onClick: dismiss }, '知道了')),
      h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 6 } }, notes)) : null,
    upd && upd.newer ? h('div', { className: 'ab-note warn' },
      h('div', null, h('b', null, '有新版本 v' + upd.latest), '（现在是 v' + upd.current + '）。在 PowerShell 里运行下面这行，然后重启 DSH；设置、人格、记忆都会保留。'),
      h('div', { className: 'ab-flex', style: { marginTop: 6 } },
        h('code', { style: { flex: '1 1 300px', fontSize: 11.5, wordBreak: 'break-all' } }, upd.command),
        h(Btn, { small: true, onClick: () => { try { navigator.clipboard.writeText(upd.command); toast('复制好了', 'ok') } catch (e) { toast('复制失败，手动选中复制吧', 'err') } } }, '复制'))) : null)
}

function Overview({ st, toast, go }) {
  const cfg = st.config
  const s = st.stats || {}
  const conn = st.onebot.state === 'connected'
  const quick = (p, body) => async () => { const r = await post(p, body); toast(r.message || (r.ok ? '好了' : '没成功')) }
  return h('div', { className: 'ab-grid' },
    h(UpdateNotes, { st, toast }),
    !cfg.enabled ? h('div', { className: 'ab-note warn' }, '总开关是关着的：大肥鱼现在不会收也不会发任何 QQ 消息。准备好了就在右上角打开。') : null,
    cfg.enabled && cfg.dryRun ? h('div', { className: 'ab-note' }, '现在是试运行：她会照常思考回复，但只写进日志，不会真的发到 QQ。确认没问题后在右上角关掉「试运行」。') : null,
    cfg.enabled && !conn ? h('div', { className: 'ab-note err' }, '还没连上 QQ 网关' + (st.onebot.problem ? '：' + st.onebot.problem + '。' : '。去「连接」标签看看 SnowLuma 有没有装好、启动没有。') + ' ', h('a', { href: '#', onClick: (e) => { e.preventDefault(); go('connect') } }, '去连接 →')) : null,
    h('div', { className: 'ab-grid ab-g4' },
      [['今天收到', s.received, '📥'], ['今天发出', s.sent, '📤'], ['语音条', s.voice, '🎙️'], ['表情包', s.stickers, '😺']].map(([l, n, ic]) => h('div', { key: l, className: 'ab-card ab-stat' }, h('span', { className: 'ic', 'aria-hidden': true }, ic), h('div', { className: 'n' }, n || 0), h('div', { className: 'l' }, l))),
    ),
    h('div', { className: 'ab-grid ab-g2' },
      h(Card, { title: '她现在', desc: '心情会随聊天起伏，过一阵子慢慢回到平常。' },
        h('div', { className: 'ab-flex', style: { marginBottom: 8 } }, h('b', null, st.mood.label), h('span', { className: 'ab-muted' }, st.mood.value + ' / 100')),
        h('div', { className: 'ab-mood' }, h('i', { style: { width: Math.max(4, st.mood.value) + '%' } })),
        h('div', { className: 'ab-kv', style: { marginTop: 14 } },
          h('span', null, '表情库'), h('span', null, st.stickers.count + ' 张'),
          h('span', null, '下一篇日记'), h('span', null, cfg.diary.enabled ? (st.diary.next || '今天写完了') : '没开'),
          h('span', null, '人格'), h('span', null, (st.personas.find((p) => p.id === cfg.persona.current) || {}).name || cfg.persona.current),
          h('span', null, 'QQ 会话'), h('span', null, Object.keys(st.sessions || {}).filter((k) => !k.startsWith('system:')).length + ' 个（在侧栏「QQ Hub」工作区里）'),
        ),
      ),
      h(Card, { title: '快捷操作', desc: '试一试她是不是活着。这些操作会真的发到 QQ（试运行时只写日志）。' },
        h('div', { className: 'ab-flex' },
          h(Btn, { kind: 'primary', onClick: quick('/test-send') }, '给主人发一条自测'),
          h(Btn, { onClick: quick('/speakup/fire') }, '让她现在来找你'),
          h(Btn, { onClick: quick('/diary/run', { visibility: 'self' }) }, '写一篇日记（仅自己可见）'),
        ),
        h('p', { className: 'ab-muted ab-small', style: { marginTop: 12, marginBottom: 0 } }, '想看她和每个人聊了什么、调了什么工具：点 DSH 侧栏「QQ Hub」工作区里对应的会话，也可以直接在会话里插话。'),
        h('div', { className: 'ab-flex', style: { marginTop: 10 } },
          h(Btn, { small: true, kind: 'ghost', onClick: async () => { if (!confirm('把现在所有 QQ 会话归档、让她从头开始聊？（旧会话在侧栏的归档里还能找到）')) return; const r = await post('/sessions/reset'); toast(r.message) } }, '重新开始所有 QQ 会话')),
      ),
    ),
    h(RecentLogs, { go }),
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
  return h(Card, { title: '最近动态', right: h(Btn, { kind: 'ghost', small: true, onClick: () => go('logs') }, '全部日志 →') },
    items === null ? h(Empty, { icon: '⏳', text: '加载中…' }) : items.length === 0 ? h(Empty, { text: '还没有动静' }) :
      h('div', { className: 'ab-logs', style: { maxHeight: 240 } }, items.slice().reverse().map((e, i) => h(LogLine, { key: i, e }))))
}

function LogLine({ e }) {
  return h('div', { className: cx('ab-log', e.level) }, h('span', { className: 't' }, e.time), h('span', { className: 'a' }, e.area), h('span', { className: 'm' }, e.text))
}

/** 控制台密码状态：插件自动管理；登不上时给「重置为自动密码」。 */

export { Overview, UpdateNotes, RecentLogs, LogLine }
