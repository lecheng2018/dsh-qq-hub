// 群聊状态（1.3.57，hub 状态所有权重构第二批）。
//
// 以前散在 chat/hub.js 里的七个 groupId 键 Map：消息缓冲、引用编号表、话题加入截止时间、
// 她说话/插话的时间序列、群名缓存、群成员缓存。全是纯内存 + 一个键（groupId），
// 但内联规则很碎：
//   · 「缓冲只留最近 40 条」「时间序列只看 1 小时内的」——两处重复写了两遍
//   · 「在群里说过话 = 自动加入话题」——藏在 deliver 中间一行
// 收进这里以后，这些规则各有名字，hub 只留调用点。
//
// 缓冲条目允许调用方**就地改**（语音转写补字、标 fed、挂引用内容），所以 buffer() 返回活动数组，
// 这是刻意保留的——复制数组反而让调用方的修改丢失。

const BUFFER_KEEP = 40
const WINDOW_MS = 3600_000 // 她说话/插话的时间序列只看最近 1 小时
const ENGAGE_MS = 3 * 60_000 // 说了话算加入话题，持续 3 分钟

export function createGroupState() {
  const buf = new Map() // groupId → [{ t, uid, nick, text, at, mid, direct, replyId, media?, quote?, fed?, ... }]
  const refs = new Map() // groupId → { 编号: { mid, uid } }  上一段提示词里的编号，引用回复用
  // groupId → { until, since, replies }：话题加入的截止时间、入场时刻、连聊条数。
  const engaged = new Map()
  // 真机刷屏根因复盘（2026-11-14）：旧版值只有 until，且 noteSpokeInGroup 每次说话都把
  // until 重置为 now+3min —— 活跃群里 she 一发不可收拾：engaged 通道排在冷却/每小时上限
  // 之前、又不吃插话概率，自我续期 = 永不离场。现在 engaged 模式的回复不再续期，
  // 连聊条数（replies）由 group-policy 的 engagedMaxReplies 封顶。
  const said = new Map() // groupId → [t]  她每次说话的时间（刹车用）
  const interjects = new Map() // groupId → [t]  她主动开口（插话）的时间
  const names = new Map() // groupId → 群名
  const members = new Map() // groupId → { at, list }  群成员缓存

  const joinTopicOf = (gid, now) => {
    // 说话者走到这里 = 她「重新入场」了（摇号命中，或被人直接搭话）。
    // 硬重置窗口/入场时刻/连聊条数：继续对话的死循环由 engaged 分叉负责（见 noteEngagedReply），
    // 这里不再可能被续聊路径摸到 —— 窗口活着时闸门锁死 engaged，摇不到 interject。
    engaged.set(String(gid), { until: now + ENGAGE_MS, since: now, replies: 0 })
  }
  const recent = (map, gid, now) => {
    const list = (map.get(String(gid)) || []).filter((t) => now - t < WINDOW_MS)
    if (!list.length) return []
    map.set(String(gid), list) // 顺手清掉过期项，别让数组无限长
    return list
  }

  return {
    // ---- 消息缓冲 ----
    /** 这个群的缓冲（活动数组，调用方可就地改条目）。 */
    buffer (gid) {
      return buf.get(String(gid)) || []
    },
    /** 追加一条群消息，超出上限自动丢最旧的。 */
    appendMessage (gid, entry) {
      const id = String(gid)
      const list = buf.get(id) || []
      list.push(entry)
      while (list.length > BUFFER_KEEP) list.shift()
      buf.set(id, list)
      return entry
    },
    /** 这个群里某人最近说的那条（语音转写补字用）。 */
    lastFrom (gid, uid) {
      const list = buf.get(String(gid)) || []
      return list.findLast?.((x) => String(x.uid) === String(uid)) || null
    },

    // ---- 引用编号表 ----
    refs (gid) {
      return refs.get(String(gid)) || {}
    },
    setRefs (gid, table) {
      refs.set(String(gid), table || {})
    },

    // ---- 话题加入 ----
    engagedUntil (gid) {
      return engaged.get(String(gid))?.until || 0
    },
    /** 本场已连着接了几条（给 group-policy 的 engagedMaxReplies 预算用）。 */
    engagedReplies (gid) {
      return engaged.get(String(gid))?.replies || 0
    },
    /** 本场入场时刻（给 engagedMaxMs 时长预算用；没入场返回 0）。 */
    engagedSince (gid) {
      return engaged.get(String(gid))?.since || 0
    },
    /** 加入话题（默认 3 分钟）。已在话题里则不续期（见 joinTopicOf）。 */
    joinTopic (gid, now = Date.now()) {
      joinTopicOf(gid, now)
    },
    leaveTopic (gid) {
      engaged.delete(String(gid))
    },
    /**
     * 在群里说了话 = 重新入场（硬重置窗口/条数）。
     * 只服务 must/interject 两类发言；engaged 续聊走 noteEngagedReply，不碰这里。
     */
    noteSpokeInGroup (gid, now = Date.now()) {
      joinTopicOf(gid, now)
    },
    /** 记一次「靠起劲状态接着说」：条数进预算，但**不**延长窗口、不重置入场时刻。 */
    noteEngagedReply (gid, now = Date.now()) {
      const id = String(gid)
      const rec = engaged.get(id)
      if (rec && now < rec.until) rec.replies += 1
    },

    // ---- 时间序列（刹车 / 插话频率）----
    /** 她最近 1 小时在这个群说过几次话的时间戳。 */
    speakTimes (gid, now = Date.now()) {
      return recent(said, gid, now)
    },
    /** 记一次「她在这个群说话了」。 */
    noteSpeak (gid, now = Date.now()) {
      const id = String(gid)
      const list = recent(said, id, now)
      list.push(now)
      said.set(id, list)
      return list
    },
    /** 她最近 1 小时在这个群主动插话的时间戳。 */
    interjectTimes (gid, now = Date.now()) {
      return recent(interjects, gid, now)
    },
    /** 记一次插话。 */
    noteInterject (gid, now = Date.now()) {
      const id = String(gid)
      const list = recent(interjects, id, now)
      list.push(now)
      interjects.set(id, list)
      return list
    },

    // ---- 群名 / 成员缓存 ----
    name (gid) {
      return names.get(String(gid)) || ''
    },
    setName (gid, name) {
      if (name) names.set(String(gid), String(name))
    },
    /** 缓存的群成员列表；超过 ttl 就返回 null（调用方自己去拉）。 */
    cachedMembers (gid, ttlMs = 10 * 60_000, now = Date.now()) {
      const hit = members.get(String(gid))
      if (hit && now - hit.at < ttlMs) return hit.list
      return null
    },
    /** 拉取失败时退回旧缓存（哪怕过期）。 */
    staleMembers (gid) {
      return members.get(String(gid))?.list || []
    },
    setMembers (gid, list, now = Date.now()) {
      members.set(String(gid), { at: now, list })
    },

    /** groupNames 这个 Map 本身（memory.js 等外部按 `.get?.()` 用，保持原样）。 */
    names,
  }
}

export { ENGAGE_MS }
