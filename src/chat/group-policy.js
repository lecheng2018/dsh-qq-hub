// 群聊回复策略：什么时候必回、什么时候插话、什么时候闭嘴。纯函数，便于测试。

export const DEFAULT_GROUP_POLICY = {
  // 群聊「叫醒词」的出厂默认值，面板可改（cfg.group.wakeWords 覆盖它）。
  // 与 persona/identity-context.js 的 wakeWords 是两套：那边判「她在说她自己」，
  // 这边判「群友在叫醒她」。故意分开——叫醒词是运维配置，不该随人设卡漂移。
  wakeWords: ['大肥鱼', '肥鱼'],
  interjectChance: 0.15, // 普通消息的基础插话概率（话题越相关越高，最高 80%）
  cooldownSec: 90, // 两次插话至少间隔
  maxPerHour: 6, // 每群每小时插话上限
  quietHours: [1, 8], // [开始, 结束) 小时，静默时段不插话（必回不受影响）
  minRecentMessages: 3, // 最近 activeWindowSec 内至少有这么多条消息才算「群里在聊」
  activeWindowSec: 300,
  // 话题相关度：群里正在聊的东西和她有关，才可能插话。
  // 注意：这里只放「谁都能聊的通用话题」。白米饭、熬夜、猫狗、睡觉这类看着无害，
  // 实际是主人的兴趣画像——写进插话触发器后，群里一提到这些词她就主动开口，
  // 等于替主人向陌生人报告他爱看什么、几点睡。想让她对某类话说得上话，
  // 请用面板按需配置，不要把这些词做成默认值。
  interests: ['游戏', '追剧', '番剧', '动漫', '电影', '音乐', '天气', '下雨', '表情包', '可爱', '奶茶', '甜品', '美食', '旅行'],
  minRelevance: 0.25, // 相关度低于这个就不插话（0 = 不看话题，纯随机）
  burstMax: 8, // 安全刹车：burstWindowSec 秒内她最多说这么多次，超了就歇着（主人 @ 除外），只防失控
  burstWindowSec: 120,
}

/**
 * 群里最近在聊的内容和她有多相关（0~1）。
 * @param {string[]} recentTexts 最近几条群消息
 * @param {string[]} interests 她感兴趣的话题词
 * @param {number} [memoryScore] 记忆库对这段话题的命中强度（0~1，可选）
 */
export function topicRelevance(recentTexts, interests, memoryScore = 0) {
  const txt = (recentTexts || []).join(' ')
  let hits = 0
  for (const w of interests || []) if (w && txt.includes(w)) hits++
  return Math.min(1, hits * 0.3 + Math.max(0, Math.min(1, memoryScore)) * 0.5)
}

/** 合并全局策略和单群覆盖。 */
export function policyFor(global, overrides, groupId) {
  const g = { ...DEFAULT_GROUP_POLICY, ...(global || {}) }
  const o = overrides && overrides[String(groupId)]
  return o ? { ...g, ...o } : g
}

/**
 * 短时间里她说了多少次（burst 刹车的计数）。纯函数，门禁与 decideGroupReply 共用同一口径。
 * @param {number[]} [botReplyTimes] 她最近每次说话的时间戳（毫秒）
 * @param {number} now 现在（毫秒）
 * @param {number} [burstWindowSec] 统计窗口（秒），缺省 120
 */
export function burstCount(botReplyTimes, now, burstWindowSec) {
  const win = (Number(burstWindowSec) || 120) * 1000
  return (Array.isArray(botReplyTimes) ? botReplyTimes : [])
    .filter((t) => Number.isFinite(t) && now - t < win)
    .length
}

export function inQuietHours(hour, quiet) {
  if (!Array.isArray(quiet) || quiet.length !== 2) return false
  const [a, b] = quiet.map(Number)
  if (a === b) return false
  return a < b ? hour >= a && hour < b : hour >= a || hour < b
}

