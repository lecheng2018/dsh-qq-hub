// 生图：兼容 OpenAI /v1/images/generations 的服务（硅基流动、通义万相兼容层、本地 ComfyUI / SD WebUI 的 OpenAI 代理……）。
// 地址和密钥由主人在面板里填；生成结果以 base64 交给 QQ 发出。

import { fetchImage } from '../core/net.js'

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
