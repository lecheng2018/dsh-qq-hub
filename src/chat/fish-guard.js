// QQ 群「鱼群保护」—— 纯函数层（可单测，不碰网络/状态）。
//
// 移植自 surfcore 的 src/fish-guard.js（MIT，2026-11-04 存档见 docs/reference/）。
//
// 为什么需要：同一个群里往往有好几只同类 bot（2026-11-04 实测群 333444555：
// 412 条消息里 195 条来自「无敌大肥鱼 / 泡泡鲸 / 小鲸」，占 47%）。
// 没有这层判定，每只 bot 都按自己的概率发言，叠加起来就是集体刷屏。
//
// 规则（默认值，面板可改）：
//   ① 最近 10 分钟里，名字像鱼的不同发送者 ≥ 5 → 本轮不参与
//   ② 最近连续 5 条消息都来自鱼（≥2 只） → 本轮不参与
//   ③ 同一只鱼连续 5 条 → 本轮不参与
//   ④ 鱼消息 ≥ 8 条且占比 ≥ 60%（≥2 只鱼） → 本轮不参与
//   ⑤ 群名本身像鱼窝时，①的阈值收紧到 3
// 被直接 @ / 引用 / 管理员点名时默认放行（可关）。
//
// 本文件只做判定；冷却计时、落盘、真正拦下发送由 hub.js 负责。

export const DEFAULT_FISH_GUARD = Object.freeze({
  enabled: true,
  windowMs: 10 * 60 * 1000,
  cooldownMs: 10 * 60 * 1000,
  maxFish: 5,
  maxConsecutiveFish: 5,
  singleFishMaxConsecutive: 5,
  maxFishMessages: 8,
  maxFishRatio: 0.6,
  minSample: 8,
  minFishSendersForRatio: 2,
  groupNestMaxFish: 3,
  groupNestIds: [],
  // 名字像鱼：结尾词 / 包含词 / 开头词，任一命中就算
  // 宁可极小概率把真人认成鱼，也别漏掉同类 bot；群名判断只用「肥鱼/fish」
  namePrefixes: [],
  // 只认「同类 bot 的强特征」，不认任何带「鱼」字的名字。
  // 教训（2026-11-04）：原来 nameSuffixes 里有单独的 '鱼'，于是群友「某鱼」（当天发了两百多条
  // 正常聊天）被当成同类 bot，群 222333444 被判「88% 消息来自鱼」而整轮锁死。
  // 现在要求出现「肥鱼」或「鲸」（DeepSeek 鲸鱼系 bot 的典型命名），「小鱼」「咸鱼」「摸鱼达人」都不算。
  nameContains: ['肥鱼', '鲸'],
  nameSuffixes: ['肥鱼', 'fish'],
  groupNameKeywords: ['肥鱼', 'fish'],
  exemptNames: [],
  exemptIds: [],
  fishIds: [],
  bypassDirectAddress: true,
})

const asBool = (v, d) => (typeof v === 'boolean' ? v : d)
const clampInt = (v, d, min, max) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d
}
const clampNum = (v, d, min, max) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
}
const cleanList = (v, max = 50) => {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[\s,，;；]+/)
  return [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, max)
}

