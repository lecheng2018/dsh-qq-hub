// 记忆分层的面板：看主记忆库和人物小档案在各作用域里各有多少，
// 全局的能直接看，私聊的默认只给条数不预览（可在设置里打开预览开关调试）。
//
// 以前这个面板只报本模块自己那套 scoped.json，模型几乎不走它，所以永远显示 0 条，
// 看着像没生效。现在以真正在拦截的那套（主记忆库 + 人物小档案）为准。
//
// 每个分区支持：
// - 查看该分区记忆（弹窗列表）
// - 单分区隔离开关（强制不隔离 → global 也可见）
// - 清空本分区（本模块 scoped.json + 主记忆库，二次确认）
// - 过滤日志（最近 200 次投喂中被拦掉的跨域记忆）

const { useState, useEffect } = React

return function MemoryPrivacyPanel(props) {
  const { Card, Btn, Empty } = ui
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState('')
  const [viewing, setViewing] = useState(null)   // 正在查看的分区 scope
  const [viewItems, setViewItems] = useState(null)
  const [confirming, setConfirming] = useState('') // 清空二次确认
  const load = () => call('/memory-privacy/stats').then((r) => setD(r)).catch(() => setD({ ok: false }))
  useEffect(() => { load() }, [])

  const toast = (msg, kind) => props.toast && props.toast(msg, kind)

  const del = async (id) => {
    setBusy(id)
    try {
      const r = await call('/memory/delete', { id })
      toast(r.ok ? '删掉了' : '没成功', r.ok ? 'ok' : 'err')
      await load()
    } finally { setBusy('') }
  }

  // 查看分区：list 接口 preview=1 时私聊分区也返回原文
  const viewScope = async (scope) => {
    setViewing(scope)
    setViewItems(null)
    try {
      const r = await call('/memory-privacy/list?all=1&preview=1')
      setViewItems((r.items || []).filter((m) => String(m.scope || 'global') === scope))
    } catch (error) { setViewItems([]) }
  }
  const clearScope = async (scope, which) => {
    setBusy('clear:' + scope + ':' + which)
    try {
      const r = await call(which === 'main' ? '/memory-privacy/clear-main' : '/memory-privacy/clear-scope', { scope })
      toast(r.message || (r.ok ? '清空了' : '没成功'), r.ok ? 'ok' : 'err')
      await load()
    } finally { setBusy('') }
  }
  const setOverride = async (scope, mode) => {
    setBusy('ov:' + scope)
    try {
      const r = await call('/memory-privacy/set-override', { scope, mode })
      toast(r.message || '已切换', r.ok ? 'ok' : 'err')
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
  const badge = (scope) => {
    if (scope === 'global') return { text: '通用', style: { background: '#2b3a55', color: '#cfe3ff' } }
    if (scope.startsWith('private:')) return { text: '私聊 ' + scope.slice(8), style: { background: '#3d2b2b', color: '#ffc9c9' } }
    if (scope.startsWith('group:')) return { text: '群 ' + scope.slice(6), style: { background: '#2b3d2f', color: '#c9f0d2' } }
    return { text: scope, style: {} }
  }

  // 单个分区行：条数 + 查看 + 隔离开关 + 清空
  const ScopeRow = ({ scope, n }) => {
    const isGlobal = scope === 'global'
    const opened = (d.overrides || {})[scope] === 'open'
    const key = scope
    return h('div', { key, style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' } },
      h('span', { className: 'ab-small', style: { flex: 1, minWidth: 160 } },
        label(scope), ' ', h('b', null, n + ' 条'),
        opened ? h('span', { className: 'ab-small', style: { color: '#e8b339', marginLeft: 6 } }, '⚠ 不隔离') : null),
      h(Btn, { small: true, onClick: () => viewScope(scope) }, '查看'),
      !isGlobal
        ? h(Btn, { small: true, disabled: busy === 'ov:' + scope, onClick: () => setOverride(scope, opened ? '' : 'open') },
            opened ? '恢复隔离' : '不隔离')
        : null,
      confirming === 'cs:' + scope
        ? h(Btn, { small: true, onClick: () => { setConfirming(''); clearScope(scope, 'scoped') } }, '确认清空(分层)')
        : h(Btn, { small: true, onClick: () => setConfirming('cs:' + scope) }, '清空分层'),
      confirming === 'cm:' + scope
        ? h(Btn, { small: true, onClick: () => { setConfirming(''); clearScope(scope, 'main') } }, '确认清空(主库)')
        : h(Btn, { small: true, onClick: () => setConfirming('cm:' + scope) }, '清空主库'),
    )
  }

  // 查看弹窗
  const viewer = viewing
    ? h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' },
        onClick: (e) => { if (e.target === e.currentTarget) setViewing(null) } },
        h('div', { style: { background: 'var(--ab-panel-bg, #1a1f2b)', borderRadius: 10, padding: 16, maxWidth: 520, width: '86%', maxHeight: '72vh', overflow: 'auto' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
            h('b', { className: 'ab-small' }, '分区记忆：' + label(viewing)),
            h(Btn, { small: true, onClick: () => setViewing(null) }, '关')),
          viewItems === null
            ? h('div', { className: 'ab-small ab-muted' }, '读着呢…')
            : viewItems.length
              ? viewItems.slice().reverse().map((m) => h('div', { key: m.id, style: { borderBottom: '1px solid rgba(255,255,255,.08)', padding: '6px 0' } },
                  h('div', { className: 'ab-small' }, m.text),
                  h('div', { className: 'ab-small ab-muted' }, new Date(m.at).toLocaleString(), ' · ', badge(String(m.scope || 'global')).text)))
              : h('div', { className: 'ab-small ab-muted' }, '这个分区还没有记忆')))
    : null

  const main = d.main || null
  const profs = d.profiles || null

  return h('div', null,
    h(Card, { title: '分层情况', desc: '私聊里说的事只存在私聊那一层，群里怎么套也读不到——过滤发生在交给模型之前，不是靠她自己守着。' },
      h('div', { className: 'ab-small', style: { fontWeight: 600, marginBottom: 6 } }, '记忆库'),
      main
        ? h('div', null,
            h('div', { className: 'ab-small', style: { marginBottom: 6 } }, `一共 ${main.total} 条`),
            (main.scopes || []).length
              ? main.scopes.map((s) => h(ScopeRow, { key: s.scope, scope: s.scope, n: s.n }))
              : h('div', { className: 'ab-small ab-muted' }, '还没有记忆'))
        : h('div', { className: 'ab-note err' }, '读不到记忆库：' + (d.mainError || '未知')),
      h('div', { className: 'ab-small', style: { fontWeight: 600, margin: '14px 0 6px' } }, '人物小档案（之前私聊私事就是从这里漏到群里的）'),
      profs
        ? h('div', null,
            h('div', { className: 'ab-small', style: { marginBottom: 6 } }, `一共 ${profs.total} 份`),
            (profs.scopes || []).length
              ? profs.scopes.map((s) => h(ScopeRow, { key: 'p:' + s.scope, scope: s.scope, n: s.n }))
              : h('div', { className: 'ab-small ab-muted' }, '还没有小档案'))
        : null,
      (d.globalItems || []).length
        ? h('div', null,
            h('div', { className: 'ab-small', style: { margin: '14px 0 6px' } }, '本模块全局条目（这些在哪里都会被想到）'),
            d.globalItems.slice().reverse().map((m) => h('div', { key: m.id, style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
              h('span', { className: 'ab-small', style: { flex: 1 } }, m.text),
              h(Btn, { small: true, disabled: busy === m.id, onClick: () => del(m.id) }, busy === m.id ? '…' : '删'))))
        : null),
    h(Card, { title: '跨域隔离说明', desc: '记忆过滤现在在主记忆库（recallHint/检索）发生：私聊记忆只进对应私聊的检索索引，群聊物理上拿不到。单会话隔离开关（上面每行的「不隔离」）是唯一的例外通道，开了会在状态列标黄。' },
      h('div', { className: 'ab-small ab-muted' }, '旧版「每轮固定注入 4 条分层记忆」已停用：主库按查询检索 + 作用域过滤更准，也不占每轮上下文。scoped.json 的存量条目已一次性迁移进主库（作用域原样保留）。')),
    viewer,
  )
}
