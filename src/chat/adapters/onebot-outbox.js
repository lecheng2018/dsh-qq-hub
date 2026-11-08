// M3-C · OneBot Outbox Adapter：把真实 OneBot 客户端接入统一 Outbox 的 send 注入点
//
// 职责边界（任务书 M3-C + PR-1 收口扩展，ADR-0002）：
//   - outbox.request 的 send 注入 = 本适配器：调 OneBot RPC、把结果转成 { messageId, raw }、
//     把失败按 client.js 的 unknown/definite 分类如实上抛；
//   - PR-1 后本出口是**全仓唯一物理写者**：除 send_*_msg 外，经 outbox 直通模式承载
//     upload_*/send_poke/send_qzone_msg/forward 等发信类动作（回执要求由调用方声明）；
//   - 清洗/分条仍是 reply.js 的事；live/shadow 不在本适配器做。

import { parseChatKey } from '../chat-key.js'

/**
 * @param {object} o
 * @param {{ call: (action: string, params: object, opts?: object) => Promise<object> }} o.onebot
 *   OneBot 客户端（真实 createOneBotClient / fake 网关都实现同一签名）
 */
export function createOnebotOutboxAdapter({ onebot }) {
  if (!onebot || typeof onebot.call !== 'function') throw new TypeError('onebot.call 必填')
  return {
    /**
     * Outbox send 注入点签名：send(action, params, opts) → { messageId?, raw }；
     * 失败按错误原样上抛（client.js 已标 unknown/definite，outbox 据此记账）。
     * raw 保留网关原始回执（message_id/file_id/itemid…）供 hub 兼容层返回 legacy 形状。
     */
    async send(action, params, opts) {
      const result = await onebot.call(action, params, opts)
      const messageId = result?.message_id
      return { ...(messageId != null ? { messageId: String(messageId) } : {}), raw: result }
    },
  }
}

/** 便捷：ChatKey + segments → OneBot params（M4 管道用）。 */
export function paramsFor(chatKey, segments) {
  const { kind, id } = parseChatKey(chatKey)
  return kind === 'group'
    ? { group_id: Number(id), message: segments }
    : { user_id: Number(id), message: segments }
}
