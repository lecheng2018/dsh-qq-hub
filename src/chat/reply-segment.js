// 回复指令解析、气泡拆分/合并/上限裁剪、语气规则、语音识别与气泡间隔计算。

import { sanitizeOutbound, isSilence } from './reply-sanitize.js'
import { protectCode, stripMarkdown } from './reply-markdown.js'
import { isLongDocument, splitDocumentBySections } from './reply-document.js'

const MAX_BUBBLES = 6

/**
 * 解析一轮回复。
 * @param {string} text 模型这一轮的最终正文
 * @returns {{silent: boolean, items: Array<{kind:'text'|'voice'|'sticker'|'image', value:string, replyTo?:string}>}}
 */
export function parseReply(text, rules = {}) {
  let raw = sanitizeOutbound(text).trim()
  if (isSilence(raw)) return { silent: true, items: [] }
  // 报告标记（1.3.48）：<report>…</report> 里的内容是「给主人看的数据」。
  // 摘出来当**一条**整段气泡（在 ||| 拆分之前摘，标记里的空行不能当气泡边界）；
  // 标记外的部分照常走 ||| 分条（开场白归聊天）。模型偶尔忘了闭合：从开标记到结尾都算报告。
  let reportRaw = ''
  let reportBody = ''
  const reportMatch = raw.match(/<report>([\s\S]*?)<\/report>/) || raw.match(/<report>([^]*)$/)
  if (reportMatch) {
    reportRaw = reportMatch[1].trim()
    reportBody = stripMarkdown(reportRaw)
    raw = (raw.slice(0, reportMatch.index) + raw.slice(reportMatch.index + reportMatch[0].length)).trim()
    if (isSilence(raw) && isSilence(reportBody)) return { silent: true, items: [] }
  }
  // T3.11：切 ||| / 匹配 <voice>/<sticker>/<poke> 之前先把代码块换成占位符 ——
  // 代码里出现的 ||| 不该被当成气泡边界，标签字样也不该被当成真的语音/表情。
  // 最后的 restore 在返回前统一做（stripMarkdown 内部自己也 mask，二者互不干扰）。
  const codeGuard = protectCode(raw)
  raw = codeGuard.text
  const hardLimit = Math.max(1, Math.round(Number(rules.maxBubbles) || MAX_BUBBLES))
  // 她自己用 ||| 划出来的气泡数：这是**硬边界**，场景软顶（四态收尾礼让、群聊紧缩）只能压
  // 「自动切出来」的气泡，不能把她的边界粘回去。真机 2026-11-24 08:16：对方回短句 → 趋势
  // 向下 → 礼让 maxBubbles=1 → 她写的三条被 capBubbles 合成一条带换行的长消息，QQ 上看起来
  // 就是「||| 不生效」（同一天 08:18、08:21 又各复现一次）。
  const explicitBubbles = raw.split('|||').filter((bubble) => {
    const part = bubble.trim()
    return part && !isSilence(part)
  }).length
  const items = []
  // 代码占位符的还原器：文档判定/分章要用「还原后的原文」（否则代码被换成令牌后
  // 文本长度骤减，isLongDocument 的长度闸门会把长文档误判成闲聊，整篇挤成一条）。
  const meta = { docSplit: false, hardLimit, restoreCode: codeGuard.restoreFenced }
  for (const bubble of raw.split('|||')) {
    const part = bubble.trim()
    if (!part) continue
    // 每个 ||| 气泡内独立维护 replyTo，避免跨气泡泄漏到下一条无关气泡。
    let replyTo = ''
    const attach = (from) => {
      if (replyTo && items.length > from) {
        items[from].replyTo = replyTo
        replyTo = ''
      }
    }
    // 依次切出 reply / voice / sticker / markdown 图片，其余是文字
    // 兼容 <reply:…>、<reply：…>（全角冒号）、[reply:…]、[reply：…] 及 <reply:[3]>（方括号包裹编号）；
    // 具体能不能对上人由投递层查 refs 决定——对不上就当没写引用、照常发（见 reply-delivery）。
    const re = /<poke\s*\/?>|<reply[:：]\s*([^<>|\n]{1,40}?)\s*>|\[reply[:：]\s*([^\]\[|\n]{1,40}?)\s*\]|<voice>([\s\S]*?)<\/voice>|<sticker:([^>]+?)>(?:\s*<\/sticker>)?|!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g
    let last = 0
    let m
    while ((m = re.exec(part)) !== null) {
      let from = items.length
      pushText(items, part.slice(last, m.index), rules, meta)
      attach(from)
      from = items.length
      if (m[0].startsWith('<poke')) {
        if (!items.some((i) => i.kind === 'poke')) items.push({ kind: 'poke', value: '' })
      } else if (m[1] !== undefined || m[2] !== undefined) {
        const rawRef = (m[1] ?? m[2] ?? '').trim()
        replyTo = rawRef.replace(/^\[([^[\]]+)\]$/, '$1').trim()
      } else if (m[3] !== undefined) {
        const v = stripMarkdown(m[3])
        if (v) items.push({ kind: 'voice', value: v })
      } else if (m[4] !== undefined) {
        const v = m[4].trim()
        if (v) items.push({ kind: 'sticker', value: v })
      } else if (m[5] !== undefined) {
        items.push({ kind: 'image', value: m[5] })
      }
      attach(from)
      last = re.lastIndex
    }
    const from = items.length
    pushText(items, part.slice(last), rules, meta)
    attach(from)
  }
  // 一轮最多引用一次，多的去掉（大多数时候正常发就好）
  let quoted = false
  for (const it of items) {
    if (!it.replyTo) continue
    if (quoted) delete it.replyTo
    quoted = true
  }
  if (items.length === 0 && !reportBody) return { silent: true, items: [] }
  // 文档型长回复已按章节切分时使用硬顶 hardLimit，不受四态收尾礼让 softMaxBubbles 压成 1 条巨块
  const limit = meta.docSplit ? hardLimit : bubbleLimit(rules, explicitBubbles)
  const finalItems = capBubbles(items, limit)
  // 报告气泡放最后（她一般先说一句人话，再给数据）：≤500 字整段保留，超过 500 字按章节分页避免整坨糊脸
  if (reportBody) {
    if (reportBody.length > 500) {
      for (const sec of paginateLongText(reportRaw, reportBody, hardLimit)) {
        finalItems.push({ kind: 'text', value: sec })
      }
    } else {
      finalItems.push({ kind: 'text', value: reportBody })
    }
  }
  for (const it of finalItems) {
    if (typeof it.value === 'string') it.value = codeGuard.restore(it.value)
  }
  return { silent: false, items: finalItems }
}
/** 超长报告/长文分页兜底：优先按章节切；无章节无空行的纯长段再按句子均匀分页，避免整坨糊脸。 */
function paginateLongText(rawText, strippedText, maxBubbles = MAX_BUBBLES) {
  const limit = Math.max(1, Math.round(Number(maxBubbles) || MAX_BUBBLES))
  const sections = splitDocumentBySections(rawText || strippedText, limit)
  if (sections.length > 1) return sections
  const single = sections[0] || strippedText
  if (!single || single.length <= 500 || limit <= 1) return single ? [single] : []
  // 单段纯文字无标题/无空行且 > 500 字：按完整句子攒成 ≤420 字的段
  const pieces = sentencePieces(single).map((p) => p.trim()).filter(Boolean)
  const pages = []
  let buf = ''
  for (const piece of pieces) {
    if (buf && (buf + piece).length > 420) {
      pages.push(buf)
      buf = piece
    } else {
      buf += piece
    }
  }
  if (buf) pages.push(buf)
  while (pages.length > limit && pages.length > 1) {
    let bestIdx = 0
    let bestLen = Infinity
    for (let i = 0; i < pages.length - 1; i += 1) {
      const pairLen = pages[i].length + pages[i + 1].length
      if (pairLen < bestLen) {
        bestLen = pairLen
        bestIdx = i
      }
    }
    pages.splice(bestIdx, 2, `${pages[bestIdx]}\n\n${pages[bestIdx + 1]}`)
  }
  return pages.length ? pages : [single]
}
/**
 * 这一轮最多几条文字气泡。
 *
 * - `maxBubbles`（面板「一轮最多几条」，1~12）是**硬顶**，谁都越不过；
 * - `softMaxBubbles` 是场景软顶（四态收尾礼让/收尾、群聊紧缩），只压**自动**切出来的气泡；
 * - 她自己写的 `|||` 是硬边界：软顶再小，也至少放出她划出来的那几条（仍受硬顶约束）。
 *
 * 收尾该收紧的是「按字数/标点自动切分」，不是把她明确要分开说的话用换行粘回一条 ——
 * 后者在 QQ 上就是「||| 不生效」（真机 2026-11-24 08:16/08:18/08:21 三连复现）。
 */
