/**
 * 「现在是不是她醒着的时间」。
 *
 * 审计 T3.11：companion / qzone-social / speakup 各自抄了一份小时判断，三份语义并不一致：
 * qzone 用 `h < from || h >= to` —— 对 20:00→04:00 这种跨午夜窗口，晚上 20~23 点会被
 * 判成「睡着」，凌晨反而醒着；对 0→24 全天窗口也是错的。这里只留一份真相：
 *
 * · awakeFrom === awakeTo（模 24）或 0 → ≥24：全天醒着；
 * · awakeFrom < awakeTo：普通窗口 [from, to)；
 * · awakeFrom > awakeTo：跨午夜窗口 [from, 24) ∪ [0, to)。
 *
 * @param {number} [now]
 * @param {number} [awakeFrom]
 * @param {number} [awakeTo]
 * @returns {boolean}
 */
export function isAwakeAt(now = Date.now(), awakeFrom = 0, awakeTo = 24) {
  const from = Number(awakeFrom)
  const to = Number.isFinite(Number(awakeTo)) ? Number(awakeTo) : 24
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true
  if ((from === 0 && to >= 24) || ((from % 24) === (to % 24))) return true
  const h = new Date(now).getHours()
  const f = ((from % 24) + 24) % 24
  const t = to >= 24 ? 24 : ((to % 24) + 24) % 24
  return f < t ? (h >= f && h < t) : (h >= f || h < t)
}
