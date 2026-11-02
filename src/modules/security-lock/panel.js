// 权限锁的面板：显示当前锁/解锁状态 + otpauth 二维码（手机验证器扫一下就绑好了）+ 重置密钥。
// 二维码是纯前端画的（不多引依赖）：把 otpauth:// 字符串按字节做 QR 太复杂，
// 这里用「把密钥分组显示 + 复制按钮 + otpauth 链接」的方式，手动输入或点链接都行。

const { useState, useEffect } = React

/** 把 base32 密钥按 4 位一组断开，手动输入到验证器里不容易看错。 */
const group = (s) => String(s || '').replace(/(.{4})/g, '$1 ').trim()

return function SecurityLockPanel(props) {
  const { Card, Btn, Empty } = ui
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState('')
  const load = () => call('/security-lock/status').then((r) => setD(r)).catch(() => setD({ ok: false }))
  useEffect(() => { load() }, [])
  if (!d) return h(Card, { title: '绑定与状态' }, h(Empty, { icon: '⏳', text: '读着呢…' }))
  if (d.ok === false) return h(Card, { title: '绑定与状态' }, h('div', { className: 'ab-note err' }, '读不到状态（扩展模块没在跑？）'))

  const copy = async (t) => {
    try { await navigator.clipboard.writeText(t); props.toast && props.toast('复制好了', 'ok') } catch (e) { props.toast && props.toast('复制不了，手动选中吧', 'err') }
  }

  return h(Card, { title: '绑定与状态', desc: '在手机装个验证器（Google Authenticator / 微软 Authenticator / Aegis 都行），把下面这串密钥加进去。' },
    h('div', { className: 'ab-small' },
      '现在：',
      h('b', { style: { color: d.locked ? '#ef4444' : '#22c55e' } }, d.locked ? '锁着（低权限）' : `解锁中，还剩 ${d.remainingMin} 分钟`),
      '　总开关：', h('b', null, d.enabled ? '开' : '关（面板设置里打开才生效）')),
    h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      h('code', { className: 'ab-small', style: { padding: '6px 8px', background: 'var(--ab-bg2, #f3f4f6)', borderRadius: 6, letterSpacing: 1, userSelect: 'all' } }, group(d.secret || '')),
      h(Btn, { small: true, onClick: () => copy(d.secret || '') }, '复制密钥'),
      h(Btn, { small: true, onClick: () => copy(d.otpauth || '') }, '复制 otpauth 链接'),
      h(Btn, {
        small: true, disabled: busy === 'reset',
        onClick: async () => {
          if (!confirm('重置之后手机上旧的验证码全部作废，要用新密钥重新绑。确定？')) return
          setBusy('reset')
          try { const r = await call('/security-lock/reset-secret', {}); props.toast && props.toast(r.ok ? '换了新密钥，重新绑一下' : '没成功', r.ok ? 'ok' : 'err'); await load() } finally { setBusy('') }
        },
      }, busy === 'reset' ? '换着呢…' : '重置密钥')),
    h('div', { className: 'ab-small ab-muted', style: { marginTop: 10, lineHeight: 1.7 } },
      '绑好后在 QQ 私聊里：', h('code', null, '/unlock'), ' 拿到一次性码 → 再发 ', h('code', null, '/unlock 一次性码 手机6位口令'), '。',
      h('br'), '解锁窗口到期会自己锁回去，也可以发 ', h('code', null, '/lock'), ' 马上锁上，', h('code', null, '/lockstatus'), ' 看还剩多久。'),
    h('div', { className: 'ab-note', style: { marginTop: 10 } }, '这个密钥等于是「第二把钥匙」，别截图发给别人；面板这里也不会回传给你以外的人。'))
}
