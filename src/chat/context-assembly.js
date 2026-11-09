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

import { assertContextFragment } from '../kernel/modular-contracts.js'
import { parseChatKey } from './chat-key.js'

/**
 * @param {object} o
 * @param {Array<{moduleId: string, priority?: number, scope?: string, sessionId?: string,
 *   cacheStable?: boolean, onError?: 'isolate'|'fail-closed',
 *   provide: (req: {chatKey: string, sessionId?: string}) => (string | {content: string, sessionId?: string, scope?: string})}>} o.providers
 */
export function createContextAssembly({ providers = [] } = {}) {
  const registered = providers.map((p, index) => normalizeProvider(p, index))

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

  /** 注册（模块启停/热重载时由装载层调用）。 */
  function register(provider) {
    const norm = normalizeProvider(provider, registered.length)
    registered.push(norm)
    return () => unregister(norm.moduleId)
  }

  function unregister(moduleId) {
    const i = registered.findIndex((p) => p.moduleId === moduleId)
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

    const fragments = []
    const errors = []
    for (const p of ordered) {
      try {
        const raw = await p.provide({ chatKey, sessionId, chat: req?.chat }) // chat 视图透传（legacy provider 契约吃 chat 对象）
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
