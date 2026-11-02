// 预算守门员的面板：各聊天用量进度条 + 一键压缩。
// 约定：panel.js 拿到的 4 个参数是 (React, h, ui, call)；最后 return 一个组件函数。
// call 已经绑好本模块：call('/status') → GET /ext/token-guardian/status

const { useState, useEffect } = React
const fmt = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : String(n))
const ago = (t) => { if (!t) return '—'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.round(m / 60) + ' 小时前' }

return function TokenGuardianPanel(props) {
  const { Card, Btn, Empty } = ui
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState('')
  const load = () => call('/status').then((r) => r && r.ok !== false && setD(r)).catch(() => setD({ ok: false, items: [] }))
  useEffect(() => { load() }, [])
  if (!d) return h(Card, { title: '用量' }, h(Empty, { icon: '⏳', text: '读着呢…' }))
  if (d.ok === false) return h(Card, { title: '用量' }, h('div', { className: 'ab-note err' }, '读不到用量（扩展模块没在跑？）'))
  const items = d.items || []
  return h(Card, { title: '各聊天用了多少', desc: `估算口径：字符数 ÷ 1.2。超过 ${fmt(d.threshold)} 就会在你空闲时自动压一次。` },
    items.length ? h('div', null, items.map((it, i) => {
      const pct = Math.min(100, Math.round((it.tokens / Math.max(1, d.threshold)) * 100))
      return h('div', { key: it.chatId, style: { marginBottom: 10 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
          h('span', { className: 'ab-small' }, it.chatId),
          h('span', { className: 'ab-small ab-muted' }, `${fmt(it.tokens)} / ${fmt(d.threshold)}`),
          h(Btn, {
            small: true, disabled: busy === it.chatId,
            onClick: async () => { setBusy(it.chatId); try { const r = await call('/compact-now', { chatId: it.chatId }); props.toast && props.toast(r.message || (r.ok ? '好了' : '没成功'), r.ok ? 'ok' : 'err'); await load() } finally { setBusy('') } },
          }, busy === it.chatId ? '压着呢…' : '现在压一次')),
        h('div', { style: { height: 6, borderRadius: 3, background: 'var(--ab-line, #e5e7eb)', marginTop: 4 } },
          h('div', { style: { height: 6, borderRadius: 3, width: pct + '%', background: pct >= 100 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#22c55e' } })),
        h('div', { className: 'ab-small ab-muted' }, `压过 ${it.compacts} 次，上次说话 ${ago(it.lastAt)}，上次压缩 ${ago(it.lastCompactAt)}${it.hasSummary ? '，有摘要' : ''}`))
    })) : h(Empty, { icon: '📊', text: '还没有聊天记录，聊几句就有了' }))
}
