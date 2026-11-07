// M4 · 模块化新核心组装根（FLAG_MODULAR_CORE 开启态；关闭态本工厂不被装配）
//
// 全链：NormalizedInbound → SessionRegistry → TurnController → ContextAssembly → Outbox。
// 每一件都是 M2/M3 的独立模块，这里只做装配与接线（host 不承载业务规则——总览 §4）。
//
// dispatch 语义（与 legacy dispatchEvent 对齐）：
//   - message / message_sent → 合流入回合 → 执行（DSH 会话轮次）→ 回复经 outbox 投递；
//   - poke → 独立入站事件（segments=[poke]，消费方决定是否回应）；
//   - 命令（owner 斜杠命令）在 M4-2 由命令闸先截（回复 force 直发，同 legacy 语义）。
//
// 红线：物理发送只有 outbox 一个 owner；unknown 不自动重发；turn 执行尊重取消信号（诚实标记）。

import { legacyEventToNormalized } from '../chat/adapters/legacy-inbound.js'
import { createDshSessionAdapter } from '../chat/adapters/dsh-session.js'
import { createOnebotOutboxAdapter, paramsFor } from '../chat/adapters/onebot-outbox.js'
import { createLegacyContextAdapter } from '../chat/adapters/legacy-context.js'
import { createSessionRegistry } from '../chat/session-registry.js'
import { createTurnController } from '../chat/turn-controller.js'
import { createContextAssembly } from '../chat/context-assembly.js'
import { createOutbox } from '../chat/outbox.js'
import { isOwner } from '../chat/access.js'
import { parseMessageEvent } from '../chat/inbound.js'
import { parseCommand } from '../chat/commands.js'

/**
 * @param {object} o
 * @param {object} o.dsh DSH 上下文（services.sessionController）
 * @param {{ call: Function }} o.onebot OneBot 客户端
 * @param {object} o.mods 模块中枢（contextFor / commands / use）
 * @param {object} o.getConfig / o.setConfig
 * @param {object} o.logger
 * @param {(text: string) => string} [o.personaText] 人格文本注入（装配 fragment，priority 最高）
 * @param {(inbound: object, view: object) => Promise<string|null>} [o.runCommand] owner 命令闸（返回回复文本或 null）
 */
