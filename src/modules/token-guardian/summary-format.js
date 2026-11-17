// 压缩摘要的「结构化 → 自然语言」两层。
//
// 为什么分两层（2026-11-17 对照 MaiBot 的 context_compaction 复盘）：
//   - 纯文本摘要最容易丢的是「还没了结的事」和「说好的约定」—— 一段流水账里，
//     这两类信息会被「他们聊了些什么」盖过去，而它们恰恰是下一轮开场最该接的。
//   - 但直接把 JSON 注入上下文会把她带成报表体，破坏拟人感。
// 所以：模型按五类返回（有槽位，丢不掉），代码再渲染回一段连贯口语（注入时像人话）。
//
// 铁律：**解析失败就当纯文本用**。摘要本身是锦上添花，绝不能因为模型没按格式返回
// 就让整次压缩失败（那样等于把她对更早对话的记忆直接清空）。

/** 五类槽位。顺序即「先讲什么」的顺序，渲染时按这个顺序拼。 */
export const SUMMARY_FIELDS = Object.freeze(['topics', 'background', 'progress', 'pending', 'agreements'])

/** 渲染时的引导语：让五段拼起来像一段话，而不是五个小标题。 */
const RENDER_LEAD = Object.freeze({
  topics: '之前主要在聊',
  background: '背景是',
  progress: '说到的有',
  pending: '还没了结的有',
  agreements: '你们之前说好',
})

/** 每条单独渲染时最多留多少字（整个摘要另有 summaryMaxChars 总闸）。 */
const ITEM_MAX_CHARS = 80

/** 一条合法字符串：去空白、去首尾标点、截断。 */
function cleanItem(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  // 按 code point 切，不切坏 emoji
  const points = Array.from(text)
  return points.length <= ITEM_MAX_CHARS ? text : points.slice(0, ITEM_MAX_CHARS - 1).join('') + '…'
}

/**
 * 从模型输出里抠出五类字段。容忍：代码块外壳、前后多余的解释、字段名大小写、
 * 数组里混进对象/数字（丢掉）。**任何不合规都返回 null**（调用方退回纯文本）。
 */
export function parseStructuredSummary(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  let body = text
  // 剥 markdown 代码块外壳（模型很爱包 ```json）
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fence) body = fence[1].trim()
  // 抠第一个 { 到最后一个 }（前后可能带「好的，摘要如下：」这类废话）
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const out = {}
  let filled = 0
  for (const field of SUMMARY_FIELDS) {
    // 模型偶尔会把字段名写成大写或带空格，按小写归位
    const key = Object.keys(parsed).find((k) => String(k).trim().toLowerCase() === field)
    const list = key === undefined ? [] : parsed[key]
    const items = (Array.isArray(list) ? list : list ? [list] : [])
      .map(cleanItem)
      .filter(Boolean)
    out[field] = items
    if (items.length) filled += 1
  }
  // 五类全空 / 只有一类有东西且看起来不像摘要 —— 都不算解析成功，让调用方退回纯文本
  if (!filled) return null
  return out
}

/**
 * 把结构化摘要渲染成一段连贯的中文（注入上下文用）。
 * 刻意不输出列表/标题：她在群里说话时不该像在读会议纪要。
 */
export function renderStructuredSummary(structured) {
  if (!structured || typeof structured !== 'object') return ''
  const parts = []
  for (const field of SUMMARY_FIELDS) {
    // 这里再过一遍 cleanItem：render 也可能吃到从磁盘读回来的旧数据或测试手搓的对象，
    // 不能只依赖 parse 阶段清洗（否则一条 200 字的长句会原样撑爆摘要）。
    const items = (Array.isArray(structured[field]) ? structured[field] : []).map(cleanItem).filter(Boolean)
    if (!items.length) continue
    parts.push(`${RENDER_LEAD[field]}${items.join('；')}`)
  }
  if (!parts.length) return ''
  // 段间用句号收，读起来是一段话；段内已经是分号
  return parts.join('。') + '。'
}

/** 摘要里有没有「还没了结的事」—— 面板和日志用得上。 */
export function countPending(structured) {
  if (!structured || typeof structured !== 'object') return 0
  const list = Array.isArray(structured.pending) ? structured.pending : []
  return list.filter(Boolean).length
}

/**
 * 组装压缩用的 system prompt。
 *
 * @param {object} o
 * @param {string} o.name 她在这个聊天里的名字（摘要口径跟着人设卡走）
 * @param {number} o.maxChars 渲染后全文的字数上限
 * @param {boolean} [o.hasPrev] 输入里是否带上一份摘要（带的话是「合并」不是「重写」）
 * @param {string[]} [o.threadLines] 挂起线索账本里仍在等的线索（一行一条），让她并入 pending 而不是重新发现
 * @returns {string}
 */