export function bubbleLimit(rules = {}, explicitBubbles = 1) {
  const hard = Math.max(1, Math.round(Number(rules.maxBubbles) || MAX_BUBBLES))
  const softRaw = Number(rules.softMaxBubbles)
  const soft = Number.isFinite(softRaw) && softRaw > 0 ? Math.round(softRaw) : hard
  const explicit = Math.max(1, Math.round(Number(explicitBubbles) || 1))
  return Math.min(hard, Math.max(1, Math.max(soft, explicit)))
}
/**
 * 文字气泡超过上限时，**均匀分组**，不是把剩下的全塞进最后一条。
 * 老做法（tail.join('\n')）会得到「4 条极短 + 1 坨巨块」，线上实测最难看的就是这个
 * （2026-11-05）。均匀分组至少让每条长短接近，读起来像人一条条说。
 */
export function capBubbles(items, max = MAX_BUBBLES) {
  const limit = Math.max(1, Math.round(Number(max) || MAX_BUBBLES))
  const texts = items.filter((i) => i.kind === 'text')
  if (texts.length <= limit) return items
  const groups = []
  let start = 0
  for (let g = 0; g < limit; g += 1) {
    const remain = texts.length - start
    const left = limit - g
    const size = Math.ceil(remain / left)
    const slice = texts.slice(start, start + size)
    const replyTo = slice.find((t) => t.replyTo)?.replyTo
    groups.push({
      value: slice.map((t) => t.value).join('\n\n'),
      size,
      ...(replyTo ? { replyTo } : {}),
    })
    start += size
  }
  // 按「合并组首条文字项的原始下标」放回，中间穿插的表情/语音/图片位置不动。
  // 审计 T3.11：旧实现用 gi 按**文字出现次数**前进，第 2 组会顶到第 2 条文字的位置 ——
  // [文1, 文2, 表情, 文3] 被压成 2 组时，第 2 组（文3）被插到表情之前，顺序错乱。
  const out = []
  const groupAt = new Map()
  let textIndex = 0
  for (const group of groups) {
    groupAt.set(textIndex, group)
    textIndex += group.size
  }
  let ti = 0
  for (const it of items) {
    if (it.kind !== 'text') { out.push(it); continue }
    const group = groupAt.get(ti)
    if (group) {
      const merged = { ...it, kind: 'text', value: group.value }
      if (group.replyTo) merged.replyTo = group.replyTo
      else delete merged.replyTo
      out.push(merged)
    }
    ti += 1
  }
  return out
}
const SENTENCE_END_CHARS = '。！？!?…；;'
const CLOSING_WRAP_CHARS = '”」』）)]】'
const isPunctOnly = (s) => /^[\s\p{P}~～]+$/u.test(String(s || ''))
/**
 * 一轮回复怎么分条。调研过同类项目的做法（AstrBot / MaiMBot，见 docs/回复分条.md）：
 *
 *  - 换行不是消息边界。模型用单换行排版（一行一个要点），当成消息边界发出去就是
 *    「4 条极短 + 1 坨巨块」，线上实测最难看（2026-11-05）。
 *  - 真正的边界只有三个：`|||`（她显式写的）、空行（段落）、句末标点（。！？…；）。
 *  - 太短的不单独成条：攒够「最短条长」才断开。
 *  - 一整段没有任何句末标点时，退一步把单换行当**弱边界**（可用，但不强制），
 *    这样排版型汇报也能切成几条，而不是一坨 200 多字。
 *  - 清单、步骤、代码块、指标汇报整段发，不按行拆。
 *
 * 返回 [{ text, brk }]，brk 是这一片**后面**的边界类型：'punct' | 'nl' | ''
 */
