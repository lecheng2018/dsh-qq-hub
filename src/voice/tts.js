// 文字 → 语音文件。
//   首选：edge-tts（微软在线朗读，音色好），装在插件自己的 Python 虚拟环境 C:\Aurabot\pyenv 里，不污染系统。
//   兜底：Windows 自带的中文语音（System.Speech / Huihui），什么都不装也能用（只有 Windows 有）。
// 管线：文字 → TTS → 文件路径。任何一步失败由调用方退回发文字。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, readdirSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { buildWav } from './wav.js'
import { join, dirname, extname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { dataDir } from '../core/store.js'
import { UV_SOURCES } from './uv.js'

// edge-tts 的私有 Python 环境，一键安装时自动创建。老安装沿用 C:\Aurabot\pyenv；新安装放在用户目录下
const LEGACY_PYENV = 'C:\\Aurabot\\pyenv'
export const PYENV_DIR = process.env.AURABOT_PYENV || (existsSync(LEGACY_PYENV) ? LEGACY_PYENV : join(homedir(), 'Aurabot', 'pyenv'))
const WIN = process.platform === 'win32'
// 虚拟环境的目录结构 Windows 和 Linux / macOS 不一样
const pyExe = () => (WIN ? join(PYENV_DIR, 'Scripts', 'python.exe') : join(PYENV_DIR, 'bin', 'python'))

function run(cmd, args, { timeoutMs = 60000, input, env } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(env || {}) } })
    } catch (error) {
      resolve({ code: -1, out, err: error.message })
      return
    }
    const t = setTimeout(() => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        } else {
          child.kill('SIGKILL')
        }
      } catch (e) {}
      err += '\n超时'
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { err += e.message })
    child.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, out, err })
    })
    if (input !== undefined) {
      child.stdin.end(input, 'utf8')
    }
  })
}

function outDir() {
  const d = dataDir('voice-cache')
  mkdirSync(d, { recursive: true })
  // 顺手清掉一天前的旧文件
  try {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (Date.now() - statSync(p).mtimeMs > 86400_000) unlinkSync(p)
    }
  } catch (error) {}
  return d
}

export function edgeInstalled() {
  if (!existsSync(pyExe())) return false
  if (WIN) return existsSync(join(PYENV_DIR, 'Lib', 'site-packages', 'edge_tts'))
  try {
    return readdirSync(join(PYENV_DIR, 'lib')).some((v) => v.startsWith('python') && existsSync(join(PYENV_DIR, 'lib', v, 'site-packages', 'edge_tts')))
  } catch (error) {
    return false
  }
}

/** 面板「安装语音组件」：建虚拟环境并 pip 安装 edge-tts（开源，LGPL）。 */
export async function installEdge(log) {
  mkdirSync(PYENV_DIR, { recursive: true })
  if (!existsSync(pyExe())) {
    // 电脑上有 Python 就直接用；没有就用 uv 下一个私有的 Python（不用用户自己装）
    let r = WIN ? await run('py', ['-3', '-m', 'venv', PYENV_DIR], { timeoutMs: 180000 }) : { code: -1 }
    if (r.code !== 0) r = await run('python3', ['-m', 'venv', PYENV_DIR], { timeoutMs: 180000 })
    if (r.code !== 0) r = await run('python', ['-m', 'venv', PYENV_DIR], { timeoutMs: 180000 })
    if (r.code !== 0) {
      log?.info('电脑上没有可用的 Python，用 uv 准备一个私有的')
      const uv = await findOrFetchUv(log)
      if (!uv) return { ok: false, message: WIN ? '准备 Python 失败：下载安装工具 uv 没成功，检查一下网络（开代理或换个网络）再试' : '准备 Python 失败：电脑上没有能建虚拟环境的 Python（Debian / Ubuntu 装一下 python3-venv），也没有 uv（curl -LsSf https://astral.sh/uv/install.sh | sh）' }
      const env = { UV_PYTHON_INSTALL_DIR: join(dirname(PYENV_DIR), 'python'), UV_PYTHON_INSTALL_MIRROR: 'https://registry.npmmirror.com/-/binary/python-build-standalone' }
      r = await run(uv, ['venv', '-q', PYENV_DIR, '--python', '3.12'], { timeoutMs: 600000, env })
      if (r.code !== 0) return { ok: false, message: '准备 Python 失败：' + r.err.slice(-300) }
    }
  }
  log?.info('正在安装 edge-tts …')
  let r = await run(pyExe(), ['-m', 'pip', 'install', '-q', 'edge-tts'], { timeoutMs: 300000 })
  if (r.code !== 0) {
    r = await run(pyExe(), ['-m', 'pip', 'install', '-q', '-i', 'https://mirrors.aliyun.com/pypi/simple', 'edge-tts'], { timeoutMs: 300000 })
  }
  // uv 建的环境里没有 pip：改用 uv 装
  if (r.code !== 0 && /No module named pip/.test(r.err)) {
    const uv = await findOrFetchUv(log)
    if (uv) {
      r = await run(uv, ['pip', 'install', '-q', '--python', pyExe(), 'edge-tts'], { timeoutMs: 300000 })
      if (r.code !== 0) r = await run(uv, ['pip', 'install', '-q', '--python', pyExe(), '--default-index', 'https://mirrors.aliyun.com/pypi/simple', 'edge-tts'], { timeoutMs: 300000 })
    }
  }
  if (r.code !== 0) return { ok: false, message: '安装 edge-tts 失败：' + r.err.slice(-300) }
  return { ok: true, message: '语音组件装好了' }
}

