import { AsyncLocalStorage } from 'node:async_hooks'
import { parseReply, bubbleDelay, replyRules, extractAndStripInnerMonologue } from './reply.js'
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
    const parseRules = inGroup ? { ...rules, maxBubbles: Number.MAX_SAFE_INTEGER } : rules
    const r = parseReply(text, parseRules)
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
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const selected = it.replyTo ? refs[it.replyTo] : (!explicit && i === firstSendable ? opts.autoReply : null)
      const replyId = selected?.mid
      const userId = selected && opts.autoReply?.uid === selected.uid ? selected.uid : undefined
      if (it.replyTo && !replyId) log.debug(`${chatId}：引用的编号 ${it.replyTo} 对不上，正常发`)
      if (it.kind === 'text') await sendText(chatId, it.value, replyId, missedAt, userId)
      else if (it.kind === 'voice') {
        if (cfg.voice?.enabled) await sendVoice(chatId, it.value, replyId, userId)
        else await sendText(chatId, it.value, replyId, missedAt, userId)
      } else if (it.kind === 'sticker') await sendSticker(chatId, it.value, replyId, userId)
      else if (it.kind === 'poke') { if (!opts.simulate) await pokeBack(chatId) }
      else if (it.kind === 'image') await sendImage(chatId, it.value, replyId, userId)
      else if (it.kind === 'mixed') await sendMixed(chatId, it.parts, replyId, missedAt, userId)
      if (i < items.length - 1 && !opts.simulate) await wait(waitBefore(i + 1))
    }
    if (opts.simulate) return items
    if (inGroup) {
      const gid = chatId.slice(6)
      groups.noteSpeak(gid)
      groups.noteSpokeInGroup(gid) // 在群里说了话 = 加入了话题
    }
    const said = items.flatMap((item) => item.kind === 'mixed' ? item.parts : [item]).map((i) => (i.kind === 'text' || i.kind === 'voice' ? i.value : `[${i.kind}]`)).join(' ')
    logChat?.(chatId, 'bot', said)
    // 不是这个聊天自己那一轮发的（主人在私聊里让她去群里说、扩展模块代发）：记下来，下次这个聊天交给她时告诉她自己说过什么
    if (!opts.own) interaction.queueAside(chatId, said)
    onDelivered?.({ chatId, items, cfg })
    onActivity?.({ kind: 'out', chatId, reply: text, userText: opts.userText || '' })
    return { missedAt }
  }

  return { deliver, deliverNow }
}
