// 群黑话本的面板：看候选词、一键通过、删掉已批准的。

const { useState, useEffect } = React

return function SlangPanel(props) {
  const { Card, Btn, Empty } = ui
  const [d, setD] = useState(null)
  const [gid, setGid] = useState('')
  const [busy, setBusy] = useState('')
  const [draft, setDraft] = useState({}) // word → 意思
  const load = (g) => call('/list' + (g ? '?gid=' + encodeURIComponent(g) : '')).then((r) => { setD(r); if (r && r.gid) setGid(r.gid) }).catch(() => setD({ ok: false }))
  useEffect(() => { load('') }, [])
  if (!d) return h(Card, { title: '群黑话' }, h(Empty, { icon: '⏳', text: '读着呢…' }))
  if (d.ok === false) return h(Card, { title: '群黑话' }, h('div', { className: 'ab-note err' }, '读不到黑话本（扩展模块没在跑？）'))

  // 没选群的时候：先列有候选的群
  if (!d.gid) {
    const groups = Object.keys(d.pendingCounts || {})
    return h(Card, { title: '群黑话', desc: '挑一个群看它攒下的候选词。' },
      groups.length
        ? h('div', null, groups.map((g) => h('div', { key: g, style: { marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' } },
            h(Btn, { small: true, onClick: () => load(g) }, '群 ' + g),
            h('span', { className: 'ab-small ab-muted' }, `${d.pendingCounts[g]} 个候选`))))
        : h(Empty, { icon: '💬', text: '还没有攒下候选词，群里多聊几句再看' }),
      h('div', { style: { marginTop: 10, display: 'flex', gap: 8 } },
        h('input', { className: 'ab-input', placeholder: '也可以直接填群号', value: gid, onChange: (e) => setGid(e.target.value.replace(/\D/g, '')) }),
        h(Btn, { small: true, disabled: !gid, onClick: () => load(gid) }, '看这个群')))
  }

  const approve = async (word) => {
    setBusy(word)
    try {
      const meaning = String(draft[word] || '')
      const r = await call('/approve', { gid: d.gid, word, meaning })
      props.toast && props.toast(r.ok ? `通过了「${word}」` : (r.message || '没成功'), r.ok ? 'ok' : 'err')
      await load(d.gid)
    } finally { setBusy('') }
  }

  const pending = d.pending || []
  const approved = Object.entries(d.approved || {})
  return h(Card, { title: `群 ${d.gid} 的黑话`, desc: '候选词是她自己从聊天里数出来的；你通过之后，她在**这个群**聊天时才会用上。' },
    h('div', { style: { marginBottom: 10 } }, h(Btn, { small: true, onClick: () => { setGid(''); setD({ ok: true, pendingCounts: d.pendingCounts || {} }) } }, '← 换一个群')),
    h('div', { className: 'ab-small', style: { marginBottom: 6 } }, `候选（${pending.length}）`),
    pending.length
      ? h('div', null, pending.map((x) => h('div', { key: x.word, style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' } },
          h('b', { style: { minWidth: 80 } }, x.word),
          h('span', { className: 'ab-small ab-muted', style: { minWidth: 54 } }, `${x.count} 次`),
          h('input', {
            className: 'ab-input', style: { flex: 1, minWidth: 120 }, placeholder: '它是什么意思 / 怎么用（可不填）',
            value: draft[x.word] || '', onChange: (e) => setDraft({ ...draft, [x.word]: e.target.value }),
          }),
          h(Btn, { small: true, kind: 'primary', disabled: busy === x.word, onClick: () => approve(x.word) }, busy === x.word ? '…' : '通过'))))
      : h(Empty, { icon: '🫧', text: '没有待审的候选词' }),
    h('div', { className: 'ab-small', style: { margin: '14px 0 6px' } }, `已通过（${approved.length}）`),
    approved.length
      ? h('div', null, approved.map(([w, v]) => h('div', { key: w, style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
          h('b', null, w), h('span', { className: 'ab-small ab-muted', style: { flex: 1 } }, v.meaning || '（没写意思）'))))
      : h('div', { className: 'ab-small ab-muted' }, '还没有通过任何词'))
}
