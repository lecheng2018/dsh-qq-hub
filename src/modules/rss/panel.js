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
  /** 改 rss 下的任意子字段（比如 digest.*）：一律函数式更新，别拿旧快照重建 */
  const setDraftRss = (key, value) => props.setDraft && props.setDraft((prev) => {
    const cur = prev || {}
    const rss = { ...(cur.rss || {}) }
    rss[key] = value
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

    h(Card, {
      title: '每日精选',
      desc: '每天到点从池子里挑几条，让她用群友的口气说出来（不是资讯播报）。走的是模型筛选，每条都要调一次，所以默认关。',
      right: h(Btn, { small: true, disabled: busy === 'digest', onClick: async () => {
        setBusy('digest')
        try {
          const r = await call('/rss/digest-now')
          props.toast && props.toast(r?.ok ? `挑了 ${r.count} 条发出去了` : (r?.message || '没挑成'), r?.ok ? 'ok' : 'err')
          await load()
        } finally { setBusy('') }
      } }, busy === 'digest' ? '挑着呢…' : '现在精选一次'),
    },
      h(Row, { label: '开起来', hint: '关掉就只有群友问她时才查，不主动发。' },
        h(Switch, {
          on: props.draft?.rss?.digest?.enabled === true,
          onChange: (v) => setDraftRss('digest', { ...(props.draft?.rss?.digest || {}), enabled: v }),
        })),
      h(Row, { label: '每天几点发', hint: '24 小时制。到点那一小时内会发一次，重启也不会重复发。' },
        h('input', {
          className: 'ab-input sm', type: 'number', min: 0, max: 23,
          value: props.draft?.rss?.digest?.hour ?? 9,
          onChange: (e) => setDraftRss('digest', { ...(props.draft?.rss?.digest || {}), hour: Number(e.target.value) }),
        })),
      h(Row, { label: '每次几条', hint: '1~6 条。太多就成资讯播报了。' },
        h('input', {
          className: 'ab-input sm', type: 'number', min: 1, max: 6,
          value: props.draft?.rss?.digest?.count ?? 3,
          onChange: (e) => setDraftRss('digest', { ...(props.draft?.rss?.digest || {}), count: Number(e.target.value) }),
        })),
      h(Row, { label: '发到哪', hint: '留空 = 发主人私聊。也可以填 group:群号 发到某个群。' },
        h('input', {
          className: 'ab-input', style: { width: '100%' }, placeholder: '留空发私聊 / group:123456789',
          value: props.draft?.rss?.digest?.target || '',
          onChange: (e) => setDraftRss('digest', { ...(props.draft?.rss?.digest || {}), target: e.target.value.trim() }),
        })),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } },
        d.digest?.lastAt ? `上次发：${ago(d.digest.lastAt)}，${d.digest.lastCount} 条` : '还没发过'),
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