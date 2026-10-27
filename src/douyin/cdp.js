// 抖音专用 Edge：独立用户资料 + 本机随机调试端口，经 CDP（Node 全局 WebSocket）控制。
// 不签 a_bogus：刷流靠被动截获页面自己的 Network.responseReceived。
// 所有真正点开浏览器的步骤都经「driver」接口，测时注入假驱动，不需要真开 Edge。

import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { looksLikeVerify, looksLimited, awemesFromResponse, isRecommendUrl } from './util.js'

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean)
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

export function findBrowser(explicit = '') {
  if (explicit && existsSync(explicit)) return explicit
  for (const p of [...EDGE_CANDIDATES, ...CHROME_CANDIDATES]) if (p && existsSync(p)) return p
  return ''
}

/** 本机空闲端口（127.0.0.1）。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

/** CDP WebSocket：发命令、收事件。wsFactory 方便测时替换。 */
export function createCdpSession(wsUrl, { wsFactory, log } = {}) {
  const WS = wsFactory || globalThis.WebSocket
  if (!WS) throw new Error('当前 Node 没有 WebSocket（请用 --experimental-websocket 或 Node ≥ 22）')
  let sock
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()
  let closed = false

  const emit = (method, params) => {
    for (const fn of listeners.get(method) || []) try { fn(params) } catch (error) { log?.debug?.('cdp listener', error.message) }
    for (const fn of listeners.get('*') || []) try { fn(method, params) } catch (error) {}
  }

  const open = () => new Promise((resolve, reject) => {
    sock = new WS(wsUrl)
    const t = setTimeout(() => reject(new Error('连不上浏览器调试端口')), 15000)
    sock.addEventListener('open', () => { clearTimeout(t); resolve() })
    sock.addEventListener('error', (e) => { clearTimeout(t); reject(e.error || e) })
    sock.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()) } catch (error) { return }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve: ok, reject: bad } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) bad(Object.assign(new Error(msg.error.message || 'CDP 出错'), { code: msg.error.code }))
        else ok(msg.result)
      } else if (msg.method) emit(msg.method, msg.params || {})
    })
    sock.addEventListener('close', () => {
      closed = true
      for (const [, { reject: bad }] of pending) bad(new Error('浏览器调试连接断了'))
      pending.clear()
    })
  })

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('浏览器已关'))
    const id = nextId++
    pending.set(id, { resolve, reject })
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    try { sock.send(JSON.stringify(payload)) } catch (error) { pending.delete(id); reject(error) }
  })

  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, new Set())
    listeners.get(method).add(fn)
    return () => listeners.get(method)?.delete(fn)
  }

  const close = () => { try { sock?.close() } catch (error) {} }

  return { open, send, on, close, get closed() { return closed } }
}

/** HTTP GET JSON（拉 /json/version、/json/list）。 */
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`读 ${url} 失败：${r.status}`)
  return r.json()
}

/**
 * 真浏览器驱动。profileDir = 独立用户资料目录；browserPath 可空（自动找）。
 * 返回的对象实现 createFakeDriver 同形接口，duty 只认这些方法。
 */
