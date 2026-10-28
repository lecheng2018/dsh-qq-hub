// 生图：兼容 OpenAI /v1/images/generations 的服务（硅基流动、通义万相兼容层、本地 ComfyUI / SD WebUI 的 OpenAI 代理……）。
// 地址和密钥由主人在面板里填；生成结果以 base64 交给 QQ 发出。

import { fetchImage } from '../core/net.js'
import { mimeOf } from '../chat/inbound.js'
import { findFfmpeg, shrinkImage } from '../core/img.js'

// 工具结果里带的图超过这个大小就先缩一下：2MB 的图直接塞进上下文会把下一轮请求搞挂
const TOOL_IMAGE_MAX_BYTES = 500 * 1024

export function createImageGen({ getConfig, log, local }) {
  async function generate(prompt) {
    const c = getConfig().imageGen
    // 本地接口接管：用用户自己电脑上的画图服务
    if (local?.active('image')) {
      const { toImageBuffer } = await import('../local/local.js')
      const t = Date.now()
      const buf = await toImageBuffer(await local.call('image', { prompt: [c.stylePrompt, prompt].filter(Boolean).join('，'), size: c.size }))
      log.info(`本地画好了一张图（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
      return buf
    }
    if (!c.enabled) throw new Error('生图还没开启')
    const base = String(c.baseUrl || '').replace(/\/+$/, '')
    if (!base || !c.model) throw new Error('还没填生图服务地址或模型')
    const full = [c.stylePrompt, prompt].filter(Boolean).join('，')
    const headers = { 'content-type': 'application/json' }
    if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`
    const t = Date.now()
    const r = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: c.model, prompt: full, size: c.size, n: 1, response_format: 'b64_json', image_size: c.size }),
      signal: AbortSignal.timeout(180000),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j?.error?.message || j?.message || `HTTP ${r.status}`)
    const item = (j.data || j.images || [])[0] || {}
    let buf
    if (item.b64_json) buf = Buffer.from(item.b64_json, 'base64')
    else if (item.url) buf = await fetchImage(item.url, { maxBytes: 20 * 1024 * 1024, allowLocal: false })
    else throw new Error('生图服务没有返回图片')
    log.info(`画好了一张图（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
    return buf
  }
  return { generate, enabled: () => Boolean(local?.active('image') || (getConfig().imageGen.enabled && getConfig().imageGen.baseUrl && getConfig().imageGen.model)) }
}

/**
 * qq_draw_image 工具结果里那句话。
 * 看不了图时要如实说，否则她会照着提示词编画面细节 —— 主人以为她看见了，其实全是猜的。
 * （不带文件路径：知道路径她就会自己去读图，绕开「不给看」的判断。）
 */
export function drawToolMessage ({ visual = false } = {}) {
  return visual ? '画好发出去了' : '画好发出去了，但这次没能把图片交给你看；别描述画面里有什么'
}

/**
 * qq_draw_image 的工具结果怎么渲染：一行文字 +（有图时）image 块。
 * image 一般是 DSH 附件块（imageToolBlock() 登记过的），原样透传；没图就只回文字。
 */
export function drawResultBlocks (_args, value) {
  const text = value && value.ok === false ? '✗ ' + (value.message || '没成功') : (value && value.message) || '✓'
  const blocks = [{ type: 'text', text }]
  const img = value && value.image
  if (img && img.attachment) blocks.push({ ...img, type: 'image' })
  return blocks
}

/**
 * 工具结果里要带的那张图：太大的先缩图，再交给 DSH 的附件服务登记成附件块。
 * ⚠ 必须走附件服务：模型适配层只认附件块，把 base64 直接塞进工具结果会让下一轮请求整轮失败
 * （实测 2MB 的 PNG 直接塞进去 → "DeepSeek Messages transport failed"，重试 5 次全挂）。
 * 缩图或登记失败都返回 null —— 只给文字，宁可少给也不要崩。
 */
export async function imageToolBlock (dsh, buf, { ffmpegPath = '', maxSide = 1024, maxBytes = TOOL_IMAGE_MAX_BYTES } = {}) {
  if (!dsh) return null
  let data = buf
  let mediaType = mimeOf(buf)
  if (buf.length > maxBytes) {
    const ffmpeg = findFfmpeg(ffmpegPath)
    const small = ffmpeg ? await shrinkImage(buf, maxSide, ffmpeg) : null
    if (!small || small.length > maxBytes) return null
    data = small
    mediaType = 'image/jpeg'
  }
  const att = dsh.attachments || (typeof dsh.get === 'function' ? dsh.get('attachments') : null)
  if (!att || typeof att.admitPromptContent !== 'function') return null
  try {
    const [block] = await att.admitPromptContent([{ type: 'image', data: data.toString('base64'), mediaType }])
    if (block && block.type === 'image' && block.attachment) return block
  } catch (error) {}
  return null
}