export function normalizeFishGuard(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const windowMs = clampInt(src.windowMs, DEFAULT_FISH_GUARD.windowMs, 60_000, 24 * 3600_000)
  return {
    ...DEFAULT_FISH_GUARD,
    ...src,
    enabled: asBool(src.enabled, DEFAULT_FISH_GUARD.enabled),
    windowMs,
    cooldownMs: clampInt(src.cooldownMs, Math.max(windowMs, DEFAULT_FISH_GUARD.cooldownMs), 60_000, 24 * 3600_000),
    maxFish: clampInt(src.maxFish, DEFAULT_FISH_GUARD.maxFish, 2, 20),
    maxConsecutiveFish: clampInt(src.maxConsecutiveFish, DEFAULT_FISH_GUARD.maxConsecutiveFish, 2, 30),
    singleFishMaxConsecutive: clampInt(src.singleFishMaxConsecutive, DEFAULT_FISH_GUARD.singleFishMaxConsecutive, 2, 50),
    maxFishMessages: clampInt(src.maxFishMessages, DEFAULT_FISH_GUARD.maxFishMessages, 2, 100),
    maxFishRatio: clampNum(src.maxFishRatio, DEFAULT_FISH_GUARD.maxFishRatio, 0, 1),
    minSample: clampInt(src.minSample, DEFAULT_FISH_GUARD.minSample, 2, 200),
    minFishSendersForRatio: clampInt(src.minFishSendersForRatio, DEFAULT_FISH_GUARD.minFishSendersForRatio, 1, 20),
    groupNestMaxFish: clampInt(src.groupNestMaxFish, DEFAULT_FISH_GUARD.groupNestMaxFish, 2, 20),
    groupNestIds: cleanList(src.groupNestIds, 200).filter((x) => /^\d{4,15}$/.test(x)),
    namePrefixes: cleanList(src.namePrefixes ?? DEFAULT_FISH_GUARD.namePrefixes),
    nameContains: cleanList(src.nameContains ?? DEFAULT_FISH_GUARD.nameContains),
    // 空数组 = 用默认（面板里留空不该等于「谁都不算同类」）
    nameSuffixes: cleanList(src.nameSuffixes).length ? cleanList(src.nameSuffixes) : [...DEFAULT_FISH_GUARD.nameSuffixes],
    groupNameKeywords: cleanList(src.groupNameKeywords ?? DEFAULT_FISH_GUARD.groupNameKeywords),
    exemptNames: cleanList(src.exemptNames, 200),
    exemptIds: cleanList(src.exemptIds, 200).filter((x) => /^\d{4,15}$/.test(x)),
    fishIds: cleanList(src.fishIds, 200).filter((x) => /^\d{4,15}$/.test(x)),
    bypassDirectAddress: asBool(src.bypassDirectAddress, DEFAULT_FISH_GUARD.bypassDirectAddress),
  }
}

