// 群聊回复策略：什么时候必回、什么时候插话、什么时候闭嘴。纯函数，便于测试。

export const DEFAULT_GROUP_POLICY = {
  // 群聊「叫醒词」的出厂默认值，面板可改（cfg.group.wakeWords 覆盖它）。
  // 与 persona/identity-context.js 的 wakeWords 是两套：那边判「她在说她自己」，
  // 这边判「群友在叫醒她」。故意分开——叫醒词是运维配置，不该随人设卡漂移。
  wakeWords: ['大肥鱼', '肥鱼'],
  interjectChance: 0.15, // 普通消息的基础插话概率（话题越相关越高，最高 80%）
  cooldownSec: 90, // 两次插话至少间隔
  // 每小时**说话总条数**（不是「插话次数」）。
  // 2026-11-17 改口径：以前这个数只数 interjectTimes，而每次插话成功还会白送
  // engagedMaxReplies 条「连聊」额度、且连聊不吃任何上限 —— 名义设 6 的群实测每小时能说
  // 22.5 条（6 × (1+3) 再打个摩擦折扣）。现在插话和连聊吃同一份令牌桶预算。
  // 语义也从「滚动一小时硬顶」变成「长期速率」：允许最多 ⌈maxPerHour/3⌉ 条连发（一波聊起来的
  // 余地），之后按 maxPerHour 的速率慢慢回补。这样既压住总量，又不会「前半程说光、后半程哑掉」。
  maxPerHour: 20,
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
  // 「正聊得起劲」的连聊预算：一次入场最多连着接这么多条，或聊满这么久，
  // 到顶就退出话题（想再聊必须重新过插话摇号）。真机刷屏事故的根因就是
  // engaged 既不受冷却/每小时上限约束、又会每次说话自我续期，一旦入场永不离场。
  engagedMaxReplies: 3,
  engagedMaxMs: 6 * 60_000,
}

/**
 * 群里最近在聊的内容和她有多相关（0~1）。
 * @param {string[]} recentTexts 最近几条群消息
 * @param {string[]} interests 她感兴趣的话题词
 * @param {number} [memoryScore] 记忆库对这段话题的命中强度（0~1，可选）
 */
export function topicRelevance(recentTexts, interests, memoryScore = 0) {
  const hasInterests = Array.isArray(interests) && interests.length > 0
  const mem = Math.max(0, Math.min(1, Number(memoryScore) || 0))
  const txt = (recentTexts || []).join(' ')
  let hits = 0
  if (hasInterests) {
    for (const w of interests) if (w && txt.includes(w)) hits++
  }
  // 未配置任何感兴趣话题且无特定记忆加分时：没有定义话题词表约束，不把日常闲聊判为 0
  // （避免与默认门槛 0.35 构成死锁扼杀所有群插话）；返回基础相关度 0.35，让基础概率生效。
  // 配置了话题词时（哪怕只有一个词未命中）仍严格走下方计算，不放水。
  if (!hasInterests && mem <= 0) return 0.35
  return Math.min(1, hits * 0.3 + mem * 0.5)
}

/**
 * 把「她自己卡上的名字」并进唤醒词。
 * （已关闭自动并入卡名：群消息文本匹配完全以配置中的 wakeWords 为准，
 * 避免人设名与群日常话题重叠（如「豆包」模型/反代/客户端）导致频繁误唤醒。）
 * @param {object} policy 已经合并过单群覆盖的策略
 * @param {{name?:string, hasCard?:boolean}} [identity] 身份中枢的解析结果
 */
