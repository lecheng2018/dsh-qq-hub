// 共享浏览器服务：谁在用、用到什么时候、什么时候该关。
//
// 一个进程、每模块一个标签页、任务串行。
// 为什么不排队：可用内存本来就只有 2 GB 出头，排队会让任务和闭包堆在那儿，更容易被 OOM 杀掉。
// 宁可立刻告诉调用方「忙」，让它下轮再来。

import { mkdirSync, readFileSync } from 'node:fs'
import { freemem } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ensureDisplay, findXvfb } from './display.js'
import { connectCdp, installRequestGuard } from './cdp.js'
import { findChrome, launchBrowser } from './process.js'
import { libDirsUnder as libDirsOf } from './install.js'
import { createPolicy, DENY_ALL } from './policy.js'
import { createTabPool } from './tabs.js'
import { getCookies, setCookies, clearOrigin } from './cookies.js'

/** 当前可用内存（MB）。读不到就返回 -1（当作未知，不拦）。 */
export function memAvailableMB() {
  try {
    const m = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m)
    if (m) return Math.round(Number(m[1]) / 1024)
  } catch {}
  try {
    return Math.round(freemem() / 1048576)
  } catch { return -1 }
}

const BUSY = (msg) => {
  const e = new Error(msg)
  e.code = 'BUSY'
  return e
}

/**
 * 造一个浏览器服务。**导入本身不启动任何进程**，只有 acquire() 才会。
 *
 * @param {{
 *   root: string,                       // 放 profile / xvfb / chrome 的目录
 *   log?: object,
 *   getConfig: () => object,
 *   policies?: Record<string, string[]>, // 模块 → 允许的域名
 *   vncStarter?: (opts: object) => Promise<object>, // 注入用（测试）
 * }} o
 */
