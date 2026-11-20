// 浏览器进程：启动、等调试口、关闭、孤儿回收。
//
// 启动参数不是随便写的，几条都是踩出来的（详见验收记录）：
//   --no-sandbox  用户态装不了 setuid 的 chrome-sandbox，不关就直接崩（Trace/breakpoint trap）
//   窗口位置      自管虚拟屏时**必须 0,0**：放在 -2400,-2400 会被判成「被遮挡」，媒体管线静默挂起，
//                视频永远 readyState=0 且不报错。真实桌面下才用屏幕外。
//   --mute-audio  别把声音放到主人的音箱里
//   autoplay      播放/自动播放权限，否则 video.play() 被 NotAllowedError 拦

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { getJson, waitDebugger } from './cdp.js'

const SYSTEM_CANDIDATES = [
  process.env.EDGE_PATH,
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

/**
 * 找浏览器可执行文件。
 * 顺序：面板填的 → 插件自带（用户态解包）→ 系统里常见的。
 * @param {string} explicit 面板里填的路径
 * @param {string} root 插件的浏览器根目录（里面可能有 chrome/opt/google/chrome/google-chrome）
 */
export function findChrome(explicit = '', root = '', existsImpl) {
  const exists = existsImpl || ((p) => { try { return existsSync(p) } catch { return false } })
  if (explicit) return exists(explicit) ? explicit : ''
  const bundled = [
    root && join(root, 'chrome', 'opt', 'google', 'chrome', 'google-chrome'),
    root && join(root, 'chrome', 'opt', 'microsoft', 'msedge', 'msedge'),
  ].filter(Boolean)
  return [...bundled, ...SYSTEM_CANDIDATES].find(exists) || ''
}

/** 本机空闲端口。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

/** 读 /proc/<pid>/stat 的 starttime（第 22 个字段）。用来防止 PID 复用误杀。 */
function procStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm 可能带空格和括号，从最后一个 ) 之后切
    const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return rest[19] || '' // 第 22 字段（含 comm/state 偏移后是索引 19）
  } catch {
    return ''
  }
}

function procCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ')
  } catch {
    return ''
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' }
}

/**
 * 回收上次没关干净的浏览器。
 *
 * 只认**自己记录过的**那个 PID，而且三重校验（PID 活着 + starttime 对得上 + 命令行里是本服务的资料目录）。
 * 任何一项对不上就只报警不动手 —— 按进程名全局 kill 会误杀别人家的 Chrome。
 *
 * @param {{ profileDir: string, stateFile: string, log?: object }} o
 */
export function reclaimOrphan({ profileDir, stateFile, log }) {
  let saved
  try {
    saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return { reclaimed: false }
  }
  const pid = Number(saved?.pid) || 0
  if (!pid || !pidAlive(pid)) {
    rmSync(stateFile, { force: true })
    return { reclaimed: false }
  }
  const sameStart = saved?.starttime && procStartTime(pid) === saved.starttime
  const sameCmd = procCmdline(pid).includes(`--user-data-dir=${profileDir}`)
  if (!sameStart || !sameCmd) {
    log?.warn?.(`发现 PID ${pid} 但身份对不上（starttime/命令行），不敢动它；请手动确认`)
    return { reclaimed: false, suspicious: true, pid }
  }
  log?.info?.(`回收上次残留的浏览器进程 PID ${pid}`)
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} }
  const end = Date.now() + 3000
  while (Date.now() < end && pidAlive(pid)) {
    // 同步等一小会儿：这里在启动路径上，不能 await 太久
    const until = Date.now() + 100
    while (Date.now() < until) { /* spin */ }
  }
  if (pidAlive(pid)) {
    try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
  }
  rmSync(stateFile, { force: true })
  return { reclaimed: true, pid }
}

/**
 * 起一个浏览器。
 * @param {{
 *   profileDir: string,
 *   stateFile: string,
 *   bin: string,
 *   display: string,
 *   displayOwned?: boolean,
 *   headless?: boolean,
 *   windowSize?: string,
 *   extraArgs?: string[],
 *   log?: object,
 * }} o
 */
export async function launchBrowser({
  profileDir, stateFile, bin, display, displayOwned = false,
  headless = false, windowSize = '1280,860', extraArgs = [], log,
}) {
  if (!bin) throw new Error('找不到浏览器可执行文件')
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })

  reclaimOrphan({ profileDir, stateFile, log })

  const port = await freePort()
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion',
    `--window-size=${windowSize}`,
    // 自己起的虚拟屏没人看得见 → 窗口放 0,0。放屏幕外会被判成被遮挡，媒体管线挂起。
    // 真实桌面下才挪到屏幕外，不抢主人的前台。
    `--window-position=${displayOwned ? '0,0' : '-2400,-2400'}`,
    ...(headless ? ['--headless=new'] : ['--no-sandbox']),
    ...extraArgs,
    'about:blank',
  ]

  const child = spawn(bin, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
    env: { ...process.env, DISPLAY: display || '' },
  })

  // stderr 收着但只留最后几 KB：启动失败时要能给出真实原因，而不是一律报「资料目录被占用」
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (c) => {
    stderr = (stderr + c).slice(-4000)
  })

  let exited = null
  child.on('exit', (code, signal) => { exited = { code, signal } })
  child.on('error', (error) => { exited = { error } })
  child.unref?.()

  const ok = await waitDebugger(port, 20000)
  if (!ok) {
    const reason = exited
      ? (exited.error ? exited.error.message : `进程退出了（${exited.code ?? exited.signal}）`)
      : '20 秒内调试口没响应'
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    const tail = stderr.trim().split('\n').slice(-3).join('；')
    const error = new Error(`浏览器没起来：${reason}${tail ? `｜${tail}` : ''}`)
    error.stderr = stderr
    throw error
  }

  // 自己记一份状态：Edge/Chrome 有些版本不写 DevToolsActivePort，而且我们要靠它做孤儿回收
  try {
    writeFileSync(stateFile, JSON.stringify({
      pid: child.pid,
      starttime: procStartTime(child.pid),
      port,
      profileDir,
      at: Date.now(),
    }), { mode: 0o600 })
  } catch {}

  const version = await getJson(`http://127.0.0.1:${port}/json/version`, 3000).catch(() => ({}))
  log?.info?.(`浏览器已启动：${bin}（${version.Browser || '?'}），调试口 127.0.0.1:${port}`)

  return {
    pid: child.pid,
    port,
    browser: version.Browser || '',
    stderrTail: () => stderr,
    /** 关掉：先 TERM 整个进程组，等一会儿再 KILL。幂等。 */
    async stop({ graceMs = 5000 } = {}) {
      const alive = () => pidAlive(child.pid)
      if (!alive()) { rmSync(stateFile, { force: true }); return }
      try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
      const end = Date.now() + graceMs
      while (Date.now() < end && alive()) await sleep(100)
      if (alive()) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
      }
      rmSync(stateFile, { force: true })
    },
  }
}