/** 找 uv：电脑上有就用，都没有就下一个（走系统代理）。 */
async function findOrFetchUv(log) {
  if (process.env.AURABOT_UV) return process.env.AURABOT_UV
  if ((await run('uv', ['--version'], { timeoutMs: 15000 })).code === 0) return 'uv'
  // Linux / macOS：只找装好的（官方安装脚本默认放 ~/.local/bin 或 ~/.cargo/bin），不自动下载
  if (!WIN) return [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv')].find((p) => existsSync(p)) || ''
  const local = join(dirname(PYENV_DIR), 'bin', 'uv.exe')
  for (const p of [local, join('C:\\Aurabot', 'rvc', 'bin', 'uv.exe'), join(homedir(), 'Aurabot', 'rvc', 'bin', 'uv.exe')]) if (existsSync(p)) return p
  log?.info('下载 uv …')
  const zip = join(dirname(PYENV_DIR), 'bin', 'uv.zip')
  const tmp = join(dirname(PYENV_DIR), 'bin', 'uv-src')
  mkdirSync(dirname(zip), { recursive: true })
  // 下载源：国内镜像上的 uv 安装包优先，最后才试 GitHub；有校验值的核对一下
  const ps = "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri $env:AB_URL -OutFile $env:AB_OUT -UseBasicParsing -TimeoutSec 300; if ($env:AB_SHA -and (Get-FileHash $env:AB_OUT -Algorithm SHA256).Hash.ToLower() -ne $env:AB_SHA) { throw 'sha256 mismatch' }; if (Test-Path $env:AB_TMP) { Remove-Item $env:AB_TMP -Recurse -Force }; Expand-Archive -LiteralPath $env:AB_OUT -DestinationPath $env:AB_TMP -Force; $e = Get-ChildItem $env:AB_TMP -Recurse -Filter uv.exe | Select-Object -First 1; Copy-Item $e.FullName $env:AB_DEST -Force; Remove-Item $env:AB_OUT; Remove-Item $env:AB_TMP -Recurse -Force"
  for (const src of UV_SOURCES) {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 400000, env: { AB_URL: src.url, AB_OUT: zip, AB_TMP: tmp, AB_DEST: local, AB_SHA: src.sha256 || '' } })
    if (r.code === 0 && existsSync(local)) return local
    log?.info(`从 ${new URL(src.url).host} 下 uv 没成功，换一个源`)
  }
  return existsSync(local) ? local : ''
}

