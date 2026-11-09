// M3-D · Legacy Context Adapter：把 legacy 的上下文来源映射为 ContextAssembly 的 provider
//
// legacy 的三个来源（任务书 M3-D）：
//   1. systemPrompt 变量（persona/rules —— hub 直读，M4 继续直读，本层不接管）；
//   2. hooks.prompt（模块对提示词的过滤）——事件级，不在 provider 范围；
//   3. mods.contextFor（模块上下文）→ 本层把它包成一个 provider，scope/sessionId 语义对齐新契约。
//
// 无法兼容的惰性求值行为（任务书要求记录）：legacy contextProviders 是「每事件现取」的
// 函数数组（模块热重载即时生效）；本适配器注入的 provider 同样每事件现取 mods 引用，语义等价。

/**
 * @param {object} o
 * @param {{ contextFor: (args: { chat: object, sessionId?: string }) => string|Promise<string>, generation?: () => number }} o.mods
 *   legacy 模块中枢的 contextFor（mods 对象本体，热重载由现取保证）
 * @param {number} [o.priority] 装配优先级（缺省 100，与 memory 主库同级）
 */
export function createLegacyContextAdapter({ mods, priority = 100 } = {}) {
  if (!mods || typeof mods.contextFor !== 'function') throw new TypeError('mods.contextFor 必填')
  return {
    moduleId: 'legacy-context',
    priority,
    scope: 'global', // 所有聊天都经过它；内部按 chatId 分发给各模块（legacy 语义）
    cacheStable: false,
    onError: 'isolate', // 模块异常按 legacy 语义隔离（contextFor 自己吞错返回空）
    /**
     * ContextAssembly provider 签名。
     * 真机审计 1.1 第二层：legacy hub 挂给 mods.contextFor 的是 **{ chat, sessionId }**
     * （chat=解析后的会话视图，模块 provider 解构 chat.kind 直接用）；
     * 本适配器此前传 { chatId } → provider 里 chat=undefined → 抛错被吞 → 全员空串。
     * 现在按同一形状传：chat 视图优先由装配方透传，缺省时从 ChatKey 如实派生。
     */
    provide: async ({ chatKey, sessionId, chat }) => {
      const view = chat || chatViewFromKey(chatKey)
      const text = await mods.contextFor({ chat: view, sessionId })
      return typeof text === 'string' ? text : ''
    },
  }
}

/** 从 ChatKey 派生 legacy 兼容的 chat 视图（kind/chatId/userId/groupId）。 */
function chatViewFromKey(chatKey) {
  const key = String(chatKey || '')
  if (key.startsWith('group:')) return { kind: 'group', chatId: key, groupId: key.slice(6), userId: '' }
  if (key.startsWith('private:')) return { kind: 'private', chatId: key, groupId: '', userId: key.slice(8) }
  return { kind: 'system', chatId: key, groupId: '', userId: '' }
}
