// 目的引擎的面板：显示实际生效的运行状态。
// 之前的坑：面板显示的「每日上限 3」是 defaults，实际被 speakUp.maxPerDay=4 覆盖成 4，
// 用户以为没生效。这里全部读 /purpose/status 的真实值（config 映射后的），不显示静态默认值。
const { useState, useEffect } = React

return function PurposePanel(props) {
  const { Card, Btn, Empty } = ui
  const [d, setD] = useState(null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState('')
  const load = () => call('/purpose/status').then((r) => setD(r)).catch(() => setD({ ok: false }))
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [])

  const fire = async () => {
    setBusy('fire')
    try {
      const r = await call('/purpose/fire', {})
      props.toast && props.toast(r.message || (r.ok ? '好' : '没成'), r.ok ? 'ok' : 'err')
      await load()
    } finally { setBusy('') }
  }
  const loadPreview = async () => {
    setBusy('preview')
    try {
      const r = await call('/purpose/preview', {})
      setPreview(r.preview || null)
    } finally { setBusy('') }
  }

  if (!d) return h(Card, { title: '目的引擎状态' }, h(Empty, { icon: '⏳', text: '读着呢…' }))
  if (d.ok === false) return h(Card, { title: '目的引擎状态' }, h('div', { className: 'ab-note err' }, '读不到（模块没在跑？）'))
  const s = d.status || {}

  return h(Card, { title: '目的引擎状态', desc: '下面是实际生效的值（不是默认值）：每日上限没单独设时沿用「主动搭话」页的次数上限。' },
    h('div', { className: 'ab-flex', style: { marginBottom: 8 } },
      h('span', { className: 'ab-pill' }, '今天 ' + (s.countToday || 0) + '/' + (s.dailyMax ?? '?') + ' 次'),
      s.nextFireAt ? h('span', { className: 'ab-pill' }, '下次 ' + new Date(s.nextFireAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })) : null,
      s.lastOutcome ? h('span', { className: 'ab-pill' }, '上次 ' + (s.lastOutcome === 'sent' ? '已发送' : s.lastOutcome) + (s.lastSentAt ? ' ' + new Date(s.lastSentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '')) : null),
    h('div', { className: 'ab-small ab-muted', style: { marginBottom: 10 } },
      '实际生效：素材≥' + (s.minMaterials ?? '—')
      + ' · 候选≤' + (s.maxCandidates ?? '—')
      + ' · 每日≤' + (s.dailyMax ?? '—')
      + ' · 已攒素材 ' + (s.materialCount ?? 0)
      + ' · 观察记录 ' + (s.observationCount ?? 0)
      + ' · 挂起目的 ' + (s.pending?.length ?? 0)),
    h('div', { className: 'ab-flex' },
      h(Btn, { small: true, disabled: busy === 'fire', onClick: fire }, busy === 'fire' ? '…' : '现在就让她来找我'),
      h(Btn, { small: true, disabled: busy === 'preview', onClick: loadPreview }, busy === 'preview' ? '…' : '看她在想什么（预览）')),
    preview
      ? h('div', { className: 'ab-small', style: { marginTop: 10, borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 8 } },
          h('div', { style: { marginBottom: 4 } }, '素材 ' + (preview.stats?.total ?? preview.materials?.length ?? 0) + ' 条 · 候选 ' + (preview.candidates || []).length + ' 个：'),
          (preview.candidates || []).slice(0, 6).map((c, i) => h('div', { key: i, className: 'ab-muted', style: { paddingLeft: 10 } }, '· ' + c.text)),
          preview.selected ? h('div', { style: { marginTop: 4 } }, '→ 挑了：' + preview.selected.text) : null)
      : null,
  )
}
