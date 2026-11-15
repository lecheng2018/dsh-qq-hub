// 云端 ASR（1.4.4）：硅基 SenseVoice / OpenAI 兼容 whisper。
// 配置门控默认关；本地接口优先，云端失败落回 QQ 转文字 / DSH 本地识别；密钥不进日志。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCloudAsrConfig, createCloudAsr } from '../src/voice/cloud-asr.js'
import { createInboundAudio } from '../src/chat/inbound-audio.js'
import { buildWav } from '../src/voice/wav.js'

const log = { debug() {}, warn() {} }
const record = { type: 'record', data: { file: 'voice.silk' } }
const extOn = { ext: { voice: { cloudAsrEnabled: true, cloudAsrApiKey: 'secret-k', cloudAsrBaseUrl: 'https://mock/v1', cloudAsrModel: 'SenseVoiceSmall' } } }
const wavB64 = () => buildWav([0, 1, -1], 16000).toString('base64')

test('normalizeCloudAsrConfig：默认关 / 缺 key / 非法地址都返回 null', () => {
  assert.equal(normalizeCloudAsrConfig({}), null)
  assert.equal(normalizeCloudAsrConfig({ cloudAsrEnabled: true }), null)
  assert.equal(normalizeCloudAsrConfig({ cloudAsrEnabled: true, cloudAsrApiKey: 'k', cloudAsrBaseUrl: 'ftp://x' }), null)
  assert.equal(normalizeCloudAsrConfig(null), null)
  const c = normalizeCloudAsrConfig({ cloudAsrEnabled: true, cloudAsrApiKey: 'k' })
  assert.equal(c.baseUrl, 'https://api.siliconflow.cn/v1')
  assert.equal(c.model, 'FunAudioLLM/SenseVoiceSmall')
  assert.equal(c.provider, 'siliconflow')
  assert.equal(normalizeCloudAsrConfig({ cloudAsrEnabled: true, cloudAsrApiKey: 'k', cloudAsrProvider: 'openai', cloudAsrBaseUrl: 'https://x/v1/' }).baseUrl, 'https://x/v1', '尾斜杠去掉')
})

test('transcribe：multipart 结构、鉴权头、模型字段正确，返回识别文本', async () => {
  let req = null
  const asr = createCloudAsr({
    getConfig: () => extOn,
    fetchImpl: async (url, opts) => { req = { url, opts }; return { ok: true, json: async () => ({ text: ' 听见了 ' }) } },
  })
  assert.equal(asr.enabled(), true)
  const wav = buildWav([0, 1, -1], 16000)
  assert.equal(await asr.transcribe(wav), '听见了')
  assert.equal(req.url, 'https://mock/v1/audio/transcriptions')
  assert.equal(req.opts.headers.Authorization, 'Bearer secret-k')
  const ct = req.opts.headers['Content-Type']
  assert.match(ct, /^multipart\/form-data; boundary=/)
  const body = req.opts.body.toString('latin1')
  assert.equal(body.includes('name="model"'), true)
  assert.equal(body.includes('SenseVoiceSmall'), true)
  assert.equal(body.includes('name="file"; filename="audio.wav"'), true)
  assert.equal(req.opts.body.includes(wav), true, 'wav 原样进 body')
  assert.equal(asr.status().lastError, '')
})

test('transcribe：HTTP 失败/网络异常 throw，日志不带 key', async () => {
  const warns = []
  const asr = createCloudAsr({ getConfig: () => extOn, log: { warn: (m) => warns.push(String(m)) }, fetchImpl: async () => ({ ok: false, status: 503 }) })
  await assert.rejects(() => asr.transcribe(Buffer.from('x')), /503/)
  assert.match(asr.status().lastError, /503/)
  const asr2 = createCloudAsr({ getConfig: () => extOn, log: { warn: (m) => warns.push(String(m)) }, fetchImpl: async () => { throw new Error('reset') } })
  await assert.rejects(() => asr2.transcribe(Buffer.from('x')), /reset/)
  assert.equal(warns.some((w) => w.includes('secret-k')), false, '密钥绝不进日志')
})

