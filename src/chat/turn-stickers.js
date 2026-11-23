// 同一回合内的表情去重台账。
//
// 为什么需要（真机 2026-11-23 15:01，群 955741432）：模型在**同一步**里写了正文、又调了
// `qq_send_sticker`——工具是**立即直发**；下一步收尾又按回复协议写了 `<sticker:无语>`。
// 两条通路互相不认识，同一张表情就发进了群两遍，正文还被后一步覆盖掉了（见 modular-core）。
// 这里记「本回合这个聊天已经真的发出去的表情 md5」，投递层据此把正文里重复的那张摘掉。
//
// 只按 chatKey 记账：同一个聊天同时只会有一个回合（调度槽保证），不需要 session 维度。
// 回合开始和投递结束各清一次——工具也可能在非回复回合里被调用，台账不能跨回合留着。

const EMPTY = new Set()

export function createTurnStickers() {
  const byChat = new Map()
  const keyOf = (chatId) => String(chatId || '')

  return {
    /** 记一张已经真的发出去的表情（只在拿到网关回执后调用）。 */
    note(chatId, md5) {
      const key = keyOf(chatId)
      const id = String(md5 || '')
      if (!key || !id) return
      const set = byChat.get(key) || new Set()
      set.add(id)
      byChat.set(key, set)
    },
    /** 本回合这个聊天已发过的表情 md5；没有就返回空集（调用方不必判空）。 */
    sentIn(chatId) {
      return byChat.get(keyOf(chatId)) || EMPTY
    },
    /** 清台账：回合开始、投递结束各一次；不传 chatId 就全清（会话重置/卸载）。 */
    clear(chatId) {
      const key = keyOf(chatId)
      if (key) byChat.delete(key)
      else byChat.clear()
    },
  }
}
