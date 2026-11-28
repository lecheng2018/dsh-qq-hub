import { canSeeImages, describeWithHelper, modelVision } from '../core/llm.js'

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

  /**
   * 本轮实际的「看得到图吗」。
   *
   * 审计 T3.10：过去固定用 cfg 里的默认模型判断（canSeeImages），而这一轮真正跑的
   * 是会话 target（聊天/群各自选的模型，modular-core 已经 resolveTarget 过）。
   * 默认模型能看图、会话模型不能 → 图片照发，回合被模型拒收；
   * 反过来默认模型不能看图、会话模型能 → 白白把图转述成文字，视觉能力形同不存在。
   * cfg.model.vision 是面板显式声明，优先级最高（on/off 直接定死）。
   */
  async function visionOf(cfg, target) {
    const v = cfg?.model?.vision
    if (v === 'on') return true
    if (v === 'off') return false
    if (target?.provider && target?.model) return modelVision(dsh, target.provider, target.model)
    return canSeeImages(dsh, cfg)
  }

  async function admit(content, { nickname = '对方', hint = '', cfg, target = null } = {}) {
    if (!content.some((block) => block.type === 'image') || (await visionOf(cfg, target)) !== false) {
      return inboundImages.admit(content)
    }
    const images = []
    const failed = []
    for (const block of content) {
      if (block.type !== 'image') continue
      try { images.push(await inboundImages.read(block)) } catch { failed.push(block) }
    }
    // 审计 T3.10：一张都没下下来时，过去回落 inboundImages.admit(content) ——
    // 那里会把同样的地址再下载一遍（又一次 15s 超时 × N），最后才发占位。
    // 已经失败过就别重试，直接去掉图片块 + 逐个失败占位。
    if (!images.length) {
      const out = content.filter((block) => block.type !== 'image')
      for (let i = 0; i < failed.length; i++) {
        out.push({ type: 'text', text: '（对方发来一张图片，但本机没能把它下载下来，这轮看不到）' })
      }
      return out
    }
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