test('transcribe：超时 abort', async () => {
  const asr = createCloudAsr({
    getConfig: () => extOn, log,
    fetchImpl: (url, opts) => new Promise((_, reject) => { opts.signal.addEventListener('abort', () => reject(new Error('aborted'))) }),
  })
  await assert.rejects(() => asr.transcribe(Buffer.from('x'), { timeoutMs: 30 }), /aborted/)
})

test('未启用时 transcribe 直接 throw，不调 fetch', async () => {
  let called = 0
  const asr = createCloudAsr({ getConfig: () => ({}), fetchImpl: async () => { called += 1; return { ok: true, json: async () => ({}) } } })
  assert.equal(asr.enabled(), false)
  await assert.rejects(() => asr.transcribe(Buffer.from('x')), /未启用/)
  assert.equal(called, 0)
})

// ---------------- 入站链路集成 ----------------

function onebotFixture(calls, { gatewayText = '' } = {}) {
  return {
    async call(action) {
      calls.push(action)
      if (action === 'get_record') return { base64: wavB64() }
      if (action === 'fetch_ptt_text') {
        if (gatewayText) return { text: gatewayText }
        throw new Error('网关不可用')
      }
      throw new Error(`意外调用 ${action}`)
    },
  }
}

test('链路：本地接口失败 → 云端成功（先于 QQ 网关）', async () => {
  const calls = []
  let cloudCalled = 0
  const prevFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    cloudCalled += 1
    assert.match(String(url), /audio\/transcriptions/)
    return { ok: true, json: async () => ({ text: '云端听见了' }) }
  }
  try {
    const audio = createInboundAudio({
      log, getConfig: () => extOn,
      localApi: { active: () => true, dir: () => '/tmp', call: async () => { throw new Error('本地挂了') } },
      dsh: { get: () => null },
      onebot: onebotFixture(calls),
    })
    assert.equal(await audio.transcribe({ messageId: 'm1', records: [record] }), '[语音] 云端听见了')
    assert.equal(cloudCalled, 1)
    assert.equal(calls.includes('fetch_ptt_text'), false, '云端成功就不走网关')
  } finally { globalThis.fetch = prevFetch }
})

test('链路：云端失败 → 落回 QQ 网关转文字', async () => {
  const calls = []
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500 })
  try {
    const audio = createInboundAudio({
      log, getConfig: () => extOn,
      localApi: null,
      dsh: { get: () => null },
      onebot: onebotFixture(calls, { gatewayText: '网关听见了' }),
    })
    assert.equal(await audio.transcribe({ messageId: 'm1', records: [record] }), '[语音] 网关听见了')
    assert.equal(calls.filter((c) => c === 'fetch_ptt_text').length, 1)
  } finally { globalThis.fetch = prevFetch }
})

test('链路：默认关闭时不调云端，行为与旧版一致', async () => {
  const calls = []
  let cloudCalled = 0
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => { cloudCalled += 1; return { ok: true, json: async () => ({ text: 'x' }) } }
  try {
    const audio = createInboundAudio({
      log, getConfig: () => ({}),
      localApi: null,
      dsh: { get: () => null },
      onebot: onebotFixture(calls, { gatewayText: '网关听见了' }),
    })
    assert.equal(await audio.transcribe({ messageId: 'm1', records: [record] }), '[语音] 网关听见了')
    assert.equal(cloudCalled, 0)
    // 不传 getConfig 的旧调用方同样不启用云端
    const legacy = createInboundAudio({ log, localApi: null, dsh: { get: () => null }, onebot: onebotFixture([], { gatewayText: '网关听见了' }) })
    assert.equal(await legacy.transcribe({ messageId: 'm1', records: [record] }), '[语音] 网关听见了')
    assert.equal(cloudCalled, 0)
  } finally { globalThis.fetch = prevFetch }
})
