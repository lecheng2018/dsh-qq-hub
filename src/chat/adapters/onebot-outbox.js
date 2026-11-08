// M3-C · OneBot Outbox Adapter：把真实 OneBot 客户端接入统一 Outbox 的 send 注入点
//
// 职责边界（任务书 M3-C）：
//   - outbox.request 的 send 注入 = 本适配器：调 OneBot RPC、把结果转成 { messageId }、
//     把失败按 client.js 的 unknown/definite 分类如实上抛；
//   - 清洗/分条/dryRun/身份保护仍是 legacy reply.js 的职责（M4 接线时以 payload 预处理进入）；
//   - live/shadow 不在本适配器做（影子比对属 kernel 出口切换，M4 只选其一接线）。

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
     * Outbox send 注入点签名：send(action, params) → { messageId }；失败按错误原样上抛
     * （client.js 已标 unknown/definite，outbox 据此记账）。
     */
    async send(action, params) {
      if (action !== 'send_group_msg' && action !== 'send_private_msg') {
        throw new TypeError(`outbox 物理出口只发消息（收到 ${action}）；媒体/文件走 upload_* 由调用方组装`)
      }
      const result = await onebot.call(action, params)
      // OneBot v11 成功回执：data.message_id（fake/真实网关同形）；没有 = 回执丢失（outbox 记 unknown）
      const messageId = result?.message_id
      return { ...(messageId != null ? { messageId: String(messageId) } : {}) }
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
