// 投递异常面板：只读。展示没送出去 / 不确定送达的消息。
// 约定：panel.js 拿到的 4 个参数是 (React, h, ui, call)；最后 return 一个组件函数。
// call 已经绑好本模块：call('/deliveries/exceptions') → GET /qq-hub/api/delivery-inbox/deliveries/exceptions

const { useState, useEffect } = React

/** 相对时间：这类排查最关心"多久之前"，绝对时间反而要心算。 */
const ago = (t) => {
  if (!t) return '—'
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const h = Math.round(m / 60)
  if (h < 24) return h + ' 小时前'
  return Math.round(h / 24) + ' 天前'
}

/** 状态标签：unknown 用橙色（可能已送达）、failed 用红色（确定没送达）。 */
const STATE_META = {
  unknown: { label: '不确定送达', color: 'var(--ab-warn, #b45309)', hint: '网关没给回执，可能已经发出去了' },
  failed: { label: '发送失败', color: 'var(--ab-err, #b91c1c)', hint: '确定没送出去' },
  cancelled: { label: '被拦下', color: 'var(--ab-muted, #6b7280)', hint: '总开关/dryRun/权限/身份闸拦的，不是网关问题' },
}

return function DeliveryInboxPanel(props) {
  const { Card, Btn, Empty } = ui
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = () => {
    setBusy(true)
    call('/deliveries/exceptions')
      .then((r) => setD(r || { ok: false }))
      .catch(() => setD({ ok: false }))
      .finally(() => setBusy(false))
  }
  useEffect(() => { load() }, [])

  const refreshBtn = h(Btn, { small: true, disabled: busy, onClick: load }, busy ? '读着呢…' : '刷新')

  if (!d) return h(Card, { title: '投递异常' }, h(Empty, { icon: '⏳', text: '读着呢…' }))

  // 读不到 ≠ 没有异常。这条必须说清，否则主人会以为一切正常。
  if (d.ok === false) {
    return h(Card, { title: '投递异常', extra: refreshBtn },
      h('div', { className: 'ab-note err' },
        '读不到投递台账（文件缺失或格式坏了）。这不代表没有异常——请先确认网关闭要正常、插件数据目录可读。'),
      d.file ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '台账路径：' + d.file) : null)
  }

  const items = d.items || []
  const counts = d.counts || {}
  const header = h('div', { className: 'ab-small ab-muted', style: { marginBottom: 8 } },
    `台账共 ${d.total} 条`
    + (counts.sent ? `（已送达 ${counts.sent}）` : '')
    + (items.length ? `，其中 ${items.length} 条要你看一眼` : '，没有需要看的异常')
    + (d.savedAt ? `。最后落盘 ${ago(d.savedAt)}` : ''))

  return h(Card, {
    title: '投递异常',
    extra: refreshBtn,
    desc: '这里只列没送出去、或不确定送达的消息。不确定送达的那类可能其实已经发出去了，所以不提供重发按钮——要不要再发一次，你来决定。',
  },
  header,
  items.length
    ? h('div', null, items.map((it) => {
      const meta = STATE_META[it.state] || { label: it.state || '异常', color: 'var(--ab-muted, #6b7280)', hint: '' }
      return h('div', {
        key: it.deliveryId || (it.chatKey + it.at),
        style: { padding: '8px 0', borderTop: '1px solid var(--ab-line, #eef0f3)' },
      },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { className: 'ab-small', style: { color: meta.color, fontWeight: 600 } }, meta.label),
          h('span', { className: 'ab-small' }, it.chatKey),
          h('span', { className: 'ab-small ab-muted' }, ago(it.at)),
          it.attemptCount ? h('span', { className: 'ab-small ab-muted' }, `试了 ${it.attemptCount} 次`) : null,
          it.source ? h('span', { className: 'ab-small ab-muted' }, `发件方：${it.source}`) : null),
        it.preview
          ? h('div', { style: { marginTop: 4, wordBreak: 'break-word' } }, it.preview)
          : h('div', { className: 'ab-small ab-muted', style: { marginTop: 4 } }, '（这条没有可展示的正文）'),
        it.reason ? h('div', { className: 'ab-small', style: { color: meta.color, marginTop: 2 } }, `原因：${it.reason}`) : null,
        it.note ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 2 } }, `备注：${it.note}`) : null)
    }))
    : h(Empty, { icon: '✅', text: '没有需要看的投递异常' }),
  d.file ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 10 } }, '台账原文：' + d.file) : null)
}
