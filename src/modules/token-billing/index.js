// 内置模块：每日 Token 记账（US-018 / 计划书 §八.2、§十一.1）。
//
// 为什么需要：计划书把「每日 Token 配额」定义为 Phase 3 新建服务，要求达到单日
// 配额后自动熔断后台生活流与内心独白、优雅降级为经典低成本问答模式。
// 但此前 src/chat/token-ledger.js 是零引用死代码 —— 没有任何代码在做每日记账，
// 于是熔断条件永远不成立。
//
// 本模块只做一件事：订阅每轮的 session/usage，把真实消耗记进账本。
// 熔断动作由消费方（如 modules/speakup）查 isExhausted 决定，记账与决策分离。
//
// 口径：与 token-guardian 同一份厂商上报字段（uncachedInput + cacheRead + cacheWrite），
// 但两者用途不同 —— guardian 判「上下文要不要压缩」，本模块累计「今天一共花了多少」。

import { defaultLedger } from '../../chat/token-ledger.js'

export default {
  id: 'token-billing',
  name: 'Token 记账',
  version: '1.0.0',
  description: '按会话累计每日 Token 消耗，供主动生活流熔断使用',
  tab: 'token',
  files: ['chat/token-ledger.js'],
  setup(api) {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

    // 关键：record() 只对「已分配配额的 chatKey」入账，未 allocate 时 limit=0 会直接
    // 返回 refused/no-quota，账本永远是 0 —— 那样熔断条件永远不成立。
    // 所以每天第一次记账前先把当期会话分配一次（allocate 幂等，重复调用只刷新分配表）。
    let allocatedDay = ''
    function ensureAllocated(cfg) {
      const snap = defaultLedger.snapshot()
      const day = String(snap?.dateKey || '')
      if (day === allocatedDay) return
      // 主人私聊 + 白名单群：这两类才分主动生活流配额（计划书 §八.2 的口径）。
      const chats = []
      const ownerQQ = String(cfg?.ownerQQ || '')
      if (ownerQQ) chats.push({ chatKey: `private:${ownerQQ}`, owner: true })
      for (const g of (cfg?.allow?.groups || [])) chats.push({ chatKey: `group:${g}`, whitelisted: true })
      try {
        defaultLedger.allocate(chats)
        allocatedDay = day
      } catch (error) {
        api.log?.warn?.('Token 配额分配失败：', error?.message || error)
      }
    }

    api.on('session/usage', (u) => {
      try {
        if (!u || !u.usage) return
        const chatId = String(u.chatId || '')
        if (!chatId) return
        // 入向口径与 token-guardian 一致：真实上下文 = 未缓存输入 + 缓存读 + 缓存写。
        const inputTokens = num(u.usage.uncachedInputTokens) + num(u.usage.cacheReadTokens) + num(u.usage.cacheWriteTokens)
        // 出向（她的回复）同样算钱；缺失就不计，不猜。
        const outputTokens = num(u.usage.outputTokens)
        const total = inputTokens + outputTokens
        if (total <= 0) return
        ensureAllocated(api.config())
        defaultLedger.record(chatId, total)
      } catch (error) {
        // 记账失败不能影响正常聊天：本轮放弃记账，下一轮继续。
        api.log?.warn?.('Token 记账失败：', error?.message || error)
      }
    })

    // 面板/诊断用：今日各会话用量与配额。
    api.route('/token-usage', async () => ({ ok: true, ...defaultLedger.snapshot() }))
    return { ledger: defaultLedger }
  },
}
