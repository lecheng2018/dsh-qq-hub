// 时间锚。
//
// QQ 消息本身不带时间戳，模型看到的历史全是「某某：一句话」，分不出这条是刚说的还是两小时前的。
// DSH 自带的 @deepseek-ai/dsh-time-context 会注入一行时间，但有三个问题：
//   1. 默认 refreshIntervalMs = 10 分钟，10 分钟内不重复注入 —— 连续聊天时她的「现在」是冻住的
//      （实测：19:42 注入一次，19:42 和 19:50 两条消息都没有新时间，她手里还是 19:42）；
//   2. 那行是英文，夹在提示词末尾，还得跟一整段中文角色扮演抢注意力；
//   3. 消息本身仍然没有时间，所以「两个小时前叫我去睡觉」里的「两个小时前」没有锚。
//
// 所以这里自己补中文时间行，每轮现算，不走缓存；群聊再给每条消息标一个「（2 小时前）」。
// 只在发给模型的文本里用，绝不影响发到 QQ 的内容。

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const pad = (n) => String(n).padStart(2, '0')

/** 11-05 22:03（周三） */
export function stamp (ms) {
  const d = new Date(Number(ms) || Date.now())
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（${WEEK[d.getDay()]}）`
}

/** 2 小时 7 分钟 / 8 分钟 / 3 天 2 小时 */
export function formatGap (ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0))
  const min = Math.floor(n / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟`
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h < 24) return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
  const d = Math.floor(h / 24)
  const hh = h % 24
  return hh ? `${d} 天 ${hh} 小时` : `${d} 天`
}

/**
 * 每一轮放在 QQ 消息最前面的那行。
 * @param {number} nowMs 现在
 * @param {number} [lastMs] 上一次把消息交给她是什么时候；不传就只报现在
 * @param {{what?:string}} [o] what = 「上一条消息」/「上一段消息」
 */
export function nowLine (nowMs, lastMs, o = {}) {
  const now = Number(nowMs) || Date.now()
  const head = `【现在】${stamp(now)}`
  const last = Number(lastMs) || 0
  if (!last || last > now) return head
  const what = o.what || '上一条消息'
  return `${head}｜距${what} ${formatGap(now - last)}`
}

/** 群聊每条消息后面的相对时间；1 分钟以内不标（免得满屏「刚刚」），够久才标。 */
export function agoLabel (tsMs, nowMs, { minGapMs = 60_000 } = {}) {
  const ts = Number(tsMs) || 0
  const now = Number(nowMs) || Date.now()
  if (!ts || ts > now) return ''
  const gap = now - ts
  if (gap < minGapMs) return ''
  return `（${formatGap(gap)}前）`
}