export function segmentUnits(text) {
  const tags = []
  // 标签/URL/时间/小数先占位：它们的冒号、斜杠、点绝不能当断句点
  // （「到14:22」曾被杀成「…到14」「22」；链接从 ? 处断成两截点不开）
  const guarded = String(text || '').replace(
    /\d{1,3}:\d{1,3}(?::\d{1,3})?|\d+\.\d+|<(?:face|sticker|voice|at|reply|poke)[^>]*>|<\/[^>]+>|\b(?:https?:\/\/|www\.)[^\s，。！？!；;、，？]+/gi,
    (m) => { tags.push(m); return '~~Z' + (tags.length - 1) + 'Z~~' },
  )
  const units = []
  let buf = ''
  let quote = 0
  // 仅统计中文成对开闭引号；ASCII 单引号 ' 在英文缩写（don't / it's）中单次出现，绝不能参与深度计数
  const quoteOpen = '“「『'
  const quoteClose = '”」』'
  for (let i = 0; i < guarded.length; i += 1) {
    const ch = guarded[i]
    if (quoteOpen.includes(ch)) quote += 1
    else if (quoteClose.includes(ch) && quote > 0) quote -= 1
    if (ch === '\n') {
      // 单换行：不写进正文，只当弱边界候选；
      // 若上一片刚以句末标点结束（如「……8核 64线程算。\n论坛/光猫圈说法：……」），
      // 把上一片的边界升级为 nl，避免 mergeUnits 合并时用空串粘成同一行吃掉换行。
      if (buf.trim()) { units.push({ text: buf.trim(), brk: 'nl' }); buf = '' }
      else {
        if (units.length > 0 && units[units.length - 1].brk === 'punct') units[units.length - 1].brk = 'nl'
        buf = ''
      }
      continue
    }
    buf += ch
    if (!SENTENCE_END_CHARS.includes(ch)) continue
    if (quote > 0) continue // 引号里的句号不是句子边界
    // 吞并连续句末标点（…… / ！！ / ？？ / ？！），不把连续省略号或感叹号劈成单字碎片
    let j = i
    while (j + 1 < guarded.length && SENTENCE_END_CHARS.includes(guarded[j + 1])) j += 1
    const afterPunct = guarded[j + 1] || ''
    if ('：:'.includes(afterPunct)) continue // 「注意：」后面还有内容
    if (/[0-9]/.test(buf[buf.length - 2] || '') && /[0-9]/.test(afterPunct)) continue // 1.5 这类
    while (i < j) { i += 1; buf += guarded[i] }
    // 一并吞并紧随句末标点之后的闭合引号/括号（”」』）)]】）
    while (i + 1 < guarded.length && CLOSING_WRAP_CHARS.includes(guarded[i + 1])) {
      i += 1
      const c = guarded[i]
      if (quoteClose.includes(c) && quote > 0) quote -= 1
      buf += c
    }
    units.push({ text: buf.trim(), brk: 'punct' })
    buf = ''
  }
  const rest = buf.trim()
  if (rest) units.push({ text: rest, brk: '' })
  // 换行的性质看整段排版：
  //  · **短行**（≤15 字）随便多少行都是她在分行说话（「a/b/c/d」七个超短行也是）→ hard。
  //  · **中行**（16~30 字）只在行数 ≤3 时算聊天分行 → hard。原阈值只有 15，两句话各 17 字
  //    （「今晚刚见证教程没捂热号先凉，你说呢」正好 17）被误判成排版，soft 边界再按 0.45 概率
  //    合——一半概率把两句不同话题粘成一条带 \n 的消息（2026-11-06 线上实锤）。
  //  · **长行**（>30 字/行）或中行超过 3 行 → 长文排版（指标汇报一类）→ soft，能不拆就不拆。
  const lines0 = guarded.split('\n').map((x) => x.trim()).filter(Boolean)
  // 编号条目段落（如「1. G7615A（主控 ZX279132）\nNPU 核心数：…」）是标题+正文的整体，
  // 绝不能被 fewMedium 当成聊天分行，把小标题单独劈成一条气泡。
  const isNumberedBlock = /^\d+(?:\.(?!\d)|[、)])/.test(lines0[0] || '')
  const allShort = !isNumberedBlock && lines0.length > 1 && lines0.every((x) => x.length <= 15)
  const fewMedium = !isNumberedBlock && lines0.length > 1 && lines0.length <= 3 && lines0.every((x) => x.length <= 30)
  for (const u of units) {
    if (u.brk !== 'nl') continue
    u.brk = (allShort || fewMedium) ? 'hard' : 'soft'
  }
  return units.map((u) => ({ ...u, text: u.text.replace(/~~Z(\d+)Z~~/g, (_, i) => tags[Number(i)] || '') }))
}
/**
 * 把句子片攒成气泡：攒够 minBubble 才考虑断开，断不断带随机（真人不是机械切）。
 * 换行边界比句末标点更容易断（0.7 vs 0.4），因为换行本来就是排版意图。
 */
