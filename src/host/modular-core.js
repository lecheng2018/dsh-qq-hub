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
import { createSessionFileStore } from '../chat/session-store.js'
import { createTurnController } from '../chat/turn-controller.js'
import { createContextAssembly } from '../chat/context-assembly.js'
import { createOutbox } from '../chat/outbox.js'
import { createDeliveryLedger } from '../chat/delivery-ledger.js'
import { isOwner, checkAllowed, levelFor, presetFor } from '../chat/access.js'
import { checkIdentityLeak } from '../chat/identity-guard.js'
import { parseMessageEvent } from '../chat/inbound.js'
import { parseCommand } from '../chat/commands.js'

/** 入站事件 → checkAllowed 需要的 msg 形状（从 ChatKey + sender 还原 kind/userId/groupId）。 */
function aclMsgFromInbound(inbound) {
  const chatKey = String(inbound?.chatKey ?? '')
  if (chatKey.startsWith('group:')) return { kind: 'group', userId: String(inbound?.sender?.userId ?? ''), groupId: chatKey.slice(6) }
  return { kind: 'private', userId: chatKey.slice(8), groupId: '' }
}

/** 段列表 → 纯文本（身份闸用；同 legacy sendSegments 的取词）。 */
function textOfSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .filter((s) => s && s.type === 'text')
    .map((s) => String(s?.data?.text || '')).join('')
}

/** 入站成员段 → DSH content 块（legacy 视图语义：文本段原样、图片段带 url/file、其余如实降级）。 */
function segmentsToContent(members) {
  const content = []
  for (const m of members) {
    for (const s of (m?.segments ?? [])) {
      if (s?.type === 'text') { const t = String(s.data?.text ?? ''); if (t) content.push({ type: 'text', text: t }) }
      else if (s?.type === 'image') content.push({ type: 'image', url: String(s.data?.url || s.data?.file || '') })
      else if (s?.type) content.push({ type: 'text', text: `\n[${s.type}]\n` }) // 语音/文件/转发/@：如实占位，不静默丢
    }
  }
  return content
}

/**
 * @param {object} o
 * @param {object} o.dsh DSH 上下文（services.sessionController）
 * @param {{ call: Function }} o.onebot OneBot 客户端
 * @param {object} o.mods 模块中枢（contextFor / commands / use）
 * @param {object} o.getConfig / o.setConfig
 * @param {object} o.logger
 * @param {(text: string) => string} [o.personaText] 人格文本注入（装配 fragment，priority 最高）
 * @param {(inbound: object, view: object) => Promise<string|null>} [o.runCommand] owner 命令闸（返回回复文本或 null）
 * @param {string} [o.ledgerFile] 投递台账文件（提供则真实持久化；缺省 = 内存，测试用）
 * @param {string} [o.sessionStoreFile] 会话映射文件（提供则持久化 + 启动恢复；缺省 = 内存，测试用）
 */