async function edgeSynth(text, voice, rate, pitch) {
  const file = join(outDir(), `${randomUUID()}.mp3`)
  // 文字走 stdin 的临时文件，避免命令行里的引号 / 编码问题
  const txt = join(outDir(), `${randomUUID()}.txt`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(txt, text, 'utf8')
  const args = ['-I', '-m', 'edge_tts', '--voice', voice, '--file', txt, '--write-media', file]
  if (rate && rate !== '+0%') args.push(`--rate=${rate}`)
  if (pitch && pitch !== '+0Hz') args.push(`--pitch=${pitch}`)
  const r = await run(pyExe(), args, { timeoutMs: 60000 })
  try { unlinkSync(txt) } catch (error) {}
  if (r.code !== 0 || !existsSync(file) || statSync(file).size < 500) {
    throw new Error('edge-tts 失败：' + (r.err || r.out).slice(-200))
  }
  return file
}

async function windowsSynth(text) {
  const file = join(outDir(), `${randomUUID()}.wav`)
  const script =
    'Add-Type -AssemblyName System.Speech;' +
    '$t=[Console]::In.ReadToEnd();' +
    '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
    "$zh=$s.GetInstalledVoices()|Where-Object{$_.VoiceInfo.Culture.Name -eq 'zh-CN'}|Select-Object -First 1;" +
    'if($zh){$s.SelectVoice($zh.VoiceInfo.Name)};' +
    `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}');$s.Speak($t);$s.Dispose()`
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::InputEncoding=[Text.Encoding]::UTF8;${script}`], { timeoutMs: 60000, input: text })
  if (!existsSync(file) || statSync(file).size < 1000) throw new Error('Windows 语音失败：' + r.err.slice(-200))
  return file
}

// ---------- 本地 / 自建 TTS 服务（地址是主人自己填的，所以允许 127.0.0.1） ----------

async function fetchAudio(url, init, timeoutMs = 120000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`HTTP ${r.status}：${(await r.text().catch(() => '')).slice(0, 120)}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 400) throw new Error('返回的音频太短：' + buf.toString('utf8').slice(0, 120))
  return buf
}

function saveAudio(buf, sampleRate) {
  const isWav = buf.toString('ascii', 0, 4) === 'RIFF'
  const isMp3 = buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
  const isOgg = buf.toString('ascii', 0, 4) === 'OggS'
  let out = buf
  let ext = isWav ? 'wav' : isMp3 ? 'mp3' : isOgg ? 'ogg' : 'wav'
  // 裸 PCM16（CosyVoice 官方 FastAPI 就是这样流式返回的）：包一个 WAV 头
  if (!isWav && !isMp3 && !isOgg) out = buildWav(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)), sampleRate)
  const file = join(outDir(), `${randomUUID()}.${ext}`)
  writeFileSync(file, out)
  return file
}

