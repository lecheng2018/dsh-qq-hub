// 云端语音引擎（豆包语音 2.0 / 阿里百炼 qwen-tts / 小米 MiMo）：本地起假服务，看它发了什么、
// 又把什么当音频收下来；不联网。语义移植上游社区模块（aurabot mods 的 voice / qwen-tts / aura-mimo）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 云元数据服务的公开已知地址（链路本地保留段），这里只当作「必须被拒的下载目标」，
// 不是本机地址。集中成常量，避免同一个保留地址在多处散落。
const METADATA_URL = 'http://169.254.169.254/latest/meta-data/' // pii-scan:ignore

// 生成的音频别落到主人真实的语音缓存里
const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-cloud-tts-'))
process.env.AURABOT_DATA_DIR = dataDir

const tts = await import('../src/voice/tts.js')
const { doubaoSynth, qwenSynth, mimoSynth, fixStreamingWav, parseQwenTone, splitQwenText, inferDoubaoEmotion } = tts

// 一个最小合法 WAV（44 字头 + 少量数据），豆包流式分片就用它当 payload
function tinyWav(dataLen = 200) {
  const pcm = Buffer.alloc(dataLen, 0x11)
  const out = Buffer.alloc(44 + dataLen)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + dataLen, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(24000, 24)
  out.writeUInt32LE(24000 * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(dataLen, 40)
  pcm.copy(out, 44)
  return out
}

const hits = []
let respond = () => {}
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), host: req.headers.host })
    respond(res)
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`

after(() => {
  server.close()
  rmSync(dataDir, { recursive: true, force: true })
})

// ---------- 纯函数 ----------

test('fixStreamingWav：回填 0xFFFFFFFF 的 RIFF/data 长度', () => {
  const wav = tinyWav(300)
  wav.writeUInt32LE(0xffffffff, 4)
  wav.writeUInt32LE(0xffffffff, 40)
  const fixed = fixStreamingWav(wav)
  assert.equal(fixed.readUInt32LE(4), fixed.length - 8)
  const dataPos = fixed.indexOf(Buffer.from('data'))
  assert.equal(fixed.readUInt32LE(dataPos + 4), fixed.length - dataPos - 8)
  // 非 WAV 原样返回
  const plain = Buffer.from('不是wav')
  assert.deepEqual([...fixStreamingWav(plain)], [...plain])
})

test('inferDoubaoEmotion：按关键词给语气指令，没命中给空', () => {
  assert.equal(inferDoubaoEmotion('哈哈哈哈笑死我了'), '用开心、轻快、带笑意的语气说这句话')
  assert.equal(inferDoubaoEmotion('今天天气不错'), '')
})

test('parseQwenTone：【语气】标记拆出正文和描述，表外标记不动', () => {
  const a = parseQwenTone('【撒娇】行吧')
  assert.equal(a.text, '行吧')
  assert.match(a.instruction, /撒娇/)
  const b = parseQwenTone('[zzz] 原样保留')
  assert.equal(b.text, '[zzz] 原样保留')
  assert.equal(b.instruction, '')
})

test('splitQwenText：长文本按句末标点切段，单句超长硬切', () => {
  assert.deepEqual(splitQwenText('短文本'), ['短文本'])
  const long = '第一句。'.repeat(60) // 240 字
  assert.equal(splitQwenText(long, 100).length, 3)
  const hard = '无标点'.repeat(120) // 360 字无标点
  const parts = splitQwenText(hard, 300)
  assert.equal(parts.length, 2)
  assert.ok(parts[0].length <= 300)
})

// ---------- 豆包语音 2.0 ----------

test('doubaoSynth：POST v3 unidirectional，NDJSON 分片拼成 WAV，自动配语气', async () => {
  hits.length = 0
  const wav = tinyWav(500)
  const chunk1 = wav.subarray(0, 200).toString('base64')
  const chunk2 = wav.subarray(200).toString('base64')
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'x-tt-logid': 'log-1' })
    res.end(`{"code":0,"data":"${chunk1}"}\n{"code":0,"data":"${chunk2}"}\n`)
  }
  const file = await doubaoSynth('今天太开心啦！', { apiKey: 'k-1', speaker: 'S_TEST', speechRate: -10, contextTexts: '放慢一点', endpoint: base + '/api/v3/tts/unidirectional' })
  const h = hits[0]
  assert.equal(h.method, 'POST')
  assert.equal(h.url, '/api/v3/tts/unidirectional')
  assert.equal(h.headers['x-api-key'], 'k-1')
  assert.equal(h.headers['x-api-resource-id'], 'seed-icl-2.0')
  const body = JSON.parse(h.body)
  assert.equal(body.user.uid, 'dsh-qq-hub')
  assert.equal(body.req_params.text, '今天太开心啦！')
  assert.equal(body.req_params.speaker, 'S_TEST')
  assert.equal(body.req_params.audio_params.speech_rate, -10)
  // 固定指令 + autoEmotion 命中「开心」各一条
  assert.deepEqual(body.req_params.context_texts, ['放慢一点', '用开心、轻快、带笑意的语气说这句话'])
  assert.ok(file.endsWith('.wav'))
  assert.ok(existsSync(file))
  // 拼接后的音频和原始 WAV 完全一致（分片 base64 解码后 concat）
  assert.equal(readFileSync(file).length, wav.length)
})

test('doubaoSynth：HTTP 错误带 logid；没填 Key 明确报错', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(403, { 'x-tt-logid': 'log-9' }); res.end('forbidden') }
  await assert.rejects(() => doubaoSynth('嗨', { apiKey: 'k-1', endpoint: base + '/api/v3/tts/unidirectional' }), /403[\s\S]*log-9/)
  await assert.rejects(() => doubaoSynth('嗨', { endpoint: base + '/api/v3/tts/unidirectional' }), /API Key/)
})

test('doubaoSynth：分片里夹错误行不致命，全空则报「没返回音频」', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200); res.end('{"code":55000000,"message":"bad speaker"}\n') }
  await assert.rejects(() => doubaoSynth('嗨', { apiKey: 'k', endpoint: base + '/api/v3/tts/unidirectional' }), /没返回音频[\s\S]*55000000/)
})

// ---------- 阿里百炼 qwen-tts ----------

test('qwenSynth：POST SpeechSynthesizer → 取 output.audio.url → 落盘；instruction 合并语气标记', async () => {
  hits.length = 0
  const wav = tinyWav(1000)
  let step = 0
  respond = (res) => {
    step++
    if (step === 1) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ output: { audio: { url: `${base}/audio-file-1.wav` } } })) }
    else { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav) }
  }
  const file = await qwenSynth('【开心】今天也超棒！', {
    apiKey: 'sk-1', baseUrl: `${base}/compatible-mode/v1`, model: 'qwen-audio-3.1-tts-flash', voice: 'Cherry',
    instruction: '用日常聊天的语气', sampleRate: 24000,
  })
  // 第一次 POST 到 SpeechSynthesizer（baseUrl 只取到域名）
  const post = hits[0]
  assert.equal(post.method, 'POST')
  assert.equal(post.url, '/api/v1/services/audio/tts/SpeechSynthesizer')
  assert.equal(post.headers.authorization, 'Bearer sk-1')
  const body = JSON.parse(post.body)
  assert.equal(body.model, 'qwen-audio-3.1-tts-flash')
  assert.equal(body.input.voice, 'Cherry')
  assert.equal(body.input.format, 'wav')
  assert.equal(body.input.sample_rate, 24000)
  // 语气基底 + 【开心】的描述拼在一起
  assert.match(body.input.instruction, /日常聊天/)
  assert.match(body.input.instruction, /这一句很高兴/)
  // 第二次 GET 下载音频
  assert.equal(hits[1].method, 'GET')
  assert.equal(hits[1].url, '/audio-file-1.wav')
  assert.ok(file.endsWith('.wav'))
  assert.equal(readFileSync(file).length, wav.length)
})

test('qwenSynth：长文本切两段 → 两次合成 → 拼成一个 WAV；模型挂了报第几段', async () => {
  hits.length = 0
  const wav1 = tinyWav(1200)
  const wav2 = tinyWav(1600)
  let step = 0
  respond = (res) => {
    step++
    if (step % 2 === 1) { res.writeHead(200); res.end(JSON.stringify({ output: { audio: { url: `${base}/seg-${step}.wav` } } })) }
    else { res.writeHead(200); res.end(step === 2 ? wav1 : wav2) }
  }
  const long = '第一句话挺长的呀。'.repeat(40) // > 300 字
  const file = await qwenSynth(long, { apiKey: 'sk-1', baseUrl: base, maxCharsPerSegment: 300 })
  const posts = hits.filter((h) => h.method === 'POST')
  assert.equal(posts.length, 2, '两段各合成一次')
  assert.notEqual(posts[0].body, posts[1].body, '两段文字不同')
  assert.ok(file.endsWith('.wav'))
  // 拼接后的 PCM 长度 = 两段 data 之和
  const merged = readFileSync(file)
  assert.equal(merged.length, 44 + 1200 + 1600)
})

test('qwenSynth：单段也重打包 WAV 头（百炼返回的 data 长度字段不可信）', async () => {
  hits.length = 0
  const wav = tinyWav(1200)
  wav.writeUInt32LE(0x7fffff9b, 40) // 百炼真实返回里见过的坏 data 长度
  let step = 0
  respond = (res) => {
    step++
    if (step === 1) { res.writeHead(200); res.end(JSON.stringify({ output: { audio: { url: `${base}/one.wav` } } })) }
    else { res.writeHead(200); res.end(wav) }
  }
  const file = await qwenSynth('一句话', { apiKey: 'sk-1', baseUrl: base })
  const saved = readFileSync(file)
  assert.equal(saved.readUInt32LE(40), saved.length - 44, 'data 长度按真实字节回填')
  assert.equal(saved.readUInt32LE(4), saved.length - 8, 'RIFF 长度也回填')
})

test('qwenSynth：401 给人话报错；没填 Key 明确报错', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(401); res.end('{"code":"InvalidApiKey"}') }
  await assert.rejects(() => qwenSynth('嗨', { apiKey: 'bad' }), /不认这个 API Key/)
  await assert.rejects(() => qwenSynth('嗨', {}), /API Key/)
})

// ---------- 小米 MiMo ----------

test('mimoSynth：复刻模型带参考音频 data URI，messages 带种子与风格，音频落盘', async () => {
  hits.length = 0
  const refPath = join(dataDir, 'ref-sample.wav')
  writeFileSync(refPath, tinyWav(120))
  const wav = tinyWav(700)
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { audio: { data: wav.toString('base64') } } }] }))
  }
  const file = await mimoSynth('今天也要元气满满哦', {
    apiKey: 'sk-mimo', apiBase: `${base}/v1`, model: 'mimo-v2.5-tts-voiceclone',
    stylePrompt: '元气少女音', seedText: '这是参考音频里说的话', refAudio: refPath,
  })
  const h = hits[0]
  assert.equal(h.method, 'POST')
  assert.equal(h.url, '/v1/chat/completions')
  assert.equal(h.headers.authorization, 'Bearer sk-mimo')
  const body = JSON.parse(h.body)
  assert.equal(body.model, 'mimo-v2.5-tts-voiceclone')
  assert.equal(body.audio.format, 'wav')
  // messages：种子一句 user，正文一句 assistant（带 <style> 包裹）
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant'])
  assert.equal(body.messages[0].content, '这是参考音频里说的话')
  assert.match(body.messages[1].content, /<style>元气少女音<\/style>今天也要元气满满哦/)
  // audio.voice 是参考音频的 data URI
  assert.match(body.audio.voice, /^data:audio\/wav;base64,/)
  assert.ok(body.audio.voice.length > 100)
  assert.ok(file.endsWith('.wav'))
  assert.equal(readFileSync(file).length, wav.length)
})

test('mimoSynth：voicedesign 模型用音色描述，不带 audio.voice；参考音频缺失明确报错', async () => {
  hits.length = 0
  const wav = tinyWav(300)
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { audio: { data: wav.toString('base64') } } }] }))
  }
  const file = await mimoSynth('你好呀', { apiKey: 'sk-mimo', apiBase: `${base}/v1`, model: 'mimo-v2.5-tts-voicedesign', stylePrompt: '温柔的女声' })
  const body = JSON.parse(hits[0].body)
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant'])
  assert.equal(body.messages[0].content, '温柔的女声')
  assert.equal(body.audio.voice, undefined)
  assert.ok(existsSync(file))
  await assert.rejects(() => mimoSynth('你好', { apiKey: 'sk', model: 'mimo-v2.5-tts-voiceclone' }), /参考音频/)
  await assert.rejects(() => mimoSynth('你好', { apiKey: '', model: 'mimo-v2.5-tts-voiceclone', refAudio: '/x.wav' }), /API Key/)
})

test('mimoSynth：参考音频超过 15MB 拒绝（防整段音频塞进请求体）', async () => {
  hits.length = 0
  const big = join(dataDir, 'ref-big.wav')
  const fd = openSync(big, 'w')
  writeSync(fd, Buffer.alloc(15 * 1024 * 1024 + 1, 0x22))
  closeSync(fd)
  respond = () => { res.writeHead(200); res.end() }
  await assert.rejects(() => mimoSynth('你好', { apiKey: 'sk', refAudio: big }), /太大/)
  rmSync(big, { force: true })
})

// ---------- 密钥登记（掩码 + 留空保存保留原值）----------

test('三个云端引擎的 API Key 都进了 SECRETS：面板拿不到明文，空保存不抹值', async () => {
  const config = await import('../src/core/config.js')
  const fake = structuredClone(config.DEFAULTS.voice)
  fake.doubao.apiKey = 'secret-doubao'
  fake.qwentts.apiKey = 'secret-qwen'
  fake.mimo.apiKey = 'secret-mimo'
  const full = config.normalize({ voice: fake })
  const pub = config.publicConfig(full)
  assert.equal(pub.voice.doubao.apiKey, '', '豆包 Key 不回传明文')
  assert.equal(pub.voice.qwentts.apiKey, '', '百炼 Key 不回传明文')
  assert.equal(pub.voice.mimo.apiKey, '', 'MiMo Key 不回传明文')
  assert.equal(pub.voice.doubao.apiKeySet, true)
  assert.equal(pub.voice.qwentts.apiKeySet, true)
  assert.equal(pub.voice.mimo.apiKeySet, true)
  // 面板空保存：原值保留
  const merged = config.mergeFromPanel(full, { voice: { doubao: { apiKey: '' }, qwentts: { apiKey: '' }, mimo: { apiKey: '' } } })
  assert.equal(merged.voice.doubao.apiKey, 'secret-doubao')
  assert.equal(merged.voice.qwentts.apiKey, 'secret-qwen')
  assert.equal(merged.voice.mimo.apiKey, 'secret-mimo')
})

// ---------- 部署测试发现的问题回归：normalize 的引擎白名单要认新引擎 ----------

test('normalize：voice.engine 白名单放行 doubao / qwentts / mimo（部署实测曾被打回 auto）', async () => {
  const config = await import('../src/core/config.js')
  for (const engine of ['doubao', 'qwentts', 'mimo']) {
    const c = config.normalize({ voice: { engine } })
    assert.equal(c.voice.engine, engine, engine)
  }
  assert.equal(config.normalize({ voice: { engine: 'unknown-engine' } }).voice.engine, 'auto', '未知引擎仍回 auto')
})

// 审计 S10：二次下载的目的地策略。audioUrl 来自 API 响应（半可信），被篡改的响应
// 可能把下载引去任意地址（含内网）。但「与接口同源」**不是**官方契约——百炼官方文档
// 的响应就是跨域的：请求打 dashscope.aliyuncs.com，output.audio.url 指向
// dashscope-result-bj.oss-cn-beijing.aliyuncs.com（完整文件 URL，24 小时有效）。
// 所以按供应商语义分域判：官方 baseUrl 只认官方结果桶，自建服务仍按 origin 绑定。

test('qwenSynth：官方 baseUrl + 官方 OSS 音频域能正常合成（S10 跨域是正常契约）', async () => {
  hits.length = 0
  const wav = tinyWav(2000)
  // 用 fetch 桩模拟官方跨域响应：合成接口在 dashscope 域，音频在 OSS 结果域
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(String(url))
    if (String(url).includes('SpeechSynthesizer')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          status_code: 200,
          output: { audio: { url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/1d/ab/x.wav?Expires=1&Signature=s', id: 'audio_x', expires_at: 1 } },
        }),
      }
    }
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.length) }
  }
  try {
    const file = await qwenSynth('你好', {
      apiKey: 'sk-1', baseUrl: 'https://dashscope.aliyuncs.com',
      model: 'qwen-audio-3.1-tts-flash', voice: 'Cherry',
    })
    assert.ok(existsSync(file), '官方跨域响应必须能落成音频文件')
    assert.ok(seen.some((u) => u.includes('dashscope-result-bj.oss-cn-beijing.aliyuncs.com')), '应真的去下载 OSS 上的音频')
  } finally { globalThis.fetch = realFetch }
})

test('qwenSynth：官方 baseUrl 但音频域不是官方结果桶 → 拒绝（S10 首次下载校验）', async () => {
  hits.length = 0
  const realFetch = globalThis.fetch
  let downloaded = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('SpeechSynthesizer')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ output: { audio: { url: METADATA_URL } } }) }
    }
    downloaded++
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => tinyWav(2000).buffer }
  }
  try {
    await assert.rejects(
      () => qwenSynth('你好', { apiKey: 'sk-1', baseUrl: 'https://dashscope.aliyuncs.com', model: 'qwen-audio-3.1-tts-flash', voice: 'Cherry' }),
      /不是百炼官方结果域/,
      '被篡改的响应把下载指向内网元数据地址，必须拒绝',
    )
    assert.equal(downloaded, 0, '拒绝必须发生在发出下载 GET 之前')
  } finally { globalThis.fetch = realFetch }
})

test('qwenSynth：自建服务（非官方域）仍按 origin 绑定，异源音频拒绝', async () => {
  hits.length = 0
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ output: { audio: { url: 'http://127.0.0.1:9/x.wav' } } }))
  }
  await assert.rejects(
    () => qwenSynth('你好', { apiKey: 'sk-1', baseUrl: `${base}/compatible-mode/v1`, model: 'qwen-audio-3.1-tts-flash', voice: 'Cherry' }),
    /不同源/,
    '自建服务的音频地址与接口不同源，必须拒绝',
  )
})

test('qwenSynth：自建服务可显式配置 audioOrigin 放行独立的音频域', async () => {
  hits.length = 0
  const wav = tinyWav(2000)
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('SpeechSynthesizer')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ output: { audio: { url: 'http://audio.internal.example/out.wav' } } }) }
    }
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.length) }
  }
  try {
    // 不配置 → 拒绝
    await assert.rejects(
      () => qwenSynth('你好', { apiKey: 'sk-1', baseUrl: 'http://127.0.0.1:13080', model: 'm', voice: 'Cherry' }),
      /不同源/,
    )
    // 显式配置 audioOrigin → 放行
    const file = await qwenSynth('你好', {
      apiKey: 'sk-1', baseUrl: 'http://127.0.0.1:13080', audioOrigin: 'http://audio.internal.example', model: 'm', voice: 'Cherry',
    })
    assert.ok(existsSync(file), '显式放行的音频域应能下载成功')
  } finally { globalThis.fetch = realFetch }
})

test('qwenSynth：音频下载的重定向必须逐跳校验（同源首跳 302 到异源要拒）', async () => {
  hits.length = 0
  const realFetch = globalThis.fetch
  let evilHits = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('SpeechSynthesizer')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ output: { audio: { url: 'http://127.0.0.1:13080/a.wav' } } }) }
    }
    if (String(url) === 'http://127.0.0.1:13080/a.wav') {
      // 首跳与接口同源，能过校验；但它 302 去异源
      return { ok: false, status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? METADATA_URL : null) }, arrayBuffer: async () => Buffer.alloc(0) }
    }
    evilHits++
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => tinyWav(2000).buffer }
  }
  try {
    await assert.rejects(
      () => qwenSynth('你好', { apiKey: 'sk-1', baseUrl: 'http://127.0.0.1:13080', model: 'm', voice: 'Cherry' }),
      /重定向到策略外的地址/,
      '同源首跳再 302 到异源，必须被逐跳校验拦住',
    )
    assert.equal(evilHits, 0, '异源目标一次都不该被请求')
  } finally { globalThis.fetch = realFetch }
})

test('qwenSynth：baseUrl 只填域名（不带协议）也能正常合成并正确校验', async () => {
  hits.length = 0
  const wav = tinyWav(2000)
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('SpeechSynthesizer')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ output: { audio: { url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/x.wav' } } }) }
    }
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.length) }
  }
  try {
    // qwenBase 明确容忍裸域名，且 404 提示也写「baseUrl 只填到域名」
    const file = await qwenSynth('你好', { apiKey: 'sk-1', baseUrl: 'dashscope.aliyuncs.com', model: 'm', voice: 'Cherry' })
    assert.ok(existsSync(file), '裸域名的 baseUrl 不应被误判成非法音频地址')
  } finally { globalThis.fetch = realFetch }
})

// 审计 S06：voice.http.headers/body 实际用法就是塞凭据（面板模板与 hint 都这么
// 引导），不能明文回传面板。进 SECRETS 清单后走既有机制：回显置空 + Set 标记 +
// 留空保存保留原值。urlTemplate 不是凭据，不受影响。
test('S06：voice.http.headers/body 不再明文回显，留空保存保留原值', async () => {
  const { normalize, publicConfig, mergeFromPanel } = await import('../src/core/config.js')
  const current = normalize({ voice: { http: { headers: 'Authorization: Bearer;REAL', body: '{"t":"REAL"}', urlTemplate: 'https://t/x' } } })
  const pub = publicConfig(current)
  assert.equal(pub.voice.http.headers, '', 'headers 不得回显原文')
  assert.equal(pub.voice.http.body, '', 'body 不得回显原文')
  assert.equal(pub.voice.http.headersSet, true)
  assert.equal(pub.voice.http.bodySet, true)
  assert.equal(pub.voice.http.urlTemplate, 'https://t/x', 'urlTemplate 不是凭据，正常回显')

  const next = mergeFromPanel(current, { voice: { http: { headers: '', body: '' } } })
  assert.equal(next.voice.http.headers, 'Authorization: Bearer;REAL', '留空保存保留原值')
  assert.equal(next.voice.http.body, '{"t":"REAL"}')
  const replaced = mergeFromPanel(current, { voice: { http: { headers: 'Authorization: Bearer;NEW' } } })
  assert.equal(replaced.voice.http.headers, 'Authorization: Bearer;NEW', '整段重填则覆盖')
})

test('textToSpeech：试听（noFallback）与非 Windows 下直接透出豆包 / 百炼 / MiMo 真实报错', async () => {
  const { textToSpeech } = tts
  // noFallback: true（面板 /voice/test 试听口径）：无论平台，直接抛出真实引擎错误
  await assert.rejects(
    () => textToSpeech('你好', { engine: 'doubao', doubao: { apiKey: '' }, noFallback: true }),
    /豆包语音还没填 API Key/,
  )
  await assert.rejects(
    () => textToSpeech('你好', { engine: 'qwentts', qwentts: { apiKey: '' }, noFallback: true }),
    /百炼语音还没填 API Key/,
  )
  await assert.rejects(
    () => textToSpeech('你好', { engine: 'mimo', mimo: { apiKey: 'sk-1', model: 'mimo-v2.5-tts-voiceclone', refAudio: '' }, noFallback: true }),
    /MiMo 复刻音色要先在「语音」页填参考音频路径/,
  )
  // 非 Windows 即使未传 noFallback，也应抛出主引擎报错，不再被「没有 Windows 自带语音」盖住
  if (process.platform !== 'win32') {
    await assert.rejects(
      () => textToSpeech('你好', { engine: 'mimo', mimo: { apiKey: 'sk-1', model: 'mimo-v2.5-tts-voiceclone', refAudio: '' } }),
      /MiMo 复刻音色要先在「语音」页填参考音频路径/,
    )
    // 没有主引擎报错时（例如直接选了 windows），保留原提示
    await assert.rejects(
      () => textToSpeech('你好', { engine: 'windows' }),
      /Linux \/ macOS 上没有 Windows 自带语音可以兜底/,
    )
  }
})

test('voice 模块 /voice/test 路由：失败时直接透出云端引擎真实报错', async () => {
  const voiceMod = (await import('../src/modules/voice/index.js')).default
  const routes = new Map()
  voiceMod.setup({
    config: () => ({ voice: { engine: 'mimo', mimo: { apiKey: 'sk-1', model: 'mimo-v2.5-tts-voiceclone', refAudio: '' } } }),
    log: { warn() {}, info() {}, debug() {} },
    dsh: { get: () => null },
    core: {
      hub: {},
      onebot: {},
      local: { active: () => false },
      http: { body: async () => ({ text: '试听一句' }) },
    },
    route: (path, fn) => routes.set(path, fn),
  })
  const handler = routes.get('/voice/test')
  assert.equal(typeof handler, 'function')
  await assert.rejects(() => handler({}), /MiMo 复刻音色要先在「语音」页填参考音频路径/)
})
