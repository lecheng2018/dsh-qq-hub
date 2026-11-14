// 内置模块：目的引擎（实验性，默认关）。
// 像人一样定期主动找主人搭话：素材（记忆 + 聊天流水）→ 目标假设（带归属/置信度/风险）
// → 选一个目的 → 生成一句话 → 投递私聊。
//
// 与「主动搭话」（speakup）的关系：speakup 的默认实现保持不变；本模块是可选的新引擎，
// 默认关闭。想换引擎：在面板「主动搭话」页打开目的引擎开关，并关掉主动搭话的总开关
// （两套同时开会重复打扰）。迁移说明见 docs/PURPOSE_MODULE_API.md。
//
// 薄壳只做注册；引擎在 src/purpose/engine.js（纯函数），接线在 src/purpose/module.js。

import { createPurpose } from '../../purpose/module.js'

export default {
  id: 'purpose',
  name: '目的引擎（实验）',
  version: '1.0.0',
  description: '像人一样主动找主人搭话：攒素材 → 记观察 → 立目标假设 → 挑一个候选，到点了才来找你。默认关闭；开启前建议先关掉「主动搭话」总开关，两套别同时开。',
  tab: 'speakup',
  panel: true,
  files: ['purpose/engine.js', 'purpose/module.js'],
  defaults: {
    enabled: false, // 默认关：这是可选的新引擎，由主人决定要不要启用（启用前建议关掉 speakup 总开关）
    minMaterials: 2, // 素材少于这个数（也没有惦记的事/人格卡）就不硬找话
    initialDelayMinutes: 15, // 启动后的第一枪延迟
    maxCandidates: 6,
    promptMaxChars: 16000,
    maxPerDay: 3, // 每日上限。留空/0/未设都沿用「主动搭话」的 maxPerDay；填大于 0 的数才用这里自己的
  },
  settings: [
    { key: 'enabled', label: '启用目的引擎', type: 'switch', hint: '默认关。开启后她会按目的主动找主人；建议先关掉「主动搭话」总开关，避免两套同时打扰' },
    { key: 'minMaterials', label: '最少素材数', type: 'number', min: 0, max: 20, hint: '低于这个数且没有惦记的事/人格卡时，这轮不硬找话' },
    { key: 'initialDelayMinutes', label: '启动延迟（分钟）', type: 'number', min: 1, max: 720, hint: '插件启动后第一次主动搭话前先等多久' },
    { key: 'maxCandidates', label: '候选方向数', type: 'number', min: 3, max: 10 },
    { key: 'maxPerDay', label: '每日上限', type: 'number', min: 0, max: 20, hint: '0 或留空 = 沿用「主动搭话」页的次数上限；填大于 0 的数才用这里自己的上限' },
  ],
  setup(api) {
    // Token 熔断接线（缺陷 D）：purpose 和 speakup 一样受每日配额约束。
    // 账本从 token-billing 模块**暴露的 exports** 上拿（api.use → { ledger }），
    // 而不是直接 import 记账实现：模块间解耦，且 token-billing 被用户关掉时自然拿不到，
    // 此时按「不计配额」继续跑，不因为记账模块缺席就把主动生活流永久掐死。
    const ledgerOf = () => {
      try {
        const billing = api.use('token-billing')
        const ledger = billing?.ledger
        // 熔断判定需要 isExhausted；拿不到就返回 null（= 不熔断）。
        return ledger && typeof ledger.isExhausted === 'function' ? ledger : null
      } catch {
        return null
      }
    }
    const budgetExhausted = (chatId) => {
      const ledger = ledgerOf()
      if (!ledger) return false
      try {
        // isExhausted 的语义（缺陷 C 修过）：未分配配额 → false（放行），
        // 已分配但耗尽 / 本来就分不到 → true（熔断）。非法 chatKey 抛错也按未熔断处理。
        return ledger.isExhausted(String(chatId || '')) === true
      } catch {
        return false
      }
    }

    const purpose = createPurpose({
      getConfig: api.config,
      hub: api.core.hub,
      chatLog: api.core.chatLog,
      log: api.log,
      isMuted: (chatId) => { try { return api.core.mutes.muted(chatId) } catch { return false } },
      memory: () => api.use('memory'),
      personaText: () => { try { return api.core.personas?.current?.() || '' } catch { return '' } },
      budgetExhausted,
    })
    api.every(60_000, () => purpose.tick(), '目的引擎')
    api.route('/purpose/fire', async () => {
      if (!api.settings().enabled) return { ok: false, message: '目的引擎没开（主动搭话页可以打开）' }
      const r = await purpose.fire('手动')
      if (!r) return { ok: false, message: '没有结果' }
      if (r.outcome === 'sent') return { ok: true, message: '已经去找你了' }
      if (r.outcome === 'silent') return { ok: true, message: '她这轮想了想，决定不说（不硬发）' }
      if (r.outcome === 'muted') return { ok: false, message: '主人在私聊里让她闭嘴了' }
      if (r.outcome === 'disabled') return { ok: false, message: '目的引擎开关是关的' }
      return { ok: true, message: `这轮结束：${r.outcome}` }
    })
    api.route('/purpose/status', async () => ({ ok: true, status: purpose.status(), state: purpose.state() }))
    api.route('/purpose/preview', async () => ({ ok: true, preview: purpose.preview() }))
    // 驱动向量 → 提示层：把「最近比较想要什么」轻描淡写地写进每一轮的上下文（引擎关着时返回空）
    api.rule(() => purpose.drivesRule())
    return purpose
  },
}