/** CosyVoice 官方 runtime/python/fastapi：/inference_sft（tts_text, spk_id）、/inference_instruct（再加 instruct_text）。 */
async function cosyvoiceSynth(text, c) {
  const base = String(c.url || '').replace(/\/+$/, '')
  if (!base) throw new Error('没填 CosyVoice 地址')
  const instruct = c.mode === 'instruct' && c.instruct
  const form = new URLSearchParams({ tts_text: text, spk_id: c.spkId || '中文女' })
  if (instruct) form.set('instruct_text', c.instruct)
  const buf = await fetchAudio(`${base}/${instruct ? 'inference_instruct' : 'inference_sft'}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })
  return saveAudio(buf, c.sampleRate || 22050)
}

/** GPT-SoVITS api_v2：GET /tts?text=…&text_lang=zh&ref_audio_path=…&prompt_text=…&prompt_lang=zh */
async function gptsovitsSynth(text, c) {
  const base = String(c.url || '').replace(/\/+$/, '')
  if (!base) throw new Error('没填 GPT-SoVITS 地址')
  const q = new URLSearchParams({ text, text_lang: c.textLang || 'zh', ref_audio_path: c.refAudio || '', prompt_text: c.promptText || '', prompt_lang: c.promptLang || 'zh', media_type: 'wav' })
  return saveAudio(await fetchAudio(`${base}/tts?${q}`, { method: 'GET' }), 32000)
}

/** 通用：GET 一个地址模板，{text} 换成要念的话。 */
/** 请求头文本 → 对象。一行一个「Key: Value」，空行和 # 开头的行忽略。 */
export function parseHeaderText(raw) {
  const out = {}
  for (const line of String(raw || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf(':')
    if (i <= 0) continue
    const k = s.slice(0, i).trim()
    const v = s.slice(i + 1).trim()
    if (k && v) out[k] = v
  }
  return out
}

/** 云厂商把音频塞在 JSON 里（base64），这里把常见的几种字段扒出来。 */
export function pickAudioFromJson(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const keys = ['data', 'audio', 'audio_base64', 'audioBase64', 'base64', 'voice', 'result']
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 200) return v
    if (v && typeof v === 'object') {
      const inner = pickAudioFromJson(v)
      if (inner) return inner
    }
  }
  return ''
}

/** 通用 HTTP TTS（语义移植上游）：GET/POST + 自定义请求头/请求体，JSON 里的 base64 音频自动解出。
 * 火山豆包 / 阿里 / 讯飞这类要鉴权的云 TTS 都靠它接上。{text} 自动 JSON 转义，{text_raw} 不转义（表单用），
 * {reqid} 每次换新 UUID。老配置只填 urlTemplate 的照旧走 GET，行为不变。 */
export async function httpSynth(text, c) {
  const url = String(c.urlTemplate || '').trim()
  if (!url) throw new Error('通用 TTS 没填地址')
  const method = String(c.method || 'GET').trim().toUpperCase()
  const headers = parseHeaderText(c.headers)
  const hasHeader = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name)

  let target = url
  let body
  if (method === 'GET' || method === 'HEAD') {
    if (!url.includes('{text}')) throw new Error('GET 方式的地址里要有 {text}')
    target = url.split('{text}').join(encodeURIComponent(text))
  } else {
    const raw = String(c.body || '').trim()
    if (!raw) throw new Error(`${method} 方式要填请求体`)
    const escaped = JSON.stringify(text).slice(1, -1)
    body = raw.split('{text}').join(escaped).split('{text_raw}').join(text).split('{reqid}').join(randomUUID())
    if (!hasHeader('content-type')) headers['content-type'] = 'application/json'
  }

  const r = await fetch(target, { method, headers, body, signal: AbortSignal.timeout(120000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}：${(await r.text().catch(() => '')).slice(0, 160)}`)

  let buf = Buffer.from(await r.arrayBuffer())
  const ctype = String(r.headers.get('content-type') || '')
  const looksJson = ctype.includes('json') || buf[0] === 0x7b
  if (looksJson) {
    let parsed = null
    try { parsed = JSON.parse(buf.toString('utf8')) } catch (error) {}
    if (!parsed) throw new Error('返回的是 JSON 但解析失败：' + buf.toString('utf8').slice(0, 160))
    const code = parsed.code ?? parsed.status ?? parsed.retcode
    const b64 = pickAudioFromJson(parsed)
    if (!b64) {
      throw new Error(`返回里没找到音频数据（code=${code}，message=${parsed.message || parsed.msg || parsed.err_msg || '-'}）`)
    }
    buf = Buffer.from(b64, 'base64')
  }
  if (buf.length < 400) throw new Error('返回的音频太短：' + buf.toString('utf8').slice(0, 160))
  return saveAudio(buf, c.sampleRate || 24000)
}

// ---------- 云端 TTS：豆包语音 2.0 / 阿里百炼 qwen-tts / 小米 MiMo ----------
// 语义移植上游社区模块（aurabot mods 的 voice / qwen-tts / aura-mimo，均 MIT），按本文件管线落地：
// 都走「引擎失败 → 退回 edge-tts / Windows 语音」的老路，不会让她突然不会说话。
// 配置都在 config.voice.doubao / voice.qwentts / voice.mimo，面板「语音」页填。

/** 豆包语音 2.0（火山引擎）：POST 流式 NDJSON，data 字段是 base64 WAV 分片。 */
export const DOUBAO_API = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'