export function buildSummaryPrompt({ name, maxChars, hasPrev = false, threadLines = [] } = {}) {
  const who = String(name || '她')
  const limit = Math.max(200, Math.round(Number(maxChars) || 1200))
  const lines = []
  lines.push(`你是「${who}」的记忆整理助手。把下面的聊天整理成一份供后续对话参考的摘要。`)
  if (hasPrev) {
    lines.push('开头带【更早聊天的摘要】，那是上一份检查点：保留仍然成立的事实、丢掉已经过时的、把新内容并进去，输出**一份**合并后的结果，不要照抄也不要分两截。')
  }
  lines.push('按下面五类返回，每条信息只放一处，没有内容就给空数组：')
  lines.push('- topics 正在聊什么：当前的话题，以及必要的指代关系（「他」「那个东西」指的是谁、是什么）。')
  lines.push('- background 背景：相关的人物、关系和事件背景。每条写清是谁说的，并区分事实、转述、猜测、玩笑。')
  lines.push('- progress 进展：重要互动、有效结论、已经做完的事。以实际结果为准 —— 只是答应或批准了不算做完。')
  lines.push('- pending 还没了结的：没答的问题、没做完的事、答应过的事。写明是谁的，能合并的合并成一条。不要从玩笑话里推待办。')
  lines.push('- agreements 说好的事：对话里明确提出、对后面仍然有效的要求，写明是谁提的。已经过期或不适用的去掉。')
  lines.push('')
  lines.push('要求：')
  lines.push('- 最后一条用户发言按原意保留，别只写成「聊了某事」。')
  lines.push('- 不要评价、不要编造、不要推测没有发生的事。')
  lines.push(`- 每类最多 6 条，每条不超过 60 字；渲染成一段话后合计 ${limit} 字以内。`)
  if (threadLines.length) {
    lines.push('')
    lines.push('下面是她自己记下的、还挂着的线索。请把它们并进 pending（已经在这段对话里了结的可以去掉，但不要凭空多写）：')
    for (const line of threadLines) lines.push(`- ${line}`)
  }
  lines.push('')
  lines.push('只输出 JSON 对象，不要代码块、不要解释、不要开场白：')
  lines.push('{"topics":[],"background":[],"progress":[],"pending":[],"agreements":[]}')
  return lines.join('\n')
}

/** 挂起线索类型 → 中文短语（喂给模型的输入用）。 */
const THREAD_TYPE_LABEL = Object.freeze({
  temporary_leave: '暂时离开',
  promise: '答应了某事',
  question_pending: '问出去还没答',
  topic_postponed: '话题被打断',
})

/**
 * 压缩原文字幕里的说话人标签。
 *
 * 她自己统一叫「你」—— chatlog 里 bot 的 who 是 `'bot'`（不是 `'self'`），判错了摘要里会
 * 全是「对方」，分不清哪句是她说的，摘要质量直接废掉一半（2026-11-05 线上复盘）。
 *
 * 其他人用**真实群名片**（2026-11-17）：以前一律塌缩成「对方」，群聊里八个人全叫「对方」，
 * 模型只能写出「对方说 A、对方又说 B」，下一轮就把 A 的经历安到 B 头上（issue #2366 同源问题）。
 * 名片可能带换行/全角冒号，会把「名字：正文」的行结构弄垮，先中和掉。
 */
export function speakerLabel(record) {
  const who = String(record?.who || '').trim()
  if (who === 'bot' || who === 'self') return '你'
  if (!who) return '对方'
  // 纯数字（只有 QQ 号、没有名片）没有可读性，仍然用「对方」；私聊本来也就一个人
  if (/^\d{5,}$/.test(who)) return '对方'
  const clean = who.replace(/[\r\n\t]+/g, ' ').replace(/[：:]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return '对方'
  const points = Array.from(clean)
  return points.length <= 16 ? points.join('') : points.slice(0, 15).join('') + '…'
}

/** 把账本里的一条线索渲染成一行（喂模型用）。 */
export function threadLine(thread) {
  if (!thread || typeof thread !== 'object') return ''
  const summary = String(thread.summary || '').replace(/\s+/g, ' ').trim()
  if (!summary) return ''
  const label = THREAD_TYPE_LABEL[thread.type] || '挂着的事'
  return `${label}：${summary}`
}
