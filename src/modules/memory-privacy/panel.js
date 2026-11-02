// 记忆分层的面板：看主记忆库和人物小档案在各作用域里各有多少，
// 全局的能直接看，私聊的只给条数不预览。
//
// 以前这个面板只报本模块自己那套 scoped.json，模型几乎不走它，所以永远显示 0 条，
// 看着像没生效。现在以真正在拦截的那套（主记忆库 + 人物小档案）为准。

const { useState, useEffect } = React

return function MemoryPrivacyPanel(props) {
  const { Card, Btn, Empty } = ui
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState('')
  const load = () => call('/memory-privacy/stats').then((r) => setD(r)).catch(() => setD({ ok: false }))
  useEffect(() => { load() }, [])
  const del = async (id) => {
    setBusy(id)
    try {
      const r = await call('/memory/delete', { id })
      props.toast && props.toast(r.ok ? '删掉了' : '没成功', r.ok ? 'ok' : 'err')
      await load()
    } finally { setBusy('') }
  }
  if (!d) return h(Card, { title: '分层情况' }, h(Empty, { icon: '⏳', text: '读着呢…' }))
  if (d.ok === false) return h(Card, { title: '分层情况' }, h('div', { className: 'ab-note err' }, '读不到（扩展模块没在跑？）'))

  const label = (scope) => {
    if (scope === 'global') return '全局（哪里都能用）'
    if (scope.startsWith('private:')) return '私聊 ' + scope.slice(8) + '（只有这个私聊看得到）'
    if (scope.startsWith('group:')) return '群 ' + scope.slice(6) + '（只有这个群看得到）'
    return scope
  }
  const ScopeRows = ({ scopes, emptyText }) => (scopes || []).length
    ? h('div', null, scopes.map((s) => h('div', { key: s.scope, style: { display: 'flex', gap: 8, marginBottom: 4 } },
        h('span', { className: 'ab-small', style: { flex: 1 } }, label(s.scope)),
        h('b', { className: 'ab-small' }, s.n + ' 条'))))
    : h('div', { className: 'ab-small ab-muted' }, emptyText)

  const main = d.main || null
  const profs = d.profiles || null

  return h('div', null,
    h(Card, { title: '分层情况', desc: '私聊里说的事只存在私聊那一层，群里怎么套也读不到——过滤发生在交给模型之前，不是靠她自己守着。' },
      h('div', { className: 'ab-small', style: { fontWeight: 600, marginBottom: 6 } }, '记忆库'),
      main
        ? h('div', null,
            h('div', { className: 'ab-small', style: { marginBottom: 6 } }, `一共 ${main.total} 条（其中私聊 ${main.privateCount} 条，面板不预览）`),
            h(ScopeRows, { scopes: main.scopes, emptyText: '还没有记忆' }))
        : h('div', { className: 'ab-note err' }, '读不到记忆库：' + (d.mainError || '未知')),
      h('div', { className: 'ab-small', style: { fontWeight: 600, margin: '14px 0 6px' } }, '人物小档案（之前私聊私事就是从这里漏到群里的）'),
      profs
        ? h('div', null,
            h('div', { className: 'ab-small', style: { marginBottom: 6 } }, `一共 ${profs.total} 份`),
            h(ScopeRows, { scopes: profs.scopes, emptyText: '还没有小档案' }))
        : null,
      (d.globalItems || []).length
        ? h('div', null,
            h('div', { className: 'ab-small', style: { margin: '14px 0 6px' } }, '本模块全局条目（这些在哪里都会被想到）'),
            d.globalItems.slice().reverse().map((m) => h('div', { key: m.id, style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
              h('span', { className: 'ab-small', style: { flex: 1 } }, m.text),
              h(Btn, { small: true, disabled: busy === m.id, onClick: () => del(m.id) }, busy === m.id ? '…' : '删'))))
        : null)
  )
}