/** 按关键词给这句话配一条语气指令（上游 voice 模块的 autoEmotion 规则，不参与计费）。 */
const DOUBAO_EMOTION_RULES = [
  [['哭', '难过', '伤心', '委屈', '失落', '心碎', '难受', '呜呜', '唉'], '用低落、难过、带一点鼻音的语气说这句话'],
  [['生气', '气死', '烦死', '讨厌', '滚', '闭嘴', '过分', '凭什么', '怒了'], '用生气、急躁、带一点责备的语气说这句话'],
  [['开心', '高兴', '太好了', '哈哈', '笑死', '棒', '嘿嘿', '耶', '爽'], '用开心、轻快、带笑意的语气说这句话'],
  [['撒娇', '不要嘛', '人家', '抱抱', '哼', '好不好嘛', '陪我'], '用撒娇、软糯一点的语气说这句话'],
  [['害怕', '恐怖', '吓死', '紧张', '慌了', '担心'], '用紧张、放轻、带一点害怕的语气说这句话'],
  [['别怕', '没事的', '我在', '乖', '安慰', '心疼'], '用温柔、安慰、放慢一点的语气说这句话'],
  [['温柔', '宠溺', '哄哄我', '轻声'], '用温柔、宠溺、放慢一点的语气说这句话'],
  [['严肃', '冷静', '正经', '好好说'], '用冷静、平稳、认真的语气说这句话'],
  [['惊讶', '真的假的', '居然', '不会吧', '卧槽', '哇'], '用惊讶、语调上扬的语气说这句话'],
]

/** 关键词命中最多的一条语气指令；没命中返回空串。 */
export function inferDoubaoEmotion(text) {
  const t = String(text || '')
  let best = ''
  let bestScore = 0
  for (const [words, hint] of DOUBAO_EMOTION_RULES) {
    let score = 0
    for (const w of words) {
      let i = 0
      while ((i = t.indexOf(w, i)) !== -1) { score++; i += w.length }
    }
    if (score > bestScore) { best = hint; bestScore = score }
  }
  return best
}

/** 流式 WAV 的 RIFF/data 长度字段是 0xFFFFFFFF，回填真实长度，否则部分播放器读不出时长。 */
export function fixStreamingWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf
  buf.writeUInt32LE(buf.length - 8, 4)
  const pos = buf.indexOf(Buffer.from('data'))
  if (pos !== -1 && buf.length >= pos + 8) buf.writeUInt32LE(buf.length - pos - 8, pos + 4)
  return buf
}

export async function doubaoSynth(text, c) {
  const key = String(c.apiKey || '').trim()
  if (!key) throw new Error('豆包语音还没填 API Key（火山引擎「豆包语音」控制台创建）')
  const instructions = String(c.contextTexts || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (c.autoEmotion !== false) {
    const hint = inferDoubaoEmotion(text)
    if (hint) instructions.push(hint)
  }
  const req = {
    text,
    speaker: String(c.speaker || 'S_1CmxEOek2').trim(),
    audio_params: {
      format: 'wav',
      sample_rate: 24000,
      speech_rate: Math.max(-50, Math.min(100, Math.round(Number(c.speechRate) || 0))),
    },
  }
  if (instructions.length) req.context_texts = instructions
  const timeoutMs = Math.max(5, Number(c.timeout) || 60) * 1000
  const r = await fetch(String(c.endpoint || DOUBAO_API), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Api-Key': key,
      'X-Api-Resource-Id': String(c.resourceId || 'seed-icl-2.0'),
      'X-Api-Connect-Id': randomUUID(),
    },
    body: JSON.stringify({ user: { uid: 'dsh-qq-hub' }, req_params: req }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await r.text()
  if (!r.ok) {
    const logid = r.headers.get('x-tt-logid') || ''
    throw new Error(`豆包语音 HTTP ${r.status}：${raw.slice(0, 160)}${logid ? `（logid=${logid}）` : ''}`)
  }
  // 返回是逐行 JSON：{code, message?, data?}；code 非 0 记下来，data 是 base64 WAV 分片
  const chunks = []
  let message = ''
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    let item = null
    try { item = JSON.parse(s) } catch { continue }
    if (item.code !== 0 && item.code != null && !item.data) message = `code=${item.code} ${item.message || ''}`
    if (item.data) chunks.push(Buffer.from(String(item.data), 'base64'))
  }
  const audio = Buffer.concat(chunks)
  if (!audio.length) throw new Error(`豆包语音没返回音频${message ? `：${message}` : `：${raw.slice(0, 160)}`}`)
  return saveAudio(fixStreamingWav(audio), 24000)
}

// ---- 阿里百炼 qwen-tts（DashScope SpeechSynthesizer）----

/** 【语气】标记：『【撒娇】行吧』→ 拆出正文和语气描述；表里没有的标记原样保留。 */
const QWEN_TONES = {
  撒娇: '这一句在撒娇，声音软一点，尾音稍微拖一点点，别太用力。',
  吐槽: '这一句在吐槽，语气随意、带点无语，别一字一顿，也别真的发火。',
  困: '这一句很困，声音偏低、偏慢、含糊一点，像马上要睡着了。',
  害羞: '这一句有点不好意思，声音小下去，说得比平时快一点。',
  生气: '这一句有点火，语气冲一点，语速快一点。',
  委屈: '这一句有点委屈，声音软下来，带一点闷。',
  惊讶: '这一句在惊讶，语速快一点，语气往上扬。',
  开心: '这一句很高兴，语气亮一点，往上扬。',
  无语: '这一句很无语，语气平、慢，带一点叹气的感觉。',
  认真: '这一句在认真说事，语气收敛，不撒娇。',
  无奈: '这一句有点无奈，语气自然、轻轻叹口气。',
  疑惑: '这一句有点疑惑，语气带一点好奇。',
  卖萌: '这一句在卖萌，语气轻快可爱，不要太夸张。',
}
const QWEN_TONE_RE = /[【\[]([^】\]]{1,6})[】\]]/g

