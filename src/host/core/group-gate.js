// 群回复闸 + 回合模式账（真机审计 §1）。
//
// 从 host/modular-core.js 拆出：群消息要不要回（decideGroupReplyFor）、在途回合配额
// （noteTurnMode / pruneInFlightGroup / releaseTurnMode / isTurnActive）。决策本身仍复用
// legacy 的纯函数与状态模块（group-policy / group-atmosphere-gate），本模块不另立策略。
//
// 状态归属：turnModes / inFlightEngaged / inFlightInterject 只在这里读写；核心读模式时
// 走 turnModeOf（一份读口），避免两个文件各持一份 Map 而漂移。
//
// 依赖一律是活引用/取数函数：getConfig 每轮读最新配置（面板改完下一轮生效），
// getController 延迟取回 turn controller（它在本模块装配之后才创建，与原闭包语义一致）。

import { resolveCharacterIdentity } from '../../persona/identity-context.js'
import { policyFor, topicRelevance, withRoleWakeWords, isOfficialBotSender } from '../../chat/group-policy.js'
import { decideGroupReplyWithAtmosphere } from '../../chat/group-atmosphere-gate.js'
import { isOwner } from '../../chat/access.js'
import { assessFishDensity, assessPairLoop, dedupConvo, fishGuardReasonText, normalizeFishGuard, senderFish } from '../../chat/fish-guard.js'

