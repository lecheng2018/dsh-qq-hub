import { AsyncLocalStorage } from 'node:async_hooks'
import { parseReply, bubbleDelay, replyRules, extractAndStripInnerMonologue } from './reply.js'
import { updateClosureState } from './conversation-closure.js'
import { applyThreadContinuation, adaptThreadLedger } from './inner-thread-link.js'
import { calculateTypingCadence, typingWaitAfter, typingCadenceEnabled } from './reply-cadence.js'

// AC-2 的字面要求：律动计算从投递模块表面也能直接取到。
// 真身仍然只有一份，定义在 reply-cadence.js（纯函数，便于单测与复用），这里只是 re-export。
export { calculateTypingCadence }

// 一轮回复的业务编排：拆条、群聊合并、富媒体与同会话投递顺序。
// 物理发送由注入的发送函数进入统一 Outbox，本模块不持有网关。
export function createReplyDelivery({
  getConfig, log, hooks, reportTurns, groups, stickers, interaction,
  sendText, sendVoice, sendSticker, sendImage, sendMixed, pokeBack,
  logChat, onActivity, onDelivered, outbox, isCaptured, sleep, threadLedger, deliveryContext = new AsyncLocalStorage(),
}) {
  const deliveryChains = new Map()
  // US-006 · 四态会话收尾：per-chat 状态。放这里而不是宿主，因为真正决定
  // 「这一轮说几条、要不要反问」的地方是 deliverNow 里的 rules —— 接在别处会被
  // 这里的 replyRules(cfg, inGroup) 重新算一遍而失效。
  const closureStates = new Map()
  const CLOSURE_LEN_WINDOW = 6
  const CLOSED_STATE = 'closed'

  /** 依据「对方这轮说的话」推出本轮发言处方。异常时退回 null（不施加约束）。 */
  function closurePlanFor(chatId, incomingText) {
    const key = String(chatId || '')
    if (!key) return null
    try {
      const prev = closureStates.get(key) || null
      const prevLengths = Array.isArray(prev?.lengths) ? prev.lengths : []
      const text = String(incomingText ?? '').trim()
      const nextLengths = text ? [...prevLengths, Array.from(text).length].slice(-CLOSURE_LEN_WINDOW) : prevLengths
      const next = updateClosureState(prev?.state || null, { lengths: nextLengths, ...(text ? { text } : {}) })
      // CLOSED 的静默是有期限的（模块只给出时长 muteLockMs，不给时间戳），
      // 所以接线方必须自己记「什么时候关的」，否则一次「晚安」会把该会话永久锁死。
      const closedAt = next.state === CLOSED_STATE
        ? (prev?.state?.state === CLOSED_STATE ? (prev?.closedAt || Date.now()) : Date.now())
        : 0
      closureStates.set(key, { state: next, lengths: nextLengths, closedAt })
      return { ...next, closedAt }
    } catch {
      return null
    }
  }
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  function deliver(chatId, text, opts = {}) {
    if (opts.simulate || isCaptured?.()) return deliverNow(chatId, text, opts)
    // 嵌套调用（本轮气泡里又触发了一次 deliver，比如戳回去、语音退回文字）：
    // 直接复用外层的票，**不再 reserve**。否则会新建一道闸，而外层的闸要等本轮气泡
    // 结束才放行 → 外层等内层、内层等外层，死锁。
    const outer = deliveryContext.getStore()
    const reusing = outer && outer.chatId === chatId ? outer : null
    const reservation = reusing ? null : (outbox?.()?.reserve?.(chatId) || null)
    const run = () => {
      const context = { chatId, active: true, ticket: reusing ? reusing.ticket : reservation?.ticket }
      return deliveryContext.run(context, () => deliverNow(chatId, text, opts).finally(() => {
        context.active = false
        reservation?.release?.()
      }))
    }
    // 复用外层票时，本次发送仍要排在外层已入队的气泡之后 —— 走外层同一条 deliveryChains 队
    const previous = deliveryChains.get(chatId)
    const current = previous ? previous.catch(() => {}).then(run) : run()
    deliveryChains.set(chatId, current)
    const cleanup = () => { if (deliveryChains.get(chatId) === current) deliveryChains.delete(chatId) }
    current.then(cleanup, cleanup)
    return current
  }

  async function deliverNow(chatId, text, opts = {}) {
    const cfg = getConfig()
    if (hooks?.reply) {
      try {
        const next = await hooks.reply(text, { chatId, userText: opts.userText || '' })
        if (next === null) return log.info(`${chatId}：扩展模块拦下了这次回复`)
        if (typeof next === 'string') text = next
      } catch (error) {
        log.warn('扩展模块改写回复出错：', error.message)
      }
    }
    // 分条规则跟着配置走：她自己断的句优先，字数只当兜底（群里与私聊上限可以不同）
    const inGroup = chatId.startsWith('group:')
    const rules = replyRules(cfg, inGroup)
    // 报告兜底（1.3.48 第二层）：这一轮确实调过「内容型工具」（RSS、B 站、小黑盒这类查资料的），
    // 但她忘了写 <report> 标记 → 整轮按报告处理，不被拆碎。记忆型工具（recall_memory 等）不算。
    if (opts.forceReport || reportTurns.get(chatId)) rules.forceReport = true
    // 群上限不超过配置上限时，由群合并统一限制；避免解析时跨媒体合并文字并丢掉引用。
    // US-006 · 四态收尾：只收紧不放宽。maxBubbles 取更小值；CLOSED 时本轮直接不说话。
    // 位置很关键 —— 必须在 replyRules 之后（否则被重算覆盖），在语音转换之前
    // （否则会改到语音路径，语音用例会整片挂掉）。
    const closurePlan = closurePlanFor(chatId, opts.userText || '')
    // 触发门槛：单条短句不足以判「对方没劲」——中文 3~4 字（「好的」「第一句」）
    // 是正常回话，按模块默认的 lastLen<=4 会把大量正常轮次压成 1 条气泡。
    // 所以只有「连续 2 条以上短句/趋势向下」或「明确道别」才真正施加约束。
    const closureActive = closurePlan && (
      closurePlan.state === 'closed'
      || Number(closurePlan.ackStreak) >= 1
      || String(closurePlan.trend || '') === 'down'
    )
    // 注意：CLOSED 的 muteLockMs 是**主动搭话硬锁，不锁入站回复**（模块注释第 24 行）。
    // 用户说完「晚安」又来找她，她必须回；把 CLOSED 用在回复静默上是接错了语义。
    // 所以这里不因 CLOSED 直接 return，只收紧「这条回复怎么说」（气泡数/问句）。
    // 群聊不套用私聊的四态紧缩：群里有多个发言者，isAck/trend 是按单会话算的，
    // 套到群里会把正常群回复压成 1 条。群侧已有 groupLimit（见下方）做合并约束。
    if (closureActive && !inGroup && Number.isFinite(Number(closurePlan.maxBubbles))) {
      rules.maxBubbles = Math.min(
        Number(rules.maxBubbles) || Number(closurePlan.maxBubbles),
        Math.max(1, Number(closurePlan.maxBubbles)),
      )
    }
    const parseRules = inGroup ? { ...rules, maxBubbles: Number.MAX_SAFE_INTEGER } : rules
    const r = parseReply(text, parseRules)
    // 对方没劲了（yielding）时不追问：把文字气泡末尾的问号改成句号，不删内容。
    if (closureActive && !inGroup && closurePlan.allowQuestion === false && Array.isArray(r.items)) {
      for (const it of r.items) {
        if (it && it.kind === 'text' && typeof it.value === 'string') {
          it.value = it.value.replace(/[?？]+\s*$/u, '。').replace(/[。]{2,}$/u, '。')
        }
      }
    }
    if (r.silent) {
      log.info(`${chatId}：她选择不说话`)
      if (chatId.startsWith('group:')) groups.leaveTopic(chatId.slice(6)) // 不想聊就退出这个话题
      return
    }
    let items = r.items
    // 对方明确要语音、她却只打了字：整段改成语音发（模型偶尔会忘，这里兜底）
    if (opts.wantVoice && cfg.voice?.enabled && !items.some((i) => i.kind === 'voice')) {
      const spoken = items.filter((i) => i.kind === 'text').map((i) => i.value).join('，')
      if (spoken && spoken.length <= 300) items = [{ kind: 'voice', value: spoken }, ...items.filter((i) => i.kind !== 'text')]
    }
    // 短回复按概率整条变语音
    const texts = items.filter((i) => i.kind === 'text')
    if (cfg.voice?.enabled && items.length === texts.length && texts.length > 0) {
      const all = texts.map((t) => t.value).join('，')
      if (all.length <= cfg.voice.autoMaxChars && Math.random() < cfg.voice.autoChance) items = [{ kind: 'voice', value: all }]
    }
    // US-019 · 顺承前情 → 挂起线索闭环：从本轮 <inner> 读【顺承前情】标记与闭环信号。
    // 命中的线索才 resolve，没标记的只按拓扑往后挪一格（用户换话题绝不误闭环）。
    // threadLedger 由宿主注入，adaptThreadLedger 把它适配成 peek/resolve/advance 契约。
    try {
      const adapted = threadLedger ? adaptThreadLedger(threadLedger) : null
      if (adapted) {
        const innerMeta = extractAndStripInnerMonologue(String(text || '')).inner || {}
        const innerRaw = String(innerMeta.raw || '')
        // 直接把 inner 原文交给 applyThreadContinuation —— 它内部自己用 parseInnerClosure
        // 重新解析，不需要我们预处理。之前为了绕开「inner.closure 默认是 continue」而
        // 删除 raw 里的 `closure: continue` 字面量是错的：那会把模型**显式**写的
        // no-close 信号一起删掉，导致本该拦截的轮次照常 resolve。
        // 默认值和显式值的区分由 parseInnerClosure 自己负责（无信号返回 null）。
        if (innerRaw) {
          const applied = applyThreadContinuation(adapted, chatId, innerRaw)
          if (applied.resolved.length) log.info(`${chatId}：闭环线索 ${applied.resolved.join(',')}`)
        }
      }
    } catch (error) {
      log.warn('线索闭环处理失败：', error?.message || error)
    }

    const groupLimit = Math.max(1, Math.min(3, Number(rules.maxBubbles) || 3))
    let needsGroupPacking = false
    if (inGroup && items.length > groupLimit) {
      const nonText = items.filter((i) => i.kind !== 'text' && i.kind !== 'voice')
      const keepNonText = nonText.slice(-groupLimit)
      const referenced = nonText.find((item) => item.replyTo)
      if (referenced && !keepNonText.includes(referenced)) keepNonText[0] = referenced
      items = items.filter((item) => item.kind === 'text' || item.kind === 'voice' || keepNonText.includes(item))
      while (items.length > groupLimit) {
        let mergeAt = -1
        for (let i = items.length - 2; i >= 0; i--) {
          const a = items[i]
          const b = items[i + 1]
          if (!['text', 'voice'].includes(a.kind) || a.kind !== b.kind || (a.replyTo && b.replyTo && a.replyTo !== b.replyTo)) continue
          if (mergeAt < 0) mergeAt = i
          if (!b.replyTo) { mergeAt = i; break }
        }
        if (mergeAt < 0) break
        const a = items[mergeAt]
        const b = items[mergeAt + 1]
        items.splice(mergeAt, 2, { ...a, value: `${a.value} ${b.value}`, ...(a.replyTo || b.replyTo ? { replyTo: a.replyTo || b.replyTo } : {}) })
      }
      needsGroupPacking = items.length > groupLimit
      log.info(`${chatId}：回复超过 ${groupLimit} 条，按原顺序合并相邻气泡`)
    }
    // 按概率补一张表情（群里已经有两条以上就不补了）
    if (cfg.stickers?.enabled && !items.some((i) => i.kind === 'sticker') && !(inGroup && items.length >= 2) && Math.random() < cfg.stickers.autoChance) {
      const pick = stickers.pickForReply(texts.map((t) => t.value).join(' '))
      if (pick) items.push({ kind: 'sticker', value: pick })
    }
    if (hooks?.items) {
      try {
        const next = await hooks.items(items, { chatId, text, userText: opts.userText || '' })
        if (next === null) return log.info(`${chatId}：扩展模块拦下了这次回复`)
        if (Array.isArray(next)) items = next
      } catch (error) {
        log.warn('扩展模块改写回复出错：', error.message)
      }
    }
    if (needsGroupPacking && items.length > groupLimit) {
      const packed = items.slice()
      const packable = (item) => ['text', 'voice', 'image', 'sticker', 'mixed'].includes(item.kind)
      while (packed.length > groupLimit) {
        let mergeAt = -1
        for (let i = packed.length - 2; i >= 0; i--) {
          const a = packed[i]
          const b = packed[i + 1]
          if (packable(a) && packable(b) && !(a.replyTo && b.replyTo && a.replyTo !== b.replyTo)) { mergeAt = i; break }
        }
        if (mergeAt < 0) break
        const a = packed[mergeAt]
        const b = packed[mergeAt + 1]
        const parts = [...(a.kind === 'mixed' ? a.parts : [a]), ...(b.kind === 'mixed' ? b.parts : [b])]
        const replyTo = a.replyTo || b.replyTo
        packed.splice(mergeAt, 2, { kind: 'mixed', parts, value: parts.filter((part) => part.kind === 'text').map((part) => part.value).join(' '), ...(replyTo ? { replyTo } : {}) })
      }
      if (packed.length <= groupLimit) items = packed
      else {
        log.warn(`${chatId}：语音或戳一戳与其他内容交错，无法在 3 条内保留全部类型和顺序，沿用旧合并策略`)
        const nonText = items.filter((item) => item.kind !== 'text' && item.kind !== 'voice').slice(-2)
        const textItems = items.filter((item) => item.kind === 'text' || item.kind === 'voice')
        const slots = Math.max(1, 3 - nonText.length)
        const merged = []
        for (let i = 0; i < textItems.length; i++) {
          const group = merged.length === slots - 1 ? textItems.slice(i) : [textItems[i]]
          const replyTo = group.find((item) => item.replyTo)?.replyTo
          merged.push({ kind: 'text', value: group.map((item) => item.value).join(' '), ...(replyTo ? { replyTo } : {}) })
          if (group.length > 1) break
        }
        items = [...merged, ...nonText]
      }
    }
    // 一段只有一个人明确 @ / 引用她时，第一条回复引用并 @ 那个人；多人同时叫她不猜。
    // 模型明确选了引用编号时尊重它，不再自动引用另一条。
    const refs = inGroup ? (opts.refs || groups.refs(chatId.slice(6))) : {}
    const explicit = items.some((item) => item.replyTo)
    const sendable = (item) => item.kind === 'mixed' ? item.parts.some(sendable) : item.kind === 'text' || item.kind === 'voice' || item.kind === 'image' || (item.kind === 'sticker' && cfg.stickers?.enabled && Boolean(item.value && typeof item.value === 'object' ? item.value : stickers.match(item.value)))
    // 仿真打字律动：多条气泡时按「思考 + 逐字击键 + 呼吸间隙」拉长间隔。
    // 关闭开关或算不出来（条目非法）时退回既有的固定公式，行为与旧版一致。
    const cadence = typingCadenceEnabled(cfg) ? calculateTypingCadence(items.map((item) => ({ kind: item.kind, value: item.kind === 'text' || item.kind === 'voice' ? item.value : '' }))) : null
    const cadenceUsable = Boolean(cadence?.valid)
    const waitBefore = (index) => {
      if (!cadenceUsable) return bubbleDelay(items[index].kind === 'text' ? items[index].value : '')
      return typingWaitAfter(cadence, index - 1)
    }
    const firstSendable = items.findIndex(sendable)
    const missedAt = [] // 写了 @ 却没对上群里人的名字
    // 逐条气泡如实记账（缺陷：轮次级谎报）。
    // outbound 的发送方法成功时返回 OneBot 的原始回执、失败时返回 null（它自己已经把
    // unknown/failed 写进台账了）。过去这里把返回值直接丢掉，于是「3 条里挂了 2 条」
    // 和「3 条全成功」在调用方看来一模一样，turn 一律报 state:'sent' —— 这就是谎报。
    // 现在统计 attempted / delivered，把差额作为 failedCount 交给调用方。
    // 注意 pokeBack 没有回执（戳一戳接口不返回消息 id），只计入 attempted，不算失败。
    let attempted = 0
    let delivered = 0
    let unconfirmed = 0
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const selected = it.replyTo ? refs[it.replyTo] : (!explicit && i === firstSendable ? opts.autoReply : null)
      const replyId = selected?.mid
      const userId = selected && opts.autoReply?.uid === selected.uid ? selected.uid : undefined
      if (it.replyTo && !replyId) log.debug(`${chatId}：引用的编号 ${it.replyTo} 对不上，正常发`)
      // 每个分支都拿到返回值：真对象 = 网关确认；null = 没发出去（含「无内容可发」的空跳过，
      // 那种情况本来就极少，按「未确认」计也更诚实）。
      let receipt = null
      let counted = true
      if (it.kind === 'text') receipt = await sendText(chatId, it.value, replyId, missedAt, userId)
      else if (it.kind === 'voice') {
        if (cfg.voice?.enabled) receipt = await sendVoice(chatId, it.value, replyId, userId)
        else receipt = await sendText(chatId, it.value, replyId, missedAt, userId)
      } else if (it.kind === 'sticker') receipt = await sendSticker(chatId, it.value, replyId, userId)
      else if (it.kind === 'poke') { counted = false; if (!opts.simulate) await pokeBack(chatId) }
      else if (it.kind === 'image') receipt = await sendImage(chatId, it.value, replyId, userId)
      else if (it.kind === 'mixed') receipt = await sendMixed(chatId, it.parts, replyId, missedAt, userId)
      if (counted && !opts.simulate) {
        attempted += 1
        if (receipt) delivered += 1
        else unconfirmed += 1
      }
      if (i < items.length - 1 && !opts.simulate) await wait(waitBefore(i + 1))
    }
    if (opts.simulate) return items
    if (inGroup) {
      const gid = chatId.slice(6)
      groups.noteSpeak(gid)
      // 「正聊得起劲」的续聊不入场、不续期，只进连聊预算（真机刷屏根因：
      // 续聊也刷新话题窗口 → 自我续期永不离场，1% 摇号只管进门不管出去）。
      // must/interject/其它路径的发言照旧算「加入话题」。
      if (opts.topicMode === 'engaged') groups.noteEngagedReply?.(gid)
      else groups.noteSpokeInGroup(gid)
    }
    const said = items.flatMap((item) => item.kind === 'mixed' ? item.parts : [item]).map((i) => (i.kind === 'text' || i.kind === 'voice' ? i.value : `[${i.kind}]`)).join(' ')
    logChat?.(chatId, 'bot', said)
    // 不是这个聊天自己那一轮发的（主人在私聊里让她去群里说、扩展模块代发）：记下来，下次这个聊天交给她时告诉她自己说过什么
    if (!opts.own) interaction.queueAside(chatId, said)
    // 有气泡没拿到回执就必须让调用方知道（不是致命错误：剩下的已经发出去了，
    // 也不该重发——那会重复说话）。调用方据此把 turn 记成部分送达而不是 sent。
    if (unconfirmed > 0) {
      log.warn(`${chatId}：本轮 ${attempted} 条气泡里有 ${unconfirmed} 条没拿到网关回执（已发出的不回滚、不重发）`)
    }
    onDelivered?.({ chatId, items, cfg })
    onActivity?.({ kind: 'out', chatId, reply: text, userText: opts.userText || '' })
    return { missedAt, attempted, delivered, failedCount: unconfirmed }
  }

  /**
   * 这个会话现在该不该被「主动开口」打扰（道别后的一小时静默期）。
   *
   * 为什么补这个：`conversation-closure` 的四态处方表里给了 `muteLockMs`（CLOSED 的静默时长），
   * `closurePlanFor` 也一直把 `closedAt` 记下来 —— 但**从来没有任何消费者读它**。
   * 于是「她说了晚安，一小时内不该自己再找你」这个设计意图在生产上根本没实现：
   * speakup 和 purpose 都不知道刚才道过别，照样按自己的空闲阈值开口。
   * 结果就是用户刚说完「睡了」，十分钟后又被她戳一下。
   *
   * 语义严格照模块注释：**只锁主动开口，不锁入站回复**。用户说完晚安又回来找她，
   * 照样必须回（deliverNow 完全不看这个函数）。
   *
   * @param {string} chatId
   * @param {number} [now] 注入时间便于测试
   * @returns {{muted: boolean, until: number, remainingMs: number, reason: string}}
   */
  function proactiveMuteState(chatId, now = Date.now()) {
    const key = String(chatId || '')
    const idle = { muted: false, until: 0, remainingMs: 0, reason: '' }
    if (!key) return idle
    try {
      const rec = closureStates.get(key)
      if (!rec || rec.state?.state !== CLOSED_STATE) return idle
      const lock = Math.max(0, Number(rec.state?.muteLockMs) || 0)
      if (lock <= 0) return idle
      // 没有 closedAt 就按「刚关」算：宁可少打扰一次，也不放她立刻去戳人。
      // （过期由时间自然解决，不会永久锁死 —— 这正是必须有时间戳的原因。）
      const since = Number(rec.closedAt) || Number(now)
      const until = since + lock
      const remainingMs = Math.max(0, until - Number(now))
      if (remainingMs <= 0) return idle
      return { muted: true, until, remainingMs, reason: '刚道别（CLOSED 静默期）' }
    } catch {
      // 任何异常都当成「没锁」：锁的存在是为了少打扰，不能因为内部状态坏掉就永久掐话。
      return idle
    }
  }

  /** 只回答「现在能不能主动开口」，方便调用方一行判断。 */
  const isProactivelyMuted = (chatId, now = Date.now()) => proactiveMuteState(chatId, now).muted

  return { deliver, deliverNow, proactiveMuteState, isProactivelyMuted }
}