export function parseQwenTone(text) {
  const src = String(text || '')
  let desc = ''
  const clean = src.replace(QWEN_TONE_RE, (m, name) => {
    const hint = QWEN_TONES[String(name).trim()]
    if (hint) { desc = desc || hint; return ' ' }
    return m
  }).replace(/[ \t]{2,}/g, ' ').trim()
  return { text: clean, instruction: desc }
}

/** 长文本按句末标点切成不超过 maxChars 的分段（单段超长按逗号切，再不行硬切）。 */
export function splitQwenText(text, maxChars = 300) {
  const src = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!src) return []
  if (src.length <= maxChars) return [src]
  const pieces = src.match(/[^。！？!?；;\n…]+[。！？!?；;\n…]*|[。！？!?；;\n…]+/g) || [src]
  const out = []
  let buf = ''
  const push = () => { if (buf.trim()) out.push(buf.trim()); buf = '' }
  for (const p of pieces) {
    if ((buf + p).length <= maxChars) { buf += p; continue }
    push()
    if (p.length <= maxChars) { buf = p; continue }
    const parts = p.match(/[^，,、：:]+[，,、：:]*/g) || [p]
    for (const q of parts) {
      if ((buf + q).length <= maxChars) { buf += q; continue }
      push()
      if (q.length <= maxChars) { buf = q; continue }
      for (let i = 0; i < q.length; i += maxChars) {
        const chunk = q.slice(i, i + maxChars)
        if (chunk.length === maxChars) out.push(chunk)
        else buf = chunk
      }
    }
  }
  push()
  return out.length ? out : [src.slice(0, maxChars)]
}

function qwenBase(s) {
  let u = String(s || '').trim() || 'https://dashscope.aliyuncs.com'
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  try { const p = new URL(u); return `${p.protocol}//${p.host}` } catch { return 'https://dashscope.aliyuncs.com' }
}

