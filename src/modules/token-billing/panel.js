// Token 记账面板：预算/已用/剩余一屏看清 + 手动重置（两步确认）。
// 约定：panel.js 拿到的 4 个参数是 (React, h, ui, call)；最后 return 一个组件函数。
// call 已绑本模块：call('/token-usage') → GET /qq-hub/api/token-billing/token-usage。

const { useState, useEffect } = React

/** 字节级数字转人话（预算是 token 数，直接千分位即可，不用换算 KB）。 */
const fmt = (n) => Number(n || 0).toLocaleString('en-US')

/** 单会话用量条：剩余越少越红。 */
function bar(used, limit) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  const color = pct >= 100 ? 'var(--ab-err, #b91c1c)' : pct >= 80 ? 'var(--ab-warn, #b45309)' : 'var(--ab-ok, #15803d)'
  return h('div', { style: { background: 'var(--ab-muted-2, #e5e7eb)', borderRadius: 6, height: 8, overflow: 'hidden' } },
    h('div', { style: { background: color, height: '100%', width: pct + '%' } }))
}

return function TokenBillingPanel(props) {
  const { Card, Btn, Empty } = ui
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const load = () => {
    setBusy(true)
    call('/token-usage')
      .then((r) => setD(r || { ok: false }))
      .catch(() => setD({ ok: false }))
      .finally(() => setBusy(false))
  }
  useEffect(() => { load() }, [])

  const reset = () => {
    setBusy(true)
    call('/token-usage/reset', {})
      .then((r) => { toast(r?.ok === false ? (r.message || '没重置成') : '今天的用量已清零'); load() })
      .catch(() => toast('重置失败，看日志'))
      .finally(() => setBusy(false))
  }

  if (!d || !d.ok) return h(Card, { title: 'Token 记账' }, h(Empty, { icon: '⏳', text: '读着呢…' }))

  const totalLimit = Number(d.totalLimit) || 0
  const totalUsed = Number(d.totalUsed) || 0
  const totalRemaining = Number(d.totalRemaining) || 0
  const pct = totalLimit > 0 ? Math.round((totalUsed / totalLimit) * 100) : 0

  const rows = Object.entries(d.allocations || {}).map(([chatKey, limit]) => {
    const used = Number((d.usage || {})[chatKey]) || 0
    return { chatKey, limit: Number(limit) || 0, used }
  }).sort((a, b) => b.used - a.used)

  return h(Card, { title: 'Token 记账（' + (d.dateKey || '?') + '）' },
    h('div', { style: { marginBottom: 10 } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 } },
        h('span', null, `已用 ${fmt(totalUsed)} / ${fmt(totalLimit)}`),
        h('span', { style: { color: totalRemaining <= 0 ? 'var(--ab-err, #b91c1c)' : 'inherit' } },
          totalRemaining <= 0 ? '已用完 · 主动搭话熔断中' : `剩 ${fmt(totalRemaining)}`)),
      bar(totalUsed, totalLimit),
      h('div', { style: { marginTop: 4 } }, h('span', { className: 'ab-muted ab-small' }, `烧完只熔断「她主动开口」（主动搭话/目的引擎），正常问答不受影响；跨日自动恢复`))),

    rows.length ? h('div', { style: { margin: '10px 0' } },
      rows.map((r) => h('div', { key: r.chatKey, style: { marginBottom: 8 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 2 } },
          h('span', null, r.chatKey),
          h('span', { className: 'ab-muted ab-small' }, `${fmt(r.used)} / ${fmt(r.limit)}`)),
        bar(r.used, r.limit)))) : null,

    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      h(Btn, { small: true, disabled: busy, onClick: load }, busy ? '读着呢…' : '刷新'),
      confirming
        ? [h(Btn, { key: 'yes', small: true, disabled: busy, onClick: reset }, '确认清零今天用量'),
           h(Btn, { key: 'no', small: true, onClick: () => setConfirming(false) }, '算了')]
        : h(Btn, { small: true, disabled: busy || totalUsed <= 0, onClick: () => setConfirming(true) }, '重置今天用量'),
      h('span', { className: 'ab-muted ab-small' }, '重置只清已用，分配保留')))
})