export function mergeUnits(units, { cap, minBubble, rand = Math.random }) {
  const valid = (units || []).filter((u) => u && u.text)
  const out = []
  let cur = ''
  let brk = ''
  for (let idx = 0; idx < valid.length; idx += 1) {
    const u = valid[idx]
    const isLast = idx === valid.length - 1
    if (!cur) { cur = u.text; brk = u.brk; continue }
    // 纯标点/空白单元绝不独立成泡，强制回并前一条气泡
    if (isPunctOnly(u.text)) {
      cur += u.text
      brk = u.brk
      continue
    }
    const joiner = brk === 'soft' ? '\n' : ''
    // 极短尾段（<=2 字且在末尾，非硬换行分行）强制回并前一条气泡
    if (isLast && brk !== 'hard' && Array.from(u.text).length <= 2) {
      cur += joiner + u.text
      brk = u.brk
      continue
    }
    if (brk === 'hard' && !isPunctOnly(cur)) { out.push(cur); cur = u.text; brk = u.brk; continue }
    const merged = cur + joiner + u.text
    const closeProb = brk === 'soft' ? 0.45 : 0.4
    const long = merged.length > cap
    if (cur.length >= minBubble && (long || rand() < closeProb)) {
      out.push(cur)
      cur = u.text
    } else {
      cur = merged
    }
    brk = u.brk
  }
  if (cur) out.push(cur)
  // 收尾兜底：确保末条不是纯标点
  while (out.length > 1 && isPunctOnly(out[out.length - 1])) {
    const tail = out.pop()
    out[out.length - 1] += tail
  }
  return out
}
/** 一整轮文字 → 若干气泡（字符串数组）。pushText 用它。 */
/** 真正的「报表」才整段发：两个以上【小标题】，或者一整片短条目的编号清单。
 *  以前只要看到编号列表就整段发，结果她发一段带路径的技术说明，499 字挤成一条巨块，
 *  在 QQ 里像贴文档（2026-11-05 实测）。 */
