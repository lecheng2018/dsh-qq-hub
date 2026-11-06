// 把一条 OneBot v11 消息事件拆成插件好用的形状。纯函数。

/** 消息段数组（兼容字符串 CQ 码：只取纯文字）。 */
export function segmentsOf(event) {
  const m = event && event.message
  if (Array.isArray(m)) return m.filter((s) => s && typeof s === 'object')
  if (typeof m === 'string') return [{ type: 'text', data: { text: m.replace(/\[CQ:[^\]]*\]/g, '') } }]
  return []
}

/** 这个段是不是「表情包」（不是普通照片）。判定必须严格。 */
export function isStickerSegment(seg) {
  if (!seg || !seg.data) return false
  if (seg.type === 'mface') return true
  if (seg.type !== 'image') return false
  const d = seg.data
  if (String(d.sub_type ?? d.subType ?? '') === '1') return true
  if (d.emoji_id || d.emojiId) return true
  return false
}

/**
 * @param {object} event OneBot 消息事件
 * @param {string|number} selfId 机器人 QQ
 * @returns {{
 *   kind: 'private'|'group', chatId: string, userId: string, groupId: string,
 *   nickname: string, role: string, messageId: string, text: string,
 *   mentioned: boolean, replyId: string, images: object[], stickers: object[], records: object[],
 *   forwards: string[], files: object[],
 * }}
 */
export function parseMessageEvent(event, selfId, { faceName } = {}) {
  const self = String(selfId || event.self_id || '')
  const kind = event.message_type === 'group' ? 'group' : 'private'
  const userId = String(event.user_id ?? event.sender?.user_id ?? '')
  const groupId = kind === 'group' ? String(event.group_id ?? '') : ''
  const sender = event.sender || {}
  let mentioned = false
  let replyId = ''
  const texts = []
  const images = []
  const stickers = []
  const records = []
  const forwards = [] // 合并转发的 id
  const files = [] // 收到的文件（要另外调接口去取下载地址）
  for (const seg of segmentsOf(event)) {
    const d = seg.data || {}
    switch (seg.type) {
      case 'text':
        texts.push(String(d.text ?? ''))
        break
      case 'at':
        if (String(d.qq) === self || d.qq === 'all') mentioned = mentioned || String(d.qq) === self
        else texts.push(`@${d.name || d.qq} `)
        break
      case 'reply':
        replyId = String(d.id ?? '')
        break
      case 'face': {
        // QQ 系统表情按名字给她看（「[捂脸]」），认不出才写「[表情]」
        const name = faceName?.(d.id)
        texts.push(name ? `[${name}]` : d.raw?.faceText || '[表情]')
        break
      }
      case 'image':
      case 'mface':
        if (isStickerSegment(seg)) {
          stickers.push(seg)
          texts.push(d.summary ? `${d.summary}` : '[表情包]')
        } else {
          images.push(seg)
          texts.push('[图片]')
        }
        break
      case 'record':
        records.push(seg)
        break
      case 'video':
        texts.push('[视频]')
        break
      case 'file':
        // 文件本体不在消息里，只有 file_id；要另外调 get_private_file_url / get_group_file_url
        // 去换带时效的下载地址（NapCat 系 5 分钟左右过期，必须拿到就下）。
        files.push(seg)
        texts.push(`[文件 ${d.file_name || d.name || d.file || ''}]`)
        break
      case 'json':
        texts.push(cardText(d.data))
        break
      case 'xml':
        texts.push('[卡片消息]')
        break
      case 'poke':
        texts.push('[戳一戳]')
        break
      case 'forward': {
        // 合并转发：先放个占位，收到后再去拉里面的聊天记录展开
        const id = String(d.id ?? d.res_id ?? d.forward_id ?? '')
        if (id) forwards.push(id)
        texts.push('[合并转发]')
        break
      }
      default:
        break
    }
  }
  const text = texts.join('').replace(/\s+\n/g, '\n').trim()
  return {
    kind,
    chatId: kind === 'group' ? `group:${groupId}` : `private:${userId}`,
    userId,
    groupId,
    nickname: String(sender.card || sender.nickname || userId),
    role: String(sender.role || ''),
    messageId: String(event.message_id ?? ''),
    text,
    mentioned,
    replyId,
    images,
    stickers,
    records,
    forwards,
    files,
  }
}

/** 偷表情的尺寸兜底（拿到字节、宽高之后再判）。 */
/** 偷表情的尺寸与体积判定（支持动图/静图双轨制）。 */
export function stickerSizeOk({ width, height, bytes, mime }, limits = {}) {
  const maxSide = limits.maxSide ?? 1920
  const isGif = Boolean(limits.isGif || mime === 'image/gif')
  // 静态表情默认上限 5MB，GIF 动图允许放宽至 10MB
  const defaultBytes = isGif ? (10 * 1024 * 1024) : (5 * 1024 * 1024)
  const maxBytes = limits.maxBytes ?? defaultBytes
  if (!(bytes > 0) || bytes > maxBytes) return false
  if (!(width > 0) || !(height > 0)) return true // 读不出尺寸就只看体积
  if (width > maxSide || height > maxSide) return false
  const r = width / height
  // GIF 经常带字幕或宽条比例，放宽至 0.4 ~ 2.5；静态表情放宽至 0.6 ~ 1.6
  if (isGif) return r >= 0.4 && r <= 2.5
  return r >= 0.6 && r <= 1.6
}

/** 从图片字节里读宽高（PNG / GIF / JPEG / WEBP），读不出返回 0。 */
export function imageSize(buf) {
  try {
    if (!buf || buf.length < 24) return { width: 0, height: 0 }
    if (buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    if (buf[0] === 0x47 && buf[1] === 0x49) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) {
      const chunk = buf.toString('ascii', 12, 16)
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21)
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
      }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue }
        const marker = buf[i + 1]
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        }
        i += 2 + len
      }
    }
  } catch (error) {}
  return { width: 0, height: 0 }
}

/** QQ 分享卡片（B 站 / 链接分享）里认出标题和链接；认不出就是「[卡片消息]」。 */
export function cardText(raw) {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw
    const meta = j?.meta || {}
    const m = meta.detail_1 || meta.news || meta.music || Object.values(meta)[0] || {}
    const title = String(m.desc || m.title || j.prompt || '').trim()
    const url = String(m.qqdocurl || m.jumpUrl || m.url || '').split('?')[0]
    const from = String(m.title && m.desc ? m.title : m.tag || '').trim()
    if (!title && !url) return '[卡片消息]'
    return `[分享卡片${from ? '（' + from + '）' : ''}：${title}${url ? ' ' + url : ''}]`
  } catch (error) {
    return '[卡片消息]'
  }
}

/**
 * 从字节里认图片类型。认不出返回 'application/octet-stream'。
 * QQ 表情包常见 webp（动图）、png、gif；部分 OneBot 实现还会回 bmp / apng / avif。
 * 注意 WEBP 的前 4 字节是 'RIFF'，第 9~12 字节才是 'WEBP'，所以必须看 buf[8..12]。
 */
export function mimeOf(buf) {
  if (!buf || buf.length < 12) return 'application/octet-stream'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp' // 'BM'
  // AVIF / HEIF：第 4~8 字节是 'ftyp'
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1') return 'image/heic'
  }
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x2a)) return 'image/tiff'
  return 'application/octet-stream'
}