export function withRoleWakeWords(policy, identity) {
  return policy || DEFAULT_GROUP_POLICY
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
 * 每小时发言额度：令牌桶，纯函数从「她最近说话的时刻」反推，不落新状态（重启/重放一致）。
 *
 * 为什么不是「最近一小时数够 N 条就拒」：那样额度是**先到先得**的 —— 活跃群在前半程
 * 一口气把额度说光，后半程彻底哑掉。2026-11-17 实测（三段爆发 / 一小时）：
 * 前 20 分钟说了 14 条（占 64%），第三段爆发（40~48 分）一句都说不了。
 *
 * 令牌桶把「总量」和「节奏」一起管：容量给一小波连聊的余地（⌈maxPerHour/3⌉ 条），
 * 之后按 maxPerHour 的速率回补。既限住了每小时总量，又能接住「一阵猛聊」。
 *
 * @param {number[]} botReplyTimes 她在本群最近每次说话的时间戳（毫秒），已由 group-state 裁到 1 小时窗
 * @param {number} now 现在（毫秒）
 * @param {number} maxPerHour 每小时允许说的条数（0 = 不许主动说话）
 * @returns {{level:number, cap:number, rate:number, allowed:boolean}} level = 当前可用额度（条）
 */
export function replyBudget(botReplyTimes, now, maxPerHour) {
  const perHour = Number(maxPerHour)
  const rate = Number.isFinite(perHour) && perHour > 0 ? perHour / 3600_000 : 0 // 每毫秒回补几条
  if (!(rate > 0)) return { level: 0, cap: 0, rate: 0, allowed: false }
  const cap = Math.max(1, Math.ceil(perHour / 3))
  const times = (Array.isArray(botReplyTimes) ? botReplyTimes : [])
    .filter((t) => Number.isFinite(t) && t <= now)
    .sort((a, b) => a - b)
  // 起点往前挪 cap / rate 毫秒：让「桶初始是满的」这个假设成立（没有历史时 level 正好等于 cap）
  let prev = (times.length ? times[0] : now) - cap / rate
  let level = cap
  for (const t of times) {
    level = Math.min(cap, level + (t - prev) * rate)
    level = Math.max(0, level - 1)
    prev = t
  }
  level = Math.min(cap, level + (now - prev) * rate)
  return { level, cap, rate, allowed: level >= 1 }
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
 * @param {number} [p.engagedUntil]  话题加入截止时间戳（在此之前且相关度够 = 「正聊得起劲」）
 * @param {number} [p.engagedReplies]  本次入场已经连着接了几条（engaged 预算用）
 * @param {number} [p.engagedSince]  本次入场时间戳（engaged 预算用）
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
  // 纯图片/表情的正文是空串：可以缓冲供下一轮看，但不能自己触发插话或 engaged 回合。
  // 直接 @ / 引用她仍放行，由后续视觉能力链决定是看图还是明确说看不到。
  if (!text.trim() && !p.mentioned && !p.repliedToBot) return { reply: false, mode: 'none', reason: '空文本/纯媒体不主动插话' }
  if (p.mentioned) return { reply: true, mode: 'must', reason: '被 @' }
  if (p.repliedToBot) return { reply: true, mode: 'must', reason: '引用了她的消息' }
  const hit = (pol.wakeWords || []).find((w) => w && text.includes(w))
  if (hit) return { reply: true, mode: 'must', reason: `叫到了「${hit}」` }
  const rel = typeof p.relevance === 'number' ? p.relevance : 1

  if (!(pol.interjectChance > 0)) return { reply: false, mode: 'none', reason: '插话关着' }
  // 每小时发言额度（令牌桶）：插话和连聊吃**同一份**预算。
  // 以前 maxPerHour 只数 interjectTimes，而连聊既不计数也不受冷却/上限约束 ——
  // 名义 6 的群实测每小时 22.5 条（2026-11-17 模拟，24 小时三段爆发）。
  const budget = replyBudget(p.botReplyTimes, p.now, pol.maxPerHour)
  if (!budget.allowed) {
    const refill = budget.rate > 0 ? Math.ceil(1 / budget.rate / 1000) : 0
    return { reply: false, mode: 'none', reason: `这小时说够了（额度 ${budget.level.toFixed(1)}/${budget.cap}，约 ${refill} 秒回一条），歇一会儿` }
  }
  if (inQuietHours(p.hour, pol.quietHours)) return { reply: false, mode: 'none', reason: '静默时段' }
  const minRel = Number(pol.minRelevance) || 0
  // 已经加入了这个话题：接着聊（每段看完再回，不受冷却限制）——
  // 但**有预算**：连聊条数与入场时长双双是硬顶，到顶就离场；
  // 而且上面那道令牌桶也管着它（连聊不是免费额度）。
  // 没有这些顶时，engaged 是自我续期的死循环：她每回一条都刷新「刚加入」，
  // 群里消息间隔只要小于窗口长度，她就永远在「起劲」，1% 摇号只管进门不管出去。
  if (p.engagedUntil && p.now < p.engagedUntil && rel >= minRel) {
    // 0 必须真的等于 0：以前写 `Number(x) || 默认值`，配 0 会被兜回 3，永远关不掉这条通道。
    const rawCap = Number(pol.engagedMaxReplies)
    const cap = Number.isFinite(rawCap) && rawCap >= 0 ? rawCap : DEFAULT_GROUP_POLICY.engagedMaxReplies
    const rawMs = Number(pol.engagedMaxMs)
    const maxMs = Number.isFinite(rawMs) && rawMs >= 0 ? rawMs : DEFAULT_GROUP_POLICY.engagedMaxMs
    const used = Number(p.engagedReplies) || 0
    if (used >= cap) {
      return { reply: false, mode: 'none', reason: `这个话题已连着接了 ${used} 条，先退一步（再想聊要重新摇号）` }
    }
    const since = Number(p.engagedSince) || 0
    if (since && p.now - since >= maxMs) {
      return { reply: false, mode: 'none', reason: '这场聊得够久了，先退出来' }
    }
    return { reply: true, mode: 'engaged', reason: `正聊得起劲，接着说（相关度 ${rel.toFixed(2)}）` }
  }
  const times = p.interjectTimes || []
  const last = times.length ? Math.max(...times) : 0
  if (p.now - last < pol.cooldownSec * 1000) return { reply: false, mode: 'none', reason: '插话冷却中' }
  const recent = (p.recentTimes || []).filter((t) => p.now - t < pol.activeWindowSec * 1000).length
  if (recent < pol.minRecentMessages) return { reply: false, mode: 'none', reason: '群里没在聊' }
  // 话题和她有关才插，越相关越容易插（不传 relevance 时按「不看话题」处理，兼容旧调用）。
  // 低概率档（<= 5%）表示用户明确要求极少插话，不再按相关度做最高 5 倍放大（否则设 1% 实测变成 5%）。
  if (minRel > 0 && rel < minRel) return { reply: false, mode: 'none', reason: `话题和她关系不大（相关度 ${rel.toFixed(2)}）` }
  const chance = minRel > 0 && pol.interjectChance > 0.05
    ? Math.min(0.8, pol.interjectChance * (1 + 4 * rel))
    : pol.interjectChance
  if (rand() < chance) return { reply: true, mode: 'interject', reason: `话题相关，插一句（相关度 ${rel.toFixed(2)}）` }
  return { reply: false, mode: 'none', reason: '这次不插话' }
}
