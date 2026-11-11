// 记忆作用域纯函数层（1.3.65 重构 K-02 / Task 3.1）。
// 从 optional 模块 memory-privacy 迁出，消除 memory-bus 对扩展模块的倒置依赖。
// 纯函数，零状态，零 I/O。

/** 当前聊天能看到哪些作用域的记忆（私聊只看自己和全局，群聊只看本群和全局）。 */
export function visibleScopes(chat) {
  if (!chat || chat.kind === 'system') return []
  if (chat.kind === 'private') return [`private:${chat.userId}`, 'global']
  if (chat.kind === 'group') return [`group:${chat.groupId}`, 'global']
  // 认不出来的聊天类型：只给 global，不给任何人的私有内容
  return ['global']
}

/** 一条记忆在当前聊天里可见吗？ */
export function isVisible(item, chat) {
  if (!item) return false
  // system（她自己后台想事情）会话不该看到任何分层记忆
  if (!chat || chat.kind === 'system') return false
  const scope = String(item.scope || '').trim()
  // 无 scope 的按「不可见」处理，不再默认当 global。
  // 和 features/memory.js 的 scopeVisible 保持同一口径：认不出来源就不给，
  // 否则一批没写 scope 的老条目会在任何聊天里都可见。
  if (!scope) return false
  if (scope === 'global') return true
  return visibleScopes(chat).includes(scope)
}

/** 当前聊天记下的记忆应该落到哪个作用域？ */
export function scopeOf(chat) {
  if (!chat || chat.kind === 'system') return 'global'
  if (chat.kind === 'private') return `private:${chat.userId}`
  if (chat.kind === 'group') return `group:${chat.groupId}`
  // 认不出来的聊天类型，不要默认写进 global —— 那等于把内容直接公开。
  // 退到一个谁也不共享的私有作用域，宁可自己看不到，也不让它漏给别人。
  return 'private:unknown'
}