/** 合成一段：返回音频 Buffer。百炼把音频放在 output.audio.url（24 小时有效），要再 GET 一次。 */
async function qwenSegment(text, instruction, c) {
  const url = `${qwenBase(c.baseUrl)}/api/v1/services/audio/tts/SpeechSynthesizer`
  const input = { text, voice: String(c.voice || 'Cherry').trim(), format: 'wav', sample_rate: Number(c.sampleRate) || 24000 }
  if (Number.isFinite(Number(c.seed)) && Number(c.seed) > 0) input.seed = Math.max(0, Math.min(65535, Math.round(Number(c.seed))))
  if (Number(c.speechRate) > 0 && Number(c.speechRate) !== 1) input.rate = Number(c.speechRate)
  if (instruction) input.instruction = instruction
  const timeoutMs = Math.max(10000, Number(c.timeoutMs) || 30000)
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(c.apiKey || '').trim()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: String(c.model || 'qwen-audio-3.1-tts-flash').trim(), input, parameters: {} }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await r.text()
  if (!r.ok) {
    const why = { 401: '百炼不认这个 API Key', 403: '这个 API Key 没有调语音的权限', 404: '接口地址不对（baseUrl 只填到域名）', 429: '调用太频繁被限流了' }[r.status] || `HTTP ${r.status}`
    throw new Error(`百炼语音合成失败：${why}：${raw.slice(0, 120)}`)
  }
  let j
  try { j = JSON.parse(raw) } catch { throw new Error('百炼语音返回的不是 JSON：' + raw.slice(0, 120)) }
  const audioUrl = j?.output?.audio?.url
  if (!audioUrl) throw new Error('百炼语音没返回音频地址：' + raw.slice(0, 160))
  // 审计 S10：二次下载做**同源绑定**——audioUrl 来自 API 响应 JSON，是半可信输入；
  // 供应商返回被篡改/被劫持时，可能把我们带去任意地址（包括内网）。官方语义里
  // 音频域与 API 域同源（dashscope），这里按 origin 绑定：与 baseUrl 不同源一律拒绝。
  // 不用 assertPublicUrl：baseUrl 本身允许主人自填内网/本地地址（自建兼容服务），
  // 同源绑定既挡住「响应把下载引去别处」，又不影响合法的自建部署与测试回环。
  try {
    const audioHost = new URL(audioUrl).host
    const apiHost = new URL(c.baseUrl).host
    if (audioHost !== apiHost) throw new Error(`音频地址与接口不同源（${audioHost} ≠ ${apiHost}），已拒绝下载`)
  } catch (error) {
    if (error?.message?.includes('不同源')) throw error
    throw new Error(`音频地址不是合法 URL：${String(audioUrl).slice(0, 80)}`)
  }
  const a = await fetch(audioUrl, { signal: AbortSignal.timeout(timeoutMs) })
  if (!a.ok) throw new Error(`下载合成好的音频失败（HTTP ${a.status}）`)
  const buf = Buffer.from(await a.arrayBuffer())
  if (buf.length < 1024) throw new Error(`拿到的音频太小（${buf.length} 字节），可能是空音频`)
  return buf
}

function qwenParseWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const start = off + 8
    if (id === 'fmt ' && size >= 16 && start + 16 <= buf.length) fmt = { channels: buf.readUInt16LE(start + 2), rate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) }
    else if (id === 'data') data = buf.subarray(start, Math.min(buf.length, start + size))
    off = start + size + (size & 1)
    if (size <= 0 || off > buf.length) break
  }
  if (!fmt || !data || !fmt.rate || !fmt.bits) return null
  return { ...fmt, data }
}

/** 百炼返回的 WAV 头部 data 长度字段不可信，按真实数据重打包；多段按 PCM 拼成一个 WAV。 */
function qwenConcatWav(bufs) {
  const parsed = bufs.map((b) => qwenParseWav(b))
  if (parsed.some((p) => !p)) return bufs.length === 1 ? bufs[0] : null
  const first = parsed[0]
  const same = parsed.every((p) => p.channels === first.channels && p.rate === first.rate && p.bits === first.bits)
  if (!same) return null
  const pcm = Buffer.concat(parsed.map((p) => p.data))
  return buildWav(new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2)), first.rate)
}

export async function qwenSynth(text, c) {
  const key = String(c.apiKey || '').trim()
  if (!key) throw new Error('百炼语音还没填 API Key（阿里云百炼创建）')
  const { text: clean, instruction: toneDesc } = parseQwenTone(text)
  const base = String(c.instruction || '').trim()
  const instruction = toneDesc ? (base ? `${base}${base.endsWith('。') ? '' : '。'}${toneDesc}` : toneDesc) : base
  const maxChars = Math.min(300, Math.max(50, Number(c.maxCharsPerSegment) || 300))
  const segs = splitQwenText(clean || text, maxChars)
  const bufs = []
  for (let i = 0; i < segs.length; i++) {
    try {
      bufs.push(await qwenSegment(segs[i], instruction, c))
    } catch (error) {
      throw new Error(segs.length > 1 ? `百炼语音第 ${i + 1}/${segs.length} 段合成失败——${error.message}` : error.message)
    }
  }
  const merged = qwenConcatWav(bufs)
  if (!merged || !merged.length) throw new Error('百炼语音分段格式不一致，拼不成完整音频')
  return saveAudio(merged, Number(c.sampleRate) || 24000)
}

// ---- 小米 MiMo TTS（OpenAI 兼容 chat/completions，message.audio.data 是 base64 音频）----

const MIMO_MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg' }

