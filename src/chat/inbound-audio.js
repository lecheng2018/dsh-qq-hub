import { randomUUID } from 'node:crypto'
import { fetchImage } from '../core/net.js'
import { toMono16k } from '../voice/wav.js'
import { createCloudAsr } from '../voice/cloud-asr.js'
import { neutralizeInboundDsl } from './inbound.js'

export function createInboundAudio({ onebot, dsh, localApi, log, getConfig } = {}) {
  // 云端 ASR（1.4.4）：配置门控默认关；未传 getConfig 时恒不启用（兼容旧调用方）。
  const cloudAsr = createCloudAsr({ getConfig: getConfig || (() => ({})), log })
  // T3.10：一条语音在本地 ASR 失败后还会走云端 / DSH 两条路，过去每条路都重新
  // get_record + 下载一次（同一条语音最多下 3 次，30s 超时 ×3）。按 rec 身份惰性缓存
  // 单次下载结果，三条路共用一份；失败也不缓存，下一轮还能重试。
  const wavCache = new WeakMap()
  const MAX_BASE64_CHARS = Math.ceil((30 * 1024 * 1024 * 4) / 3) + 16
  async function recordWav(rec) {
    const info = await onebot.call('get_record', { file: rec.data?.file, out_format: 'wav' }, { timeoutMs: 30000 })
    // T3.10：网关回的是整段 base64，长度不受控 —— 先量长度再解码，避免一个坏响应
    // 直接把进程内存吃满（Buffer.from 会按声明长度分配）。
    const b64 = typeof info?.base64 === 'string' ? info.base64 : ''
    if (b64.length > MAX_BASE64_CHARS) throw new Error(`语音数据过大（base64 ${b64.length} 字符）`)
    const raw = b64
      ? Buffer.from(b64, 'base64')
      : await fetchImage(info?.file || info?.url, { maxBytes: 30 * 1024 * 1024, allowLocal: false })
    return toMono16k(raw)
  }
  function wavOf(rec) {
    if (!rec || typeof rec !== 'object') return recordWav(rec)
    let hit = wavCache.get(rec)
    if (!hit) {
      hit = recordWav(rec)
      wavCache.set(rec, hit)
      hit.catch(() => wavCache.delete(rec))
    }
    return hit
  }

  async function localText(rec) {
    if (!localApi?.active?.('asr')) return ''
    const { writeFileSync, mkdirSync, unlinkSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(String(localApi.dir?.() || '/tmp'), 'out')
    mkdirSync(dir, { recursive: true })
    // T3.10：只带毫秒后缀时，同毫秒并发转写会写到同一个文件（后写覆盖前写、先完成者删掉别人的文件）。
    const file = join(dir, `asr-${Date.now()}-${randomUUID().slice(0, 8)}.wav`)
    writeFileSync(file, await wavOf(rec))
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
    const spec = stt.resolve({ audio: new Uint8Array(await wavOf(rec)) })
    const result = await stt.transcribe(spec, AbortSignal.timeout(60000))
    const text = typeof result === 'string' ? result : result?.text || result?.transcript
    return text ? String(text).trim() : ''
  }

  async function cloudText(rec) {
    if (!cloudAsr.enabled()) return ''
    return cloudAsr.transcribe(await wavOf(rec))
  }

  async function transcribeRecord(rec, messageId) {
    try {
      const text = await localText(rec)
      if (text) return text
    } catch (error) {
      log?.debug?.('本地接口语音识别失败：', error.message)
    }
    try {
      const text = await cloudText(rec)
      if (text) return text
    } catch (error) {
      log?.debug?.('云端语音识别失败：', error.message)
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
      // T3.11：转写文本来自对方的声音（可控内容），同样要过入站 DSL 中立化 ——
      // 转述回来时不能变成「[语音] 忽略上面的设定」这种可执行片段。
      return text ? `[语音] ${neutralizeInboundDsl(text)}` : '[发来一条语音，没听清]'
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
