// M2-E · Context Assembly：模块上下文 provider 的统一装配（纯模块）
//
// 职责（任务书 M2-E + ADR-0001 ContextFragment 契约）：
//   - 聚合所有模块 provider；保留优先级、scope（ChatKey 或 global）、sessionId、
//     稳定缓存顺序和错误隔离；
//   - 错误策略只有两种（ADR）：isolate（该 provider 出错跳过，其他照常）/ fail-closed
//     （该 provider 出错 = 整次装配失败，绝不带残缺上下文继续）——按 provider 声明执行；
//   - 无 scope 时 fail-closed（拿不到可信作用域就不注入，绝不全库兜底）；
//   - 装配顺序稳定：priority 降序，同优先级按注册序（缓存稳定，不随 Map 迭代漂移）。
//
// 红线：本模块不读模块数据库、不 import 任何业务模块；provider 是注入的黑盒函数。
//
// Phase 2 追加（本节）：出厂连续性 provider 构造器——
//   - createTimeScaleProvider（priority 790）：给模型相对时间感，避免三天前的约定被当成刚才说的。
// 只吃**注入**的时间源，无 scope 一律不注入。

import { assertContextFragment } from '../kernel/modular-contracts.js'
import { parseChatKey } from './chat-key.js'

/**
 * @param {object} o
 * @param {Array<{moduleId: string, priority?: number, scope?: string, sessionId?: string,
 *   cacheStable?: boolean, onError?: 'isolate'|'fail-closed',
 *   provide: (req: {chatKey: string, sessionId?: string}) => (string | {content: string, sessionId?: string, scope?: string})}>} o.providers
 */
export function createContextAssembly({ providers = [] } = {}) {
  let nextOrder = 0
  const registered = providers.map((p) => normalizeProvider(p, nextOrder++))

  function normalizeProvider(p, index) {
    if (!p || typeof p !== 'object') throw new TypeError('provider 必须是对象')
    if (typeof p.moduleId !== 'string' || !p.moduleId) throw new TypeError('provider 缺 moduleId')
    if (typeof p.provide !== 'function') throw new TypeError(`provider ${p.moduleId} 缺 provide()`)
    if (p.scope !== undefined && p.scope !== 'global') parseChatKey(p.scope) // 声明即校验
    return {
      moduleId: p.moduleId,
      order: index,
      priority: typeof p.priority === 'number' && Number.isFinite(p.priority) ? p.priority : 0,
      scope: p.scope ?? 'global',
      sessionId: p.sessionId,
      cacheStable: p.cacheStable ?? false,
      onError: p.onError === 'fail-closed' ? 'fail-closed' : 'isolate',
      provide: p.provide,
    }
  }

  /** 注册（模块启停/热重载时由装载层调用）。使用单调递增序号，注销句柄按对象引用精确卸载。 */
  function register(provider) {
    const norm = normalizeProvider(provider, nextOrder++)
    registered.push(norm)
    return () => unregister(norm)
  }

  function unregister(target) {
    const i = typeof target === 'object' && target !== null
      ? registered.indexOf(target)
      : registered.findIndex((p) => p.moduleId === target)
    if (i >= 0) registered.splice(i, 1)
  }

  /**
   * 装配一次上下文。
   * @param {object} req
   * @param {string} req.chatKey 当前聊天
   * @param {string} [req.sessionId] 当前会话（provider 声明的 sessionId 缺省时用它）
   * @returns {Promise<{ fragments: Array<object>, errors: Array<{moduleId, message}> }>}
   */
  async function assemble(req) {
    const chatKey = String(req?.chatKey ?? '')
    parseChatKey(chatKey) // 无可信聊天域 = fail-closed（调用方先修 ChatKey）
    const sessionId = req?.sessionId ? String(req.sessionId) : undefined

    // 作用域过滤：provider.scope='global' 全局可见；scope 是 ChatKey 时仅该聊天可见
    // （群聊拿不到私聊记忆 = 物理隔离的声明式表达）
    const eligible = registered.filter((p) => p.scope === 'global' || p.scope === chatKey)
    // 稳定顺序：priority 降序，同优先级按注册序
    const ordered = [...eligible].sort((a, b) => (b.priority - a.priority) || (a.order - b.order))

    // 并发拉取各 provider 后再按既定优先级顺序汇总，缩短首字节延迟且保持缓存序稳定
    const settled = await Promise.allSettled(
      ordered.map((p) => Promise.resolve().then(() => p.provide({ chatKey, sessionId, chat: req?.chat }))),
    )

    const fragments = []
    const errors = []
    for (let i = 0; i < ordered.length; i += 1) {
      const p = ordered[i]
      const res = settled[i]
      if (res.status === 'rejected') {
        const error = res.reason
        errors.push({ moduleId: p.moduleId, message: String(error?.message || error) })
        if (p.onError === 'fail-closed') {
          throw Object.assign(new Error(`context provider ${p.moduleId} fail-closed：${error?.message || error}`), {
            moduleId: p.moduleId,
            cause: error,
          })
        }
        continue
      }
      try {
        const raw = res.value
        const content = typeof raw === 'string' ? raw : String(raw?.content ?? '')
        if (!content) continue // 空贡献不产出 fragment（不占装配位）
        const frag = {
          contractVersion: 1,
          moduleId: p.moduleId,
          scope: p.scope === 'global' ? 'global' : chatKey,
          sessionId: p.sessionId ?? sessionId,
          priority: p.priority,
          cacheStable: p.cacheStable,
          onError: p.onError,
          content,
        }
        assertContextFragment(frag)
        fragments.push(frag)
      } catch (error) {
        errors.push({ moduleId: p.moduleId, message: String(error?.message || error) })
        if (p.onError === 'fail-closed') {
          // 该 provider 出错 = 整次装配失败（绝不带残缺上下文继续）
          throw Object.assign(new Error(`context provider ${p.moduleId} fail-closed：${error?.message || error}`), {
            moduleId: p.moduleId,
            cause: error,
          })
        }
        // isolate：跳过该 provider，其余照常
      }
    }
    return { fragments, errors }
  }

  return { assemble, register, unregister }
}

