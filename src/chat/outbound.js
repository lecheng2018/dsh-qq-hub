import { readFileSync } from 'node:fs'
import { createFaces, textToSegments, stripFaceTags, speakableText, dedupeFaces } from './faces.js'
import { expandMentions, hasMention } from './mentions.js'
import { fetchImage } from '../core/net.js'

// 回复发送所需的 OneBot 段编排；物理发送只经注入的 Shared Outbox。
export function createOutbound({ getConfig, log, onebot, outbox, groups, stickers, tts, interaction, hooks, onStats, deliveryContext }) {
  const faces = createFaces({ onebot, log })
  const quote = (replyId) => (replyId ? [{ type: 'reply', data: { id: String(replyId) } }] : [])
  const mention = (userId, segs = []) => (userId && !segs.some((s) => s.type === 'at' && String(s.data?.qq) === String(userId)) ? [{ type: 'at', data: { qq: String(userId) } }, { type: 'text', data: { text: ' ' } }] : [])

  async function membersOf(groupId) {
    const hit = groups.cachedMembers(groupId)
    if (hit) return hit
    try {
      const result = await onebot.call('get_group_member_list', { group_id: Number(groupId) }, { timeoutMs: 15000 })
      const list = Array.isArray(result) ? result : result?.data || []
      groups.setMembers(groupId, list)
      return list
    } catch (error) {
      log.debug('拉群成员失败，@ 按文字发：', error.message)
      return groups.staleMembers(groupId)
    }
  }

  async function textSegments(chatId, text, missed) {
    let body = text
    if (getConfig().stickers?.faces) {
      const d = dedupeFaces(body, interaction.facesUsed(chatId))
      if (d.text !== body) {
        body = d.text
        if (!body) return { body, segs: [] }
      }
      interaction.rememberFaces(chatId, d.used)
    }
    let segs = getConfig().stickers?.faces ? textToSegments(body, faces.idOf) : [{ type: 'text', data: { text: stripFaceTags(body) } }]
    if (chatId.startsWith('group:') && hasMention(body)) segs = expandMentions(segs, await membersOf(chatId.slice(6)), missed)
    if (!segs.length || (segs.length === 1 && segs[0].type === 'text' && !segs[0].data.text.trim())) segs = []
    return { body, segs }
  }

  async function sendSegments(chatId, message, note, { force = false, onResult } = {}) {
    if (hooks?.send) {
      try {
        const next = await hooks.send(message, { chatId, note, force })
        if (next === null) return null
        if (Array.isArray(next)) message = next
      } catch (error) {
        log.warn('扩展模块改写发送内容出错：', error.message)
      }
    }
    try {
      const result = await outbox.request({ chatKey: chatId, sourceModuleId: 'core', segments: message, note, force, _outboxTicket: deliveryContext?.getStore()?.ticket })
      if (result?.state !== 'sent') {
        onResult?.({ ok: false, unknown: result?.state === 'unknown', error: result?.reason ? new Error(result.reason) : undefined })
        return null
      }
      onStats?.('sent')
      onResult?.({ ok: true, result: result.raw ?? result })
      return result.raw ?? result
    } catch (error) {
      onStats?.('errors')
      onResult?.({ ok: false, unknown: error?.unknown === true, error })
      return null
    }
  }

  async function sendText(chatId, text, replyId, missed, userId) {
    const { body, segs } = await textSegments(chatId, text, missed)
    if (!segs.length) return null
    return sendSegments(chatId, [...quote(replyId), ...mention(userId, segs), ...segs], (replyId ? '[引用] ' : '') + body.slice(0, 60))
  }

  async function sendVoice(chatId, text, replyId, userId) {
    let outcome = null
    try {
      const spoken = speakableText(text)
      if (!spoken) throw new Error('这条语音里只有表情/符号，没有能念的字')
      const { file, engine } = await tts.speak(spoken)
      const b64 = readFileSync(file).toString('base64')
      if (replyId || userId) log.debug(`语音条不能带引用/@（QQ 限制），单独发：${chatId}`)
      const result = await sendSegments(chatId, [{ type: 'record', data: { file: 'base64://' + b64 } }], `[语音·${engine}] ${text.slice(0, 40)}`, { onResult: (value) => { outcome = value } })
      if (result || getConfig().dryRun || !getConfig().enabled) onStats?.('voice')
      if (!result && getConfig().enabled && !getConfig().dryRun) {
        const error = new Error('网关没接受语音')
        error.unknown = outcome?.unknown === true
        throw error
      }
      return true
    } catch (error) {
      if (error?.unknown) {
        log.warn(`语音发送状态未知（可能已发出），不改发文字：${chatId}`)
        return false
      }
      log.warn('语音没发出去，改发文字：', error.message)
      await sendText(chatId, text, replyId, undefined, userId)
      return false
    }
  }

  async function sendSticker(chatId, query, replyId, userId) {
    if (!getConfig().stickers?.enabled) return false
    const item = query && typeof query === 'object' ? query : stickers.match(query)
    if (!item) return false
    const seg = stickers.segmentFor(item)
    if (!seg) return false
    await sendSegments(chatId, [...quote(replyId), ...mention(userId), seg], `[表情] ${item.name || item.md5.slice(0, 8)}`)
    stickers.markUsed?.(item.md5)
    onStats?.('stickers')
    return true
  }

  async function sendImage(chatId, src, replyId, userId) {
    try {
      const buf = await fetchImage(src, { maxBytes: 10 * 1024 * 1024, allowLocal: true })
      return sendSegments(chatId, [...quote(replyId), ...mention(userId), { type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], `[图片] ${src.slice(-40)}`)
    } catch (error) {
      log.warn('图片发不出去：', error.message)
      return null
    }
  }

  async function sendMixed(chatId, parts, replyId, missed, userId) {
    const segs = []
    const used = []
    for (const part of parts) {
      if (part.kind === 'text') {
        const prepared = await textSegments(chatId, part.value, missed)
        segs.push(...prepared.segs)
      } else if (part.kind === 'image') {
        try {
          const buf = await fetchImage(part.value, { maxBytes: 10 * 1024 * 1024, allowLocal: true })
          segs.push({ type: 'image', data: { file: 'base64://' + buf.toString('base64') } })
        } catch (error) { log.warn('图片发不出去：', error.message) }
      } else if (part.kind === 'voice') {
        await sendVoice(chatId, part.value, part.replyTo, undefined)
      } else if (part.kind === 'sticker' && getConfig().stickers?.enabled) {
        const item = part.value && typeof part.value === 'object' ? part.value : stickers.match(part.value)
        const seg = item && stickers.segmentFor(item)
        if (seg) { segs.push(seg); used.push(item) }
      }
    }
    if (!segs.length) return null
    const note = parts.map((part) => part.kind === 'text' ? part.value : `[${part.kind}]`).join(' ').slice(0, 60)
    const result = await sendSegments(chatId, [...quote(replyId), ...mention(userId, segs), ...segs], note)
    for (const item of used) { stickers.markUsed?.(item.md5); onStats?.('stickers') }
    return result
  }

  async function pokeBack(chatId) {
    const target = interaction.pokeBackTarget(chatId)
    if (!target) return
    const group = chatId.startsWith('group:') ? chatId.slice(6) : ''
    try {
      await outbox.request({
        chatKey: chatId,
        action: 'send_poke',
        params: { user_id: Number(target), ...(group ? { group_id: Number(group) } : {}) },
        opts: { timeoutMs: 10000 },
        receipt: 'optional',
        note: `戳了戳 ${target}`,
        sourceModuleId: 'core',
        _outboxTicket: deliveryContext?.getStore()?.ticket,
      })
    } catch (error) {
      log.debug('戳一戳失败：', error.message)
    }
  }

  return { sendText, sendVoice, sendSticker, sendImage, sendMixed, pokeBack }
}
