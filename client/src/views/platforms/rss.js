import { h } from '../../core/react.js'
import { Card, Row, Switch } from '../../ui/primitives.js'
import { useField } from '../../ui/form.js'

function RssPage({ draft, setDraft }) {
  const rss = (draft && draft.rss) || {}
  return h('div', { className: 'ab-grid' },
    h(Card, {
      title: '资讯池',
      desc: '把 RSS / Atom 订阅源拉回来存进池子，她需要找话题时自己来查。不会自动发到群里，不占群消息配额。',
      right: h(Switch, { on: rss.enabled !== false, onChange: (v) => setDraft((prev) => ({ ...(prev || {}), rss: { ...((prev || {}).rss || {}), enabled: v } })) }),
    },
      h('div', { className: 'ab-small ab-muted' }, rss.enabled === false ? '现在是关着的。打开上面的开关并保存，才会定时去拉订阅源。' : '开着：会按下面的间隔定时拉取。')),
  )
}

export { RssPage }