export function createBrowserService({ root, log, getConfig, policies = {}, vncStarter, deps = {} }) {
  // 依赖可注入：单测里不用真的装 Xvfb/Chrome，换成假的就能跑完控制流
  const ensureDisplayFn = deps.ensureDisplay || ensureDisplay
  const launchBrowserFn = deps.launchBrowser || launchBrowser
  const connectCdpFn = deps.connectCdp || connectCdp
  const findChromeFn = deps.findChrome || findChrome
  const findXvfbFn = deps.findXvfb || findXvfb
  const memAvailableFn = deps.memAvailable || memAvailableMB
  const createPoolFn = deps.createTabPool || createTabPool
  const cfg = () => getConfig()?.browser || {}
  const stateFile = () => join(root, 'browser-state.json')
  const profileDir = () => join(root, 'profile')

  let state = 'idle' // idle | starting | ready | closing
  let starting = null
  let display = null
  let proc = null
  let pool = null
  let idleTimer = null
  let vnc = null
  const leases = new Map()   // moduleId → { released, at }
  const attached = new Map() // moduleId → { cdp, offGuard }

  function touchIdle() {
    if (idleTimer) clearTimeout(idleTimer)
    const minutes = Number(cfg().idleMinutes ?? 10)
    if (!(minutes > 0)) return
    idleTimer = setTimeout(() => {
      const busy = [...leases.values()].some((l) => !l.released)
      if (busy) return touchIdle()
      shutdown('空闲超时').catch(() => {})
    }, minutes * 60_000)
    idleTimer.unref?.()
  }

  /** 探测能不能用。只读，不启动任何东西。 */
  async function probe() {
    const c = cfg()
    const issues = []
    const chrome = findChromeFn(c.chromePath || '', root)
    if (!chrome) issues.push('找不到浏览器：面板填个路径，或跑一次 install:browser')
    const hasDisplay = Boolean(process.env.DISPLAY) || Boolean(findXvfbFn(root))
    if (!hasDisplay) issues.push('没有显示服务：跑一次 install:browser（会装自带 Xvfb）')
    const free = memAvailableFn()
    const need = Number(c.minFreeMB ?? 600)
    if (free >= 0 && free < need) issues.push(`可用内存只剩 ${free} MB（低于 ${need} MB），先关掉别的程序`)
    return { ok: issues.length === 0, issues, chrome, freeMB: free, state }
  }

  async function start() {
    if (state === 'ready') return
    if (starting) return starting
    state = 'starting'
    starting = (async () => {
      const c = cfg()
      const verdict = await probe()
      if (!verdict.ok) {
        state = 'idle'
        const e = new Error(verdict.issues.join('；'))
        e.code = 'NOT_READY'
        throw e
      }
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 })
        display = await ensureDisplayFn({ root, log })
        proc = await launchBrowserFn({
          profileDir: profileDir(),
          stateFile: stateFile(),
          bin: verdict.chrome,
          display: display.display,
          displayOwned: display.owned,
          headless: Boolean(c.headless),
          // 用户态装的那份把依赖库解开在自己目录里，启动时要指过去
          extraLibPath: libDirsOf(root),
          log,
        })
        pool = createPoolFn({ port: proc.port, log })
        state = 'ready'
      } catch (error) {
        state = 'idle'
        try { display?.stop?.() } catch {}
        display = null
        proc = null
        pool = null
        throw error
      }
    })().finally(() => { starting = null })
    return starting
  }

  function policyFor(moduleId) {
    const list = policies[moduleId]
    return Array.isArray(list) ? createPolicy(list) : DENY_ALL
  }

  /** 拿（或重建）某个模块的 CDP 连接，并把请求拦截装好。 */
  async function attach(moduleId) {
    const cur = attached.get(moduleId)
    if (cur && !cur.cdp.closed) return cur
    if (cur) { try { await cur.offGuard?.() } catch {} ; attached.delete(moduleId) }

    const tab = await pool.acquire(moduleId)
    const cdp = connectCdpFn(tab.wsUrl)
    await cdp.ready
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable', { maxResourceBufferSize: 20e6, maxTotalBufferSize: 100e6 })
    await cdp.send('Page.setMuted', { muted: true }).catch(() => {})

    const policy = policyFor(moduleId)
    let offGuard = null
    try {
      offGuard = await installRequestGuard(cdp, policy, {
        onBlock: (url, reason) => log?.debug?.(`[${moduleId}] 拦下 ${url}：${reason}`),
      })
    } catch (error) {
      log?.debug?.(`[${moduleId}] 请求拦截没装上（只用导航前检查）：${error.message}`)
    }
    const rec = { cdp, offGuard }
    attached.set(moduleId, rec)
    return rec
  }

  function makeLease(moduleId, cdp, { timeoutMs }) {
    const policy = policyFor(moduleId)
    let released = false
    const release = () => {
      if (released) return
      released = true
      leases.set(moduleId, { released: true, at: Date.now() })
      touchIdle()
    }

    function assertLive() {
      if (released) throw BUSY(`模块 ${moduleId} 的租约已经释放`)
      if (cdp.closed) throw new Error('浏览器连接断了')
    }

    function checkUrl(url) {
      const verdict = policy.check(url)
      if (!verdict.ok) {
        const e = new Error(verdict.reason || '网址不在白名单')
        e.code = 'BLOCKED'
        throw e
      }
      return url
    }

    const lease = {
      moduleId,
      release,
      get released() { return released },

      goto: async (url, { waitMs = 8000 } = {}) => {
        assertLive()
        checkUrl(url)
        const loaded = new Promise((resolve) => {
          const off = cdp.on('Page.loadEventFired', () => { off(); resolve() })
          // 不能 unref：goto 在等这个计时器（页面不触发 load 时靠它到点返回）
          const t = setTimeout(() => { off(); resolve() }, waitMs)
        })
        await cdp.send('Page.navigate', { url })
        await loaded
      },

      content: async () => {
        assertLive()
        const r = await cdp.send('Runtime.evaluate', {
          expression: '({ html: document.documentElement.outerHTML, url: location.href, title: document.title })',
          returnByValue: true,
        })
        return r.result?.value || { html: '', url: '', title: '' }
      },

      evaluate: async (expression, { timeoutMs: ms = 30000 } = {}) => {
        assertLive()
        const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms)
        if (r.exceptionDetails) {
          throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text || '页面脚本出错')
        }
        return r.result?.value
      },

      waitFor: async (selector, { timeoutMs: ms = 10000 } = {}) => {
        assertLive()
        const end = Date.now() + ms
        while (Date.now() < end) {
          const box = await lease.evaluate(`(() => {
            const n = document.querySelector(${JSON.stringify(selector)})
            if (!n) return null
            n.scrollIntoView({ block: 'center', inline: 'center' })
            const r = n.getBoundingClientRect()
            if (r.width <= 0 || r.height <= 0) return null
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: (n.innerText || '').slice(0, 200) }
          })()`).catch(() => null)
          if (box) return box
          await sleep(300)
        }
        return null
      },

      click: async (x, y) => {
        assertLive()
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
          await sleep(40 + Math.random() * 60)
        }
      },

      press: async (selector) => {
        assertLive()
        const r = await lease.evaluate(`(() => {
          const n = document.querySelector(${JSON.stringify(selector)})
          if (!n) return null
          n.scrollIntoView({ block: 'center', inline: 'center' })
          if (document.visibilityState !== 'visible') {
            for (const t of ['mouseover','mousedown','mouseup','click']) n.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 }))
            return { dom: true }
          }
          const b = n.getBoundingClientRect()
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
        })()`)
        if (!r) return false
        if (!r.dom) await lease.click(r.x, r.y)
        return true
      },

      type: async (text) => {
        assertLive()
        await cdp.send('Input.insertText', { text })
      },

      clearFocused: async () => {
        assertLive()
        const key = async (k, code, vk, modifiers = 0) => {
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
        }
        await key('a', 'KeyA', 65, process.platform === 'darwin' ? 4 : 2)
        await key('Backspace', 'Backspace', 8)
      },

      pressEnter: async () => {
        assertLive()
        const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, text: '\r' })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k })
      },

      waitResponse: (urlRe, { timeoutMs: ms = 10000 } = {}) => {
        assertLive()
        return new Promise((resolve) => {
          const ids = new Map()
          const done = (v) => { offA(); offB(); clearTimeout(t); resolve(v) }
          const offA = cdp.on('Network.responseReceived', (p) => {
            if (urlRe.test(p.response?.url || '')) ids.set(p.requestId, { status: p.response.status, headers: p.response.headers || {} })
          })
          const offB = cdp.on('Network.loadingFinished', async (p) => {
            if (!ids.has(p.requestId)) return
            const b = await cdp.send('Network.getResponseBody', { requestId: p.requestId }).catch(() => null)
            let json = null
            try { json = JSON.parse(b?.base64Encoded ? Buffer.from(b.body, 'base64').toString() : b?.body) } catch {}
            done({ ...ids.get(p.requestId), json })
          })
          // 不能 unref：waitResponse 在等它
          const t = setTimeout(() => done(null), ms)
        })
      },

      screenshot: async ({ clip } = {}) => {
        assertLive()
        const r = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
        return r.data ? 'data:image/png;base64,' + r.data : ''
      },

      cookies: async (urls = []) => {
        assertLive()
        return getCookies(cdp, { urls })
      },

      setCookies: async (list) => {
        assertLive()
        return setCookies(cdp, list)
      },

      clearCookies: async (origin) => {
        assertLive()
        return clearOrigin(cdp, origin)
      },

      /**
       * 把窗口挪进/挪出屏幕。
       * 自管虚拟屏时**没人看得见**，这里只会返回一句说明 —— 要看画面请用 vnc()。
       */
      show: async (visible) => {
        assertLive()
        if (display?.owned) {
          return { ok: false, message: '当前是虚拟屏（无桌面），窗口挪进屏幕也看不见。用「远程看画面」或 VNC 连过来。' }
        }
        const { windowId } = await cdp.send('Browser.getWindowForTarget')
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {})
        await cdp.send('Browser.setWindowBounds', {
          windowId,
          bounds: visible
            ? { left: 80, top: 60, width: 1280, height: 860 }
            : { left: -2400, top: -2400, width: 1280, height: 860 },
        })
        if (visible) await cdp.send('Page.bringToFront').catch(() => {})
        return { ok: true }
      },

      /** 租约用途的兜底超时：到点自动释放，防止某个模块卡死把整台浏览器锁住。 */
      _armTimeout: () => {
        const t = setTimeout(() => {
          log?.warn?.(`模块 ${moduleId} 的浏览器任务超时（${Math.round(timeoutMs / 1000)} 秒），自动收回`)
          release()
        }, timeoutMs)
        t.unref?.()
        return () => clearTimeout(t)
      },
    }
    return lease
  }

  /**
   * 拿一个租约。
   * @param {string} moduleId
   * @param {{ timeoutMs?: number }} [o]
   */
  async function acquire(moduleId, { timeoutMs = 180_000 } = {}) {
    if (state === 'closing') throw BUSY('浏览器正在关闭')
    const cur = leases.get(moduleId)
    if (cur && !cur.released) throw BUSY(`模块 ${moduleId} 已经有浏览器任务在跑`)

    const c = cfg()
    const maxConcurrent = Math.max(1, Number(c.maxConcurrent ?? 2))
    const active = [...leases.values()].filter((l) => !l.released).length
    if (active >= maxConcurrent) throw BUSY('浏览器正忙，稍后再试')

    await start()
    const { cdp } = await attach(moduleId)
    const lease = makeLease(moduleId, cdp, { timeoutMs })
    const disarm = lease._armTimeout()
    const origRelease = lease.release
    lease.release = () => { disarm(); origRelease() }
    leases.set(moduleId, { released: false, at: Date.now() })
    touchIdle()
    return lease
  }

  /** 便捷写法：自动释放。 */
  async function withLease(moduleId, fn, opts) {
    const lease = await acquire(moduleId, opts)
    try { return await fn(lease) } finally { lease.release() }
  }

  function status() {
    const active = [...leases.entries()].filter(([, l]) => !l.released).map(([id]) => id)
    return {
      state,
      display: display?.display || '',
      displayOwned: Boolean(display?.owned),
      browser: proc?.browser || '',
      port: proc?.port || 0,
      tabs: pool?.size?.() || 0,
      active,
      freeMB: memAvailableFn(),
      vnc: vnc ? { port: vnc.port, running: true } : { running: false },
    }
  }

  /** 关掉浏览器与虚拟屏。给空闲超时和宿主退出用。 */
  async function shutdown(reason = '') {
    if (state === 'closing' || state === 'idle') return
    state = 'closing'
    try { if (idleTimer) clearTimeout(idleTimer) } catch {}
    if (reason) log?.info?.(`关闭浏览器：${reason}`)
    for (const [id, rec] of attached) {
      try { await rec.offGuard?.() } catch {}
      try { rec.cdp.close() } catch {}
      attached.delete(id)
    }
    leases.clear()
    try { await pool?.closeAll?.() } catch {}
    pool = null
    try { await proc?.stop?.() } catch (error) { log?.warn?.('关浏览器出错：', error.message) }
    proc = null
    try { display?.stop?.() } catch {}
    display = null
    try { vnc?.stop?.() } catch {}
    vnc = null
    state = 'idle'
  }

  /**
   * 远程看画面。自管虚拟屏时主人看不见窗口，只能靠 VNC。
   * @param {'start'|'stop'|'status'} action
   */
  async function vncControl(action) {
    if (action === 'status') return vnc ? { running: true, port: vnc.port, display: display?.display } : { running: false }
    if (action === 'stop') {
      try { vnc?.stop?.() } catch {}
      vnc = null
      return { running: false }
    }
    if (!display?.owned) {
      return { running: false, message: '当前用的是真实显示，直接看屏幕就行，不用 VNC' }
    }
    if (!vncStarter) return { running: false, message: '这个环境没有 VNC 组件' }
    if (vnc) return { running: true, port: vnc.port, message: 'VNC 已经在跑' }
    const started = await vncStarter({ display: display.display, root, log })
    vnc = started
    return { running: true, port: started.port, message: `用 VNC 客户端连 NAS 的 ${started.port} 端口就能看见浏览器` }
  }

  /** 浏览器被外部杀掉时，标记成需要重启，别让状态假 ready。 */
  function markBroken() {
    if (state !== 'ready') return
    log?.warn?.('浏览器进程没了，下次任务会重新启动')
    state = 'idle'
    proc = null
    pool = null
    attached.clear()
  }

  return {
    probe, acquire, withLease, status, shutdown, vnc: vncControl, markBroken,
    /** 宿主退出时调用。 */
    async dispose() { await shutdown('宿主退出') },
    /** 测试用：直接看内部状态。 */
    _internals: () => ({ state, display, proc, pool, leases, attached }),
  }
}