export function createBrowserDriver({ profileDir, browserPath = '', minimize = true, log, wsFactory } = {}) {
  let child = null
  let session = null
  let port = 0
  let pageSessionId = ''
  const feed = [] // 最近截到的 aweme
  const caps = { verify: false, reason: '' }
  let offNet = null

  const markVerify = (why) => { caps.verify = true; caps.reason = why || '要验证' }

  async function attachPage() {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`)
    const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || list?.[0]
    if (!page?.webSocketDebuggerUrl) throw new Error('浏览器没开出可调试的标签页')
    session = createCdpSession(page.webSocketDebuggerUrl, { wsFactory, log })
    await session.open()
    await session.send('Page.enable')
    await session.send('Runtime.enable')
    await session.send('Network.enable')
    offNet = session.on('Network.responseReceived', async (p) => {
      try {
        const url = p?.response?.url || ''
        if (!/douyin\.com|amemv\.com|snssdk\.com/.test(url)) return
        if (!/aweme|feed|recommend|comment|message|im\//i.test(url)) return
        const body = await session.send('Network.getResponseBody', { requestId: p.requestId }).catch(() => null)
        if (!body?.body) return
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
        if (looksLikeVerify(text) || looksLimited(text)) { markVerify(looksLikeVerify(text) ? '页面要验证' : '账号被限制'); return }
        let json
        try { json = JSON.parse(text) } catch (error) { return }
        const list = awemesFromResponse(json)
        for (const a of list) {
          if (!feed.some((x) => x.awemeId === a.awemeId)) feed.push(a)
        }
        if (feed.length > 80) feed.splice(0, feed.length - 80)
      } catch (error) { /* 单条响应失败不挡主流程 */ }
    })
  }

  async function launch() {
    if (session && !session.closed) return { ok: true }
    const bin = findBrowser(browserPath)
    if (!bin) return { ok: false, message: '找不到 Edge / Chrome。请在面板填浏览器路径，或先装好 Microsoft Edge。' }
    port = await freePort()
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      'https://www.douyin.com/?recommend=1',
    ]
    child = spawn(bin, args, { stdio: 'ignore', detached: true })
    child.unref()
    // 等调试端口起来
    let last = null
    for (let i = 0; i < 40; i++) {
      try {
        await getJson(`http://127.0.0.1:${port}/json/version`)
        last = null
        break
      } catch (error) { last = error; await sleep(250) }
    }
    if (last) return { ok: false, message: `浏览器开了但调试端口没起来：${last.message}` }
    await attachPage()
    if (minimize) await evalJs(`try{window.moveTo(0,0);window.resizeTo(900,700)}catch(e){}`).catch(() => {})
    return { ok: true }
  }

  async function evalJs(expression) {
    if (!session || session.closed) throw new Error('浏览器没连上')
    const r = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本出错')
    return r?.result?.value
  }

  async function navigate(url) {
    if (!session || session.closed) throw new Error('浏览器没连上')
    await session.send('Page.navigate', { url })
    await sleep(1500)
  }

  async function currentUrl() {
    return String(await evalJs('location.href') || '')
  }

  async function ensureRecommend() {
    const url = await currentUrl()
    if (isRecommendUrl(url)) return { ok: true, url }
    await navigate('https://www.douyin.com/?recommend=1')
    const again = await currentUrl()
    if (!isRecommendUrl(again)) return { ok: false, message: '打不开推荐页（可能卡在精选 / 登录）', url: again }
    return { ok: true, url: again }
  }

  /** 读页面可见文字，用来判定验证码 / 登录墙。 */
  async function pageText() {
    return String(await evalJs(`(document.body && (document.body.innerText||'')).slice(0,4000)`) || '')
  }

  async function checkGate() {
    if (caps.verify) return { ok: false, verify: true, reason: caps.reason || '要验证' }
    const t = await pageText().catch(() => '')
    if (looksLikeVerify(t)) { markVerify('页面要验证'); return { ok: false, verify: true, reason: '页面要验证' } }
    if (/扫码登录|短信登录|密码登录|登录后免费畅享|立即登录/.test(t) && !/消息|私信|关注/.test(t)) {
      return { ok: false, needLogin: true, reason: '还没登录抖音' }
    }
    return { ok: true }
  }

  /** 从最近截获的 feed 里取还没看过的；不够就在页面上「下滑」再等一会儿。 */
  async function nextAwemes({ seen = new Set(), want = 1 } = {}) {
    const out = []
    for (let try_ = 0; try_ < 6 && out.length < want; try_++) {
      for (const a of feed) {
        if (seen.has(a.awemeId) || out.some((x) => x.awemeId === a.awemeId)) continue
        out.push(a)
        if (out.length >= want) break
      }
      if (out.length >= want) break
      // 模拟下滑：滚一下 + 方向键
      await evalJs(`window.scrollBy(0, Math.floor(window.innerHeight*0.85)); document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`).catch(() => {})
      await sleep(1200 + Math.random() * 800)
    }
    return out
  }

  /** 当前正在播的 aweme_id：优先 URL，其次页面数据，再次最近 feed。 */
  async function activeAwemeId() {
    const fromUrl = await evalJs(`(() => { try { const u=new URL(location.href); return u.searchParams.get('modal_id')||(location.pathname.match(/\\/video\\/(\\d+)/)||[])[1]||'' } catch(e){ return '' } })()`).catch(() => '')
    if (fromUrl) return String(fromUrl)
    const fromDom = await evalJs(`(() => { const n=document.querySelector('[data-e2e="feed-active-video"] [data-e2e="video-unique-id"],[data-e2e="video-player"]'); const id=n && (n.getAttribute('data-video-id')||n.getAttribute('data-id')); if(id) return id; const m=(document.documentElement.innerHTML.match(/"aweme_id"\\s*:\\s*"(\\d{15,})"/)||[])[1]; return m||'' })()`).catch(() => '')
    if (fromDom) return String(fromDom)
    return feed.length ? feed[feed.length - 1].awemeId : ''
  }

  async function clickLike() {
    return Boolean(await evalJs(`(() => { const b=[...document.querySelectorAll('button,[role=button],div')].find(el => /点赞|喜欢/.test(el.getAttribute('aria-label')||'') || el.dataset?.e2e==='video-player-digg'); if(!b) return false; b.click(); return true })()`))
  }
  async function openComments() {
    return Boolean(await evalJs(`(() => { const b=[...document.querySelectorAll('button,[role=button],div')].find(el => /评论/.test(el.getAttribute('aria-label')||'') || el.dataset?.e2e==='feed-comment-icon'); if(!b) return false; b.click(); return true })()`))
  }
  async function typeAndSend(text) {
    const esc = JSON.stringify(String(text))
    return Boolean(await evalJs(`(() => { const t=${esc}; const box=document.querySelector('[contenteditable=true],textarea,input[type=text]'); if(!box) return false; box.focus(); if(box.isContentEditable){ box.textContent=t; box.dispatchEvent(new InputEvent('input',{bubbles:true})) } else { box.value=t; box.dispatchEvent(new Event('input',{bubbles:true})) } const send=[...document.querySelectorAll('button,[role=button]')].find(el => /发送|发布/.test(el.innerText||el.getAttribute('aria-label')||'')); if(send) send.click(); else box.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true })()`))
  }
  async function clickFollow() {
    return Boolean(await evalJs(`(() => { const b=[...document.querySelectorAll('button,[role=button]')].find(el => /关注/.test(el.innerText||'') && !/已关注|取消关注|互相关注/.test(el.innerText||'')); if(!b) return false; b.click(); return true })()`))
  }
  async function openShareTo(secUid) {
    // 打开分享 → 私信；真正选人依赖页面，测时用假驱动
    await evalJs(`(() => { const b=[...document.querySelectorAll('button,[role=button],div')].find(el => /分享/.test(el.getAttribute('aria-label')||'') || el.dataset?.e2e==='video-player-share'); if(b) b.click() })()`)
    await sleep(600)
    return { ok: true, secUid }
  }
  async function openDmThread(secUid) {
    await navigate(`https://www.douyin.com/user/${secUid}`)
    await sleep(1000)
    await evalJs(`(() => { const b=[...document.querySelectorAll('button,[role=button]')].find(el => /私信|发私信|消息/.test(el.innerText||'')); if(b) b.click() })()`).catch(() => {})
    return { ok: true }
  }
  async function listOwnerDms() {
    // 被动：读页面上「私信」列表文本；真机再核对 sec_uid。返回 [{secUid, nickname, text, at}]
    const raw = await evalJs(`(() => { try { return [...document.querySelectorAll('[data-e2e*="message"],[class*=message-item],[class*=conversation]')].slice(0,20).map(el => ({ text: (el.innerText||'').slice(0,200), href: (el.querySelector('a')||el).href||'' })) } catch(e){ return [] } })()`).catch(() => [])
    return (Array.isArray(raw) ? raw : []).map((x) => {
      const m = String(x.href || '').match(/user\/([A-Za-z0-9_-]{20,})/)
      return { secUid: m?.[1] || '', nickname: String(x.text || '').split('\n')[0] || '', text: String(x.text || '').split('\n').slice(1).join(' ').slice(0, 200), at: Date.now() }
    }).filter((x) => x.secUid || x.text)
  }
  async function resolveUser(input) {
    // input: {secUid} | {uniqueId} | {short}
    if (input.secUid) {
      await navigate(`https://www.douyin.com/user/${input.secUid}`)
    } else if (input.short) {
      await navigate(input.short)
      await sleep(1500)
    } else if (input.uniqueId) {
      await navigate(`https://www.douyin.com/search/${encodeURIComponent(input.uniqueId)}?type=user`)
      await sleep(1500)
      await evalJs(`(() => { const a=[...document.querySelectorAll('a[href*="/user/"]')].find(x => /user\\/[A-Za-z0-9_-]{20,}/.test(x.href)); if(a) location.href=a.href })()`).catch(() => {})
      await sleep(1200)
    } else return { ok: false, message: '认不出这个抖音号 / 链接' }
    const info = await evalJs(`(() => { const u=location.href; const m=u.match(/user\\/([A-Za-z0-9_-]{20,})/); const name=(document.querySelector('h1,h2,[data-e2e="user-info"]')||{}).innerText||''; const img=(document.querySelector('img[src*="avatar"],img[class*=avatar]')||{}).src||''; return { secUid: m&&m[1]||'', nickname: (name||'').split('\\n')[0].slice(0,40), avatar: img||'' } })()`).catch(() => null)
    if (!info?.secUid) return { ok: false, message: '打开主页后还是认不出 sec_uid，请改用主页链接' }
    return { ok: true, ...info }
  }
  async function selfInfo() {
    const info = await evalJs(`(() => { try { const m=document.documentElement.innerHTML.match(/"secUid"\\s*:\\s*"([A-Za-z0-9_-]{20,})"/)||document.documentElement.innerHTML.match(/"sec_uid"\\s*:\\s*"([A-Za-z0-9_-]{20,})"/); const n=document.documentElement.innerHTML.match(/"nickname"\\s*:\\s*"([^"]{1,40})"/); return { secUid: m&&m[1]||'', nickname: n&&n[1]||'' } } catch(e){ return { secUid:'', nickname:'' } } })()`).catch(() => ({ secUid: '', nickname: '' }))
    return info || { secUid: '', nickname: '' }
  }

  async function close() {
    try { offNet?.() } catch (error) {}
    try { session?.close() } catch (error) {}
    session = null
    if (child?.pid) try { process.kill(child.pid) } catch (error) {}
    child = null
  }

  return {
    launch, close, navigate, currentUrl, ensureRecommend, checkGate, nextAwemes, activeAwemeId,
    clickLike, openComments, typeAndSend, clickFollow, openShareTo, openDmThread, listOwnerDms,
    resolveUser, selfInfo, pageText, evalJs,
    /** 测 / 面板用：最近截到的视频 */
    recentFeed: () => feed.slice(),
    get paused() { return caps.verify },
    get pauseReason() { return caps.reason },
    markVerify,
  }
}

