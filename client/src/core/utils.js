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
// 百分数框（0~100）的解析：敲 1 就是 1%，不把 ≤1 当 0~1 小数（旧写法敲 1 直接变 100，
// 和框面「% 插话」的语义打架，2026-11 复核钉死）。清空/非数字/负数落回 0，越界钳到 0~100。
const parsePct = (t) => {
  const n = Number(String(t).trim())
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(Math.min(n, 100))
}
// 数字框的解析（2026-11-24）：**空就是空**，返回 ''。
// 旧的写法把「空」也归一成数字（'' → 0 → 再被 min 夹回去 / 被 fallback 顶回来），于是
// 面板上「群里一条最长」「私聊一条最长」「一轮最多几条」这类框永远清不掉 —— 删光即弹回原值。
// 现在清空就写 ''，后端 normalize 的 num() 把空值当「没填」回落默认值（清空 = 恢复默认）。
// clamp=false 用于输入过程：敲「1」再敲「0」的过程中不该被 min 提前改掉；失焦才夹取。
const parseNumText = (t, { min, max, clamp, step } = {}) => {
  const s = String(t ?? '').trim()
  if (!s) return ''
  // 只认纯数字（可带正负号和小数点）；别的字符一律当「还没输完」，不当数字
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return ''
  const n = Number(s)
  if (!Number.isFinite(n)) return ''
  let v = Number(step || 1) === 1 ? Math.floor(n) : n // 步长是 1 的框按整数语义（3.7 → 3）
  if (clamp) {
    if (min !== undefined && min !== null && v < min) v = min
    if (max !== undefined && max !== null && v > max) v = max
  }
  return v
}
/**
 * 数字框提交时的换算（纯函数，便于测试）：把框里的原文换算成写回配置的值。
 *
 * 返回 `{ value, text }`：
 *   - `value` 是要写回配置草稿的值（数字，或空串 '' = 没填）；
 *   - `text` 是提交后框里该显示什么（空串表示保持空着）。
 *
 * 规则（2026-11-24 定）：空 / 非数字 → 允许留空就写 ''（= 恢复默认），否则落回 min；
 * 有数字就夹到 [min, max]，整数框取整；`scale` 处理「显示单位 ≠ 存储单位」（分钟 ↔ 毫秒）。
 */
const commitNumText = (raw, { min, max, step, allowEmpty, scale } = {}) => {
  const unit = Number(step || 1)
  const parsed = parseNumText(raw, { min, max, clamp: true, step: unit })
  if (parsed === '') {
    if (allowEmpty) return { value: '', text: '' }
    const fallback = min !== undefined && min !== null ? min : (max !== undefined && max !== null ? max : '')
    return { value: fallback === '' ? '' : fallback * (scale || 1), text: fallback === '' ? '' : String(fallback) }
  }
  return { value: parsed * (scale || 1), text: String(parsed) }
}
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

// ---------------- 复制与外部链接 ----------------

// 外链只认 http(s)：别人给的 / 后端返回的地址一律先过这一关，
// 挡住 `javascript:` / `data:` 这类能在宿主页面里执行或内嵌的协议。
const HTTP_URL = /^https?:\/\//i
const isSafeHttpUrl = (url) => HTTP_URL.test(String(url ?? ''))

/**
 * 打开外部链接：非 http(s) 直接拒绝，能打开时一律带 `noopener,noreferrer`
 * （否则 window.open 出来的页面能通过 `window.opener` 反向操作宿主面板）。
 *
 * @param {string} url 目标地址
 * @param {string} [name] 窗口名
 * @param {Function} [open] 打开函数（默认 globalThis.open，单测可注入）
 * @returns {boolean} 是否真的发起了打开
 */
const openExternal = (url, name = '_blank', open = globalThis.open) => {
  const target = String(url ?? '')
  if (!isSafeHttpUrl(target)) return false
  if (typeof open !== 'function') return false
  try {
    return open.call(globalThis, target, name, 'noopener,noreferrer') !== null
  } catch (e) {
    return false
  }
}

/**
 * 局域网 http 下的兜底复制：`navigator.clipboard` 只在安全上下文（https / localhost）
 * 存在，DSH 面板常常跑在 `http://192.168.x.x:port` 上，直接 `navigator.clipboard.writeText`
 * 会抛 TypeError（旧实现整块包在 try 里，于是「复制给 DSH 的话」这类按钮点了直接报错）。
 */
const legacyCopy = (value) => {
  const doc = globalThis.document
  if (!doc || typeof doc.createElement !== 'function' || typeof doc.execCommand !== 'function') return false
  let area = null
  try {
    area = doc.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    doc.body.appendChild(area)
    if (typeof area.select === 'function') area.select()
    return doc.execCommand('copy') === true
  } catch (e) {
    return false
  } finally {
    try { area?.parentNode?.removeChild(area) } catch (e) {}
  }
}

/**
 * 复制文本到剪贴板：先走 `navigator.clipboard`（安全上下文），不行再退回
 * textarea + `document.execCommand('copy')`；**真的写进去了**才提示成功。
 *
 * @param {string} text 要复制的内容
 * @param {Function} toast 提示函数
 * @param {string} [msg] 成功提示语（不填就不提示）
 * @returns {Promise<boolean>} 是否复制成功
 */
const copy = async (text, toast, msg) => {
  const value = String(text ?? '')
  let ok = false
  try {
    if (typeof navigator !== 'undefined' && navigator?.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value)
      ok = true
    }
  } catch (e) {
    ok = false
  }
  if (!ok) ok = legacyCopy(value)
  if (ok) {
    if (msg) toast(msg, 'ok')
    return true
  }
  toast('复制失败，手动选中复制吧', 'err')
  return false
}

export {
  clone, setPath, getPath, pct, cx, parsePct, parseNumText, commitNumText, pitchNum, pitchText, pitchLabel, timeAgo,
  copy, isSafeHttpUrl, openExternal
}