/**
 * 决定这段群消息要不要回。
 * @param {object} p
 * @param {object} p.policy  policyFor() 的结果
 * @param {boolean} p.mentioned  被 @
 * @param {boolean} p.repliedToBot  引用了机器人的消息
 * @param {boolean} [p.fromOwner]  是主人说的
 * @param {string} p.text  消息正文
 * @param {number} p.now  毫秒时间戳
 * @param {number[]} p.recentTimes  本群最近消息的时间戳（毫秒）
 * @param {number[]} p.interjectTimes  本群最近插话的时间戳（毫秒）
 * @param {number[]} [p.botReplyTimes]  她在本群最近每次说话的时间戳（毫秒）
 * @param {number} p.hour  当前小时
 * @param {() => number} [p.rand]
 * @returns {{reply: boolean, mode: 'must'|'interject'|'engaged'|'none', reason: string}}
 */
export function decideGroupReply(p) {
  const pol = p.policy || DEFAULT_GROUP_POLICY
  const text = String(p.text || '')
  const rand = p.rand || Math.random
  const said = p.botReplyTimes || []
  // 刹车：短时间里说太多了就歇一会儿，只有主人 @ 能叫动
  const burst = burstCount(said, p.now, pol.burstWindowSec ?? 120)
  if (burst >= (pol.burstMax ?? 8) && !(p.fromOwner && (p.mentioned || p.repliedToBot))) {
    return { reply: false, mode: 'none', reason: `刚说了太多（${burst} 次），歇一会儿` }
  }
  if (p.mentioned) return { reply: true, mode: 'must', reason: '被 @' }
  if (p.repliedToBot) return { reply: true, mode: 'must', reason: '引用了她的消息' }
  const hit = (pol.wakeWords || []).find((w) => w && text.includes(w))
  if (hit) return { reply: true, mode: 'must', reason: `叫到了「${hit}」` }
  const rel = typeof p.relevance === 'number' ? p.relevance : 1

  if (!(pol.interjectChance > 0)) return { reply: false, mode: 'none', reason: '插话关着' }
  if (inQuietHours(p.hour, pol.quietHours)) return { reply: false, mode: 'none', reason: '静默时段' }
  const minRel = Number(pol.minRelevance) || 0
  // 已经加入了这个话题：接着聊（每段看完再回，不受冷却和每小时上限限制）
  if (p.engagedUntil && p.now < p.engagedUntil && rel >= minRel) {
    return { reply: true, mode: 'engaged', reason: `正聊得起劲，接着说（相关度 ${rel.toFixed(2)}）` }
  }
  const times = p.interjectTimes || []
  const lastHour = times.filter((t) => p.now - t < 3600_000).length
  if (lastHour >= pol.maxPerHour) return { reply: false, mode: 'none', reason: '这小时插话够多了' }
  const last = times.length ? Math.max(...times) : 0
  if (p.now - last < pol.cooldownSec * 1000) return { reply: false, mode: 'none', reason: '插话冷却中' }
  const recent = (p.recentTimes || []).filter((t) => p.now - t < pol.activeWindowSec * 1000).length
  if (recent < pol.minRecentMessages) return { reply: false, mode: 'none', reason: '群里没在聊' }
  // 话题和她有关才插，越相关越容易插（不传 relevance 时按「不看话题」处理，兼容旧调用）
  if (minRel > 0 && rel < minRel) return { reply: false, mode: 'none', reason: `话题和她关系不大（相关度 ${rel.toFixed(2)}）` }
  const chance = minRel > 0 ? Math.min(0.8, pol.interjectChance * (1 + 4 * rel)) : pol.interjectChance
  if (rand() < chance) return { reply: true, mode: 'interject', reason: `话题相关，插一句（相关度 ${rel.toFixed(2)}）` }
  return { reply: false, mode: 'none', reason: '这次不插话' }
}
