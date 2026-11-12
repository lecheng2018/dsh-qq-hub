import { segmentBytes } from '../core/net.js'
import { mimeOf } from './inbound.js'

const MAX_BYTES = 8 * 1024 * 1024

export function createInboundImages({ onebot, dsh, log } = {}) {
  async function bytesOf(seg) {
    const buf = await segmentBytes(seg, onebot, { maxBytes: MAX_BYTES })
    const mediaType = mimeOf(buf)
    if (!mediaType.startsWith('image/')) throw new Error(`不是支持的图片类型（${buf.length} 字节，头 ${buf.slice(0, 12).toString('hex')}）`)
    return { data: buf.toString('base64'), mediaType }
  }

  async function admitBytes(url) {
    let buf
    if (url.startsWith('base64://')) buf = Buffer.from(url.slice(9), 'base64')
    else if (/^https?:\/\//i.test(url)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      buf = Buffer.from(await response.arrayBuffer())
    } else throw new Error('不是可下载的 http(s)/base64 地址')
    if (!buf.length) throw new Error('下载到 0 字节')
    if (buf.length > 10 * 1024 * 1024) throw new Error(`图片太大（${Math.round(buf.length / 1024)}KB）`)
    const mediaType = mimeOf(buf)
    return { data: buf.toString('base64'), mediaType }
  }

  async function load(msg) {
    const images = []
    let failed = 0
    const segments = [...(msg.stickers || []), ...(msg.images || [])].slice(0, 4)
    for (const seg of segments) {
      try {
        images.push(await bytesOf(seg))
      } catch (error) {
        failed++
        log?.warn?.(`${msg.chatId} 图片读取失败：${error.message}`)
      }
    }
    return { images, failed }
  }

  function attachments() {
    try { return dsh?.get?.('attachments') ?? null } catch { return null }
  }

  async function admit(content) {
    if (!content.some((block) => block.type === 'image')) return content
    const hydrated = []
    for (const block of content) {
      if (block.type !== 'image' || block.data) {
        hydrated.push(block)
        continue
      }
      try {
        const image = await admitBytes(String(block.url || ''))
        hydrated.push({ type: 'image', ...image, name: 'qq-image' })
      } catch (error) {
        log?.debug?.(`图片下载失败，本轮按看不了图处理：${error?.message || error}`)
        hydrated.push({ type: 'text', text: '（对方发来一张图片，但本机没能把它下载下来，这轮看不到）' })
      }
    }
    if (!hydrated.some((block) => block.type === 'image')) return hydrated
    const service = attachments()
    if (service && typeof service.admitPromptContent === 'function') {
      try { return await service.admitPromptContent(hydrated) } catch (error) {
        log?.debug?.(`图片没登记成附件，本轮按看不了图处理：${error?.message || error}`)
      }
    }
    const text = hydrated.filter((block) => block.type !== 'image').map((block) => block.text ?? '').join('\n').trim()
    const note = '（对方发来一张图片，但本机没能把它登记成附件，本轮按看不到图处理）'
    return [{ type: 'text', text: `${text ? text + '\n' : ''}${note}` }]
  }

  return {
    load,
    admit,
    read: (block) => block.data
      ? { data: String(block.data), mediaType: String(block.mediaType || 'image/png') }
      : admitBytes(String(block.url || '')),
  }
}
