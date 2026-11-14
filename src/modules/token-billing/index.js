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

import { readJson, writeJson } from '../../core/store.js'
import { defaultLedger } from '../../chat/token-ledger.js'

/** 落盘节流：用量变化后最多每 30 秒写一次，避免每轮聊天都刷盘。 */
const FLUSH_INTERVAL_MS = 30_000

export default {
  id: 'token-billing',
  name: 'Token 记账',
  version: '1.0.1',
  description: '按会话累计每日 Token 消耗，供主动生活流熔断使用',
  tab: 'token',
  files: ['chat/token-ledger.js'],
  setup(api) {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

    // 关键：record() 只对「已分配配额的 chatKey」入账，未 allocate 时 limit=0 会直接
    // 返回 refused/no-quota，账本永远是 0 —— 那样熔断条件永远不成立。
    // 所以每天第一次记账前先把当期会话分配一次（allocate 幂等，重复调用只刷新分配表）。
    let allocatedDay = ''
    // 脏标记必须声明在 ensureAllocated 之前：它内部会置 dirty=true。
    // 放在后面虽然当前调用时机安全（都在声明之后才调），但那是靠调用顺序兜着的
    // 隐性 TDZ 风险 —— 谁把 ensureAllocated 提前一次调用就炸。
    let dirty = false
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
        dirty = true
      } catch (error) {
        api.log?.warn?.('Token 配额分配失败：', error?.message || error)
      }
    }

    // ---- 落盘（缺陷 C：账本纯内存，重启清零 → 早晨第一次主动问候会被误熔断） ----
    // 只落「当日的分配 + 用量」。跨日恢复由 token-ledger.restore() 自己拒收：
    // 昨天的用量绝不能算进今天，否则重启当天会凭空少一截额度。
    const usageFile = () => api.dataDir('token-usage.json')
    let lastFlushAt = 0
    function flush(force = false) {
      if (!dirty) return
      const now = Date.now()
      if (!force && now - lastFlushAt < FLUSH_INTERVAL_MS) return
      lastFlushAt = now
      dirty = false
      try {
        writeJson(usageFile(), defaultLedger.snapshot())
      } catch (error) {
        dirty = true // 下次再试，绝不因为写盘失败影响记账
        api.log?.warn?.('Token 用量落盘失败：', error?.message || error)
      }
    }
    // 进程退出前尽力落一次（未 flush 的 30 秒窗口内重启，最多丢一分钟用量）。
    api.onDispose?.(() => flush(true))

    // ---- 启动即分配 + 恢复昨日同日的账本 ----
    // 缺陷 C 的核心：不能等第一条 usage 才 allocate，否则「重启后当天还没聊过天」的
    // 那段时间里 isExhausted 看到的是空账本。现在 setup 就跑一遍，配额始终是就绪的。
    try {
      if (defaultLedger.restore(readJson(usageFile(), null))) {
        allocatedDay = String(defaultLedger.snapshot()?.dateKey || '')
      }
    } catch (error) {
      api.log?.warn?.('Token 用量恢复失败（按空账本启动）：', error?.message || error)
    }
    ensureAllocated(api.config())

    api.on('session/usage', (u) => {
      try {
        // 每条 usage 前先确保当天分配过（跨日也要重新分配）
        ensureAllocated(api.config())
        if (!u || !u.usage) return
        const chatId = String(u.chatId || '')
        if (!chatId) return
        // 入向口径与 token-guardian 一致：真实上下文 = 未缓存输入 + 缓存读 + 缓存写。
        const inputTokens = num(u.usage.uncachedInputTokens) + num(u.usage.cacheReadTokens) + num(u.usage.cacheWriteTokens)
        // 出向（她的回复）同样算钱；缺失就不计，不猜。
        const outputTokens = num(u.usage.outputTokens)
        const total = inputTokens + outputTokens
        if (total <= 0) return
        const receipt = defaultLedger.record(chatId, total)
        if (receipt?.applied > 0) dirty = true
        flush()
      } catch (error) {
        // 记账失败不能影响正常聊天：本轮放弃记账，下一轮继续。
        api.log?.warn?.('Token 记账失败：', error?.message || error)
      }
    })

    // 每分钟兜一次：跨日立刻重新分配、并把攒下的用量落盘（不依赖有没有聊天）。
    api.every(60_000, () => {
      ensureAllocated(api.config())
      flush(true)
    }, 'Token 账本维护')

    // 面板/诊断用：今日各会话用量与配额。
    api.route('/token-usage', async () => ({ ok: true, ...defaultLedger.snapshot() }))
    return { ledger: defaultLedger }
  },
}
