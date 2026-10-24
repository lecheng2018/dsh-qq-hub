// 翻唱：点歌 → 下载（网易云）→ 分离人声和伴奏 → RVC 换成她的声音 → 混音 → 截成语音条发回去。
// 推理引擎用 Applio（MIT，固定版本），人声分离用 audio-separator，都装在一个独立的 Python 环境里，不碰系统环境。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { dataDir } from '../core/store.js'
import { searchSongs, songUrl, account } from './netease.js'
import { readZip } from './zip.js'

export const APPLIO_REPO = 'https://github.com/IAHispano/Applio.git'
export const APPLIO_COMMIT = 'c817f1f83f689ef72e0dfeb1c17ae990b9248506'
const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'
const LEGACY_ROOT = 'C:\\Aurabot\\rvc'

// RVC 推理要的预训练文件（Applio 放在 HuggingFace 上）：[远端相对路径, 本地相对 Applio 的路径]
const PREREQS = [
  ['predictors/rmvpe.pt', 'rvc/models/predictors/rmvpe.pt'],
  ['embedders/contentvec/config.json', 'rvc/models/embedders/contentvec/config.json'],
  ['embedders/contentvec/pytorch_model.bin', 'rvc/models/embedders/contentvec/pytorch_model.bin'],
]
// 国内直连 HuggingFace 常常很慢，卡住就换镜像
const HF_HOSTS = ['https://huggingface.co', 'https://hf-mirror.com']

const FETCH_SCRIPT = fileURLToPath(new URL('./fetch_file.py', import.meta.url))

/**
 * 下载一个预训练文件：已经有了就跳过。用翻唱环境里的 Python 下（会走系统代理），
 * 断了从断点接着下，卡住 30 秒就换下一个源，几轮都不行才算失败。
 */
async function downloadWithMirror(python, rel, dest, note, log) {
  if (existsSync(dest) && statSync(dest).size > 0) return
  const urls = HF_HOSTS.map((host) => `${host}/IAHispano/Applio/resolve/main/Resources/${rel}`)
  note?.(`下载 ${rel}`)
  let lastPct = -1
  await run(python, [FETCH_SCRIPT, dest, ...urls], {
    log,
    env: { PYTHONIOENCODING: 'utf-8' },
    timeoutMs: 2 * 3600_000,
    onLine: (line) => {
      const m = line.match(/^progress (\d+) (\d+)/)
      if (m && Number(m[2])) {
        const pct = Math.floor((Number(m[1]) / Number(m[2])) * 10) * 10
        if (pct !== lastPct) { lastPct = pct; note?.(`  ${rel}：${pct}%`) }
      } else if (/^retry /.test(line)) note?.('  ' + line.replace(/^retry /, '断了，换个源接着下：'))
    },
  })
}

/** 翻唱环境的根目录：老安装沿用 C:\Aurabot\rvc，新安装放用户目录下。 */
export function defaultRoot() {
  return existsSync(LEGACY_ROOT) ? LEGACY_ROOT : join(homedir(), 'Aurabot', 'rvc')
}

export function pathsOf(root) {
  return {
    root,
    python: join(root, 'env', 'Scripts', 'python.exe'),
    separatorExe: join(root, 'env', 'Scripts', 'audio-separator.exe'),
    applio: join(root, 'Applio'),
    models: join(root, 'models'),
    separatorModels: join(root, 'separator-models'),
    bin: join(root, 'bin'),
    ffmpeg: join(root, 'bin', 'ffmpeg.exe'),
    rmvpe: join(root, 'Applio', 'rvc', 'models', 'predictors', 'rmvpe.pt'),
    contentvec: join(root, 'Applio', 'rvc', 'models', 'embedders', 'contentvec', 'pytorch_model.bin'),
  }
}

/** models 目录里的音色：[{id, pth, index}]，同名 .index 可选。 */
export function listVoices(modelsDir) {
  let names = []
  try { names = readdirSync(modelsDir) } catch (error) { return [] }
  return names.filter((n) => n.toLowerCase().endsWith('.pth')).sort().map((n) => {
    const id = n.slice(0, -4)
    const idx = names.find((m) => m.toLowerCase().endsWith('.index') && m.toLowerCase().includes(id.toLowerCase()))
    return { id, pth: join(modelsDir, n), index: idx ? join(modelsDir, idx) : '' }
  })
}

/** 像不像 RVC 模型：PyTorch 存的 .pth 要么是 zip 格式（PK 开头），要么是老的 pickle（0x80 开头）。 */
export function looksLikePth(buf) {
  return buf.length > 1024 * 1024 && ((buf[0] === 0x50 && buf[1] === 0x4b) || buf[0] === 0x80)
}