export function createGroupGate({ getConfig, log, debug, groups, memoryScore, atmosphereGate, getController }) {
  // 按 turnId 绑定群闸决策模式，替代旧版按 chatKey 单槽 pendingMode：
  // 连续排入多轮时，旧单槽会在前轮 delete 后让后轮兜底成 'must'，既在提示词里谎称「有人在叫你」，
  // 又在 deliver 后走 noteSpokeInGroup 重置 engaged 窗口导致无限续聊。
  const MODE_PRIORITY = { engaged: 1, interject: 2, must: 3 }
  const turnModes = new Map() // turnId -> 'engaged' | 'interject' | 'must'
  const inFlightEngaged = new Map() // gid -> Set<turnId>（已过闸未结账的 engaged 回合，防并发超卖）
  const inFlightInterject = new Map() // gid -> Map<turnId, number>（已过闸未结账的 interject 时刻，防冷却期并发双插）
  function isTurnActive(turnId) {
    const t = getController()?.getTurn?.(turnId)
    return Boolean(t && (t.state === 'merging' || t.state === 'pending' || t.state === 'running'))
  }
  function pruneInFlightGroup(gid) {
    const id = String(gid || '')
    const eng = inFlightEngaged.get(id)
    if (eng) {
      for (const tid of eng) {
        if (!isTurnActive(tid)) { eng.delete(tid); turnModes.delete(tid) }
      }
      if (!eng.size) inFlightEngaged.delete(id)
    }
    const inj = inFlightInterject.get(id)
    if (inj) {
      for (const tid of inj.keys()) {
        if (!isTurnActive(tid)) { inj.delete(tid); turnModes.delete(tid) }
      }
      if (!inj.size) inFlightInterject.delete(id)
    }
  }
  function noteTurnMode(gid, turnId, mode, now = Date.now()) {
    if (!turnId || !mode) return
    const id = String(gid || '')
    const prev = turnModes.get(turnId)
    const next = !prev || (MODE_PRIORITY[mode] || 0) > (MODE_PRIORITY[prev] || 0) ? mode : prev
    turnModes.set(turnId, next)
    if (!id) return
    if (next === 'engaged') {
      let set = inFlightEngaged.get(id)
      if (!set) { set = new Set(); inFlightEngaged.set(id, set) }
      set.add(turnId)
      const inj = inFlightInterject.get(id)
      if (inj) { inj.delete(turnId); if (!inj.size) inFlightInterject.delete(id) }
    } else if (next === 'interject') {
      let map = inFlightInterject.get(id)
      if (!map) { map = new Map(); inFlightInterject.set(id, map) }
      if (!map.has(turnId)) map.set(turnId, now)
      const eng = inFlightEngaged.get(id)
      if (eng) { eng.delete(turnId); if (!eng.size) inFlightEngaged.delete(id) }
    } else {
      const eng = inFlightEngaged.get(id)
      if (eng) { eng.delete(turnId); if (!eng.size) inFlightEngaged.delete(id) }
      const inj = inFlightInterject.get(id)
      if (inj) { inj.delete(turnId); if (!inj.size) inFlightInterject.delete(id) }
    }
  }
  function releaseTurnMode(chatKey, turnId) {
    if (turnId) turnModes.delete(turnId)
    if (!String(chatKey || '').startsWith('group:')) return
    const id = String(chatKey).slice(6)
    const eng = inFlightEngaged.get(id)
    if (eng) { eng.delete(turnId); if (!eng.size) inFlightEngaged.delete(id) }
    const inj = inFlightInterject.get(id)
    if (inj) { inj.delete(turnId); if (!inj.size) inFlightInterject.delete(id) }
  }

  /**
   * 群消息要不要回：与 legacy 同一 decideGroupReply 调用形状。
   * 门禁只在这一处接：第 1/2/4 步仍是 decideGroupReply 本身，
   * 开关关时返回值与改造前逐字段一致。
   */
  function decideGroupReplyFor({ chatKey, text, mentioned, userId, nick = '', repliedToBot = false }) {
    const cfg = getConfig()
    const now = Date.now()
    const gid = chatKey.slice(6)
    const pol0 = policyFor(cfg.group, cfg.group?.overrides, gid)
    // 唤醒词不只认配置里那几个固定词：她自己卡上的名字也该叫得动，
    // 否则换了卡就变成「在群里喊她新名字没反应」——和身份中枢认的名字劈叉。
    const pol = withRoleWakeWords(pol0, resolveCharacterIdentity(`group:${gid}`, cfg))
    // 排除 QQ 官方系统机器人（Q群管家等），避免污染活跃度、相关度与氛围判定
    const humanBuf = groups.buffer(gid).filter((x) => !x.officialBot)
    const recentTexts = humanBuf.filter((x) => now - x.t < pol.activeWindowSec * 1000).slice(-6).map((x) => x.text)
    let memScore = 0
    try {
      const memChat = { chatId: chatKey, kind: 'group', groupId: gid }
      memScore = typeof memoryScore === 'function' ? memoryScore(recentTexts.join(' '), memChat) : 0
    } catch { memScore = 0 }
    pruneInFlightGroup(gid)
    const inFlightEng = inFlightEngaged.get(gid)?.size || 0
    const inFlightInj = inFlightInterject.get(gid) ? [...inFlightInterject.get(gid).values()] : []
    const decision = decideGroupReplyWithAtmosphere({
      messages: humanBuf,
      policy: pol,
      relevance: topicRelevance(recentTexts, pol.interests, memScore),
      engagedUntil: groups.engagedUntil(gid),
      // engaged 连聊预算的两路输入：已接条数（含在途未结账回合）+ 入场时刻（group-policy 封顶）
      engagedReplies: groups.engagedReplies(gid) + inFlightEng,
      engagedSince: groups.engagedSince(gid),
      mentioned: !!mentioned,
      repliedToBot: !!repliedToBot,
      fromOwner: isOwner(cfg, userId),
      fromOfficialBot: isOfficialBotSender(userId, nick),
      text,
      now,
      hour: new Date().getHours(),
      recentTimes: humanBuf.map((x) => x.t),
      interjectTimes: inFlightInj.length ? [...groups.interjectTimes(gid), ...inFlightInj] : groups.interjectTimes(gid),
      botReplyTimes: groups.speakTimes(gid),
    }, { gate: atmosphereGate })
    // 连聊预算用尽/超时后立刻清掉 engaged，让后续消息可以正常重新走冷却 + 插话摇号，不再死锁
    if (decision.leaveTopic) groups.leaveTopic(gid)
    // 氛围快照只在门禁开启时存在：进日志，排障时能直接看到「为什么没插嘴」。
    if (decision.atmosphere) debug(`群 ${gid} 氛围：张力 ${decision.atmosphere.tension.toFixed(2)}、热度 ${decision.atmosphere.energy.toFixed(2)}（${decision.atmosphere.advice}）`)
    return decision
  }

  /** 这个回合在闸门里被判成什么模式（核心读它决定提示词口吻与续聊分派）。 */
  function turnModeOf(turnId) { return turnModes.get(turnId) || null }

  // ---------- 鱼群 / 滞后复核（从 modular-core.js 原样搬出；闭包 groups/getConfig/log 已是注入活引用） ----------
  // 对聊冷却账：`gid:uid` → 冷却截止时刻。只服务这儿，随判定一起搬进来。
  const pairCalmUntil = new Map()
  const pairCalmSweep = (now) => {
    if (pairCalmUntil.size < 50) return
    for (const [key, until] of pairCalmUntil) if (until < now - 3 * 3600_000) pairCalmUntil.delete(key)
  }

  /**
   * 鱼群保护判定：返回 `{ handled: 'group-pass', reason }` 表示本轮不参与；返回 null 表示放行。
   *
   * 决策依据与拆分前逐行一致（pair 乒乓 + 密度两段）：缓冲只收入站消息，把她最近的发言
   * （speakTimes，noteSpeak 已记）合成 self 条目一并喂给 pair/密度判定，不写回缓冲。
   * 判定自身出错只记 debug 并放行 —— 鱼群保护是旁路，绝不因为判定异常而吞掉正常回合。
   */
  function fishGuardOf({ inbound, decision, cfg }) {
    try {
      const fg = normalizeFishGuard(cfg.group?.fishGuard || {})
      if (fg.enabled) {
        const now = Date.now()
        const gid = inbound.chatKey.slice(6)
        const userId = String(inbound?.sender?.userId ?? '')
        const pairKey = `${gid}:${userId}`
        // 鱼群保护需要「她↔对方」交替视角（缺陷：bot 自发不入缓冲 → pair/乒乓恒 0 空转）。
        // 缓冲只收入站消息；把她最近发言时间（speakTimes，noteSpeak 已记）合成 self 条目
        // 一并喂给 pair/密度判定。不写回缓冲，避免污染群提示词上下文。
        const botQQ = String(getConfig().botQQ || '')
        const selfMsgs = groups.speakTimes(gid, now).map((t) => ({ sender: '她', userId: botQQ, time: t, isSelf: true }))
        const fishMsgs = [...groups.buffer(gid).map((x) => ({ sender: x.nick, userId: x.uid, time: x.t, text: x.text, isSelf: x.self === true })), ...selfMsgs]
          .sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0))
        if (userId !== String(getConfig().ownerQQ || '')) {
          const calmUntil = pairCalmUntil.get(pairKey) || 0
          if (calmUntil > now) return { handled: 'group-pass', reason: '对聊冷却中' }
          // 保留 fg.windowMs 窗口内完整发言序列（含其他群友，供 assessPairLoop 正确识别真人插话重置）
          const pairMsgs = dedupConvo(fishMsgs.filter((x) => Number(x.time || 0) > now - fg.windowMs))
          const loop = assessPairLoop(pairMsgs, userId, { guard: fg })
          if (loop.blocked) {
            pairCalmSweep(now)
            pairCalmUntil.set(pairKey, now + fg.pairCooldownMs)
            const reason = `与 ${inbound.sender?.nickname || userId} 已互来回 ${loop.rounds} 轮，进入对聊冷却`
            log.info(`群 ${gid}：${reason}`)
            return { handled: 'group-pass', reason }
          }
        }
        const direct = decision.mode === 'must'
        const density = assessFishDensity(fishMsgs, { now, guard: fg, groupId: gid, groupName: groups.name(gid) })
        if (density.blocked) {
          const callerIsFish = senderFish({ userId, sender: inbound.sender?.nickname }, fg)
          if (!(direct && fg.bypassDirectAddress && !callerIsFish)) {
            const reason = fishGuardReasonText(density)
            log.info(`群 ${gid}：${reason}${direct && callerIsFish ? '，叫她的也在鱼名单里，豁免不适用' : ''}，本轮不参与`)
            return { handled: 'group-pass', reason }
          }
          debug(`群 ${gid}：${fishGuardReasonText(density)}，但被直接叫到 → 只回一句`)
        }
      }
    } catch (error) { debug(`鱼群保护判定出错：${error.message}`) }
    return null
  }

  return { decideGroupReplyFor, noteTurnMode, releaseTurnMode, pruneInFlightGroup, isTurnActive, turnModeOf, fishGuardOf }
}