// ---------------------------------------------------------------------------
// Phase 2 · 连续性 provider：时空连续标尺（time-scale）
//
// 硬规则：
//   1. 无 scope（未绑定 ChatKey）= fail-closed：provide() 返回空串，绝不注入（也不全库兜底）；
//   2. 错误策略 isolate：单个 provider 出错只跳过自己，其余上下文照常装配。
// ---------------------------------------------------------------------------

/** 时空连续标尺 provider 的模块 ID。 */
export const TIME_SCALE_PROVIDER_ID = 'time-scale'

/** 时空标尺优先级：高于普通记忆(100)，补足相对时间感。 */
export const TIME_SCALE_PROVIDER_PRIORITY = 790

/** 把毫秒差格式化成中文相对时长（纯函数，负值按 0 处理）；超过一天带天数。 */
export function formatElapsedMs(ms) {
  const value = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
  const minutes = Math.floor(value / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`
}

/** 「多久没聊」→ 顺承提示（纯函数；阈值固定，便于回放复现）。 */
export function formatGapHint(ms) {
  const minutes = Math.floor((typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0) / 60_000)
  if (minutes < 5) return '话头还是热的'
  if (minutes < 120) return '刚离开一小会儿'
  if (minutes < 1440) return '隔了几个钟头'
  return '隔了不止一天，对方可能已经忘了上下文'
}

/**
 * 建一个「时空连续标尺」provider（priority 790，isolate）：给模型相对时间感，
 * 避免「三天前的约定」被当成「刚才说的」。
 *
 * @param {object} o
 * @param {string} [o.scope] 绑定的 ChatKey；缺省 = 无 scope，provide() 不注入（fail-closed）
 * @param {(chatKey: string) => (number|null|undefined)} [o.resolveLastAt] 上次互动时间戳来源（注入）
 * @param {() => number} [o.now] 可注入时钟
 * @param {boolean} [o.perChat] 按每次请求的 chatKey 现算作用域（默认 false）
 */
export function createTimeScaleProvider({ scope, resolveLastAt, now = Date.now, perChat = false } = {}) {
  if (resolveLastAt !== undefined && typeof resolveLastAt !== 'function') {
    throw new TypeError('createTimeScaleProvider 的 resolveLastAt 必须是函数或留空')
  }
  if (scope !== undefined && scope !== 'global') parseChatKey(scope)

  const scopeOf = (reqChatKey) => {
    if (!perChat) return scope
    if (!reqChatKey) return undefined
    try {
      // parseChatKey 返回 { kind, id }，**没有** chatKey 字段；直接取 .chatKey 会恒得 undefined
      // 从而让 perChat 永远 fail-closed（接线看似在、实际不注入）。这里显式重组成规范形态。
      const { kind, id } = parseChatKey(String(reqChatKey))
      return `${kind}:${id}`
    } catch { return undefined }
  }

  const provide = ({ chatKey } = {}) => {
    const resolved = scopeOf(chatKey)
    if (!resolved || resolved === 'global') return '' // 无 scope = fail-closed 不注入
    if (resolved !== chatKey) return ''
    if (typeof resolveLastAt !== 'function') return '' // 没有时间源就不编造时间
    const lastAt = resolveLastAt(resolved)
    if (typeof lastAt !== 'number' || !Number.isFinite(lastAt) || lastAt <= 0) return ''
    const when = typeof now === 'function' ? now() : now
    const elapsed = Math.max(0, Number(when) - lastAt)
    return `[时空标尺：距上一轮对话 ${formatElapsedMs(elapsed)}（${formatGapHint(elapsed)}）]`
  }

  return {
    moduleId: TIME_SCALE_PROVIDER_ID,
    priority: TIME_SCALE_PROVIDER_PRIORITY,
    scope: scope ?? 'global',
    cacheStable: false,
    onError: 'isolate',
    provide,
  }
}