/** 名字归一化：去零宽字符、尾部数字/装饰符、emoji，小写。同类 bot 常带 2 / _2 / ✨。 */
function normalizeName(value) {
  return String(value ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\s_\-—·.。,，!！?？~～]+$/g, '')
    .replace(/[0-9０-９]+$/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

export function isFishName(name, guard = DEFAULT_FISH_GUARD) {
  const cfg = normalizeFishGuard(guard)
  const n = normalizeName(name)
  if (!n) return false
  if (cfg.exemptNames.some((x) => normalizeName(x) === n)) return false
  const hit = (kw) => {
    const k = normalizeName(kw)
    return k && n.includes(k)
  }
  const prefix = cfg.namePrefixes.some((kw) => {
    const k = normalizeName(kw)
    return k && n.startsWith(k)
  })
  const contains = cfg.nameContains.some(hit)
  const suffix = cfg.nameSuffixes.some((kw) => {
    const k = normalizeName(kw)
    return k && n.endsWith(k)
  })
  return prefix || contains || suffix
}

export function isFishGroupName(name, guard = DEFAULT_FISH_GUARD) {
  const cfg = normalizeFishGuard(guard)
  const n = normalizeName(name)
  if (!n) return false
  // 群名用「包含」而不是「结尾」：鱼窝群常叫「摸鱼后援会」「摸鱼肥鱼窝」
  return cfg.groupNameKeywords.some((kw) => {
    const k = normalizeName(kw)
    return k && n.includes(k)
  })
}

function senderFish(msg, cfg) {
  if (!msg || msg.isSelf || msg.isOwner) return false
  const uid = msg.userId != null ? String(msg.userId) : ''
  if (uid && cfg.exemptIds.includes(uid)) return false
  if (uid && cfg.fishIds.includes(uid)) return true
  return msg.fish === true || isFishName(msg.sender, cfg)
}

/**
 * 统计一个群最近窗口里的鱼密度。
 * @param {Array<{sender?:string,userId?:string|number,isSelf?:boolean,isOwner?:boolean,time?:number,kind?:string,fish?:boolean}>} messages
 * @param {{now?:number, guard?:object, groupName?:string, groupId?:string}} opts
 */
export function assessFishDensity(messages, { now = Date.now(), guard = DEFAULT_FISH_GUARD, groupName = '', groupId = '' } = {}) {
  const cfg = normalizeFishGuard(guard)
  const empty = {
    enabled: cfg.enabled, blocked: false, reason: '', fishCount: 0, fishMessages: 0,
    totalMessages: 0, fishRatio: 0, consecutiveFish: 0, consecutiveFishSenders: 0,
    groupIsFishNest: false, effectiveMaxFish: cfg.maxFish, windowMs: cfg.windowMs, fishNames: [],
  }
  if (!cfg.enabled) return empty

  const all = Array.isArray(messages) ? messages : []
  const cutoff = Number(now) - cfg.windowMs
  const recentAll = all.filter((m) => m && m.kind !== 'poke' && Number(m.time || 0) > cutoff)
  const recentOthers = recentAll.filter((m) => !m.isSelf)
  const groupIsFishNest = Boolean(
    isFishGroupName(groupName, cfg) || (groupId && cfg.groupNestIds.includes(String(groupId)))
  )
  const effectiveMaxFish = groupIsFishNest ? Math.min(cfg.maxFish, cfg.groupNestMaxFish) : cfg.maxFish

  const fishList = recentOthers.filter((m) => senderFish(m, cfg))
  const fishIdSet = new Set(fishList.map((m) => (m.userId != null ? `id:${m.userId}` : `name:${normalizeName(m.sender)}`)))
  const fishNames = [...new Set(fishList.map((m) => String(m.sender ?? '').trim()).filter(Boolean))].slice(0, 10)

  let consecutiveFish = 0
  const consecutiveSenders = new Set()
  for (let i = recentAll.length - 1; i >= 0; i -= 1) {
    const msg = recentAll[i]
    if (senderFish(msg, cfg)) {
      consecutiveFish += 1
      consecutiveSenders.add(msg.userId != null ? `id:${msg.userId}` : `name:${normalizeName(msg.sender)}`)
    } else break
  }

  const totalMessages = recentOthers.length
  const fishMessages = fishList.length
  const fishRatio = totalMessages > 0 ? fishMessages / totalMessages : 0
  const fishCount = fishIdSet.size

  let reason = ''
  if (fishCount >= effectiveMaxFish) reason = 'fish-count'
  else if (consecutiveFish >= cfg.maxConsecutiveFish && consecutiveSenders.size >= 2) reason = 'fish-streak'
  else if (consecutiveFish >= cfg.singleFishMaxConsecutive) reason = 'fish-streak-single'
  else if (totalMessages >= cfg.minSample && fishMessages >= cfg.maxFishMessages
    && fishRatio >= cfg.maxFishRatio && fishCount >= cfg.minFishSendersForRatio) reason = 'fish-ratio'

  return {
    enabled: true, blocked: Boolean(reason), reason, fishCount, fishMessages, totalMessages,
    fishRatio, consecutiveFish, consecutiveFishSenders: consecutiveSenders.size,
    groupIsFishNest, effectiveMaxFish, windowMs: cfg.windowMs, fishNames,
  }
}

/** 给日志/面板看的人话原因。 */
export function fishGuardReasonText(a) {
  if (!a || !a.blocked) return ''
  const win = Math.round(a.windowMs / 60000)
  if (a.reason === 'fish-count') {
    return `最近 ${win} 分钟有 ${a.fishCount} 条不同的鱼在说话（阈值 ${a.effectiveMaxFish}${a.groupIsFishNest ? '，本群像鱼窝' : ''}）`
  }
  if (a.reason === 'fish-streak') return `最近连续 ${a.consecutiveFish} 条消息都来自鱼（${a.consecutiveFishSenders} 条鱼）`
  if (a.reason === 'fish-streak-single') return `同一只鱼最近连续发了 ${a.consecutiveFish} 条消息`
  return `最近 ${a.fishMessages}/${a.totalMessages} 条消息来自鱼（占比 ${Math.round(a.fishRatio * 100)}%）`
}
