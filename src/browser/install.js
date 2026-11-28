// 用户态安装浏览器：不用 root、不动系统目录。
//
// 为什么不用 apt install：NAS 上 DSH 跑在普通用户下（本机 uid=959），没有 sudo；
// 而且系统里装什么版本不该由插件决定。这里把 deb 下下来、解包到插件自己的目录，
// 只给浏览器子进程用。
//
// 实测定下来的三条（都踩过）：
//   1. Debian 的 /usr/bin/chromium 是**壳脚本**，真二进制在 /usr/lib/chromium/chromium。
//      ldd 一个脚本永远报「零缺失」，所以必须找到真的 ELF 再检查。
//   2. 真实二进制会缺库（chromium 缺 libopenh264 / libharfbuzz-subset），
//      要把依赖包一起解出来，启动时用 LD_LIBRARY_PATH 指过去。
//   3. 官方 Chrome 自带的编解码器更全（H.264/AAC），有网优先用它；
//      下不动就退回 Debian chromium（H.264 靠 openh264，AAC 可能要另说）。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const CHROME_URL = 'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb'

// 允许下载安装包的域名（每次重定向的每一跳都要落在这些域内，且必须 https）
const TRUSTED_DOWNLOAD_HOSTS = ['dl.google.com', 'gvt1.com', 'googleusercontent.com']
const DOWNLOAD_MAX_BYTES = 300 * 1024 * 1024
const DOWNLOAD_MIN_BYTES = 1_000_000

/** 下载地址是否属于受信任域（含重定向目标）。 */
export function isTrustedDownloadUrl (url) {
  let u
  try { u = new URL(String(url || '')) } catch { return false }
  if (u.protocol !== 'https:') return false
  const host = String(u.hostname || '').toLowerCase().replace(/\.+$/, '')
  if (!host) return false
  return TRUSTED_DOWNLOAD_HOSTS.some((d) => host === d || host.endsWith('.' + d))
}
const MANIFEST = 'manifest.json'

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })

/** 命令在不在。 */
export function hasCommand(name) {
  // 名字只能作为位置参数（$1）传进 sh，绝不拼进脚本正文：
  // 旧写法 `command -v ${name}` 遇到 `sh; echo INJECTED` 会真的执行注入命令。
  const arg = String(name || '')
  if (!arg) return false
  return run('sh', ['-c', 'command -v -- "$1" >/dev/null 2>&1', '_', arg]).status === 0
}

/** 是不是真的 ELF 可执行文件（壳脚本不是）。 */
export function isElf(file) {
  try {
    const fd = readFileSync(file)
    return fd.length > 4 && fd[0] === 0x7f && fd[1] === 0x45 && fd[2] === 0x4c && fd[3] === 0x46
  } catch {
    return false
  }
}

/**
 * 从 deb 的 Depends 字段里挑出包名。
 * 处理 `foo (>= 1.2)`、`foo | bar`、`${misc:Depends}` 这些写法。
 * @param {string} text
 */
