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
  /** 消息中心：别人回我评论的列表。返回 [{id,name,text,awemeId,at}]。 */
  async function listCommentReplies() {
    await navigate('https://www.douyin.com/notice')
    await sleep(1200)
    // 尽量点到「评论」类 tab
    await evalJs(`(() => { const t=[...document.querySelectorAll('div,span,a,button')].find(el => /评论/.test((el.innerText||'').trim()) && (el.innerText||'').trim().length<=6); if(t) t.click() })()`).catch(() => {})
    await sleep(800)
    const raw = await evalJs(`(() => {
      try {
        const items = [...document.querySelectorAll('[class*=notice],[class*=message],[class*=comment],li,a')].slice(0,40);
        return items.map((el, i) => {
          const text = (el.innerText||'').slice(0,200);
          if (!/回复了你的评论|回复了你|回了你/.test(text) && !/评论/.test(text)) return null;
          const href = (el.closest('a')||el.querySelector('a')||el).href||'';
          const m = href.match(/video\/(\d{15,})/) || href.match(/modal_id=(\d{15,})/);
          const name = text.split(/\n|回复|：|:/)[0].slice(0,30);
          return { id: (m&&m[1]||'') + ':' + i + ':' + text.slice(0,40), name, text, awemeId: m&&m[1]||'', at: Date.now() };
        }).filter(Boolean).slice(0,15);
      } catch(e){ return []; }
    })()`).catch(() => [])
    return Array.isArray(raw) ? raw : []
  }
  async function resolveUser(input) {
    // input: {secUid} | {uniqueId} | {short} — 同时尽量抠数字 uid（IM friend 查找要用）
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
    const info = await evalJs(`(() => {
      const u = location.href;
      const m = u.match(/user\\/([A-Za-z0-9_-]{20,})/);
      const html = document.documentElement.innerHTML || '';
      const uidM = html.match(/"uid"\\s*:\\s*"?(\\d{5,20})"?/)
        || html.match(/"user_id"\\s*:\\s*"?(\\d{5,20})"?/)
        || html.match(/"userId"\\s*:\\s*"?(\\d{5,20})"?/);
      const name = (document.querySelector('h1,h2,[data-e2e="user-info"]') || {}).innerText || '';
      const img = (document.querySelector('img[src*="avatar"],img[class*=avatar]') || {}).src || '';
      return {
        secUid: (m && m[1]) || '',
        uid: (uidM && uidM[1]) || '',
        nickname: (name || '').split('\\n')[0].slice(0, 40),
        avatar: img || '',
      };
    })()`).catch(() => null)
    if (!info?.secUid) return { ok: false, message: '打开主页后还是认不出 sec_uid，请改用主页链接' }
    return { ok: true, ...info }
  }
  async function selfInfo() {
    const info = await evalJs(`(() => { try { const m=document.documentElement.innerHTML.match(/"secUid"\\s*:\\s*"([A-Za-z0-9_-]{20,})"/)||document.documentElement.innerHTML.match(/"sec_uid"\\s*:\\s*"([A-Za-z0-9_-]{20,})"/); const n=document.documentElement.innerHTML.match(/"nickname"\\s*:\\s*"([^"]{1,40})"/); return { secUid: m&&m[1]||'', nickname: n&&n[1]||'' } } catch(e){ return { secUid:'', nickname:'' } } })()`).catch(() => ({ secUid: '', nickname: '' }))
    return info || { secUid: '', nickname: '' }
  }

  async function openEditProfile() {
    const self = await selfInfo()
    if (!self?.secUid) throw new Error('认不出自己的抖音主页')
    await navigate(`https://www.douyin.com/user/${self.secUid}`)
    await sleep(1200)
    const clicked = await evalJs(`(() => {
      const nodes = [...document.querySelectorAll('button,a,div,span')];
      const t = nodes.find(n => {
        const tx = (n.innerText || n.getAttribute('aria-label') || '').trim();
        return /^(编辑资料|编辑个人信息)$/.test(tx) || (n.dataset && n.dataset.e2e === 'user-info-edit');
      });
      if (!t) return false;
      t.click();
      return true;
    })()`)
    if (!clicked) throw new Error('找不到「编辑资料」入口')
    await sleep(900)
    return { ok: true, secUid: self.secUid }
  }

  async function clickSaveProfile() {
    const ok = await evalJs(`(() => {
      const b = [...document.querySelectorAll('button,[role=button],div,span')].find(el => {
        const tx = (el.innerText || el.getAttribute('aria-label') || '').trim();
        return /^(保存|完成|确定)$/.test(tx);
      });
      if (!b) return false;
      b.click();
      return true;
    })()`)
    if (!ok) throw new Error('找不到保存按钮')
    await sleep(1000)
  }

  async function readProfileFields() {
    return await evalJs(`(() => {
      const nickEl = document.querySelector('input[placeholder*="昵称"],input[name*=nick],input[name*=name]')
        || [...document.querySelectorAll('input')].find(i => /昵称/.test((i.getAttribute('aria-label')||'')+(i.placeholder||'')));
      const signEl = document.querySelector('textarea[placeholder*="签名"],textarea[name*=sign],textarea[name*=desc]')
        || [...document.querySelectorAll('textarea')].find(t => /签名|简介|介绍/.test((t.getAttribute('aria-label')||'')+(t.placeholder||'')))
        || document.querySelector('textarea');
      const nick = nickEl ? String(nickEl.value || nickEl.textContent || '').trim() : '';
      const sign = signEl ? String(signEl.value || signEl.textContent || '').trim() : '';
      return { nickname: nick, signature: sign };
    })()`).catch(() => ({ nickname: '', signature: '' })) || { nickname: '', signature: '' }
  }

  /** 改昵称：打开编辑资料 → 填昵称 → 保存 → 读回核对。 */
  async function editNickname(text) {
    const want = String(text || '').trim()
    if (!want) throw new Error('昵称不能是空的')
    await openEditProfile()
    const esc = JSON.stringify(want)
    const filled = await evalJs(`(() => {
      const t = ${esc};
      const el = document.querySelector('input[placeholder*="昵称"],input[name*=nick],input[name*=name]')
        || [...document.querySelectorAll('input')].find(i => /昵称/.test((i.getAttribute('aria-label')||'')+(i.placeholder||'')))
        || document.querySelector('input[type=text],input:not([type])');
      if (!el) return false;
      el.focus();
      el.value = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    if (!filled) throw new Error('找不到昵称输入框')
    await clickSaveProfile()
    await openEditProfile().catch(() => {})
    const back = await readProfileFields()
    if (back.nickname && back.nickname !== want) throw new Error(`保存后昵称对不上：想改成「${want}」，读到「${back.nickname}」`)
    return { ok: true, nickname: want }
  }

  /** 改签名：打开编辑资料 → 填签名 → 保存 → 读回核对。 */
  async function editSignature(text) {
    const want = String(text || '').trim()
    if (!want) throw new Error('签名不能是空的')
    await openEditProfile()
    const esc = JSON.stringify(want)
    const filled = await evalJs(`(() => {
      const t = ${esc};
      const el = document.querySelector('textarea[placeholder*="签名"],textarea[name*=sign],textarea[name*=desc]')
        || [...document.querySelectorAll('textarea')].find(x => /签名|简介|介绍/.test((x.getAttribute('aria-label')||'')+(x.placeholder||'')))
        || document.querySelector('textarea,[contenteditable=true]');
      if (!el) return false;
      el.focus();
      if (el.isContentEditable) {
        el.textContent = t;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        el.value = t;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    })()`)
    if (!filled) throw new Error('找不到签名输入框')
    await clickSaveProfile()
    await openEditProfile().catch(() => {})
    const back = await readProfileFields()
    if (back.signature && back.signature !== want) throw new Error(`保存后签名对不上：想改成「${want}」，读到「${back.signature}」`)
    return { ok: true, signature: want }
  }

  /** 换头像：打开编辑资料 → 点头像上传 → 设本地文件 → 保存。filePath 必须是本机可读图片。 */
  async function editAvatar(filePath) {
    const path = String(filePath || '').trim()
    if (!path) throw new Error('没有头像文件')
    await openEditProfile()
    // 尽量点到头像 / 更换头像
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('button,a,div,span,img')].find(el => {
        const tx = (el.innerText || el.getAttribute('aria-label') || '').trim();
        return /更换头像|修改头像|上传头像|头像/.test(tx) && tx.length < 20;
      });
      if (b) b.click();
    })()`).catch(() => {})
    await sleep(600)
    const inputInfo = await evalJs(`(() => {
      const inp = document.querySelector('input[type=file][accept*="image"],input[type=file]');
      if (!inp) return null;
      if (!inp.id) inp.id = 'aurabot-dy-avatar-input';
      return { id: inp.id };
    })()`).catch(() => null)
    if (!inputInfo?.id) throw new Error('找不到头像上传控件')
    // CDP Dom.setFileInputFiles
    if (!session || session.closed) throw new Error('浏览器没连上')
    await session.send('DOM.enable').catch(() => {})
    const doc = await session.send('DOM.getDocument', { depth: 1 })
    const node = await session.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `#${inputInfo.id}, input[type=file]` })
    if (!node?.nodeId) throw new Error('CDP 找不到 file input')
    await session.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [path] })
    await sleep(1200)
    await clickSaveProfile()
    return { ok: true, path }
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
    clickLike, openComments, typeAndSend, clickFollow, listCommentReplies,
    resolveUser, selfInfo, pageText, evalJs,
    editNickname, editSignature, editAvatar,
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
    liked: [], commented: [], followed: [], dmReplies: [],
    self: script.self || { secUid: 'self_sec', nickname: '肥鱼抖音' },
    signature: script.signature || '',
    avatarPath: '',
    owner: script.owner || { secUid: 'owner_sec', uid: 'owner_uid', nickname: '主人', avatar: 'https://x/a~tplv.jpg' },
    commentReplies: script.commentReplies || [],
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
    listCommentReplies: async () => (state.commentReplies || []).slice(),
    resolveUser: async (input) => {
      if (script.resolveFail) return { ok: false, message: '认不出' }
      if (input.secUid === state.owner.secUid || input.uniqueId || input.short || input.secUid) {
        return {
          ok: true,
          secUid: state.owner.secUid,
          uid: String(state.owner.uid || ''),
          nickname: state.owner.nickname,
          avatar: state.owner.avatar,
        }
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
    editNickname: async (text) => {
      await gate()
      if (script.profileFail) throw new Error(script.profileFailMessage || '改昵称失败')
      if (state.verify) throw new Error(state.reason || '要验证')
      const want = String(text || '').trim()
      state.self = { ...state.self, nickname: want }
      state.log.push(['editNickname', want])
      return { ok: true, nickname: want }
    },
    editSignature: async (text) => {
      await gate()
      if (script.profileFail) throw new Error(script.profileFailMessage || '改签名失败')
      if (state.verify) throw new Error(state.reason || '要验证')
      const want = String(text || '').trim()
      state.signature = want
      state.log.push(['editSignature', want])
      return { ok: true, signature: want }
    },
    editAvatar: async (filePath) => {
      await gate()
      if (script.profileFail) throw new Error(script.profileFailMessage || '换头像失败')
      if (state.verify) throw new Error(state.reason || '要验证')
      const path = String(filePath || '').trim()
      if (!path) throw new Error('没有头像文件')
      state.avatarPath = path
      state.log.push(['editAvatar', path])
      return { ok: true, path }
    },
    /** 测用：看副作用 */
    _state: state,
  }
}
