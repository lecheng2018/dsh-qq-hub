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

export function createGroupGate({ getConfig, debug, groups, memoryScore, atmosphereGate, getController }) {
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

  return { decideGroupReplyFor, noteTurnMode, releaseTurnMode, pruneInFlightGroup, isTurnActive, turnModeOf }
}