function structuredReport(t) {
  const heads = t.match(/【[^】]{1,14}】/g)
  if (heads && heads.length >= 2) return true
  const lines = t.split('\n').map((x) => x.trim()).filter(Boolean)
  if (lines.length < 3) return false
  const items = lines.filter((x) => /^(\d+(?:\.(?!\d)|[、)])|[-*•·])/.test(x)).length
  if (items * 2 < lines.length) return false
  const avg = lines.reduce((n, x) => n + x.length, 0) / lines.length
  return avg <= 40
}
export function segmentBubbles(text, rules = {}) {
  const t = String(text || '').trim()
  if (!t) return []
  const cap = Math.max(10, Math.round(Number(rules.maxChars) || 30))
  const minBubble = Math.max(6, Math.round(cap * (Number(rules.minBubbleRatio) || 0.4)))
  const rand = typeof rules.rand === 'function' ? rules.rand : Math.random
  // 代码块（parseReply 阶段已换成占位符，stripMarkdown 里也可能还原成 ```）整段不拆。
  if (t.includes('```') || /\uFFF9\d+\uFFFA/.test(t)) return [t]
  // 短清单/简报（≤360 字）整段发；超长报告不整坨糊脸，走后续分段/章节切分
  if (rules.keepReports !== false && t.length <= 360 && structuredReport(t)) return [t]
  // 段落（空行）是硬边界：一段一条，段内再按句子攒；
  // 孤立单行编号标题（如模型自己在「### 1. 标题」后多敲了空行）自动并入下一段正文，不单独成条。
  const rawParagraphs = t.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean)
  const paragraphs = []
  const isNumberedHead = (s) => /^\d+(?:\.(?!\d)|[、)])\s*\S/.test(s)
  for (let i = 0; i < rawParagraphs.length; i += 1) {
    const p = rawParagraphs[i]
    const next = rawParagraphs[i + 1]
    if (rules.keepReports !== false && !p.includes('\n') && isNumberedHead(p) && p.length <= 40 && next && !isNumberedHead(next)) {
      paragraphs.push(`${p}\n${next}`)
      i += 1
      continue
    }
    paragraphs.push(p)
  }
  const bubbles = []
  for (const p of paragraphs) {
    // 编号条目段（如「1. 标题\n说明行1\n说明行2」）：在 keepReports 模式下作为完整条目保留内部换行，
    // 不随机拆碎、不把小标题单独劈出去、也不拦腰切开子项。
    const pLines = p.split('\n').map((x) => x.trim()).filter(Boolean)
    if (rules.keepReports !== false && pLines.length > 1 && isNumberedHead(pLines[0]) && p.length <= 600) {
      bubbles.push(pLines.join('\n'))
      continue
    }
    const units = segmentUnits(p)
    for (const b of mergeUnits(units, { cap, minBubble, rand })) {
      // 单片本身远超上限（英文长句、无标点堆栈）：退回按逗号/空格兜底切，绝不留半句
      if (b.length <= cap * 2) { bubbles.push(b); continue }
      for (const piece of splitLongLine(b, cap)) bubbles.push(piece)
    }
  }
  return bubbles.length ? bubbles : [t]
}
/**
 * 一段文字拆成几条气泡：真人打字是一行一条发出去的。
 * 有代码块、或者是长篇内容（比如帮主人查东西的结果）就整段发，不拆。
 */
