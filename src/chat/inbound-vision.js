import { canSeeImages, describeWithHelper } from '../core/llm.js'

export function createInboundVision({ dsh, log, inboundImages } = {}) {
  async function textFor(images, nickname, cfg, hint) {
    const helper = cfg?.visionHelper
    if (helper?.enabled && helper.provider && helper.model && images.length) {
      try {
        const description = await describeWithHelper(dsh, { images, cfg, hint, log })
        if (description) {
          return `（${nickname} 发了 ${images.length} 张图片。你的模型看不了图，下面由另一个模型看过之后转述给你，别当成你亲眼见过：\n${description}）`
        }
      } catch (error) {
        log?.debug?.('辅助看图失败：', error.message)
      }
    }
    return `（${nickname} 发了 ${images.length} 张图片，你现在的模型看不了图，只能知道有这么回事）`
  }

  async function admit(content, { nickname = '对方', hint = '', cfg } = {}) {
    if (!content.some((block) => block.type === 'image') || (await canSeeImages(dsh, cfg)) !== false) {
      return inboundImages.admit(content)
    }
    const images = []
    const failed = []
    for (const block of content) {
      if (block.type !== 'image') continue
      try { images.push(await inboundImages.read(block)) } catch { failed.push(block) }
    }
    if (!images.length) return inboundImages.admit(content)
    const note = await textFor(images, nickname, cfg, hint)
    const out = content.filter((block) => block.type !== 'image')
    out.push({ type: 'text', text: note })
    for (let i = 0; i < failed.length; i++) {
      out.push({ type: 'text', text: '（对方发来一张图片，但本机没能把它下载下来，这轮看不到）' })
    }
    return out
  }

  return { textFor, admit }
}
