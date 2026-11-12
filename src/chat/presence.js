// 面板统计与主动搭话所需的最近互动时间。
export function createPresence() {
  const stats = { received: 0, sent: 0, voice: 0, stickers: 0, errors: 0, day: new Date().toDateString() }
  let lastChatAt = 0
  let lastOwnerChatAt = 0
  let lastBotToOwner = { at: 0, text: '' }

  function bump(kind) {
    const day = new Date().toDateString()
    if (stats.day !== day) Object.assign(stats, { received: 0, sent: 0, voice: 0, stickers: 0, errors: 0, day })
    if (kind in stats) stats[kind]++
  }

  return {
    bump,
    noteIncoming(chatId, userId, cfg) {
      lastChatAt = Date.now()
      if (chatId === `private:${cfg.ownerQQ}` && String(userId) === String(cfg.ownerQQ)) lastOwnerChatAt = lastChatAt
    },
    noteDelivered({ chatId, items, cfg }) {
      lastChatAt = Date.now()
      if (chatId === `private:${cfg.ownerQQ}`) {
        lastBotToOwner = { at: lastChatAt, text: items.filter((item) => item.kind === 'text' || item.kind === 'voice').map((item) => item.value).join('\n') }
      }
    },
    stats: () => ({ ...stats }),
    get lastChatAt() { return lastChatAt },
    get lastOwnerChatAt() { return lastOwnerChatAt },
    get lastBotToOwner() { return lastBotToOwner },
  }
}
