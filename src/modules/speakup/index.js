// 内置模块：主动搭话。主人一阵子没找她时，她会在私聊里主动找主人聊几句（群里不会）。
//
// US-018 · Token 熔断：后台主动生活流与内心独白共用每日配额。达到单日配额后
// 自动熔断这里（plan §八.2：优雅降级为「经典低成本问答模式」，绝不无限空转）。
// 前端问答不受影响——熔断的只是"她主动开口"这条花钱的路径。

import { createSpeakUp } from '../../features/companion.js'
import { defaultLedger } from '../../chat/token-ledger.js'

export default {
  id: 'speakup',
  name: '主动搭话',
  version: '1.0.0',
  description: '主人一阵子没理她时，在私聊里主动找主人说话',
  tab: 'speakup',
  files: ['features/companion.js', 'chat/token-ledger.js'],
  setup(api) {
    const { hub, mutes } = api.core
    const speakUp = createSpeakUp({ getConfig: api.config, hub, log: api.log, isMuted: (chatId) => mutes.muted(chatId) })

    /** 该会话今日配额是否已耗尽（主人私聊 chatKey 形如 private:<QQ>）。 */
    const exhausted = (chatId) => {
      try {
        return defaultLedger.isExhausted(String(chatId || '')) === true
      } catch {
        // 非法 chatKey 或账本异常：不因为记账出问题就永久掐掉主动搭话，按"未熔断"处理。
        return false
      }
    }

    /**
     * 刚道别后的静默期（conversation-closure 的 CLOSED + muteLockMs）。
     *
     * 这个闸门以前**根本不存在**：closure 处方表里给了 muteLockMs、reply-delivery 也一直
     * 记着 closedAt，但没有任何消费者读它 —— 于是用户刚说「睡了晚安」，十分钟后又被她
     * 按空闲阈值戳一下。现在由核心暴露 proactiveMuteState，这里少打扰一次。
     * 只锁主动开口：用户说完晚安又回来找她，入站回复完全不受影响。
     */
    const coolingDown = (chatId) => {
      try {
        const st = api.core?.proactiveMuteState?.(String(chatId || ''))
        return st?.muted === true
      } catch {
        // 核心没暴露或状态坏掉：按"没锁"处理，绝不永久掐话。
        return false
      }
    }

    api.every(60_000, () => {
      // 熔断优先于一切：配额用完后连 tick 都不跑，省掉一次模型调用。
      const ownerKey = `private:${String(api.config().ownerQQ || '')}`
      if (api.config().ownerQQ && exhausted(ownerKey)) {
        let left = 0
        try { left = defaultLedger.remaining(ownerKey) } catch { left = 0 }
        api.log?.info?.(`Token 配额已用完 → 主动搭话熔断（剩余 ${left}）`)
        return
      }
      // 刚道过别就先不主动开口（不必打 info：这是预期行为，每 60 秒刷一行会很吵）。
      if (api.config().ownerQQ && coolingDown(ownerKey)) return
      return speakUp.tick()
    }, '主动搭话')

    api.route('/speakup/fire', async () => {
      if (!api.config().enabled) return { ok: false, message: '先打开总开关' }
      const ownerKey = `private:${String(api.config().ownerQQ || '')}`
      if (api.config().ownerQQ && exhausted(ownerKey)) {
        return { ok: false, message: '今天的 Token 配额已经用完了，她先休息（明天自动恢复）' }
      }
      // 手动触发也受静默期约束，但要说清原因（面板点一下没反应会很困惑）。
      if (api.config().ownerQQ && coolingDown(ownerKey)) {
        let left = 0
        try { left = Math.ceil((api.core?.proactiveMuteState?.(ownerKey)?.remainingMs || 0) / 60000) } catch { left = 0 }
        return { ok: false, message: `刚道过别，${left || 60} 分钟内先不主动找主人（入站回复不受影响）` }
      }
      await speakUp.fire('手动')
      return { ok: true, message: '叫她去找你了' }
    })
    return speakUp
  },
}
