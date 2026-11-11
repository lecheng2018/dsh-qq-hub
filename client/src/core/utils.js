const clone = (o) => JSON.parse(JSON.stringify(o))
const setPath = (obj, path, value) => {
  // 面板刚打开时 draft 可能还是 null，直接 clone 会在下一行炸，兜成空对象
  const next = clone(obj == null ? {} : obj)
  let cur = next
  const ks = path.split('.')
  for (let i = 0; i < ks.length - 1; i++) cur = cur[ks[i]] = cur[ks[i]] || {}
  cur[ks[ks.length - 1]] = value
  return next
}
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
const pct = (v) => Math.round((Number(v) || 0) * 100)
const cx = (...a) => a.filter(Boolean).join(' ')
// 音调存的是 '+20Hz' 这种字符串，滑条要数字；合法范围 ±80Hz（再往上 edge-tts 服务端会夹）
const pitchNum = (s) => {
  const m = /^([+-]?\d+)Hz$/i.exec(String(s || ''))
  return m ? Math.max(-80, Math.min(80, Number(m[1]))) : 0
}
const pitchText = (n) => (n < 0 ? '-' : '+') + Math.abs(n) + 'Hz'
const pitchLabel = (n) => (n === 0 ? '正常（+0Hz）' : (n > 0 ? '+' : '') + n + ' Hz')
const timeAgo = (t) => {
  if (!t) return '—'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
  return new Date(t).toLocaleDateString()
}

// ---------------- 样式（只注入一次） ----------------

const copy = (text, toast, msg) => {
  try {
    navigator.clipboard.writeText(text)
    if (msg) toast(msg, 'ok')
  } catch (e) {
    toast('复制失败，手动选中复制吧', 'err')
  }
}

export {
  clone, setPath, getPath, pct, cx, pitchNum, pitchText, pitchLabel, timeAgo, copy
}
