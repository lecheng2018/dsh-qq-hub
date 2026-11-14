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

    api.every(60_000, () => {
      // 熔断优先于一切：配额用完后连 tick 都不跑，省掉一次模型调用。
      const ownerKey = `private:${String(api.config().ownerQQ || '')}`
      if (api.config().ownerQQ && exhausted(ownerKey)) {
        let left = 0
        try { left = defaultLedger.remaining(ownerKey) } catch { left = 0 }
        api.log?.info?.(`Token 配额已用完 → 主动搭话熔断（剩余 ${left}）`)
        return
      }
      return speakUp.tick()
    }, '主动搭话')

    api.route('/speakup/fire', async () => {
      if (!api.config().enabled) return { ok: false, message: '先打开总开关' }
      const ownerKey = `private:${String(api.config().ownerQQ || '')}`
      if (api.config().ownerQQ && exhausted(ownerKey)) {
        return { ok: false, message: '今天的 Token 配额已经用完了，她先休息（明天自动恢复）' }
      }
      await speakUp.fire('手动')
      return { ok: true, message: '叫她去找你了' }
    })
    return speakUp
  },
}
