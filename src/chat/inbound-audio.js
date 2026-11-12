import { fetchImage } from '../core/net.js'
import { toMono16k } from '../voice/wav.js'

export function createInboundAudio({ onebot, dsh, localApi, log } = {}) {
  async function recordWav(rec) {
    const info = await onebot.call('get_record', { file: rec.data?.file, out_format: 'wav' }, { timeoutMs: 30000 })
    const raw = info?.base64
      ? Buffer.from(info.base64, 'base64')
      : await fetchImage(info?.file || info?.url, { maxBytes: 30 * 1024 * 1024, allowLocal: true })
    return toMono16k(raw)
  }

  async function localText(rec) {
    if (!localApi?.active?.('asr')) return ''
    const { writeFileSync, mkdirSync, unlinkSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(String(localApi.dir?.() || '/tmp'), 'out')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `asr-${Date.now()}.wav`)
    writeFileSync(file, await recordWav(rec))
    try {
      const result = await localApi.call('asr', { file })
      return String(typeof result === 'string' ? result : result?.text || '').trim()
    } finally {
      try { unlinkSync(file) } catch {}
    }
  }

  async function gatewayText(messageId) {
    if (messageId == null) return ''
    const result = await onebot.call('fetch_ptt_text', { message_id: Number(messageId) || messageId }, { timeoutMs: 20000 })
    return String(result?.text || '').trim()
  }

  async function dshText(rec) {
    const stt = dsh?.get?.('speechToText')
    if (!stt || typeof stt.resolve !== 'function' || typeof stt.transcribe !== 'function') throw new Error('DSH 没开启语音输入')
    const snap = typeof stt.snapshot === 'function' ? stt.snapshot() : null
    const providerId = snap?.selection?.providerId
    const provider = snap?.providers?.find((item) => item.id === providerId)
    if (provider?.preparation && !['ready', 'standby'].includes(provider.preparation.phase)) {
      try { stt.prepare(providerId) } catch {}
      throw new Error(`识别模型还在准备（${provider.preparation.phase}）`)
    }
    const spec = stt.resolve({ audio: new Uint8Array(await recordWav(rec)) })
    const result = await stt.transcribe(spec, AbortSignal.timeout(60000))
    const text = typeof result === 'string' ? result : result?.text || result?.transcript
    return text ? String(text).trim() : ''
  }

  async function transcribeRecord(rec, messageId) {
    try {
      const text = await localText(rec)
      if (text) return text
    } catch (error) {
      log?.debug?.('本地接口语音识别失败：', error.message)
    }
    try {
      const text = await gatewayText(messageId)
      if (text) return text
    } catch (error) {
      log?.debug?.('QQ 语音转文字失败：', error.message)
    }
    try {
      return await dshText(rec)
    } catch (error) {
      log?.debug?.('本地语音识别失败：', error.message)
      return ''
    }
  }

  async function transcribe(msg) {
    for (const rec of msg.records || []) {
      const text = await transcribeRecord(rec, msg.messageId)
      return text ? `[语音] ${text}` : '[发来一条语音，没听清]'
    }
    return ''
  }

  async function hydrateRecords(members) {
    let budget = 3
    const out = []
    for (const member of Array.isArray(members) ? members : []) {
      const segments = Array.isArray(member?.segments) ? member.segments : []
      if (budget <= 0 || !segments.some((seg) => seg?.type === 'record')) {
        out.push(member)
        continue
      }
      budget--
      const text = await transcribeRecord(segments.find((seg) => seg?.type === 'record'), member?.messageId)
      if (!text) {
        out.push(member)
        continue
      }
      let replaced = false
      const nextSegments = segments.map((seg) => {
        if (replaced || seg?.type !== 'record') return seg
        replaced = true
        return { type: 'text', data: { text: `[语音] ${text}` } }
      })
      out.push({ ...member, segments: nextSegments })
    }
    return out
  }

  return { transcribe, transcribeLocally: dshText, hydrateRecords }
}