/** 测用假驱动：不启浏览器，按脚本吐视频 / 模拟点击。 */
export function createFakeDriver(script = {}) {
  const state = {
    url: 'https://www.douyin.com/?recommend=1',
    feed: script.feed || [],
    cursor: 0,
    verify: false,
    reason: '',
    needLogin: !!script.needLogin,
    liked: [], commented: [], followed: [], shared: [], dms: [], dmReplies: [],
    self: script.self || { secUid: 'self_sec', nickname: '肥鱼抖音' },
    owner: script.owner || { secUid: 'owner_sec', nickname: '主人', avatar: 'https://x/a~tplv.jpg' },
    inbox: script.inbox || [],
    log: [],
  }
  const gate = async () => {
    if (state.verify) return { ok: false, verify: true, reason: state.reason || '要验证' }
    if (state.needLogin) return { ok: false, needLogin: true, reason: '还没登录抖音' }
    return { ok: true }
  }
  return {
    launch: async () => ({ ok: true }),
    close: async () => {},
    navigate: async (url) => { state.url = url; state.log.push(['nav', url]) },
    currentUrl: async () => state.url,
    ensureRecommend: async () => {
      state.url = 'https://www.douyin.com/?recommend=1'
      if (script.stuckOnFeatured) return { ok: false, message: '打不开推荐页（可能卡在精选 / 登录）', url: 'https://www.douyin.com/?tab=home' }
      return { ok: true, url: state.url }
    },
    checkGate: gate,
    nextAwemes: async ({ seen = new Set(), want = 1 } = {}) => {
      const out = []
      while (out.length < want && state.cursor < state.feed.length) {
        const a = state.feed[state.cursor++]
        if (!seen.has(a.awemeId)) out.push(a)
      }
      return out
    },
    activeAwemeId: async () => {
      if (script.activeId) return script.activeId
      const last = state.feed[Math.max(0, state.cursor - 1)]
      return last?.awemeId || ''
    },
    clickLike: async () => { state.liked.push(await (async () => state.feed[Math.max(0, state.cursor - 1)]?.awemeId)()); return true },
    openComments: async () => true,
    typeAndSend: async (text) => { state.commented.push(text); return true },
    clickFollow: async () => { state.followed.push(state.feed[Math.max(0, state.cursor - 1)]?.authorSecUid); return true },
    openShareTo: async (secUid) => { state.shared.push(secUid); return { ok: true, secUid } },
    openDmThread: async (secUid) => { state.dms.push(secUid); return { ok: true } },
    listOwnerDms: async () => state.inbox.slice(),
    resolveUser: async (input) => {
      if (script.resolveFail) return { ok: false, message: '认不出' }
      if (input.secUid === state.owner.secUid || input.uniqueId || input.short || input.secUid) {
        return { ok: true, secUid: state.owner.secUid, nickname: state.owner.nickname, avatar: state.owner.avatar }
      }
      return { ok: false, message: '认不出这个抖音号 / 链接' }
    },
    selfInfo: async () => state.self,
    pageText: async () => (state.verify ? '请完成安全验证' : state.needLogin ? '扫码登录' : '推荐 关注'),
    evalJs: async () => null,
    recentFeed: () => state.feed.slice(),
    get paused() { return state.verify },
    get pauseReason() { return state.reason },
    markVerify: (why) => { state.verify = true; state.reason = why || '要验证' },
    /** 测用：看副作用 */
    _state: state,
  }
}
