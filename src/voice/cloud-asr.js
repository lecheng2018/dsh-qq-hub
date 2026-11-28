// 云端 ASR（1.4.4）：硅基流动 SenseVoice / OpenAI 兼容 whisper。
// 配置门控默认关；本地接口优先，云端失败自然落回 QQ 转文字 / DSH 本地识别。
// 协议：POST {baseUrl}/audio/transcriptions，multipart(file + model)，Bearer key。
// 零运行时依赖：multipart 手拼，密钥绝不进日志。

const DEFAULT_BASE_BY_PROVIDER = {
  siliconflow: 'https://api.siliconflow.cn/v1',
  openai: 'https://api.openai.com/v1',
}
const DEFAULT_MODEL_BY_PROVIDER = {
  siliconflow: 'FunAudioLLM/SenseVoiceSmall',
  openai: 'whisper-1',
}

/** 面板设置（ext.voice.cloudAsr*）→ 归一配置；未开启/缺 key 返回 null。 */
export function normalizeCloudAsrConfig(ext = {}) {
  const e = ext || {}
  if (e.cloudAsrEnabled !== true) return null
  const apiKey = String(e.cloudAsrApiKey || '').trim()
  if (!apiKey) return null
  const provider = e.cloudAsrProvider === 'openai' ? 'openai' : 'siliconflow'
  const baseUrl = String(e.cloudAsrBaseUrl || '').trim().replace(/\/+$/, '') || DEFAULT_BASE_BY_PROVIDER[provider]
  if (!/^https?:\/\//i.test(baseUrl)) return null
  const model = String(e.cloudAsrModel || '').trim() || DEFAULT_MODEL_BY_PROVIDER[provider]
  return { provider, baseUrl, apiKey, model }
}

export function createCloudAsr({ getConfig, log = console, fetchImpl = globalThis.fetch } = {}) {
  let lastError = ''
  const conf = () => {
    try {
      const c = getConfig() || {}
      return normalizeCloudAsrConfig((c.ext && c.ext.voice) || {})
    } catch { return null }
  }
  function enabled() { return Boolean(conf()) }
  function status() {
    const c = conf()
    return { enabled: Boolean(c), provider: c ? c.provider : '', model: c ? c.model : '', lastError }
  }
  /** wavBuffer：16k 单声道 wav。识别失败 throw（调用方落回本地链路）。 */
  async function transcribe(wavBuffer, { timeoutMs = 30000 } = {}) {
    const c = conf()
    if (!c) throw new Error('云端 ASR 未启用')
    const boundary = `----qqhub-asr-${Date.now().toString(36)}`
    const parts = []
    const field = (name, value) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
    }
    field('model', c.model)
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`))
    parts.push(Buffer.from(wavBuffer))
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
    const body = Buffer.concat(parts)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${c.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal: controller.signal,
      })
      if (!res.ok) {
        let snippet = ''
        try {
          if (typeof res.text === 'function') {
            snippet = String(await res.text() || '').replace(/\s+/g, ' ').trim().slice(0, 160)
          }
        } catch {}
        throw new Error(snippet ? `cloud asr HTTP ${res.status}：${snippet}` : `cloud asr HTTP ${res.status}`)
      }
      const data = await res.json()
      const text = String((data && (data.text || data.result)) || '').trim()
      lastError = ''
      return text
    } catch (error) {
      lastError = String((error && error.message) || error).slice(0, 200)
      log?.warn?.(`云端 ASR 失败，落回本地链路：${lastError}`)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  return { enabled, status, transcribe }
}