/** 把一个长气泡按句读硬拆成短条（群友不写长句）。仅在普通聊天路径使用；整段发（代码块/长文）不走这里。 */
function splitLongLine(line, maxChars = 30) {
  const s = String(line || '').trim()
  if (!s || s.length <= maxChars) return s ? [s] : []
  // 标签保护：<face:捂脸> / <sticker:x> / <voice>…</voice> 内部有冒号，
  // 按标点切会把 '<face:' 和 '捂脸>' 拆到两条里（线上真实事故）。
  // URL 同理：https:// 里的冒号和斜杠会被逗号/冒号层切坏（链接点不开）。
  // 占位符用纯文本（绝不用控制字符——会把源文件写成 binary）。
  const tags = []
  const canGuard = !s.includes('~~X')
  // 时间/比例（09:22、到14:22、1:3）里的冒号不是句子边界：以前把「：」「:」当切点，
  // 「今天09:22开的 到14:22」被切成「…到14」「22 已经烧掉55%」，冒号还被抹掉，
  // 线上看着就是莫名其妙被截断（2026-11-05 实测）。和标签、URL 一样先占位保护。
  const guarded = canGuard
    ? s.replace(/\d{1,3}:\d{1,3}(?::\d{1,3})?|<(?:face|sticker|voice|at|reply|poke)[^>]*>|<\/[^>]+>|\b(?:https?:\/\/|www\.)[^\s，。！？!；;、，？]+/gi, (m) => {
        tags.push(m)
        return '~~X' + (tags.length - 1) + 'X~~'
      })
    : s
  // ① 只在**句号类**标点处切（。！？；）：这些断了是自然的。
  //    逗号不是句子边界，在逗号处切会把一句话劈成两截
  //    （"Astra 压我一头" / "Code Arena 登顶" / "API 贵 2.5 倍" 那种碎裂感）。
  const parts = sentencePieces(guarded).map((x) => x.trim()).filter(Boolean)
  // ② 单句仍超 hardMax（约两倍）才按逗号切 —— 这种是真长句（并列项、绕弯的长解释）。
  //    hardMax 取 maxChars 的 2 倍：宁可发一条 45 字的长消息，也不要半句话。
  const hardMax = Math.max(maxChars * 2, 40)
  const refined = []
  for (const p of parts) {
    if (p.length <= hardMax) { refined.push(p); continue }
    let buf = ''
    for (const seg of p.split(/(?<=[，,、])/)) {
      if (buf && (buf + seg).length > hardMax) { refined.push(buf); buf = seg }
      else buf += seg
    }
    if (buf) refined.push(buf)
    // 长句被切开的地方要补上句末感：以逗号结尾的改成句号（"…差别没那么大。" 是通顺的），
    // 顿号/冒号/分号结尾的直接去掉（那是并列中途，不该带标点收尾）。
    for (let i = 0; i < refined.length - 1; i += 1) {
      refined[i] = refined[i].replace(/[，,]\s*$/, '。').replace(/[、；;]\s*$/, '')
    }
  }
  // ③ 聚合：只有**很短的片段**才跟前后挤成一条（避免「草」「好」一字一条刷屏）。
  //    完整句子一律单独成条，不硬塞 —— 两句完整的话挤在一条里比分开更像机器人。
  const out = []
  let cur = ''
  const shortLimit = Math.max(6, Math.floor(maxChars / 2))
  for (const p of refined) {
    if (!cur) { cur = p; continue }
    if (cur.length <= shortLimit || p.length <= shortLimit) {
      if ((cur + p).length <= maxChars) { cur += p; continue }
    }
    out.push(cur)
    cur = p
  }
  if (cur) out.push(cur)
  // ④ 还原标签（不删结尾逗号：既然不在逗号处断，就不会有半句）
  return out.map((t) => (canGuard ? t.replace(/~~X(\d+)X~~/g, (_, i) => tags[Number(i)] ?? '') : t))
}
/** 句号兜底切分的公共实现：先按句号类标点切；某段本身还超长（英文长句/URL/无标点堆栈）
 * 再按逗号；连逗号都没有（纯英文一整句）就按空格硬切 —— 撑爆气泡比切开更难看。
 * 之前只有句号一层，英文长句整段原样发出去。
 * URL 不切：空格切分时以 http(s)://、www. 开头的整段 token 原样保留（切开链接就点不开了）。 */
