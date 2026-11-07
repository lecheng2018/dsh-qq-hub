// M2-A · ChatKey：聊天域键的解析 / 格式化 / 判定（纯模块，不依赖 DSH / OneBot / host）
//
// 冻结契约（ADR-0001）：`private:<数字ID>` 或 `group:<数字ID>`，禁止裸 QQ 号充当跨域键。
// 本模块是 chat 层的唯一 ChatKey 出入口；校验逻辑复用 src/kernel/modular-contracts.js
// （契约冻结后的唯一权威），这里只补 chat 层常用的便捷视图，不另造第二套规则。

import { createChatKey as contractCreateChatKey, parseChatKey as contractParseChatKey } from '../kernel/modular-contracts.js'

/** 构造 ChatKey：kind 仅限 'private' | 'group'，id 接受数字或不含前导零的数字串。 */
export function createChatKey(kind, id) {
  return contractCreateChatKey(kind, id)
}

/** 解析 ChatKey → 冻结的 { kind, id }；非法输入抛 TypeError（fail-closed）。 */
export function parseChatKey(chatKey) {
  return contractParseChatKey(chatKey)
}

/** 是否为合法 ChatKey（不抛错的判定视图）。 */
export function isChatKey(value) {
  try {
    contractParseChatKey(value)
    return true
  } catch {
    return false
  }
}

/** 域名：'private' | 'group'（非法 ChatKey 抛 TypeError）。 */
export function kindOf(chatKey) {
  return contractParseChatKey(chatKey).kind
}

/** 对端 ID（字符串数字；非法 ChatKey 抛 TypeError）。 */
export function idOf(chatKey) {
  return contractParseChatKey(chatKey).id
}

/** 是否私聊。 */
export function isPrivate(chatKey) {
  return kindOf(chatKey) === 'private'
}

/** 是否群聊。 */
export function isGroup(chatKey) {
  return kindOf(chatKey) === 'group'
}

/**
 * OneBot v11 事件到 ChatKey 的映射（入站侧唯一口径）：
 * group 事件 → `group:<group_id>`；其余（私聊/poke 等）→ `private:<user_id>`。
 * 缺关键字段返回 ''（调用方按无主事件处理，不得猜键）。
 */
export function chatKeyFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return ''
  if (ev.message_type === 'group' && ev.group_id != null) {
    try { return createChatKey('group', ev.group_id) } catch { return '' }
  }
  const uid = ev.user_id ?? ev.sender?.user_id
  if (uid == null) return ''
  try { return createChatKey('private', uid) } catch { return '' }
}
