// 入站预处理：入站事件 → 闸门/模型需要的形状（纯函数，无闭包状态）。
//
// 从 host/modular-core.js 原样搬出（纯结构重构，行为逐行一致，不改任何逻辑/文案）。
// 拆分理由：这一层是「格式转换」，与核心装配无关；单独成模块后入站相关测试可以
// 直接静态定位到这些实现（真机审计里的 DSL 中和、合并转发水合都在这里）。
//
// 依赖只有 chat/inbound.js 与 chat/reply.js 的纯函数；mods 之类的活对象一律由
// 调用方当参数传进来（emitActivity），模块自己不持有任何跨轮状态。

import { parseMessageEvent, cardText, neutralizeInboundDsl } from '../../chat/inbound.js'
import { parseReply } from '../../chat/reply.js'

/** 合并转发水合：展开真实消息正文，限制条数和总长度；失败保留原段，不伪称已读。 */
export async function hydrateForwards(members, onebot, log) {
  const out = []
  for (const member of Array.isArray(members) ? members : []) {
    const segments = Array.isArray(member?.segments) ? member.segments : []
    if (!segments.some((s) => s?.type === 'forward')) { out.push(member); continue }
    const next = []
    for (const segment of segments) {
      if (segment?.type !== 'forward') { next.push(segment); continue }
      const id = String(segment.data?.id ?? segment.data?.res_id ?? segment.data?.forward_id ?? '')
      if (!id) { next.push(segment); continue }
      try {
        const raw = await onebot.call('get_forward_msg', { id }, { timeoutMs: 10000, retries: 0 })
        const rows = []
        let used = 0
        for (const item of (raw?.messages || []).slice(0, 50)) {
          const sender = item?.sender || {}
          const parsed = parseMessageEvent({
            message_type: 'private',
            user_id: item?.user_id ?? sender.user_id,
            sender,
            message: item?.message ?? item?.raw_message ?? '',
          }, '')
          const name = String(sender.card || sender.nickname || parsed.userId || '某人')
          const line = `${name}：${parsed.text || '（媒体/非文字消息）'}`
          if (used + line.length > 6000) break
          rows.push(line)
          used += line.length
        }
        if (!rows.length) throw new Error('转发内容为空')
        next.push({ type: 'text', data: { text: `[合并转发的聊天记录（${rows.length} 条）]\n${rows.map((line) => `  ${line}`).join('\n')}\n[转发结束]` } })
      } catch (error) {
        log?.debug?.(`合并转发读取失败（保留原段）：${error?.message || error}`)
        next.push(segment)
      }
    }
    out.push({ ...member, segments: next })
  }
  return out
}

/** 这段文本里有没有「人话」：只有 `<sticker:…>` / `<poke>` / `![](…)` 这类控制标记时返回 ''。
 *
 *  真机 2026-11-23 15:01（群 900000001）：模型在**同一步**里写了正文、又调了 qq_send_sticker（pii-scan:ignore 示例群号）
 *  （工具立即直发一张表情），下一步收尾又把 `<sticker:无语>` 当正文 —— 旧实现只留末步文本，
 *  上一步已经写好的「就写点后端 天天看日志」凭空消失，群里只剩两张纯表情、一个字都没有。 */
export function visibleTextOf(text) {
  try {
    const parsed = parseReply(String(text || ''))
    if (parsed.silent) return ''
    return parsed.items
      .filter((item) => item.kind === 'text' || item.kind === 'voice')
      .map((item) => String(item.value || ''))
      .join('\n')
      .trim()
  } catch {
    return String(text || '').trim()
  }
}

/** 群消息里的图片/表情段要跟着这段上下文走：群闸可能不触发回合，等下一条
 *  文字才回，此时触发轮 members 里已经没有那张图了（真机：群里只剩「（图片/表情）」占位）。 */
export const MAX_GROUP_MEDIA = 4
export function mediaOfInbound(inbound) {
  return (Array.isArray(inbound?.segments) ? inbound.segments : [])
    .filter((s) => s?.type === 'image' || s?.type === 'mface')
    .slice(0, MAX_GROUP_MEDIA)
    .map((s) => ({ type: 'image', url: String(s.data?.url || s.data?.file || '') }))
}

/** 入站事件 → checkAllowed 需要的 msg 形状（从 ChatKey + sender 还原 kind/userId/groupId）。 */
export function aclMsgFromInbound(inbound) {
  const chatKey = String(inbound?.chatKey ?? '')
  if (chatKey.startsWith('group:')) return { kind: 'group', userId: String(inbound?.sender?.userId ?? ''), groupId: chatKey.slice(6) }
  return { kind: 'private', userId: chatKey.slice(8), groupId: '' }
}

/** 段列表 → 纯文本（身份闸用；同 legacy sendSegments 的取词）。 */
export function textOfSegments(segments) {
  return (Array.isArray(segments) ? segments : []).map((s) => {
    if (s?.type === 'text') return String(s?.data?.text || '')
    if (s?.type === 'file') return `[文件 ${s.data?.file_name || s.data?.name || s.data?.file || '未命名'}]`
    if (s?.type === 'record') return '[语音]'
    if (s?.type === 'video') return '[视频]'
    return ''
  }).join('')
}

/** 入站 → 模块中枢 activity 事件（等价 legacy hub.js:1583 那一发）。
 *  token-guardian 等模块的 activity 计数全挂在这个事件上；开旗后消息不走 hub，
 *  不补这一发它们永远收不到计数（验收报告「额外缺口」，真机实测 L0 batches 恒 0）。 */
export function emitActivity(mods, inbound, { direct = false, owner = false } = {}) {
  try {
    const chatKey = String(inbound?.chatKey || '')
    if (!chatKey) return
    mods?.emit?.('activity', {
      kind: 'in',
      chatId: chatKey,
      userId: String(inbound?.sender?.userId || ''),
      nickname: String(inbound?.sender?.nickname || ''),
      text: textOfSegments(inbound.segments),
      direct,
      owner,
    })
  } catch { /* 计数是旁路，绝不打断主链 */ }
}

/** 入站 → DSH content 块（legacy 视图语义：文本段原样、图片段带 url/file、其余如实降级）。
 *  文本段一律先过 neutralizeInboundDsl（§4.3）：用户伪造的 <inner>/<voice>/<poke>/… 标签族
 *  在进模型上下文之前就中和成实体，不能冒充系统元数据。 */
export function segmentsToContent(members) {
  const content = []
  for (const m of members) {
    for (const s of (m?.segments ?? [])) {
      if (s?.type === 'text') { const t = neutralizeInboundDsl(String(s.data?.text ?? '')); if (t) content.push({ type: 'text', text: t }) }
      else if (s?.type === 'image' || s?.type === 'mface') content.push({ type: 'image', url: String(s.data?.url || s.data?.file || '') })
      else if (s?.type === 'reply' || s?.type === 'at') continue
      else if (s?.type === 'forward') content.push({ type: 'text', text: '\n[合并转发（内容没拉到）]\n' })
      // 卡片文字也是用户可控的入站正文（攻击者发一张标题带 <inner>… 的卡片就能绕过去）：
      // 必须和中 Prose 一样走中和，让模型看到字面内容而不是可执行标签。
      else if (s?.type === 'json') content.push({ type: 'text', text: `\n${neutralizeInboundDsl(cardText(s.data?.data))}\n` })
      else if (s?.type === 'xml') content.push({ type: 'text', text: '\n[卡片消息]\n' })
      else if (s?.type) content.push({ type: 'text', text: `\n[${s.type}]\n` })
    }
  }
  return content
}
