// 入站路由层：realtime / backfill 共用同一条主链（从 host/modular-core.js 原样搬出）。
//
// 顺序逐项对齐 legacy hub.onMessage：
//   ACL → 旁路指令 → 总开关 → 静音 → 群缓冲 → activity 计数 → 群回复闸 → offer。
// （真机审计 1.9/1.10/§1：enabled=false 和静音必须**入口就拦**——不进回合不烧 token；
//  activity 在闸之前发：相关模块的计数不受「要不要回」影响。）
//
// 搬动方式：整段按行切片原样搬出，只把装配根里的闭包变量改成注入项。
// 依赖一律是**活引用**（对象 / Map / Set / 取数函数），本模块不复制任何状态：
//   · groups / interaction / presence / controller / outbox / mods / groupGate 是装配根持有的同一份对象；
//   · stickerPicks / steeringChats / backfillMeta 是同一份 WeakMap / Set（与 execute 主链共享）；
//   · rateAllowed / gatedDebug / replyIdOf / quotedInfo / quoteNote / noteMedia 等是装配根的函数闭包。
// 这样 execute 主链看到的回合、缓冲、限流、表情候选与本模块完全一致（拆的是实现，不是状态）。

import { checkAllowed, isOwner } from '../../chat/access.js'
import { policyFor, isOfficialBotSender } from '../../chat/group-policy.js'
import { parseMessageEvent } from '../../chat/inbound.js'
import { parseCommand } from '../../chat/commands.js'
import { legacyEventToNormalized } from '../../chat/adapters/legacy-inbound.js'
import { aclMsgFromInbound, emitActivity, mediaOfInbound, textOfSegments } from './inbound-prep.js'

/**
 * @param {object} o
 * @param {() => object} o.getConfig 每轮读最新配置（面板改完下一轮生效）
 * @param {object} o.log / o.debug / o.gatedDebug 日志（gatedDebug 带同款去重闸）
 * @param {object} o.mods 模块中枢（emit / commands）
 * @param {object} [o.moduleHooks] poke / message / groupDecide 扩展钩子
 * @param {Function} [o.runCommand] owner 命令闸
 * @param {object} o.controller TurnController（活引用：回合 offer/steer/waitForTurn）
 * @param {object} o.outbox 物理出口（活引用：临时会话来源群 / 命令直发）
 * @param {object} o.groups 群状态（活引用：缓冲 / 决策读取）
 * @param {object} o.groupGate core/group-gate.js 的实例（decideGroupReplyFor / noteTurnMode / fishGuardOf）
 * @param {object} o.interaction 交互状态（活引用）
 * @param {object} o.presence 在场状态（活引用）
 * @param {WeakMap} o.stickerPicks 入站 → 暂存表情候选数（活引用，execute 也读）
 * @param {Set} o.steeringChats 只在生成期接受 steer 的聊天（活引用，execute 增删）
 * @param {WeakMap} o.backfillMeta 补收事件元信息（活引用，execute 读）
 */