function sentencePieces(line) {
  const out = []
  // URL 先占位再切：句号层正则里的半角 ? 会把链接的查询串切走（"…query?" / "param=1" 分家）。
  const tags = []
  const guarded = String(line || '').replace(/\d{1,3}:\d{1,3}(?::\d{1,3})?|\b(?:https?:\/\/|www\.)[^\s，。！？!；;、，？]+/gi, (m) => {
    tags.push(m)
    return '~~Y' + (tags.length - 1) + 'Y~~'
  })
  const isUrlTok = (t) => /^~~Y\d+Y~~$/.test(t.trim())
  // 与 segmentUnits 同口径：连续句末标点（……/！！/？？）及紧随闭合引号/括号整体吞并，不劈成单字单元
  const rawPieces = guarded.match(/[^。！？!?…；;]*[。！？!?…；;]+[”」』）)\]\】]*|[^。！？!?…；;]+/g) || []
  for (const piece of rawPieces) {
    if (piece.length <= 240) { out.push(piece); continue }
    let buf = ''
    for (const seg of piece.split(/(?<=[，,、])/)) {
      if (seg.length > 240) {
        // 逗号也救不了：按空格硬切（URL/代码串整段放行，切开会坏）
        for (const word of seg.split(/(?<=\s)/)) {
          if (isUrlTok(word)) {
            if (buf) { out.push(buf); buf = '' }
            out.push(word.trim())
            continue
          }
          if (buf && (buf + word).length > 240) { out.push(buf); buf = word }
          else buf += word
        }
        continue
      }
      if (buf && (buf + seg).length > 240) { out.push(buf); buf = seg }
      else buf += seg
    }
    if (buf) out.push(buf)
  }
  // 还原 URL 占位符
  const restored = out.map((p) => p.replace(/~~Y(\d+)Y~~/g, (_, i) => tags[Number(i)] || ''))
  return restored
}
function pushText(items, s, rules = {}, meta = null) {
  const rawClean = String(s || '').replace(/<\/?reply[^>]*>|\[\/?reply[^\]]*\]/gi, '').trim() // 写坏的引用标签直接去掉
  if (!rawClean) return
  const t = stripMarkdown(rawClean)
  if (!t || isSilence(t)) return
  const hardLimit = Math.max(1, Math.round(Number(meta?.hardLimit ?? rules.maxBubbles) || MAX_BUBBLES))
  // 报告路径（1.3.48）：≤500 字整段保留排版；超过 500 字按章节分页，避免整坨糊脸。
  if (rules.forceReport) {
    if (t.length > 500) {
      const sections = paginateLongText(rawClean, t, hardLimit)
      if (meta) meta.docSplit = true
      for (const sec of sections) if (!isSilence(sec)) items.push({ kind: 'text', value: sec })
      return
    }
    items.push({ kind: 'text', value: t })
    return
  }
  // 文档型长回复下沉到单气泡级：即使整轮回复带 ||| 或尾部 <sticker>，其中的超长文档泡也能按章节切分
  const rawFull = typeof meta?.restoreCode === 'function' ? meta.restoreCode(rawClean) : rawClean
  if (rules.keepReports !== false && isLongDocument(rawFull)) {
    const sections = splitDocumentBySections(rawFull, hardLimit)
    if (sections.length) {
      if (meta) meta.docSplit = true
      for (const sec of sections) if (!isSilence(sec)) items.push({ kind: 'text', value: sec })
      return
    }
  }
  // 短代码块整段发（代码块的围栏会被 stripMarkdown 去掉，所以在原文上判一次）
  // T3.11：带代码的整段不该被碎句切分。代码此时可能已换成占位符，
  // 所以除了字面 ``` 还要认占位符（否则「代码块整段发」会被切成两条）。
  if (rules.keepReports !== false && (rawClean.includes('```') || /\uFFF9\d+\uFFFA/.test(rawClean)) && t.length <= 1200) {
    items.push({ kind: 'text', value: t })
    return
  }
  for (const piece of segmentBubbles(t, rules)) {
    if (!isSilence(piece)) items.push({ kind: 'text', value: piece })
  }
}
/** 面板上的分条规则 → parseReply 的参数。群聊与私聊可以有不同上限。 */
export function replyRules(cfg, inGroup, rand) {
  const r = (cfg && cfg.reply) || {}
  // 注意 0 是合法输入（不能因为 Number(0) 是 falsy 就退回默认值）
  const pick = (v, def, min, max) => {
    const n = Number(v)
    const base = v === '' || v === null || v === undefined || !Number.isFinite(n) ? def : n
    return Math.round(Math.min(max, Math.max(min, base)))
  }
  return {
    maxChars: inGroup ? pick(r.groupMaxChars, 40, 10, 500) : pick(r.privateMaxChars, 120, 20, 2000),
    maxBubbles: pick(r.maxBubbles, 6, 1, 12),
    minBubbleRatio: 0.4,
    keepReports: r.keepReports !== false,
    // 随机源透传（缺陷：分条随机源未注入）：segmentBubbles/mergeUnits 本就认 rules.rand，
    // 这里把调用方注入的 random 带进去，气泡切分也可复现；缺省仍 Math.random。
    ...(typeof rand === 'function' ? { rand } : {}),
  }
}
/** 对方是不是明确要她发语音（「用语音说」「发个语音」「语音回我」……）。 */
export function wantsVoice(text) {
  const t = String(text || '')
  if (t.includes('不要语音') || t.includes('别发语音')) return false
  return /(用|发|来|给我|录)[^，。？！\n]{0,4}语音|语音[^，。？！\n]{0,4}(说|发|讲|回|念|唱)/.test(t)
}
/**
 * 发下一条之前停多久（毫秒）：按「打字速度」算——下一条越长停越久，再加一点随机抖动。
 * @param {string} [next] 下一条要发的内容
 */
export function bubbleDelay(next = '', rand = Math.random) {
  if (typeof next === 'function') { rand = next; next = '' }
  const len = String(next || '').length
  const typing = 350 + len * 110 // 大约每秒 9 个字
  return Math.round(Math.min(4500, Math.max(700, typing)) * (0.8 + rand() * 0.5))
}