export function createModularCore({
  dsh, onebot, mods, getConfig, logger, log,
  personaText, runCommand,
}) {
  const debug = (m) => { try { log?.debug?.(m) } catch {} }

  // ---------- Session Registry（DSH 适配） ----------
  const sessionAdapter = createDshSessionAdapter({
    dsh,
    presetOf: (chatKey) => {
      const cfg = getConfig()
      const group = chatKey.startsWith('group:')
      return group
        ? { agentPreset: cfg.longTasks && false ? 'qq-hub-private-long' : 'qq-hub-social' }
        : { agentPreset: cfg.longTasks ? 'qq-hub-private-long' : 'qq-hub-private' }
    },
  })
  const registry = createSessionRegistry({
    createSession: sessionAdapter.createSession,
    onError: (e) => log.warn('session 映射持久化异常：', e.message),
  })

  // ---------- Context Assembly（模块上下文 + 人格） ----------
  const assembly = createContextAssembly({
    providers: [
      ...(personaText ? [{ moduleId: 'persona', priority: 1000, scope: 'global', cacheStable: true, provide: () => personaText() || '' }] : []),
      createLegacyContextAdapter({ mods, priority: 100 }),
    ],
  })

  // ---------- Outbox（OneBot 适配；授权复核 = 白名单/access 语义，与 legacy 同一判定） ----------
  const outbox = createOutbox({
    send: createOnebotOutboxAdapter({ onebot }).send,
    authorize: async (delivery) => {
      const cfg = getConfig()
      const chatKey = delivery.chatKey
      const userId = chatKey.startsWith('group:') ? '' : chatKey.slice(8)
      if (chatKey.startsWith('group:')) {
        // 群聊：白名单含该群才发（fail-closed）
        const groups = (cfg.allow?.groups || []).map(String)
        return groups.includes(chatKey.slice(6))
      }
      const privates = (cfg.allow?.private || []).map(String)
      return privates.includes(userId) || isOwner(cfg, userId)
    },
  })

  // ---------- Turn Controller（执行 = 会话轮次 + 装配 + 投递） ----------
  let turnSeq = 0
  const controller = createTurnController({
    merge: {
      waitMs: Number(getConfig().merge?.waitSec * 1000) || 2500,
      maxMs: Number(getConfig().merge?.maxSec * 1000) || 8000,
      groupWaitMs: Number(getConfig().merge?.groupWaitSec * 1000) || 5000,
      groupMaxMs: Number(getConfig().merge?.groupMaxSec * 1000) || 15000,
    },
    execute: async (turn, io) => {
      // 1. 装配上下文（persona + 模块 provider）
      const lead = io.members[0]
      const sessionId0 = registry.peek(turn.chatKey)?.sessionId
      const { fragments } = await assembly.assemble({ chatKey: turn.chatKey, sessionId: sessionId0 })
      // 2. 会话（single-flight 创建在 offer 时已发生；这里拿映射）
      const { sessionId } = await registry.sessionFor(turn.chatKey)
      // 3. 构造会话消息（legacy 视图语义：文本 + 结构化段）
      const text = io.members.map((m) => (m.segments ?? []).filter((s) => s.type === 'text').map((s) => String(s.data?.text ?? '')).join('')).join('\n').trim()
      const ctxText = fragments.map((f) => f.content).join('\n')
      // 4. 驱动 DSH 会话轮次（resolveAgent → followup；steer 输入注册给后续转向）
      const ctrl = dsh?.services?.sessionController ?? dsh?.get?.('sessionController')
      if (!ctrl?.resolveAgent) throw new Error('DSH 没有 sessionController（新核心无法驱动会话）')
      const resolved = await ctrl.resolveAgent(sessionId)
      const agent = resolved?.agent
      if (!agent?.followup) throw new Error(`会话 ${sessionId} 没有 agent.followup（适配缺口，如实失败）`)
      agent.ctx?.contexts?.set?.('qq-hub-context', { name: 'qq-hub-context', text: () => ctxText })
      const replyPromise = new Promise((resolve, reject) => {
        const off = dsh.on?.('session/event', (session, ev) => {
          if (session?.id !== sessionId) return
          if (ev?.type === 'assistant/message') {
            const content = ev?.data?.message?.content || []
            const replyText = content.filter((c) => c.type === 'text').map((c) => c.text).join('')
            try { off?.() } catch {}
            resolve(String(replyText ?? ''))
          }
        })
        if (typeof off !== 'function') {
          // 无事件流的 DSH：followup 链落定后取不到回复文本（如实报错，不猜）
          reject(new Error('DSH 没有 session/event 流，无法取回复文本'))
        }
      })
      agent.followup({ content: [{ type: 'text', text }] })
      const reply = await replyPromise
      void turnSeq
      // 5. 回复经 outbox 投递（唯一物理出口）
      if (reply) {
        const result = await outbox.request({
          chatKey: turn.chatKey,
          turnId: turn.turnId,
          sourceModuleId: 'core',
          segments: [{ type: 'text', data: { text: reply } }],
        })
        return result
      }
      return null
    },
  })

  /** 聊天域消息入口（host dispatchEvent 的旗开分支）。 */
  async function dispatchLegacyEvent(ev) {
    const cfg = getConfig()
    // 命令闸（M4-2）：主人斜杠命令先截，回复经 outbox（同 legacy：命令不进合流）
    if (runCommand && ev.post_type === 'message') {
      const view = parseMessageEvent(ev, ev.self_id)
      const cmd = parseCommand(view.text, mods.commands())
      if (cmd && !cmd.ext && isOwner(cfg, view.userId)) {
        const reply = await runCommand(cmd, { ...view, chatId: view.chatId, nickname: cfg.ownerName || '主人', text: view.text })
        if (reply) {
          await outbox.request({
            chatKey: view.chatId,
            sourceModuleId: 'core',
            segments: [{ type: 'text', data: { text: String(reply) } }],
            dryRun: cfg.dryRun === true,
          })
          return { handled: 'command' }
        }
      }
    }
    const { inbound } = safeAdapt(ev, 'realtime')
    if (!inbound) return { handled: 'skipped' }
    controller.offer(inbound)
    return { handled: 'offered' }
  }

  function safeAdapt(ev, source) {
    try {
      const inbound = legacyEventToNormalized(ev, { selfId: ev.self_id, source })
      return { inbound, view: ev }
    } catch (error) {
      debug(`事件无法成键/不支持：${error.message}`)
      return { inbound: null, view: null }
    }
  }

  /** 补收入口（M4-4）：backfill 事件带原始时间，source=backfill（M1-B 语义同款）。 */
  function dispatchBackfill(ev) {
    const { inbound } = safeAdapt(ev, 'backfill')
    if (!inbound) return { handled: 'skipped' }
    controller.offer(inbound)
    return { handled: 'offered' }
  }

  async function dispose() {
    await registry.dispose()
    await controller.dispose()
  }

  return {
    dispatchLegacyEvent,
    dispatchBackfill,
    outbox,
    registry,
    controller,
    dispose,
    stats: () => ({ sessions: Object.keys(registry.snapshot()).length }),
  }
}
