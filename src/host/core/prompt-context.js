// 群聊提示词上下文拼接。
//
// 从 host/modular-core.js 原样搬出（纯结构重构，行为逐行一致），函数体按行切片搬运，未做任何改写。
// 它只读三份外部状态：群缓冲 groups、配置 getConfig()、群名缓存 groupNames —— 三者都以
// 活引用/取数函数注入，所以搬走后 execute 主链拿到的 blocks / refs / fedItems 与拆分前同一份
// （fed 标记与引用表本来就挂在 groups 里，不是快照）。

import { agoLabel, nowLine } from '../../chat/clockline.js'
import { cardText, neutralizeInboundDsl, stripInvisible } from '../../chat/inbound.js'
import { MAX_GROUP_MEDIA } from './inbound-prep.js'

export function createPromptContext({ getConfig, groups, groupNames }) {
  /** 群聊上下文拼接（真机审计 1.3；legacy groupPrompt 的简化复刻）：
   *  未投喂最近 20 条 + 已投喂 8 条，带发言人标记与相对时间；主人只标「主人」不落号码。
   *  引用正文由 quotedInfo 水合；<reply:n>/<at:> 与富媒体出站统一经当前 reply-delivery。 */
  function groupPromptContent(chatKey, members, previousTurnAt, modeOverride) {
    const gid = chatKey.slice(6)
    const buf = groups.buffer(gid)
    for (const m of (members || [])) {
      if (m?.quoteNote && m?.messageId) {
        const hit = buf.findLast?.((x) => String(x.mid) === String(m.messageId))
        if (hit) hit.quoteNote = m.quoteNote
      }
    }
    const rawFresh = buf.filter((x) => !x.fed).slice(-20)
    const baseOlder = buf.filter((x) => x.fed).slice(-4)
    // fed 不在这里标（缺陷：群缓冲静默丢消息）。现只把选中的 rawFresh 作为 fedItems 返回，
    // 由 execute 在拿到回复后才标 fed；失败路径不标 → 下轮重新作为 fresh 喂入。
    const mode = modeOverride || 'must'
    const nowAt = Date.now()
    const triggerMemberIds = new Set((members || []).map((m) => String(m?.messageId || '')).filter(Boolean))
    // 对 interject/engaged 回合按 5 分钟时效窗口切分当前话题，防止很久以前的 unfed 旧话
    // 与刚说的触发消息平权编号导致模型跑去接陈年旧话。
    const FRESH_TOPIC_WINDOW_MS = 5 * 60_000
    let fresh = rawFresh
    let older = baseOlder
    if ((mode === 'interject' || mode === 'engaged') && rawFresh.length > 1) {
      const recentFresh = rawFresh.filter((x) => (nowAt - Number(x.t || 0) <= FRESH_TOPIC_WINDOW_MS) || triggerMemberIds.has(String(x.mid || '')))
      const staleFresh = rawFresh.filter((x) => !recentFresh.includes(x))
      if (recentFresh.length) {
        fresh = recentFresh
        older = [...baseOlder, ...staleFresh].slice(-4)
      } else {
        fresh = rawFresh.slice(-1)
        older = [...baseOlder, ...rawFresh.slice(0, -1)].slice(-4)
      }
    }
    const triggerItem = fresh.findLast?.((x) => triggerMemberIds.has(String(x.mid || ''))) || fresh.at(-1) || null
    const ownerQQ = String(getConfig().ownerQQ || '')
    // 昵称也是不可信原文：群昵称可被改成 `<inner>…</inner>`，它会拼进 `昵称(uid)：正文`
  // 前缀里，绕过「只中和 segments[].data.text」的全部 4 层。所以这里过一遍中和。
  // 同时清洗不可见字符（2026-11-23 事故：群友昵称带 \u200b，导致模型按视觉文本写 <reply:☆> 时严格比对失效）。
  const safeNick = (v) => stripInvisible(neutralizeInboundDsl(String(v ?? ''))).trim() || String(v ?? '')
  const whoOf = (x) => (ownerQQ && String(x.uid) === ownerQQ ? '主人' : `${safeNick(x.nick || x.uid)}(${x.uid})`)
    // 群缓冲里的 x.text 是入站原文，同样必须中和（同 §4.3 防线；否则伪造标签从群聊路径进上下文）。
    // 前情引用**挂在发言人那一块的下方**，用 `↳ 转述` 明确标出「这是别人的话」：
    //   ① 不脱出成提示词末尾的孤立段落（那会造成编号错位，见 2026-11-16 事故）；
    //   ② 也不挤进同一行（那会让模型把转述内容当成发言人自己说的，见 2026-11-20 事故）。
    const block = (x, markTrigger = false) => {
      const text = neutralizeInboundDsl(x.text)
      const tag = markTrigger ? '（← 触发本轮）' : ''
      const head = `${whoOf(x)}${x.at ? '@了你' : ''}${agoLabel(x.t, nowAt)}：${text || (x.quoteNote ? '（本条没有正文，只在转述下面这条）' : '（图片/表情）')}${tag}`
      if (!x.quoteNote) return head
      return `${head}\n    ${neutralizeInboundDsl(x.quoteNote)}`
    }
    const name = groupNames.get(gid) || gid
    const hint = mode === 'interject' ? '（没人叫你。只有你对这个话题真有话说、能自然接上时才插一句：接着话题说，别突然开新话题；接不上就只回 [沉默]）'
      : mode === 'engaged' ? '（你刚才在参与这个话题。想接着聊就接着说，话题和你没关系了或没什么可说的就只回 [沉默]）'
      : '（有人在叫你，看完这一段再回）'
    const refs = {}
    const markMode = mode === 'interject' || mode === 'engaged'
    const numbered = fresh.map((x, i) => {
      // nick 一并存进引用表：模型可以直接写 <reply:昵称> / <reply:QQ号> 而不必算编号
      // （行内有「↳转述」时按名字引用真正说话的人，比数编号不容易挂错人）。
      if (x.mid && x.mid !== '0') refs[i + 1] = { mid: x.mid, uid: x.uid, nick: safeNick(x.nick || x.uid), ...(ownerQQ && String(x.uid) === ownerQQ ? { owner: true } : {}) }
      return `[${i + 1}] ${block(x, markMode && x === triggerItem)}`
    })
    groups.setRefs(gid, refs)
    const timeHead = nowLine(nowAt, previousTurnAt, { what: '上一段消息' })
    const olderText = older.length ? older.map((x) => block(x, false)).join('\n') : ''
    const freshText = numbered.join('\n')
    // 群聊完整协议（整体来回 / ↳ 转述 / <reply:> / <at:>）已一次性放进 L0 协议层，
    // 每轮群消息不再重复粘贴 686 字说明书；仅在当轮真的出现图片占位或转述时附 1 行按需提醒。
    const hasMediaOrPlaceholder = olderText.includes('（图片/表情）')
      || freshText.includes('（图片/表情）')
      || members.some((m) => (m?.segments ?? []).some((s) => s?.type === 'image' || s?.type === 'mface'))
      || fresh.some((x) => Array.isArray(x.images) && x.images.length > 0)
    const hasQuoteRelay = olderText.includes('↳ 转述') || freshText.includes('↳ 转述')
    const tailHints = []
    if (hasMediaOrPlaceholder) {
      tailHints.push('若只看到「图片/表情」占位，或明确提示当前模型看不了图，不得猜图中的人物、动作或内容；可以回应已有文字，没什么可说就只回 [沉默]。')
    }
    if (hasQuoteRelay) {
      tailHints.push('（注：「↳ 转述」是引用别人的原话，原话主人是「↳ 转述」后面写的名字。）')
    }
    const head = (olderText ? `【群聊 ${name}】之前在聊：\n${olderText}\n\n` : '') +
      `【群聊 ${name}】刚才新说的（${fresh.length} 条）${hint}\n${timeHead}\n${freshText}` +
      (tailHints.length ? `\n\n${tailHints.join('\n')}` : '')
    // 触发轮自身的图片一并附上；引用已由 quoteNote 挂在 block(x) 下方，不脱出做孤立段落。
    // 没触发回合的那几条群消息带的图也在这里补：群缓冲里挂着 image 块，否则她只看得到
    // 「（图片/表情）」文字，而触发轮 members 已经没有原始段可拼（真机：群里看不懂表情包）。
    const extras = []
    const seenMedia = new Set()
    let mediaCount = 0
    const addMedia = (block) => {
      const url = String(block?.url || '')
      if (!url || seenMedia.has(url) || mediaCount >= MAX_GROUP_MEDIA) return
      seenMedia.add(url)
      mediaCount++
      extras.push(block)
    }
    for (const m of members) for (const s of (m?.segments ?? [])) {
      if (s?.type === 'image' || s?.type === 'mface') addMedia({ type: 'image', url: String(s.data?.url || s.data?.file || '') })
      // 收进来的文件正文/文件名同属入站原文，同样要中和（§4.3 第四落点在 groupPromptContent）。
      // 注：这一层是**深度防御里的冗余层**——实测摘掉它测试全红不了，因为同一段文本
      // 已在 :759（源头整块中和）中和过、且 neutralizeInboundDsl 幂等，此处的二次调用
      // 结果完全相同。保留它是为了「extras 这一路将来若接入别处原文时仍有兜底」，
      // 不是为了让某项测试变红。真正被断言锁住的是 :759（见 P1-d4/P1-d5）。
      else if (s?.type === 'text' && s.data?.inboundFile) extras.push({ type: 'text', text: neutralizeInboundDsl(String(s.data.text || '')) })
      else if (s?.type === 'json') extras.push({ type: 'text', text: neutralizeInboundDsl(cardText(s.data?.data)) })
      else if (s?.type === 'xml') extras.push({ type: 'text', text: '[卡片消息]' })
      else if (s?.type && !['text', 'reply', 'at', 'forward'].includes(s.type)) extras.push({ type: 'text', text: `\n[${s.type}]\n` })
    }
    // 同一段群里、没单独触发回复的消息也带图：随缓冲条目一起交给模型，最多 4 张。
    // 取完即清，下一段 older 背景里不会把同一张图反复投喂。
    for (const x of fresh) {
      // 触发轮自己的图已在上面从 members 拼过，别按 URL 再补一份。
      if (!triggerMemberIds.has(String(x.mid || ''))) for (const block of x.media || []) addMedia(block)
      delete x.media
    }
    const direct = fresh.filter((x) => x.direct)
    const directSenders = new Set(direct.map((x) => x.uid))
    const target = directSenders.size === 1 ? direct.at(-1) : null
    const autoReply = target ? { mid: target.mid, uid: target.uid } : null
    const triggerReply = triggerItem && triggerItem.mid && triggerItem.mid !== '0'
      ? { mid: triggerItem.mid, uid: triggerItem.uid }
      : null
    const freshLast = fresh.at(-1) || null
    const freshLastAt = Number(freshLast?.t) || nowAt
    const query = fresh.map((x) => x.text).filter(Boolean).join('\n')
    const speakers = [...new Set(fresh.map((x) => String(x.uid)).filter(Boolean))]
    return { blocks: [{ type: 'text', text: head }, ...extras], mode, autoReply, triggerReply, freshLast, freshLastAt, query, speakers, fedItems: rawFresh }
  }

  return { groupPromptContent }
}