const safeName = (n) => basename(String(n).replace(/\\/g, '/')).replace(/[<>:"|?*\x00-\x1f]/g, '_').trim()

/**
 * 导入音色：.pth / .index，或者装着它们的 zip。存进 models 目录。
 * zip 里只有一个音色时，index 自动改名成「音色名.index」配上。
 * @returns {{ok: boolean, added: string[], indexes: number, message: string}}
 */
export function importModels(modelsDir, filename, buf) {
  const name = safeName(filename)
  const lower = name.toLowerCase()
  let files
  if (lower.endsWith('.zip')) {
    files = readZip(buf, (n) => /\.(pth|index)$/i.test(n) && !n.includes('__MACOSX')).map((f) => ({ name: safeName(f.name), data: f.data }))
  } else if (lower.endsWith('.pth') || lower.endsWith('.index')) {
    files = [{ name, data: buf }]
  } else {
    return { ok: false, added: [], indexes: 0, message: '只支持 .zip、.pth、.index 文件' }
  }
  const pths = files.filter((f) => f.name.toLowerCase().endsWith('.pth'))
  const idxs = files.filter((f) => f.name.toLowerCase().endsWith('.index'))
  if (!pths.length && !idxs.length) return { ok: false, added: [], indexes: 0, message: '里面没找到 .pth 模型' }
  const bad = pths.filter((f) => !looksLikePth(f.data))
  if (bad.length) return { ok: false, added: [], indexes: 0, message: `「${bad[0].name}」看起来不是 RVC 模型` }
  mkdirSync(modelsDir, { recursive: true })
  for (const f of pths) writeFileSync(join(modelsDir, f.name), f.data)
  const solo = pths.length === 1 ? pths[0].name.slice(0, -4) : ''
  for (const f of idxs) writeFileSync(join(modelsDir, solo && idxs.length === 1 ? `${solo}.index` : f.name), f.data)
  const added = pths.map((f) => f.name.slice(0, -4))
  return {
    ok: true,
    added,
    indexes: idxs.length,
    message: added.length ? `导入了 ${added.length} 个音色：${added.join('、')}${idxs.length ? `（带 ${idxs.length} 个 index）` : ''}` : `导入了 ${idxs.length} 个 index`,
  }
}

/** 删掉一个音色（连同配套的 index）。 */
export function deleteVoice(modelsDir, id) {
  const v = listVoices(modelsDir).find((x) => x.id === id)
  if (!v) return { ok: false, message: '没有这个音色' }
  rmSync(v.pth, { force: true })
  if (v.index) rmSync(v.index, { force: true })
  return { ok: true, message: `删掉了「${id}」` }
}

/** 截一段：歌比上限长时从「大约副歌」的位置开始（全曲 30% 处），否则从头。 */
export function clipWindow(durationSec, maxSec, start = 'auto') {
  if (!(durationSec > maxSec)) return { start: 0, length: durationSec }
  if (start === 'head') return { start: 0, length: maxSec }
  const s = Math.max(0, Math.min(Math.round(durationSec * 0.3), Math.floor(durationSec - maxSec)))
  return { start: s, length: maxSec }
}

function run(cmd, args, { cwd, env, log, onLine, timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true })
    let tail = ''
    const feed = (buf) => {
      const s = String(buf)
      tail = (tail + s).slice(-4000)
      for (const line of s.split(/\r?\n|\r/)) if (line.trim()) onLine?.(line.trim())
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    const timer = setTimeout(() => { try { child.kill() } catch (error) {} }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(tail)
      else {
        log?.debug(`${basename(cmd)} 失败（code ${code}）：${tail.slice(-800)}`)
        reject(new Error(`${basename(cmd)} 退出码 ${code}：${tail.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300)}`))
      }
    })
  })
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {object} deps.log
 * @param {(chatId: string, file: string, note: string) => Promise<any>} deps.sendVoiceFile  把做好的语音发到聊天
 * @param {(chatId: string, text: string) => Promise<any>} [deps.sendText]
 */