export function createModularCore({
  dsh, onebot, mods, getConfig, logger, log,
  personaText, runCommand, ledgerFile, sessionStoreFile,
}) {
  const debug = (m) => { try { log?.debug?.(m) } catch {} }

  // ---------- Session Registry（DSH 适配；preset 走 legacy levelFor/presetFor 语义） ----------
  const sessionAdapter = createDshSessionAdapter({
    dsh,
    presetOf: (chatKey) => {
      const cfg = getConfig()
      if (chatKey.startsWith('group:')) return { agentPreset: 'qq-hub-social' } // 群永远 ≤ social
      // 私聊：按主人/档位映射 preset（非主人白名单 = social，绝不再冒完整能力档）
      const level = levelFor(cfg, { kind: 'private', userId: chatKey.slice(8) })
      return { agentPreset: presetFor(level, cfg) }
    },
  })
  const sessionStore = sessionStoreFile ? createSessionFileStore({ file: sessionStoreFile }) : null
  const registry = createSessionRegistry({
    createSession: sessionAdapter.createSession,
    ...(sessionStore ? { store: sessionStore } : {}),
    onError: (e) => log.warn('session 映射持久化异常：', e.message),
  })

  // ---------- Context Assembly（模块上下文 + 人格） ----------
  const assembly = createContextAssembly({
    providers: [
      ...(personaText ? [{ moduleId: 'persona', priority: 1000, scope: 'global', cacheStable: true, provide: () => personaText() || '' }] : []),
      createLegacyContextAdapter({ mods, priority: 100 }),
    ],
  })

  // ---------- Outbox（唯一物理出口；授权/全局闸/身份闸/台账持久化全在此接线） ----------
  const ledger = ledgerFile ? createDeliveryLedger({ file: ledgerFile, onError: (e) => log.warn('投递台账落盘异常：', e.message) }) : undefined
  const outbox = createOutbox({
    send: createOnebotOutboxAdapter({ onebot }).send,
    ...(ledger ? { ledger } : {}),
    // 出站白名单复核（与 legacy checkAllowed 同一判定；出队时执行，撤权在排队期间也生效）
    authorize: async (delivery) => {
      const cfg = getConfig()
      return checkAllowed(cfg, aclMsgFromInbound({ chatKey: delivery.chatKey })).allowed
    },
    // 全局 enabled/dryRun：出队时动态读（面板随时可改；不依赖入口快照）。truthy 语义与 legacy 一致。
    enabled: () => Boolean(getConfig().enabled),
    dryRun: () => Boolean(getConfig().dryRun),
    // 身份泄露闸：唯一出站点扫受保护 QQ/群号（同 legacy sendSegments 语义）
    guard: (delivery) => {
      const cfg = getConfig()
      const ig = cfg.security?.identityGuard || {}
      if (ig.enabled === false) return { ok: true }
      const text = textOfSegments(delivery.segments)
      const chatKey = String(delivery.chatKey || '')
      const ownGroup = chatKey.startsWith('group:') ? chatKey.slice(6) : ''
      return checkIdentityLeak(text, {
        surface: chatKey.startsWith('group:') ? '群消息' : '私聊消息',
        ids: [cfg.ownerQQ, cfg.botQQ].filter(Boolean),
        allowIds: [ownGroup, ...(chatKey.startsWith('private:') ? [cfg.ownerQQ] : [])].filter(Boolean),
        mode: ig.mode === 'warn' ? 'warn' : 'block',
      })
    },
  })

  // ---------- Turn Controller（执行 = 会话轮次 + 装配 + 投递） ----------
  const controller = createTurnController({
    merge: {
      waitMs: Number(getConfig().merge?.waitSec * 1000) || 2500,
      maxMs: Number(getConfig().merge?.maxSec * 1000) || 8000,
      groupWaitMs: Number(getConfig().merge?.groupWaitSec * 1000) || 5000,
      groupMaxMs: Number(getConfig().merge?.groupMaxSec * 1000) || 15000,
    },
    execute: async (turn, io) => {
      // 1. 装配上下文（persona + 模块 provider）
      const sessionId0 = registry.peek(turn.chatKey)?.sessionId
      const { fragments } = await assembly.assemble({ chatKey: turn.chatKey, sessionId: sessionId0 })
      // 2. 会话（single-flight 创建在 offer 时已发生；这里拿映射）
      const { sessionId } = await registry.sessionFor(turn.chatKey)
      // 3. 构造会话消息（legacy 视图语义：文本 + 图片 + 其他段如实占位）
      const content = segmentsToContent(io.members)
      const ctxText = fragments.map((f) => f.content).join('\n')
      // 4. 驱动 DSH 会话轮次（resolveAgent → followup；steer 输入注册给后续转向）
      const ctrl = dsh?.services?.sessionController ?? dsh?.get?.('sessionController')
      if (!ctrl?.resolveAgent) throw new Error('DSH 没有 sessionController（新核心无法驱动会话）')
      const resolved = await ctrl.resolveAgent(sessionId)
      const agent = resolved?.agent
      if (!agent?.followup) throw new Error(`会话 ${sessionId} 没有 agent.followup（适配缺口，如实失败）`)
      agent.ctx?.contexts?.set?.('qq-hub-context', { name: 'qq-hub-context', text: () => ctxText })

      // 5. 等**回合结束**（不是首个 assistant/message）：
      //    - assistant/message：跳过 interrupted 的部分内容，记下本 turn 文本（可能多条取最后）；
      //    - turn/end：completed 且有文本才 resolve；非 completed 如实失败（不发、释放调度槽）；
      //    - followup rejection：捕获，回合落定异常，finally 清理监听器（防句柄泄漏）。
      let off = null
      const cleanupListener = () => { try { off?.() } catch {} off = null }
      const replyPromise = new Promise((resolve, reject) => {
        let lastTurn = null
        let lastText = ''
        off = dsh.on?.('session/event', (session, ev) => {
          if (session?.id !== sessionId) return
          if (ev?.type === 'assistant/message') {
            const d = ev?.data || {}
            if (d.interrupted) return
            const t = (d.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
            if (t) { lastTurn = d.turn; lastText = t }
            return
          }
          if (ev?.type === 'turn/end') {
            const d = ev?.data || {}
            const completed = d.reason && d.reason.kind === 'completed'
            const text = lastTurn === d.turn ? lastText : ''
            cleanupListener()
            if (!completed) { reject(new Error(`回合未正常结束：${d.reason?.kind || '?'}`)); return }
            resolve(String(text ?? ''))
          }
        })
        if (typeof off !== 'function') {
          // 无事件流的 DSH：followup 链落定后取不到回复文本（如实报错，不猜）
          cleanupListener()
          reject(new Error('DSH 没有 session/event 流，无法取回复文本'))
        }
      })
      // followup 的 rejected promise 必须捕获：否则 unhandledRejection + 回合永久 running 占死该聊天调度槽
      let followupError = null
      try {
        await agent.followup({ content })
      } catch (error) {
        followupError = error
      }
      if (followupError) {
        cleanupListener() // 失败路径同样摘监听（报告 §4.5「finally 清理监听」）
        throw new Error(`DSH 回合执行失败：${followupError?.message || followupError}`)
      }
      let reply
      try {
        reply = await replyPromise
      } catch (error) {
        cleanupListener() // turn/end 非 completed / 无事件流：摘除后如实失败（回合落 failed，槽释放）
        throw error
      }

      // 6. 回复经 outbox 投递（唯一物理出口）
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
    // 入站 ACL：offer 前用 legacy 同一 checkAllowed 拒绝白名单外会话（绝不让未授权消息驱动 DSH）
    const acl = checkAllowed(cfg, aclMsgFromInbound(inbound))
    if (!acl.allowed) {
      debug(`入站 ACL 拒绝：${inbound.chatKey}（${acl.reason}）`)
      return { handled: 'acl-denied', reason: acl.reason }
    }
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

  /** 补收入口（M4-4）：补收事件带原始时间，source=backfill（M1-B 语义同款）。同样过入站 ACL。 */
  function dispatchBackfill(ev) {
    const cfg = getConfig()
    const { inbound } = safeAdapt(ev, 'backfill')
    if (!inbound) return { handled: 'skipped' }
    const acl = checkAllowed(cfg, aclMsgFromInbound(inbound))
    if (!acl.allowed) return { handled: 'acl-denied', reason: acl.reason }
    controller.offer(inbound)
    return { handled: 'offered' }
  }

  async function dispose() {
    await registry.dispose()
    await controller.dispose()
    outbox.dispose()
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