export function parseDepends(text) {
  const out = []
  for (const piece of String(text || '').split(',')) {
    const first = piece.split('|')[0].trim()
    const name = first.replace(/\s*\(.*?\)\s*/g, ' ').trim().split(/\s+/)[0]
    if (!name || name.includes('${')) continue
    if (!/^[a-z0-9][a-z0-9+.-]*$/i.test(name)) continue
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/** 这个包是不是已经装在系统里了。 */
export function isInstalled(pkg) {
  const r = run('dpkg', ['-s', pkg])
  return r.status === 0 && /^Status: install ok installed/m.test(r.stdout || '')
}

/**
 * 只拿**直接**依赖（不含自己）。
 * 不用 --recurse：那会把整个 GTK 依赖链（140+ 包）都拖进来，
 * 而这台机器本来就有大半；真正缺的往往只是几个直接依赖（libopenh264 这种）。
 */
export function directDeps(pkg) {
  if (!hasCommand('apt-cache')) return []
  const r = run('apt-cache', ['depends', '--no-recommends', '--no-suggests', pkg])
  if (r.status !== 0) return []
  const out = []
  for (const line of String(r.stdout || '').split('\n')) {
    const m = line.match(/^\s+(?:Depends|PreDepends):\s+(\S+)/)
    if (!m) continue
    const name = m[1]
    // `apt-cache` 会把「或者」的备选组写成 <xxx>，那不是真的包名
    if (name.startsWith('<')) continue
    if (name !== pkg && !out.includes(name)) out.push(name)
  }
  return out
}

/** 递归拿一个包的全部依赖名（不含自己）。没有 apt-cache 就返回空。 */
export function recursiveDeps(pkg) {
  if (!hasCommand('apt-cache')) return []
  const r = run('apt-cache', [
    'depends', '--recurse', '--no-recommends', '--no-suggests',
    '--no-conflicts', '--no-breaks', '--no-replaces', '--no-enhances', pkg,
  ])
  if (r.status !== 0) return []
  const out = []
  for (const line of String(r.stdout || '').split('\n')) {
    const m = line.match(/^\s+(?:Depends|PreDepends):\s+(\S+)/)
    if (!m) continue
    const name = m[1]
    if (name !== pkg && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * 解包出来的库目录（给 LD_LIBRARY_PATH 用）。
 * 既支持「所有包合并成一棵树」（root 自己就是前缀），也支持以前的一包一目录。
 */
export function libDirsUnder(root) {
  const dirs = []
  const push = (p) => { if (existsSync(p) && !dirs.includes(p)) dirs.push(p) }
  const probe = (base) => {
    push(join(base, 'usr', 'lib', 'x86_64-linux-gnu'))
    push(join(base, 'usr', 'lib64'))
    push(join(base, 'usr', 'lib'))
    push(join(base, 'lib', 'x86_64-linux-gnu'))
    push(join(base, 'lib'))
  }
  probe(root)
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return dirs }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    probe(join(root, e.name))
  }
  return dirs
}

/** 在某个目录里找指定名字的真 ELF（跳过壳脚本）。 */
function findElfIn(dir, name) {
  const p = join(dir, name)
  return existsSync(p) && isElf(p) ? p : ''
}

/** 在解包目录里找真正的浏览器 ELF（跳过壳脚本）。 */
export function findBrowserElf(dir) {
  const wanted = ['chrome', 'chromium', 'msedge']
  const hits = []
  const walk = (d, depth = 0) => {
    if (depth > 6) return
    let list = []
    try { list = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (wanted.includes(e.name) && isElf(p)) hits.push(p)
    }
  }
  walk(dir)
  // 优先「就在浏览器主目录下」的那个：/opt/google/chrome/chrome、/usr/lib/chromium/chromium
  hits.sort((a, b) => {
    const depthA = a.split('/').length
    const depthB = b.split('/').length
    return depthA - depthB || b.length - a.length
  })
  return hits[0] || ''
}

/** ldd 检查：返回缺失的库名列表。 */
export function missingLibs(elf, libDirs = []) {
  const env = { ...process.env }
  if (libDirs.length) env.LD_LIBRARY_PATH = [...libDirs, env.LD_LIBRARY_PATH || ''].filter(Boolean).join(':')
  const r = run('ldd', [elf], { env })
  if (r.status !== 0 && !r.stdout) return []
  const out = []
  for (const line of String(r.stdout || '').split('\n')) {
    const m = line.match(/^\s+(\S+)\s+=>\s+not found/)
    if (m) out.push(m[1])
  }
  return out
}

function readManifest(root) {
  try { return JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) } catch { return null }
}

function writeManifest(root, data) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(join(root, MANIFEST), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

/**
 * 装好了没有。manifest 里有并且二进制还在、库还齐，就算好了。
 * @param {string} root
 */
export function verifyInstalled(root) {
  const m = readManifest(root)
  if (!m?.browser || !existsSync(m.browser)) return { ok: false, reason: '还没装' }
  const libs = missingLibs(m.browser, m.libDirs || [])
  if (libs.length) return { ok: false, reason: `缺库：${libs.join(', ')}`, libs }
  // VNC 是后加进安装清单的：早先装过的机器上没有它。
  // 这里必须一起查，否则会一直说「已经装好了」，主人永远补不上远程看画面。
  if (!m.vnc || !existsSync(m.vnc)) {
    return { ok: false, reason: '缺远程看画面组件（x11vnc），重跑一次 install:browser 会补上', needVnc: true, manifest: m }
  }
  return { ok: true, manifest: m }
}

/** 换 Lab 目录用。 */
const cacheDir = (root) => join(root, 'downloads')

/**
 * 装浏览器 + 虚拟显示。
 *
 * @param {{
 *   root: string,
 *   browser?: 'auto'|'chrome'|'chromium',
 *   log?: object,
 *   smoke?: boolean,      // 装完真起一次（默认 true）
 * }} o
 */
export async function installBrowser({ root, browser = 'auto', log, smoke = true }) {
  const say = (m) => log?.info?.(m)
  const warn = (m) => log?.warn?.(m)

  if (process.platform !== 'linux' || process.arch !== 'x64') {
    return { ok: false, message: `这个安装器只处理 Linux x64；当前是 ${process.platform}/${process.arch}` }
  }
  for (const cmd of ['apt-get', 'dpkg-deb', 'ldd']) {
    if (!hasCommand(cmd)) return { ok: false, message: `缺 ${cmd}，这台机器不像 Debian/Ubuntu` }
  }

  const done = verifyInstalled(root)
  if (done.ok) {
    say(`已经装好了：${done.manifest.browser}`)
    return { ok: true, already: true, browser: done.manifest.browser, libDirs: done.manifest.libDirs }
  }

  mkdirSync(cacheDir(root), { recursive: true, mode: 0o700 })

  // ---- 1) 虚拟显示：xvfb + xserver-common ----
  // x11vnc 顺带装上：无桌面时主人要靠它看见浏览器去完成验证，单独再跑一次安装很折腾。
  // 只有 1 MB 出头。
  const pkgs = ['xvfb', 'xserver-common', 'x11vnc']
  say('准备虚拟显示（xvfb）和远程看画面（x11vnc）…')

  // ---- 2) 浏览器：优先官方 Chrome（编解码器更全），下不动退回 Debian chromium ----
  let chromeDeb = ''
  const wantChrome = browser === 'auto' || browser === 'chrome'
  if (wantChrome) {
    say('下载官方 Chrome…（约 150 MB；下不动会自动退回 Debian 的 chromium）')
    chromeDeb = await download(CHROME_URL, join(cacheDir(root), 'google-chrome.deb'), { log })
    if (!chromeDeb) {
      warn('官方 Chrome 没下下来，改用 Debian chromium')
      // 有条件时优先建议走发行版仓库（包有签名校验），比用户态解包更可信
      say('提示：如果能用 root，更推荐 `sudo apt-get install -y google-chrome-stable`（走签名仓库）后在面板指定系统 Chrome。')
    }
  }
  const useChromium = !chromeDeb
  if (useChromium) {
    if (browser === 'chrome') return { ok: false, message: '指定了 chrome 但下载失败' }
    say('用 Debian 的 chromium（走 apt 源，国内快）')
    pkgs.push('chromium', 'chromium-common')
  }

  // ---- 3) 收集依赖：只下宿主上没装的 ----
  const allDeps = new Set()
  for (const p of pkgs) for (const d of directDeps(p)) if (!isInstalled(d)) allDeps.add(d)

  say(`要补的依赖包：${allDeps.size ? [...allDeps].join(', ') : '（没有，宿主都有）'}`)

  // ---- 4) 下载 + 解包（**所有包解进同一棵树**）----
  //
  // 必须合并：Chromium 会在自己旁边找 icudtl.dat / *.pak / locales，
  // 而这些东西在 chromium-common 里。一包一目录会让它报
  // 「Invalid file descriptor to ICU data received」直接 SIGTRAP。
  const sys = join(root, 'sys')
  mkdirSync(sys, { recursive: true })
  const targets = [...pkgs, ...allDeps]
  let n = 0
  for (const p of targets) {
    n++
    say(`[${n}/${targets.length}] ${p}`)
    const file = await downloadPackage(p, root, { log })
    if (!file) { warn(`${p} 下不动，跳过（可能宿主已经有了）`); continue }
    const x = run('dpkg-deb', ['-x', file, sys])
    if (x.status !== 0) warn(`解包 ${p} 失败：${(x.stderr || '').trim()}`)
  }

  if (chromeDeb) {
    const x = run('dpkg-deb', ['-x', chromeDeb, sys])
    if (x.status !== 0) return { ok: false, message: `解包 Chrome 失败：${(x.stderr || '').trim()}` }
  }

  // ---- 5) 找真二进制 + 验库 ----
  const libDirs = libDirsUnder(sys)
  const elf = findBrowserElf(sys)
  if (!elf) return { ok: false, message: '解出来的包里找不到浏览器可执行文件' }

  // chromium 的真实二进制没有执行位（deb 里靠 postinst 设），补上
  try { chmodSync(elf, 0o755) } catch {}

  const missing = missingLibs(elf, libDirs)
  if (missing.length) {
    return {
      ok: false,
      message: `还是缺库：${missing.join(', ')}。让管理员装一下对应的包（或把 .deb 放进 ${cacheDir(root)} 再跑一次）`,
      missing,
      libDirs,
    }
  }

  // ---- 6) 冒烟：真起一次 ----
  const vncElf = findElfIn(join(sys, 'usr', 'bin'), 'x11vnc')
  const manifest = {
    browser: elf,
    kind: chromeDeb ? 'chrome' : 'chromium',
    libDirs,
    vnc: vncElf,
    root,
    installedAt: new Date().toISOString(),
  }
  writeManifest(root, manifest)

  if (smoke) {
    const sm = await smokeTest({ root, manifest, log })
    if (!sm.ok) return { ok: false, message: `装好了但起不来：${sm.message}`, manifest }
    manifest.smokeOk = true
    writeManifest(root, manifest)
  }

  say(`装好了：${elf}`)
  return { ok: true, browser: elf, kind: manifest.kind, libDirs, manifest }
}

async function download(url, dest, { log, sha256: expectSha } = {}) {
  try {
    // 逐跳校验：不用 redirect: 'follow'（那样中途跳到哪个域都看不到）
    let current = String(url || '')
    let res = null
    for (let hop = 0; hop < 5; hop++) {
      if (!isTrustedDownloadUrl(current)) {
        log?.warn?.(`拒绝从不受信任的地址下载：${current}`)
        return ''
      }
      const r = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(240_000) })
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const loc = r.headers.get('location')
        if (!loc) { log?.warn?.(`${current} 重定向没给目标`); return '' }
        // 丢弃这一跳的响应体（keep-alive 连接复用；不 cancel 会一直占着 socket）
        try { await r.body?.cancel?.() } catch {}
        current = new URL(loc, current).toString()
        continue
      }
      res = r
      break
    }
    if (!res || !res.ok) return ''
    const total = Number(res.headers.get('content-length') || 0)
    if (total && total > DOWNLOAD_MAX_BYTES) { log?.warn?.(`文件太大（${total} 字节），不下载`); return '' }
    // 流式写盘：arrayBuffer() 会把 150–300MB 整个读进内存（OOM 风险）
    const hash = createHash('sha256')
    let written = 0
    const meter = new Transform({
      transform (chunk, _enc, cb) {
        written += chunk.length
        if (written > DOWNLOAD_MAX_BYTES) return cb(new Error('文件超过 300MB 上限'))
        hash.update(chunk)
        cb(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(dest))
    if (written < DOWNLOAD_MIN_BYTES) { log?.warn?.(`${current} 只拿到 ${written} 字节，当失败`); return '' }
    const digest = hash.digest('hex')
    log?.info?.(`下载完成 ${dest}（${(written / 1048576).toFixed(1)}MB，sha256=${digest}）`)
    if (expectSha && String(expectSha).toLowerCase() !== digest) {
      log?.warn?.(`sha256 不符：期望 ${expectSha}，实际 ${digest}`)
      try { unlinkSync(dest) } catch {}
      return ''
    }
    return dest
  } catch (error) {
    log?.debug?.(`下载失败 ${url}：${error.message}`)
    try { unlinkSync(dest) } catch {}
    return ''
  }
}

async function downloadPackage(pkg, root, { log } = {}) {
  const dir = cacheDir(root)
  const r = run('apt-get', ['download', pkg], { cwd: dir })
  if (r.status !== 0) { log?.debug?.(`apt-get download ${pkg} 失败：${(r.stderr || '').trim()}`); return '' }
  // 必须按包名挑自己那个 .deb。
  // 早先按「目录里最新的 .deb」取，会拿到别的包（下载是串行的，上一个刚写完），
  // 解出来的目录是空的，还照样打了 .done 标记 —— 表现就是「明明下了却还缺库」。
  let files = []
  try { files = readdirSync(dir) } catch { return '' }
  const hit = files
    .filter((f) => f.startsWith(pkg + '_') && f.endsWith('.deb'))
    .sort()
    .pop()
  return hit ? join(dir, hit) : ''
}

/** 真起一次：Xvfb + 浏览器 + 读 CDP。 */
async function smokeTest({ root, manifest, log }) {
  const { ensureDisplay } = await import('./display.js')
  const { launchBrowser } = await import('./process.js')
  let display = null
  let proc = null
  try {
    display = await ensureDisplay({ root, log })
    proc = await launchBrowser({
      profileDir: join(root, 'smoke-profile'),
      stateFile: join(root, 'smoke-state.json'),
      bin: manifest.browser,
      display: display.display,
      displayOwned: display.owned,
      extraLibPath: manifest.libDirs,
      log,
    })
    if (!proc?.port) return { ok: false, message: '调试口没起来' }
    return { ok: true, version: proc.browser }
  } catch (error) {
    return { ok: false, message: error.message }
  } finally {
    try { await proc?.stop?.({ graceMs: 2000 }) } catch {}
    try { display?.stop?.() } catch {}
  }
}

/** 装了什么（给面板/探针看）。 */
export function installedInfo(root) {
  const m = readManifest(root)
  if (!m) return null
  return { ...m, present: existsSync(m.browser), sizeBytes: dirSize(root) }
}

function dirSize(dir) {
  let total = 0
  const walk = (d, depth = 0) => {
    if (depth > 4) return
    let list = []
    try { list = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      const p = join(d, e.name)
      try {
        if (e.isDirectory()) walk(p, depth + 1)
        else total += statSync(p).size
      } catch {}
    }
  }
  walk(dir)
  return total
}

export { CHROME_URL, MANIFEST }