export function createSongStudio({ getConfig, log, sendVoiceFile, sendText, onSung }) {
  const cfg = () => getConfig().song
  const P = () => pathsOf(cfg().root || defaultRoot())
  const work = () => dataDir('songs')
  const queue = []
  let current = null // 正在做的翻唱
  let history = [] // 最近做过的 [{at, title, voice, ok, message, file}]
  let install = { running: false, step: '', log: [], ok: null, message: '' }

  function status() {
    const p = P()
    const voices = listVoices(p.models)
    const parts = {
      python: existsSync(p.python),
      applio: existsSync(join(p.applio, 'core.py')),
      separator: existsSync(p.separatorExe),
      ffmpeg: existsSync(p.ffmpeg),
      weights: existsSync(p.rmvpe) && existsSync(p.contentvec),
    }
    const ready = Object.values(parts).every(Boolean) && voices.length > 0
    return {
      enabled: cfg().enabled,
      ready,
      root: p.root,
      parts,
      voices: voices.map((v) => ({ id: v.id, hasIndex: Boolean(v.index) })),
      voice: cfg().voice,
      install: { ...install, log: install.log.slice(-30) },
      current: current ? { ...current } : null,
      queue: queue.map((q) => ({ query: q.query, chatId: q.chatId })),
      history: history.slice(0, 10),
      message: !voices.length ? '还没有音色：在下面「音色模型」里导入你有权使用的 RVC 模型（.pth 或 zip）' : ready ? (cfg().enabled ? '可以点歌了' : '准备好了，打开开关就能用') : '还差一些组件，点「一键安装」',
    }
  }

  // ---------- 一键安装（几个 GB，要十几分钟）----------
  async function runInstall() {
    if (install.running) return { ok: false, message: '已经在装了' }
    const p = P()
    install = { running: true, step: '', log: [], ok: null, message: '' }
    const note = (s) => { install.log.push(s); if (install.log.length > 200) install.log.shift() }
    const step = async (name, fn) => { install.step = name; note('▶ ' + name); log.info('翻唱安装：' + name); await fn() }
    const uv = process.env.AURABOT_UV || 'uv'
    try {
      mkdirSync(p.root, { recursive: true })
      mkdirSync(p.models, { recursive: true })
      await step('下载 Applio（RVC 推理引擎）', async () => {
        if (!existsSync(join(p.applio, '.git'))) await run('git', ['clone', '-q', APPLIO_REPO, p.applio], { log, onLine: note })
        await run('git', ['-C', p.applio, 'fetch', '-q', '--depth', '1', 'origin', APPLIO_COMMIT], { log, onLine: note }).catch(() => {})
        await run('git', ['-C', p.applio, 'checkout', '-q', APPLIO_COMMIT], { log, onLine: note })
      })
      await step('创建 Python 环境', async () => {
        if (!existsSync(p.python)) await run(uv, ['venv', '-q', join(p.root, 'env'), '--python', '3.12'], { log, onLine: note })
      })
      await step('安装 PyTorch、RVC 和人声分离（最大的一步）', async () => {
        await run(uv, ['pip', 'install', '--python', p.python, '-r', join(p.applio, 'requirements-engine.txt'), 'audio-separator[gpu]', 'imageio-ffmpeg',
          '--extra-index-url', TORCH_INDEX, '--index-strategy', 'unsafe-best-match'], { log, onLine: note, env: { UV_HTTP_TIMEOUT: '300', UV_HTTP_RETRIES: '6' }, timeoutMs: 90 * 60_000 })
      })
      await step('准备 ffmpeg', async () => setupFfmpeg())
      await step('下载 RVC 需要的预训练文件（音高、音色特征）', async () => {
        for (const [rel, dest] of PREREQS) await downloadWithMirror(p.python, rel, join(p.applio, dest), note, log)
      })
      install = { ...install, running: false, ok: true, message: '装好了' }
      log.info('翻唱环境装好了')
    } catch (error) {
      install = { ...install, running: false, ok: false, message: `「${install.step}」这步失败了：${error.message}` }
      log.warn('翻唱安装失败：', install.message)
    }
    return { ok: install.ok, message: install.message }
  }

  /** 把 imageio-ffmpeg 带的 ffmpeg 复制成 bin\ffmpeg.exe（人声分离要在 PATH 里找到 ffmpeg）。 */
  async function setupFfmpeg() {
    const p = P()
    if (existsSync(p.ffmpeg)) return
    const out = await run(p.python, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { log })
    const src = out.trim().split(/\r?\n/).pop()
    mkdirSync(p.bin, { recursive: true })
    copyFileSync(src, p.ffmpeg)
  }

  // ---------- 做一首 ----------
  const pyEnv = () => {
    const p = P()
    return { PATH: p.bin + ';' + process.env.PATH, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  }

  async function ffprobeDuration(file) {
    // ffmpeg -i 会把时长打在 stderr 里，退出码是 1，这里自己接
    return new Promise((resolve) => {
      const c = spawn(P().ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true })
      let s = ''
      c.stderr.on('data', (b) => { s += b })
      c.on('exit', () => {
        const m = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
        resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0)
      })
      c.on('error', () => resolve(0))
    })
  }

  async function download(job, dir) {
    const c = cfg()
    let pick = job.songId ? { id: job.songId, name: job.query, artists: '' } : null
    if (!pick) {
      const list = await searchSongs(job.query, { cookie: c.neteaseCookie, limit: 8 })
      if (!list.length) throw new Error(`网易云上没搜到「${job.query}」`)
      // 按顺序找第一首拿得到完整音频的
      for (const s of list) {
        const u = await songUrl(s.id, { cookie: c.neteaseCookie })
        if (u.url && !u.trial) { pick = { ...s, url: u.url }; break }
      }
      if (!pick) throw new Error(`「${job.query}」要会员或者有版权限制，下载不了${c.neteaseCookie ? '' : '（在面板里填网易云 Cookie 后可以下会员歌）'}`)
    } else {
      const u = await songUrl(pick.id, { cookie: c.neteaseCookie })
      if (!u.url || u.trial) throw new Error('这首歌下载不了（要会员或者有版权限制）')
      pick.url = u.url
    }
    job.title = pick.artists ? `${pick.name} - ${pick.artists}` : pick.name
    job.songKey = String(pick.id)
    const r = await fetch(pick.url, { signal: AbortSignal.timeout(120_000) })
    if (!r.ok) throw new Error(`下载失败（HTTP ${r.status}）`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > 60 * 1024 * 1024) throw new Error('歌太大了')
    const file = join(dir, 'song.mp3')
    writeFileSync(file, buf)
    return file
  }

  async function separate(input, dir) {
    const p = P()
    mkdirSync(p.separatorModels, { recursive: true })
    const model = cfg().separatorModel
    await run(p.separatorExe, [input, '--model_filename', model, '--model_file_dir', p.separatorModels, '--output_dir', dir, '--output_format', 'WAV'], { log, env: pyEnv(), timeoutMs: 20 * 60_000 })
    const files = readdirSync(dir)
    const vocals = files.find((f) => /\(vocals\)/i.test(f))
    const inst = files.find((f) => /\(instrumental\)/i.test(f) || /\(other\)/i.test(f))
    if (!vocals || !inst) throw new Error('人声分离没产出文件')
    return { vocals: join(dir, vocals), inst: join(dir, inst) }
  }

  async function convert(vocals, dir, voice, pitch) {
    const p = P()
    const out = join(dir, 'vocals_rvc.wav')
    await run(p.python, ['core.py', 'infer', '--input-path', vocals, '--output-path', out, '--pth-path', voice.pth, '--index-path', voice.index || '',
      '--pitch', String(pitch), '--index-rate', voice.index ? '0.5' : '0', '--protect', '0.33', '--f0-method', 'rmvpe', '--export-format', 'WAV'],
    { cwd: p.applio, log, env: pyEnv(), timeoutMs: 20 * 60_000 })
    if (!existsSync(out)) throw new Error('变声没产出文件')
    return out
  }

  async function mix(vocals, inst, dir) {
    const c = cfg()
    const full = join(dir, 'cover.mp3')
    const vol = Math.max(0.2, Math.min(2, Number(c.vocalVolume) || 1))
    const iv = Math.max(0.1, Math.min(2, Number(c.instVolume) || 0.8))
    await run(P().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', vocals, '-i', inst, '-filter_complex',
      `[0:a]volume=${vol}[v];[1:a]volume=${iv}[i];[v][i]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95`, '-ac', '2', '-ar', '44100', '-b:a', '192k', full], { log })
    return full
  }

  /** 先截出要发的那一段再处理：分离和换声都只算这一段，快一倍多。返回 {file, cut, length}。 */
  async function cutFirst(song, dir) {
    const c = cfg()
    const dur = await ffprobeDuration(song)
    const w = clipWindow(dur, Number(c.maxVoiceSec) || 120, c.clipStart)
    if (!dur || (w.start === 0 && w.length >= dur)) return { file: song, cut: false, length: dur }
    const out = join(dir, 'part.wav')
    await run(P().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(w.start), '-t', String(w.length), '-i', song, '-ar', '44100', out], { log })
    return { file: out, cut: true, length: w.length }
  }

  /** 截过的段落首尾加淡入淡出，听起来不突兀。 */
  async function fade(mixed, dir, length) {
    const out = join(dir, 'voice.mp3')
    await run(P().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', mixed,
      '-af', `afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, length - 3)}:d=3`, '-b:a', '128k', out], { log })
    return out
  }

  async function process1(job) {
    const c = cfg()
    const voice = listVoices(P().models).find((v) => v.id === (job.voice || c.voice)) || listVoices(P().models)[0]
    if (!voice) throw new Error('还没有可用的音色模型')
    const pitch = Number.isFinite(Number(job.pitch)) ? Math.max(-24, Math.min(24, Math.round(Number(job.pitch)))) : Number(c.pitch) || 0
    const dir = join(work(), Date.now().toString(36))
    mkdirSync(dir, { recursive: true })
    current.stage = '下载歌曲'
    const song = job.file || (await download(job, dir))
    // 同一首歌、同一个音色、音高和截取方式做过的，直接复用
    const key = createHash('md5').update([job.songKey || song, voice.id, pitch, c.maxVoiceSec, c.clipStart].join('|')).digest('hex').slice(0, 16)
    const cached = join(work(), 'cache', key + '.mp3')
    if (existsSync(cached)) {
      log.info(`翻唱：「${job.title}」做过了，直接用缓存`)
      return { file: cached, voice: voice.id, pitch, dir }
    }
    current.stage = '截取要唱的那一段'
    const part = await cutFirst(song, dir)
    current.stage = '分离人声和伴奏'
    const { vocals, inst } = await separate(part.file, dir)
    current.stage = '换成她的声音'
    const converted = await convert(vocals, dir, voice, pitch)
    current.stage = '混音'
    const mixed = await mix(converted, inst, dir)
    const out = part.cut ? await fade(mixed, dir, part.length) : mixed
    mkdirSync(join(work(), 'cache'), { recursive: true })
    copyFileSync(out, cached)
    return { file: cached, voice: voice.id, pitch, dir }
  }

  async function pump() {
    if (current || !queue.length) return
    const job = queue.shift()
    current = { query: job.query, title: job.query, chatId: job.chatId, stage: '排队', startedAt: Date.now() }
    log.info(`翻唱开始：「${job.query}」→ ${job.chatId}`)
    try {
      const r = await process1(job)
      current.stage = '发送'
      await sendVoiceFile(job.chatId, r.file, `[翻唱] ${job.title || job.query}`)
      history.unshift({ at: Date.now(), title: job.title || job.query, voice: r.voice, pitch: r.pitch, ok: true, message: `用时 ${Math.round((Date.now() - current.startedAt) / 1000)} 秒` })
      log.info(`翻唱完成：「${job.title || job.query}」`)
      onSung?.(job.title || job.query, job.chatId)
      if (!cfg().keepWork) try { rmSync(r.dir, { recursive: true, force: true }) } catch (error) {}
    } catch (error) {
      history.unshift({ at: Date.now(), title: job.title || job.query, ok: false, message: error.message })
      log.warn(`翻唱失败：「${job.query}」：`, error.message)
      sendText?.(job.chatId, `唱不了「${job.title || job.query}」：${error.message}`).catch(() => {})
    } finally {
      history = history.slice(0, 20)
      current = null
      pump()
    }
  }

  /** 点一首：马上返回，做好了自己发到聊天里。 */
  function request({ song, songId, file, pitch, voice, chatId }) {
    const c = cfg()
    if (!c.enabled) return { ok: false, message: '翻唱还没打开（面板「翻唱」标签里开）' }
    const st = status()
    if (!st.ready) return { ok: false, message: '翻唱环境还没装好：' + st.message }
    if (!song && !songId && !file) return { ok: false, message: '要说唱哪首歌' }
    if (queue.length >= 5) return { ok: false, message: '排队的歌太多了，等会儿再点' }
    queue.push({ query: song || basename(file || ''), songId, file, pitch, voice, chatId })
    const ahead = queue.length - 1 + (current ? 1 : 0)
    pump()
    return { ok: true, message: `开始准备「${song || basename(file || '')}」，大概要两三分钟${ahead ? `（前面还有 ${ahead} 首）` : ''}，做好了会直接发语音` }
  }

  return {
    status,
    install: () => { runInstall(); return { ok: true, message: '开始安装，要下载好几个 GB，可能要十几分钟' } },
    request,
    search: (q) => searchSongs(q, { cookie: cfg().neteaseCookie, limit: 8 }),
    account: () => account(cfg().neteaseCookie),
    voices: () => listVoices(P().models).map((v) => v.id),
    importModels: (filename, buf) => importModels(P().models, filename, buf),
    deleteVoice: (id) => deleteVoice(P().models, id),
  }
}
