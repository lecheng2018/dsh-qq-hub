// 虚拟显示（Xvfb）的生命周期。
//
// 干什么：Linux 上没有真实桌面时，给浏览器造一块「没人看得见的屏幕」。
// 为什么需要：浏览器的有头模式（不是无头）才能过抖音/小红书的无头检测，有头就要有 DISPLAY。
//
// 三个容易写错的地方（都踩过）：
//   1. 不能写死 :99 —— 会和别人占用的显示号撞车，也可能把上次遗留的 socket 当成「已就绪」。
//      用 `-displayfd` 让 X 自己挑一个空闲号写回来。
//   2. 收到数字 ≠ 可以用了 —— 还要等 X socket 真的能连上。
//   3. detached + unref 只让父进程不等它，**不负责清理**。必须自己记着句柄，退出时关掉。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const XSOCK_DIR = '/tmp/.X11-unix'

/** 在几个常见位置找 Xvfb：先用插件自带（用户态解包），再找系统的。 */
export function findXvfb(root = '') {
  const candidates = [
    root && join(root, 'xvfb', 'usr', 'bin', 'Xvfb'),
    '/usr/bin/Xvfb',
    '/usr/local/bin/Xvfb',
  ].filter(Boolean)
  return candidates.find((p) => {
    try { return existsSync(p) } catch { return false }
  }) || ''
}

/** X socket 能不能连上。比「文件存不存在」可靠：进程半死时 socket 文件可能还在。 */
export function canConnectX(display, timeoutMs = 1000) {
  const n = String(display || '').replace(/^:/, '').split('.')[0]
  if (!/^\d+$/.test(n)) return Promise.resolve(false)
  const path = join(XSOCK_DIR, 'X' + n)
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; try { sock.destroy() } catch {} ; resolve(v) } }
    const sock = net.connect(path)
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
    // 不能 unref：canConnectX 的 Promise 靠它收口
    const t = setTimeout(() => finish(false), timeoutMs)
  })
}

/** 等 X socket 出现并且能连上。 */
async function waitReady(display, deadlineMs) {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    if (await canConnectX(display)) return true
    await sleep(100)
  }
  return false
}

/**
 * 拿到一块可用的显示。
 * - 已有 DISPLAY（真实桌面 / 别人给的虚拟屏）→ 直接用，不碰进程
 * - 没有 → 起一个自己的 Xvfb，并把 display 号记下来
 *
 * 返回的 `display` 只该喂给浏览器子进程，**不要改 process.env**（那会污染整个 DSH）。
 *
 * @param {{ root?: string, log?: object, size?: string, timeoutMs?: number }} o
 */
export async function ensureDisplay({ root = '', log, size = '1280x1024x24', timeoutMs = 8000 } = {}) {
  const inherited = process.env.DISPLAY || process.env.WAYLAND_DISPLAY || ''
  if (inherited) {
    // DISPLAY 存在只算提示，真能连上才用；连不上就走自管（失效变量很常见）
    if (await canConnectX(inherited, 800)) {
      log?.debug?.(`复用已有显示 ${inherited}`)
      return { display: inherited, owned: false, stop: () => {} }
    }
    log?.warn?.(`DISPLAY=${inherited} 连不上，改用自管虚拟屏`)
  }

  const bin = findXvfb(root)
  if (!bin) {
    const error = new Error('没有可用的显示：没有 DISPLAY，也找不到 Xvfb。先跑一次 install:browser（或让管理员装 xvfb）')
    error.code = 'NO_DISPLAY'
    throw error
  }

  // -displayfd 3：让 X 把挑到的显示号写到 fd 3
  const child = spawn(bin, ['-displayfd', '3', '-screen', '0', size, '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  })

  let raw = ''
  let exited = null
  child.on('exit', (code, signal) => { exited = { code, signal } })
  child.on('error', (error) => { exited = { error } })

  const pipe = child.stdio[3]
  if (pipe) {
    pipe.setEncoding('utf8')
    pipe.on('data', (chunk) => { raw += chunk })
  }

  const deadline = Date.now() + timeoutMs
  let number = ''
  while (Date.now() < deadline) {
    if (exited) {
      const why = exited.error ? exited.error.message : `退出码 ${exited.code ?? exited.signal}`
      throw new Error(`Xvfb 启动失败：${why}`)
    }
    number = raw.trim().split(/\s+/)[0] || ''
    if (number) break
    await sleep(100)
  }

  const stop = () => {
    if (exited) return
    try { child.kill('SIGTERM') } catch {}
    // 不无限等：3 秒还没退就强杀，避免孤儿占着 socket
    const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 3000)
    t.unref?.()
  }

  if (!/^\d+$/.test(number)) {
    stop()
    throw new Error(`Xvfb 在 ${Math.round(timeoutMs / 1000)} 秒内没有报告显示号（可能 -displayfd 不被支持）`)
  }

  const display = ':' + number
  if (!await waitReady(display, 5000)) {
    stop()
    throw new Error(`Xvfb 报告了 ${display}，但那个显示连不上`)
  }

  log?.info?.(`已启动虚拟显示 ${display}（Xvfb ${bin}）`)
  return { display, owned: true, pid: child.pid, stop }
}