export async function mimoSynth(text, c) {
  const key = String(c.apiKey || '').trim()
  if (!key) throw new Error('MiMo 语音还没填 API Key（小米 MiMo 开放平台创建，sk- 开头）')
  const base = String(c.apiBase || 'https://api.xiaomimimo.com/v1').trim().replace(/\/+$/, '')
  const model = String(c.model || 'mimo-v2.5-tts-voiceclone').trim()
  const style = String(c.stylePrompt || '').trim()
  const seed = String(c.seedText || '').trim()
  const messages = []
  let audioVoice = ''
  if (model.toLowerCase().includes('voicedesign')) {
    // 音色描述模型：不用参考音频，第一条 user 消息就是音色描述
    messages.push({ role: 'user', content: style || seed || '自然亲切的中文女声，语速中等，情绪温柔' })
    messages.push({ role: 'assistant', content: text })
  } else {
    // 声音复刻：参考音频（本机路径）转 data URI
    const ref = String(c.refAudio || '').trim()
    if (!ref || !existsSync(ref)) throw new Error('MiMo 复刻音色要先在「语音」页填参考音频路径（本机一段 mp3/wav，几秒到几十秒都行）')
    if (statSync(ref).size > 15 * 1024 * 1024) throw new Error('参考音频太大（上限 15MB）：截一段几秒到几十秒的就够')
    const mime = MIMO_MIME[extname(ref).toLowerCase()] || 'audio/mpeg'
    audioVoice = `data:${mime};base64,${readFileSync(ref).toString('base64')}`
    if (seed) messages.push({ role: 'user', content: seed })
    messages.push({ role: 'assistant', content: style ? `<style>${style}</style>${text}` : text })
  }
  const timeoutMs = Math.max(30, Number(c.timeout) || 180) * 1000
  const payload = { model, messages, audio: { format: 'wav' } }
  if (audioVoice) payload.audio.voice = audioVoice
  let r
  try {
    r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`MiMo 请求超时（${Math.round(timeoutMs / 1000)} 秒）：生成较慢，可把超时调大试试`)
    throw new Error(`连不上 MiMo 接口（${base}）：${e?.message || e}`)
  }
  const bodyText = await r.text()
  if (!r.ok) throw new Error(`MiMo HTTP ${r.status}：${bodyText.slice(0, 160)}`)
  let data
  try { data = JSON.parse(bodyText) } catch { throw new Error('MiMo 返回的不是 JSON：' + bodyText.slice(0, 160)) }
  const b64 = data?.choices?.[0]?.message?.audio?.data
  if (!b64) throw new Error('MiMo 没有返回音频内容：' + bodyText.slice(0, 160))
  return saveAudio(Buffer.from(b64, 'base64'), 24000)
}

/** 说话语音的后处理：目前原样返回（语音条直接用 TTS 的声音）。 */
export const voiceConverters = []

/**
 * @returns {Promise<{file:string, engine:string}>}
 */
export async function textToSpeech(text, opt = {}, log) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('没有要念的文字')
  let file = ''
  let engine = ''
  const local = { cosyvoice: cosyvoiceSynth, gptsovits: gptsovitsSynth, http: httpSynth, doubao: doubaoSynth, qwentts: qwenSynth, mimo: mimoSynth }[opt.engine]
  if (local) {
    try {
      file = await local(clean, opt[opt.engine] || {})
      engine = opt.engine
    } catch (error) {
      log?.warn(`${opt.engine} 失败：${error.message} → 改用 Windows 语音`)
    }
  } else if (opt.engine !== 'windows' && edgeInstalled()) {
    try {
      file = await edgeSynth(clean, opt.voice || 'zh-CN-XiaoyiNeural', opt.rate, opt.pitch)
      engine = 'edge'
    } catch (error) {
      log?.warn(error.message, '→ 改用 Windows 语音')
    }
  }
  if (!file) {
    if (!WIN) throw new Error('语音没合成出来：Linux / macOS 上没有 Windows 自带语音可以兜底，先在「语音」页装好 edge-tts，或者用本地 TTS 服务')
    file = await windowsSynth(clean)
    engine = 'windows'
  }
  for (const conv of voiceConverters) {
    try {
      file = await conv(file)
    } catch (error) {
      log?.warn('变声失败，用原声：', error.message)
    }
  }
  return { file, engine }
}
