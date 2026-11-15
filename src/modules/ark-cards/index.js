// 内置模块：Ark 卡片。原生图文卡片（send_tuwen_ark）替代 json 卡片段，观感更正式。
// 降级链（延续 #150 卡片消息的设计）：原生 Ark 失败 → json 分享卡 → 文字摘要，逐级兜底不报错。
//
// 出站 URL 先过 check_url_safely（QQ 侧安全检查，可关）——只对「明确不安全」拒绝，
// 检查本身失败按「没查成」处理（放行 + 记日志）：安全检查是加分项，不能变成发送的拦路虎。
//
// 接线：send_tuwen_ark 命中 modules.js 的 send| 路由自动进统一 Outbox；client.js 零改动。

import { defineTool, str } from '../../tools/tools.js'
import { registerReadActions } from '../../onebot/read-actions.js'
import { cardSegment, cardFallbackText } from '../qq-tools/index.js'

/** jump_url 的 http(s) 校验（卡片的落点必须是网址）。 */
export function arkJumpUrlOk(url) {
  return /^https?:\/\/.+/i.test(String(url || '').trim())
}

/**
 * Ark 参数构造（纯校验，返回 {params} 或 {error}）。
 * 字段按 ErisPulse 文档的 TuwenArk(title, desc, jump_url, summary, preview_url) 对齐，
 * 网关侧字段名漂移由实机测试阶段核对。
 */
export function buildArkParams(args = {}) {
  const title = String(args.title || '').trim()
  const jump = String(args.jump_url || '').trim()
  if (!title) return { error: 'title 要填（卡片标题）' }
  if (!arkJumpUrlOk(jump)) return { error: 'jump_url 要是 http(s) 链接' }
  const params = {
    title: title.slice(0, 100),
    desc: String(args.desc || '').trim().slice(0, 200),
    jump_url: jump,
    summary: String(args.summary || '[分享]').trim().slice(0, 30) || '[分享]',
  }
  const preview = String(args.preview_url || '').trim()
  if (preview && /^https?:\/\//i.test(preview)) params.preview_url = preview
  return { params }
}

/** Ark 失败时的第一级降级：等价的 json 分享卡段（复用 qq-tools 的校验）。 */
export function arkFallbackSegment(args = {}) {
  return cardSegment({ type: 'share', url: args.jump_url, title: args.title, content: args.desc, image: args.preview_url })
}

/** 最后一级降级：文字摘要。 */
export function arkFallbackText(args = {}) {
  return cardFallbackText({ type: 'share', data: { title: args.title, content: args.desc, url: args.jump_url } })
}

export default {
  id: 'ark-cards',
  name: 'Ark 卡片',
  version: '1.0.0',
  tab: 'enhance',
  description: '主人私聊里让她发原生图文卡片（qq_send_ark）；出站链接先过 QQ 安全检查；网关不支持时自动降级 json 卡片 → 文字摘要',
  defaults: {
    urlCheckEnabled: true,
  },
  settings: [
    { key: 'urlCheckEnabled', label: '链接安全检查', type: 'switch', hint: '发送前用 QQ 的 check_url_safely 查一下目标链接；明确报不安全就拒发。检查接口挂了不拦发送' },
  ],
  setup(api) {
    const { hub, onebot } = api.core

    const reg = registerReadActions(['check_url_safely'])
    if (reg.rejected.length) api.log.warn(`只读动作登记被拒收：${reg.rejected.join('、')}`)

    /** 安全检查：明确不安全才拒；检查失败放行并记日志。 */
    async function urlSafe(jump) {
      if (!api.settings().urlCheckEnabled) return { ok: true }
      try {
        const r = await onebot.call('check_url_safely', { url: jump }, { timeoutMs: 8000 })
        // 不同实现形状不同：safe===false / unsafe===true / level.risk 明确报不安全才拒
        const unsafe = r?.safe === false || r?.unsafe === true || String(r?.level?.risk ?? '').match(/unsafe|danger/i)
        if (unsafe) return { ok: false, message: 'QQ 说这个链接不安全，没发' }
        return { ok: true }
      } catch (error) {
        api.log.debug('链接安全检查没查成（放行）：', error?.message || error)
        return { ok: true }
      }
    }

    api.tool(({ chat, level, sessionId }) => {
      if (level !== 'full') return []
      return defineTool({
        name: 'qq_send_ark',
        description: '发一张原生图文卡片到当前聊天（标题 + 说明 + 链接 + 可选预览图）。主人让你分享链接类内容时用；网关不支持时自动降级为分享卡片/文字。',
        properties: {
          title: str('卡片标题'),
          desc: str('说明文字'),
          jump_url: str('跳转链接（http/https）'),
          preview_url: str('可选：预览图链接'),
          summary: str('可选：分享角标文字，默认 [分享]'),
        },
        required: ['title', 'jump_url'],
        execute: async (args) => {
          if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我发卡片' }
          const built = buildArkParams(args)
          if (built.error) return { ok: false, message: built.error }
          const safe = await urlSafe(built.params.jump_url)
          if (!safe.ok) return { ok: false, message: safe.message }
          // 会话域参数：群给 group_id、私聊给 user_id（deliverRaw 据此自动推导 chatKey 记台账）
          const kind = chat.kind === 'group' ? 'group' : 'private'
          const chatIdNum = Number(chat.kind === 'group' ? chat.groupId : chat.userId)
          const target = kind === 'group' ? { group_id: chatIdNum } : { user_id: chatIdNum }
          try {
            // 原生 Ark（send_ 前缀：api.onebot 自动转进统一 Outbox，台账/dryRun/身份闸生效）
            await api.onebot('send_tuwen_ark', { ...target, ...built.params }, { timeoutMs: 20000 })
            return { ok: true, message: '原生卡片发出去了' }
          } catch (error) {
            // 第一级降级：等价的 json 分享卡段
            try {
              const seg = arkFallbackSegment(args)
              if (seg.error) throw new Error(seg.error)
              await hub.sendSegments(chat.chatId, [seg.segment], `[分享卡] ${built.params.title}`, { throwOnError: true })
              return { ok: true, message: `网关发不了原生 Ark，改用分享卡片发出去了（${String(error.message || error).slice(0, 80)}）` }
            } catch (error2) {
              // 最后一级：文字摘要（deliver 走 Outbox，诚实记账）
              await hub.deliver(chat.chatId, arkFallbackText(args))
              return { ok: true, message: `卡片都发不了，改用文字摘要发出去了（${String(error2.message || error2).slice(0, 80)}）` }
            }
          }
        },
      })
    })

    return { buildArkParams, arkFallbackSegment, arkFallbackText }
  },
}
