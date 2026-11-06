// 出口后处理链中间件（RFC-0001 §2 Egress Chain / §4 Phase 1，US-006）。
//
// 回溯阶段（next() 之后）吃 ctx.reply 缓冲池，清洗 + 分条后重新入队：
//   1) 防思考泄漏：栈守卫截尾 → stripReasoning 剥词 → trim → 沉默/空段整项丢弃；
//   2) 语义分条：清洗后的 text 段超 maxChars 时按句子边界回切，尾片另起新项。
// 词表与 chat/reply.js 完全一致（think|thought|reasoning|reflection|antThinking，含属性
// 形式）。<thinking> 不在词表内——照文档透传，词表扩充留给主人拍板，本件不改 reply.js。
//
// 栈守卫是本件相对 stripReasoning 的核心增值：开/闭标签同名配对（错名闭标签不算闭合），
// 一旦存在未闭合开标签，从最早那个开标签处截尾丢弃其后全部内容——宁保守勿泄漏。
// 纯孤立闭标签不截尾，交给 stripReasoning 剥 token。
//
// 内核观察项守则（US-001 verifier 移交）：
//   - queue getter 返回内部引用 → 先 [...queue] 快照，clear() 前绝不触碰原数组；
//   - enqueue 浅冻结段元素 → 重建每段全新 {type, data:{...}}，不复用原对象；
//   - id/createdAt 由 enqueue 重新生成，本件携带 targetType/targetId/quoteMessageId/priority/delayMs。

import { performance } from 'node:perf_hooks'
import { stripReasoning, SILENCE } from '../chat/reply.js'

/** 与 stripReasoning 同款词表的标签扫描器（gi，大小写与回指语义一致）。 */
const TAG_RE = /<\/?(think|thought|reasoning|reflection|antThinking)(\s+[^>]*)?>/gi
const BOUNDARY = new Set(['。', '！', '？', '!', '?', '.', '\n'])

/**
 * 栈守卫：开标签入栈；闭标签仅栈顶同名才配对弹出，错名/孤立闭标签既不弹也不入。
 * 栈里剩下的一定是未闭合开标签且按位置升序，故 stack[0] 即最早那个。
 * @param {string} text @returns {string} 截尾后的文本（无悬挂开标签时原样）
 */
export function guardTruncate(text) {
  const stack = []
  TAG_RE.lastIndex = 0
  let m
  while ((m = TAG_RE.exec(text)) !== null) {
    const name = m[1].toLowerCase()
    if (m[0][1] !== '/') stack.push({ name, index: m.index })
    else if (stack.length > 0 && stack[stack.length - 1].name === name) stack.pop()
  }
  return stack.length === 0 ? text : text.slice(0, stack[0].index)
}

/** 清洗单段：守卫截尾 → stripReasoning → trim。顺序不可换。'' 或 SILENCE 表示该段该丢。 */
export function cleanText(raw) {
  return stripReasoning(guardTruncate(String(raw ?? ''))).trim()
}

/**
 * 语义分条：从窗口右端 cur+max-1 向左找最近句子边界（边界恰在 cur+max 也拒绝——宁短切不
 * 超限）；找不到回退硬切 cur+max。返回片数组，每片 ≤maxChars 且保序拼回 === text。
 */
export function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text]
  const pieces = []
  let cur = 0
  while (cur + maxChars < text.length) {
    let cut = -1
    for (let i = cur + maxChars - 1; i >= cur + 1; i -= 1) {
      if (BOUNDARY.has(text[i])) { cut = i; break }
    }
    pieces.push(cut >= 0 ? text.slice(cur, cut + 1) : text.slice(cur, cur + maxChars))
    cur = cut >= 0 ? cut + 1 : cur + maxChars
  }
  pieces.push(text.slice(cur))
  return pieces
}

/** 清洗 + 分条单条 payload → 0..n 组新 segments（溢出尾片起新组，后续段接同组保内容顺序）。 */
function rebuildItem(item, maxChars) {
  const groups = []
  let current = []
  for (const seg of Array.isArray(item?.segments) ? item.segments : []) {
    if (seg?.type !== 'text') {
      current.push({ type: seg?.type, data: { ...seg?.data } })
      continue
    }
    const cleaned = cleanText(seg?.data?.text)
    if (cleaned === '' || cleaned === SILENCE) continue
    const pieces = chunkText(cleaned, maxChars)
    pieces.forEach((p, i) => {
      current.push({ type: 'text', data: { text: p } })
      if (i < pieces.length - 1) { groups.push(current); current = [] }
    })
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * 创建出口后处理中间件。
 * @param {object} [options]
 * @param {number} [options.maxChars=4000] 单条 text 段上限
 * @param {{ debug?: Function }} [options.log] 日志出口，自身抛错就地吃掉
 * @param {(name: string, ms: number) => void} [options.reportStage] 耗时打点，固定 name='egress'
 * @param {() => number} [options.now] 计时源，缺省 performance.now（测试注入假时钟）
 * @returns {import('./types.js').Middleware}
 */
export function createEgressMiddleware(options = {}) {
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? options.maxChars : 4000
  const log = options.log
  const reportStage = typeof options.reportStage === 'function' ? options.reportStage : () => {}
  const now = typeof options.now === 'function' ? options.now : () => performance.now()

  return async function egressMiddleware(ctx, next) {
    await next()
    const t0 = now()

    const snapshot = Array.isArray(ctx?.reply?.queue) ? [...ctx.reply.queue] : []
    const rebuilt = []
    let dropped = 0
    for (const item of snapshot) {
      const groups = rebuildItem(item, maxChars)
      if (groups.length === 0) { dropped += 1; continue }
      for (const segments of groups) rebuilt.push({ item, segments })
    }

    ctx.reply.clear()
    for (const { item, segments } of rebuilt) {
      const payload = { targetType: item.targetType, targetId: item.targetId, priority: item.priority, segments }
      if (item.quoteMessageId !== undefined) payload.quoteMessageId = item.quoteMessageId
      if (item.delayMs !== undefined) payload.delayMs = item.delayMs
      ctx.reply.enqueue(payload)
    }

    const ms = Math.max(0, Math.round((now() - t0) * 1000) / 1000)
    try { reportStage('egress', ms) } catch (error) {}
    try { log?.debug?.(`egress: in=${snapshot.length} out=${rebuilt.length} dropped=${dropped}`) } catch (error) {}
  }
}
