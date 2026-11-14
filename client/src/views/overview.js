import { useState, useEffect, useRef, useCallback, useMemo, Fragment, h } from '../core/react.js'
import { WhaleIcon } from '../ui/icons.js'
import { Card, Row, Btn, Empty, DangerZone } from '../ui/primitives.js'
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
    !cfg.enabled ? h('div', { className: 'ab-note warn' }, '总开关已关闭，不会收发 QQ 消息。') : null,
    cfg.enabled && cfg.dryRun ? h('div', { className: 'ab-note' }, '试运行已开启：只记录日志，不会发送到 QQ。') : null,
    cfg.enabled && !conn ? h('div', { className: 'ab-note err' }, '还没连上 QQ 网关' + (st.onebot.problem ? '：' + st.onebot.problem + '。' : '。去「连接」标签看看 SnowLuma 有没有装好、启动没有。') + ' ', h('a', { href: '#', onClick: (e) => { e.preventDefault(); go('connect') } }, '去连接 →')) : null,
    h('div', { className: 'ab-grid ab-g4 ab-stats' },
      [['今天收到', s.received], ['今天发出', s.sent], ['语音条', s.voice], ['表情包', s.stickers]].map(([l, n]) => h('div', { key: l, className: 'ab-card ab-stat' }, h('div', { className: 'n' }, n || 0), h('div', { className: 'l' }, l))),
    ),
    h('div', { className: 'ab-grid ab-g2 ab-overview-panels' },
      h(Card, { title: '运行速览', className: 'ab-runtime-card' },
        h('div', { className: 'ab-runtime-grid' },
          [
            ['表情库', ((st.stickers && st.stickers.count) || 0) + ' 张'],
            ['下一篇日记', cfg.diary.enabled ? ((st.diary && st.diary.next) || '今天写完了') : '未开启'],
            ['人格', (st.personas.find((p) => p.id === cfg.persona.current) || {}).name || cfg.persona.current],
            ['QQ 会话', Object.keys(st.sessions || {}).filter((k) => !k.startsWith('system:')).length + ' 个'],
          ].map(([label, value]) => h('div', { key: label, className: 'ab-runtime-item' }, h('span', { className: 'k' }, label), h('span', { className: 'v' }, value))),
        ),
      ),
      h(Card, { title: '快捷自测', desc: '试运行只记录日志；关闭后才会真实发送。', className: 'ab-quick-test' },
        h('div', { className: 'ab-flex' },
          h(Btn, { kind: 'primary', onClick: quick('/test-send') }, '发消息自测'),
          h(Btn, { onClick: quick('/speakup/fire') }, '主动找我'),
          h(Btn, { onClick: quick('/diary/run', { visibility: 'self' }) }, '写私密日记'),
        ),
      ),
    ),
    h(RecentLogs, { go }),
    h(DangerZone, {
      title: '重新开始所有 QQ 会话',
      description: '归档当前全部 QQ 会话，让她从新的上下文开始。旧会话仍保留在 DSH 归档中。',
      actionLabel: '归档并重新开始',
      confirmText: '正在进行的回复可能中断；此操作不会删除人格或长期记忆。',
      onConfirm: async () => { const r = await post('/sessions/reset'); toast(r.message) },
    }),
  )
}

function RecentLogs({ go }) {
  const [items, setItems] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => get('/logs?limit=6&level=info').then((r) => alive && setItems(r.entries || []))
    load()
    const t = setInterval(load, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return h(Card, { title: '最近动态', className: 'ab-recent-card', collapsible: true, right: h(Btn, { kind: 'ghost', small: true, onClick: () => go('logs') }, '全部日志 →') },
    items === null ? h(Empty, { icon: '⏳', text: '加载中…' }) : items.length === 0 ? h(Empty, { text: '还没有动静' }) :
      h('div', { className: 'ab-logs' }, items.slice().reverse().map((e, i) => h(LogLine, { key: i, e }))))
}

function LogLine({ e }) {
  return h('div', { className: cx('ab-log', e.level) }, h('div', { className: 'ab-log-meta' }, h('span', { className: 't' }, e.time), h('span', { className: 'a' }, e.area)), h('span', { className: 'm' }, e.text))
}

/** 控制台密码状态：插件自动管理；登不上时给「重置为自动密码」。 */

export { Overview, UpdateNotes, RecentLogs, LogLine }
