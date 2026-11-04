// 资讯池面板：订阅源管理 + 池子概览 + 立即拉取。
// 约定：panel.js 拿到的 4 个参数是 (React, h, ui, call)；最后 return 一个组件函数。
// call 已经绑好本模块：call('/rss/overview') → GET /qq-hub/api/rss/overview

const { useState, useEffect } = React
const ago = (t) => { if (!t) return '还没拉过'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.round(m / 60) + ' 小时前' }

return function RssPanel(props) {
  const { Card, Btn, Empty, Row, Switch } = ui
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [probe, setProbe] = useState(null)

  const load = () => call('/rss/overview').then((r) => r && r.ok !== false && setD(r)).catch(() => setD({ ok: false }))
  useEffect(() => { load() }, [])

  // 面板里改订阅列表：直接写进草稿配置，保存后生效
  const feedsOf = () => (Array.isArray(props.draft?.rss?.feeds) ? props.draft.rss.feeds : [])
  const setFeeds = (next) => props.setDraft && props.setDraft((prev) => {
    const cur = prev || {}
    const rss = { ...(cur.rss || {}) }
    rss.feeds = next
    return { ...cur, rss }
  })

  const addFeed = async () => {
    const url = String(newUrl || '').trim()
    if (!url) return
    setBusy('probe')
    setProbe(null)
    try {
      const r = await call('/rss/check?url=' + encodeURIComponent(url))
      if (!r || r.ok === false) { setProbe({ ok: false, msg: r?.message || '这个地址拉不下来' }); return }
      const list = feedsOf()
      if (list.some((f) => (typeof f === 'string' ? f : f.url) === url)) { setProbe({ ok: false, msg: '这个地址已经加过了' }); return }
      setFeeds([...list, { url, title: r.title || '', enabled: true }])
      setProbe({ ok: true, msg: `可以订阅：${r.title || '未命名'}（${r.count} 条）` })
      setNewUrl('')
    } finally { setBusy('') }
  }

  const pullNow = async () => {
    setBusy('pull')
    try {
      const r = await call('/rss/pull')
      props.toast && props.toast(r?.ok ? `新增 ${r.added} 条（池子共 ${r.total} 条）` : (r?.message || '拉取失败'), r?.ok ? 'ok' : 'err')
      await load()
    } finally { setBusy('') }
  }

  if (!d) return h(Card, { title: '资讯池' }, h(Empty, { icon: '⏳', text: '读着呢…' }))
  if (d.ok === false) return h(Card, { title: '资讯池' }, h('div', { className: 'ab-note err' }, '读不到（模块没在跑？）'))

  const list = feedsOf()
  return h('div', { className: 'ab-grid' },
    h(Card, {
      title: '资讯池',
      desc: '把 RSS / Atom 订阅源拉回来存进池子，她需要找话题时自己来查。**不会自动发到群里**，不占群消息配额。',
      right: h(Btn, { small: true, disabled: busy === 'pull', onClick: pullNow }, busy === 'pull' ? '拉着呢…' : '立即拉一次'),
    },
      h(Row, { label: '定时拉取', hint: '开启后按下面的间隔去拉；关掉就只在点「立即拉一次」时拉。' },
        h(Switch, { on: props.draft?.rss?.enabled !== false, onChange: (v) => props.setDraft && props.setDraft((prev) => ({ ...(prev || {}), rss: { ...((prev || {}).rss || {}), enabled: v } })) })),
      h(Row, { label: '多久拉一次（分钟）', hint: '默认 30 分钟。多数源一天也就更新几条，太短是白耗流量。' },
        h('input', {
          className: 'ab-input sm', type: 'number', min: 5, max: 1440,
          value: props.draft?.rss?.intervalMinutes ?? 30,
          onChange: (e) => props.setDraft && props.setDraft((prev) => ({ ...(prev || {}), rss: { ...((prev || {}).rss || {}), intervalMinutes: Number(e.target.value) || 30 } })),
        })),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } },
        `池子 ${d.pool?.total || 0} 条，${ago(d.lastPullAt)}${d.lastAdded ? `，上次新增 ${d.lastAdded} 条` : ''}${d.lastDurationMs ? `，用时 ${(d.lastDurationMs / 1000).toFixed(1)}s` : ''}`),
      Array.isArray(d.lastErrors) && d.lastErrors.length
        ? h('div', { className: 'ab-note err', style: { marginTop: 8 } }, '上次拉取有源失败：' + d.lastErrors.slice(0, 3).join('；'))
        : null,
    ),

    h(Card, { title: '订阅地址', desc: '填 RSS / Atom 地址。加之前会自动试拉一次，拉不通的不会加进来。' },
      h('div', { className: 'ab-flex', style: { marginBottom: 10 } },
        h('input', {
          className: 'ab-input', style: { flex: 1 }, placeholder: 'https://example.com/feed.xml',
          value: newUrl, onChange: (e) => setNewUrl(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') addFeed() },
        }),
        h(Btn, { small: true, disabled: busy === 'probe' || !newUrl, onClick: addFeed }, busy === 'probe' ? '试拉中…' : '添加')),
      probe ? h('div', { className: probe.ok ? 'ab-note' : 'ab-note err', style: { marginBottom: 8 } }, probe.msg) : null,
      list.length ? list.map((f, i) => {
        const url = typeof f === 'string' ? f : f.url
        const title = typeof f === 'string' ? '' : (f.title || '')
        const on = typeof f === 'string' ? true : f.enabled !== false
        const live = (d.feeds || []).find((x) => x.url === url)
        return h(Row, { key: url + i, label: title || url, hint: live?.error ? ('上次失败：' + live.error) : (live?.lastAt ? ('上次拉取 ' + ago(live.lastAt)) : '还没拉过') },
          h(Switch, {
            on, onChange: (v) => {
              const next = list.map((x, j) => {
                if (j !== i) return x
                return typeof x === 'string' ? { url: x, title: '', enabled: v } : { ...x, enabled: v }
              })
              setFeeds(next)
            },
          }),
          h(Btn, { small: true, kind: 'danger', onClick: () => setFeeds(list.filter((_, j) => j !== i)) }, '删'))
      }) : h(Empty, { text: '还没加订阅地址' }),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } },
        '加完记得点下面的保存。保存后模块会按新列表拉取。'),
    ),
  )
}