export function createInboundRouter({
  getConfig, log, debug, gatedDebug,
  mods, moduleHooks, runCommand,
  controller, outbox, groups, groupGate,
  interaction, presence,
  stickerPicks, steeringChats, backfillMeta,
  replyIdOf, quotedInfo, quoteNote, rateAllowed,
  interceptInteraction, isMuted, noteMedia, onStats, logChat, collectInboundStickers,
}) {
  // 自身 QQ 号：命令闸/戳一戳判定要用（gateway 每个事件都带 self_id，这里记最新一份）。
  let selfId = ''

  /**
   * 入站主链（realtime/backfill 共用），顺序逐项对齐 legacy hub.onMessage：
   * ACL → 旁路指令 → 总开关 → 静音 → 群缓冲 → activity 计数 → 群回复闸 → offer。
   */
  function routeInbound(inbound, ev, source) {
    const isPoke = (inbound?.segments || []).some((s) => s?.type === 'poke')
    if (isPoke) {
      const self = String(ev.self_id || getConfig().botQQ || '')
      const poker = String(inbound.sender?.userId || '')
      if (String(ev.target_id || '') !== self || !poker || poker === self) return { handled: 'skipped' }
    }
    const hook = isPoke ? moduleHooks?.poke : moduleHooks?.message
    const continueInbound = () => {
      if (!isPoke) return routeInboundCore(inbound, ev, source)
      try { interaction.rememberPoker(inbound.chatKey, String(inbound.sender?.userId || '')) } catch {}
      try { if (!interaction.claimPoke(inbound.chatKey)) return { handled: 'poke-throttled' } } catch {}
      const poke = inbound.segments.find((s) => s?.type === 'poke')
      const action = String(poke?.data?.action || '')
      const suffix = String(poke?.data?.suffix || '')
      return routeInboundCore({
        ...inbound,
        segments: [
          { type: 'at', data: { qq: String(ev.self_id || getConfig().botQQ || '') } },
          { type: 'text', data: { text: ` [戳了戳你${action ? `：${action}${suffix}` : ''}]` } },
        ],
      }, ev, source)
    }
    if (typeof hook !== 'function') return continueInbound()
    const input = isPoke ? ev : { ...parseMessageEvent(ev, ev.self_id), raw: ev }
    return Promise.resolve(hook(input)).then((claimed) => claimed ? { handled: 'module' } : continueInbound())
  }

  function routeInboundCore(inbound, ev, source) {
    const cfg = getConfig()
    // 入站 ACL：白名单外会话 offer 前即拒（绝不让未授权消息驱动 DSH）
    const acl = checkAllowed(cfg, aclMsgFromInbound(inbound))
    if (!acl.allowed) {
      gatedDebug(`acl:${inbound.chatKey}`, `deny|${acl.reason}`, `入站 ACL 拒绝：${inbound.chatKey}（${acl.reason}）`)
      return { handled: 'acl-denied', reason: acl.reason }
    }
    presence.noteIncoming(inbound.chatKey, String(inbound?.sender?.userId || ''), cfg)
    // 临时会话（SnowLuma 能力补齐）：ACL 放行的私聊若来自群临时会话，记住来源群，
    // 回复经 outbox 时带 group_id 才能送进临时会话。
    // 若收到普通好友私聊（sub_type === 'friend'），清除旧的临时会话来源群，避免继续带旧 group_id。
    if (String(inbound.chatKey || '').startsWith('private:')) {
      if (ev?.sub_type === 'group') {
        const sg = String(ev?.sender?.group_id ?? '')
        if (/^\d+$/.test(sg) && Number(sg) > 0) outbox.notePrivateSource(inbound?.sender?.userId, sg)
      } else if (ev?.sub_type === 'friend') {
        outbox.clearPrivateSource?.(inbound?.sender?.userId)
      }
    }
    // 旁路指令（审批批复 / 等待中的交互提问回答）：命中即消费，不进回合
    if (typeof interceptInteraction === 'function') {
      const text = textOfSegments(inbound.segments)
      const userId = String(inbound?.sender?.userId ?? '')
      try {
        if (interceptInteraction({ text, userId, chatId: inbound.chatKey })) {
          debug(`旁路指令消费：${inbound.chatKey}`)
          return { handled: 'interaction' }
        }
      } catch (error) { debug(`旁路指令判定出错（照常走回合）：${error.message}`) }
    }
    // 白名单内的媒体先暂存；总开关只阻止回合，不影响「刚才那张图」的后续读取。
    try { noteMedia?.(inbound.chatKey, inbound.segments, String(inbound?.sender?.userId || '')) } catch {}
    // 总开关 / 静音：入口拦（关了开关就不跑回合，不再只靠出站闸兜底）
    if (!cfg.enabled) {
      log.info(`总开关关着，收到 ${inbound.chatKey} 的消息但不处理：${textOfSegments(inbound.segments).slice(0, 30)}`)
      return { handled: 'disabled' }
    }
    if (typeof isMuted === 'function') {
      let muted = false
      try { muted = !!isMuted(inbound.chatKey) } catch {}
      if (muted) return { handled: 'muted' }
    }
    if (!rateAllowed(inbound)) {
      debug(`入站限流：${inbound.chatKey} 用户 ${String(inbound?.sender?.userId || '')} 消息未进入回合`)
      return { handled: 'ratelimited' }
    }
    const inGroup = inbound.chatKey.startsWith('group:')
    const text = textOfSegments(inbound.segments)
    const userId = String(inbound?.sender?.userId ?? '')
    const nick = String(inbound?.sender?.nickname || '')
    const officialBot = isOfficialBotSender(userId, nick)
    // 群缓冲（legacy 同款：群里的每条消息都记，给上下文和「群里在不在聊」用；ACL 后、闸前）
    let mentioned = false
    let buffered = null
    if (inGroup) {
      try {
        mentioned = !!parseMessageEvent(ev, ev.self_id).mentioned
      } catch {}
      const self = String(ev.self_id || getConfig().botQQ || '')
      mentioned = mentioned || inbound.segments.some((s) => s?.type === 'at' && String(s.data?.qq || '') === self)
      const gid = inbound.chatKey.slice(6)
      buffered = groups.appendMessage(gid, { t: Date.now(), uid: userId, nick, text, self: userId === self, officialBot, at: mentioned, mid: String(inbound.messageId || ''), direct: mentioned, replyId: replyIdOf(inbound), media: mediaOfInbound(inbound) })
      try { interaction.rememberSpeaker(inbound.chatKey, userId) } catch {}
    }
    const fromOwner = isOwner(cfg, userId)
    // 真机审计 1.11：入站面板统计
    try { onStats?.('received') } catch {}
    // 聊天流水（legacy hub.js 在 onMessage 里逐条记）：记忆整理/日记都从它取料
    try { logChat?.(inbound.chatKey, String(inbound?.sender?.nickname || ''), textOfSegments(inbound.segments), userId) } catch {}
    try {
      const count = collectInboundStickers?.(inbound.chatKey, inbound.segments, userId)
      if (typeof count === 'number') stickerPicks.set(inbound, count)
    } catch {}
    if (inGroup) {
      const offerWithDecision = (decision) => {
        emitActivity(mods, inbound, { direct: mentioned || decision.mode === 'must', owner: fromOwner })
        if (!decision.reply) {
          gatedDebug(`gate:${inbound.chatKey}`, decision.reason, `群闸 ${inbound.chatKey}：不回 —— ${decision.reason}`)
          return { handled: 'group-pass', reason: decision.reason }
        }
        // 鱼群保护（pair 乒乓 + 密度）：判定与状态归 core/group-gate.js。
        // 返回 { handled: 'group-pass', reason } = 本轮不参与；null = 放行（判定出错也放行）。
        const fishBlocked = groupGate.fishGuardOf({ inbound, decision, cfg })
        if (fishBlocked) return fishBlocked
        const offered = controller.offer(inbound)
        if (offered?.turnId && decision.mode) groupGate.noteTurnMode(inbound.chatKey.slice(6), offered.turnId, decision.mode)
        // 正向决策也留痕：否则只能看到后一条“不回”，容易误判成它绕闸门发了上一条回合。
        debug(`群闸 ${inbound.chatKey}：回 —— ${decision.reason}｜消息 ${inbound.messageId || '?'}｜回合 ${offered.turnId}`)
        return { handled: 'offered', turnId: offered.turnId }
      }
      const applyHook = (decision) => {
        if (typeof moduleHooks?.groupDecide !== 'function') return offerWithDecision(decision)
        const msg = { ...parseMessageEvent(ev, ev.self_id), raw: ev }
        const policy = policyFor(cfg.group, cfg.group?.overrides, inbound.chatKey.slice(6))
        return Promise.resolve(moduleHooks.groupDecide(decision, {
          msg, policy, recentTexts: groups.buffer(inbound.chatKey.slice(6)).map((x) => x.text), memScore: 0,
        })).then((next) => offerWithDecision(next || decision))
      }
      const replyId = replyIdOf(inbound)
      if (replyId) {
        return quotedInfo(replyId, inbound.chatKey).then((quoted) => {
          const repliedToBot = Boolean(quoted?.ok && quoted.isBot)
          if (buffered) {
            if (repliedToBot) buffered.direct = true
            if (quoted) buffered.quoteNote = quoteNote(quoted)
          }
          return applyHook(groupGate.decideGroupReplyFor({ chatKey: inbound.chatKey, text, mentioned, userId, nick, repliedToBot }))
        })
      }
      return applyHook(groupGate.decideGroupReplyFor({ chatKey: inbound.chatKey, text, mentioned, userId, nick }))
    }
    emitActivity(mods, inbound, { direct: true, owner: fromOwner })
    const running = controller.runningTurnOf(inbound.chatKey)
    if (running && steeringChats.has(inbound.chatKey)) {
      controller.steer(running, inbound).catch((error) => {
        debug(`私聊插话失败，转为下一轮：${error?.message || error}`)
        controller.offer(inbound)
      })
      return { handled: 'steered', turnId: running }
    }
    const offered = controller.offer(inbound)
    return { handled: 'offered', turnId: offered.turnId }
  }

  function safeAdapt(ev, source) {
    try {
      const inbound = legacyEventToNormalized(ev, { selfId: ev.self_id, source })
      return { inbound, view: ev }
    } catch (error) {
      debug(`事件无法成键/不支持：${error.message}`)
      return { inbound: null, view: null }
    }
  }

  /** 补收入口（M4-4）：补收事件带原始时间，source=backfill（M1-B 语义同款）。与实时同一条主链（ACL/闸/静音/群闸）。 */
  function dispatchBackfill(ev, meta = {}) {
    const { inbound } = safeAdapt(ev, 'backfill')
    if (!inbound) return { handled: 'skipped' }
    backfillMeta.set(inbound, {
      gapMs: Number(meta.gapMs) || 120_000,
      earliestAgeMs: Number(meta.earliestAgeMs) || 0,
    })
    return routeInbound(inbound, ev, 'backfill')
  }

  /** 聊天域消息入口（host dispatchEvent 的旗开分支）。 */
  async function dispatchLegacyEvent(ev) {
    selfId = String(ev.self_id || selfId || getConfig().botQQ || '')
    const cfg = getConfig()
    // 命令闸（M4-2）：主人斜杠命令先截，回复经 outbox（同 legacy：命令不进合流，总开关关着也处理）
    if (runCommand && ev.post_type === 'message') {
      const view = parseMessageEvent(ev, ev.self_id)
      const cmd = parseCommand(view.text, mods.commands())
      if (cmd && isOwner(cfg, view.userId)) {
        const reply = await runCommand(cmd, { ...view, chatId: view.chatId, nickname: cfg.ownerName || '主人', text: view.text })
        if (reply) {
          await outbox.request({
            chatKey: view.chatId,
            sourceModuleId: 'core',
            segments: [{ type: 'text', data: { text: String(reply) } }],
            force: true,
          })
          return { handled: 'command' }
        }
      }
    }
    const { inbound } = safeAdapt(ev, 'realtime')
    if (!inbound) return { handled: 'skipped' }
    return routeInbound(inbound, ev, 'realtime')
  }

  /** 兼容旧 hub.onMessage 的等待契约；网关实时分发仍使用上面的异步入口。 */
  async function dispatchLegacyEventSettled(ev) {
    const routed = await dispatchLegacyEvent(ev)
    if (!routed?.turnId) return routed
    const outcome = await controller.waitForTurn(routed.turnId)
    if (outcome?.error) throw outcome.error
    return { ...routed, result: outcome?.value }
  }

  return {
    routeInbound, routeInboundCore, safeAdapt, dispatchBackfill,
    dispatchLegacyEvent, dispatchLegacyEventSettled,
    selfId: () => selfId,
  }
}