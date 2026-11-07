// 聊天里的「最近互动」状态（1.3.57，hub 状态所有权重构第一批）。
//
// 这些 Map 以前散在 chat/hub.js 的两千行里，和会话调度、消息分发混在一起：
// 小黄脸去重池、谁戳过她、谁最后说过话、戳一戳节流、别处代发的补话队列。
// 它们全是「chatId → 值」的纯内存状态，零 I/O，所以收进一个模块、用意图命名的方法暴露，
// hub 里只留调用点。好处不只是文件变小：**规则有了名字**——
//   · 「20 秒内同一聊天只处理一次戳一戳」以前是内联的 Date.now() 减法
//   · 「谁戳回去 = 最近戳她的人，没人戳过就这段最后说话的人」以前是内联的 || 短路
// 现在都在这里，改规则只改一处，也能单独测。
//
// 所有 Map 的 key 都是 chatId（'group:123' / 'private:456'），跨聊天天然隔离。

const POKE_THROTTLE_MS = 20_000
const ASIDE_KEEP = 5 // 别处代发的话，一次最多替她记几条

export function createInteractionState() {
  // chatId → Set(这一轮用过的小黄脸名字)，用于「别固化」去重
  const facePool = new Map()
  // chatId → 最近戳她的人的 QQ
  const lastPoker = new Map()
  // chatId → 群里最近一段最后说话的人
  const lastSpeaker = new Map()
  // chatId → 上次处理戳一戳的时间
  const pokeAt = new Map()
  // chatId → [{ at, text }]  别处安排她在这里发的话，下次这个聊天交给她时补进上下文
  const saidElsewhere = new Map()

  return {
    /** 上一次发到这个人/群时用过哪些小黄脸（去重用）。没有就空集合。 */
    facesUsed (chatId) {
      return facePool.get(chatId) || new Set()
    },
    /** 记下这一条用了哪些小黄脸，下一条不许再撞。 */
    rememberFaces (chatId, names) {
      if (!chatId) return
      facePool.set(chatId, new Set(names || []))
    },

    /** 戳回去戳谁：群里优先最近戳她的人，没人戳过就这段最后说话的人；私聊直接戳对方。 */
    pokeBackTarget (chatId) {
      const id = String(chatId || '')
      if (!id) return ''
      if (!id.startsWith('group:')) return id.startsWith('private:') ? id.slice(8) : ''
      return lastPoker.get(id) || lastSpeaker.get(id) || ''
    },
    /** 记下「谁戳了她」（无论这次是否触发回复——戳回去要用）。 */
    rememberPoker (chatId, uid) {
      if (chatId && uid) lastPoker.set(String(chatId), String(uid))
    },
    /** 记下群里这段最后说话的人。 */
    rememberSpeaker (chatId, uid) {
      if (chatId && uid) lastSpeaker.set(String(chatId), String(uid))
    },

    /**
     * 这次戳一戳该不该真的处理：同一个聊天 20 秒内只算一次。
     * **有副作用**：返回 true 时同时记下时间（调用方不必再自己 set）。
     */
    claimPoke (chatId, now = Date.now()) {
      const id = String(chatId || '')
      if (!id) return false
      if (now - (pokeAt.get(id) || 0) < POKE_THROTTLE_MS) return false
      pokeAt.set(id, now)
      return true
    },

    /** 不是这个聊天自己那一轮发的（主人让她去群里说、模块代发）：记下来，下次交给她时告诉她。 */
    queueAside (chatId, text, now = Date.now()) {
      const id = String(chatId || '')
      const t = String(text || '').slice(0, 300)
      if (!id || !t) return
      saidElsewhere.set(id, [...(saidElsewhere.get(id) || []), { at: now, text: t }].slice(-ASIDE_KEEP))
    },
    /** 取出并清空「别处替她说过的话」。 */
    takeAside (chatId) {
      const id = String(chatId || '')
      if (!id) return []
      const list = saidElsewhere.get(id) || []
      if (list.length) saidElsewhere.delete(id)
      return list
    },

    /** 排查/测试用：当前持有的聊天数。 */
    size () {
      return { faces: facePool.size, poker: lastPoker.size, speaker: lastSpeaker.size, pokeAt: pokeAt.size, aside: saidElsewhere.size }
    },
  }
}
