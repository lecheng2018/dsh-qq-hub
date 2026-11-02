// 记忆分层的面板：看各作用域存了多少条、全局记忆能直接看和删，私聊的只给条数不预览。

const { useState, useEffect } = React

return function MemoryPrivacyPanel(props) {
  const { Card, Btn, Empty } = ui
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState('')
  const load = () => call('/memory-privacy/stats').then((r) => setD(r)).catch(() => setD({ ok: false }))
  useEffect(() => { load() }, [])
  const del = async (id) => {
    setBusy(id)
    try { const r = await call('/memory-privacy/delete', { id }); props.toast && props.toast(r.ok ? '删掉了' : '没成功', r.ok ? 'ok' : 'err'); await load() } finally { setBusy('') }
  }
  if (!d) return h(Card, { title: '分层情况' }, h(Empty, { icon: '⏳', text: '读着呢…' }))
  if (d.ok === false) return h(Card, { title: '分层情况' }, h('div', { className: 'ab-note err' }, '读不到（扩展模块没在跑？）'))

  const label = (scope) => {
    if (scope === 'global') return '全局（哪里都能用）'
    if (scope.startsWith('private:')) return '私聊 ' + scope.slice(8) + '（只有这个私聊看得到）'
    if (scope.startsWith('group:')) return '群 ' + scope.slice(6) + '（只有这个群看得到）'
    return scope
  }

  return h(Card, { title: '分层情况', desc: '私聊里说的事只存在私聊那一层，群里怎么套也读不到——过滤发生在交给模型之前，不是靠她自己守着。' },
    h('div', { className: 'ab-small', style: { marginBottom: 8 } }, `一共 ${d.total} 条`),
    (d.scopes || []).length
      ? h('div', null, d.scopes.map((s) => h('div', { key: s.scope, style: { display: 'flex', gap: 8, marginBottom: 4 } },
          h('span', { className: 'ab-small', style: { flex: 1 } }, label(s.scope)),
          h('b', { className: 'ab-small' }, s.n + ' 条'))))
      : h(Empty, { icon: '🧠', text: '还没有分层记忆，她记东西时会自动分' }),
    h('div', { className: 'ab-small', style: { margin: '14px 0 6px' } }, '全局记忆（这些在哪里都会被想到）'),
    (d.globalItems || []).length
      ? h('div', null, d.globalItems.slice().reverse().map((m) => h('div', { key: m.id, style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
          h('span', { className: 'ab-small', style: { flex: 1 } }, m.text),
          h(Btn, { small: true, disabled: busy === m.id, onClick: () => del(m.id) }, busy === m.id ? '…' : '删'))))
      : h('div', { className: 'ab-small ab-muted' }, '还没有全局记忆'))
}
