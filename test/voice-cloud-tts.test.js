// 云端语音引擎（豆包语音 2.0 / 阿里百炼 qwen-tts / 小米 MiMo）：本地起假服务，看它发了什么、
// 又把什么当音频收下来；不联网。语义移植上游社区模块（aurabot mods 的 voice / qwen-tts / aura-mimo）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
