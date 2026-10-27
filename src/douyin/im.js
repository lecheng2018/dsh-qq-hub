// 抖音社交通道：douyin-im（无浏览器）。测时注入 createFakeImClient；真机动态 import('douyin-im')。
// 会话目录默认 dataDir('douyin','im')，凭证不进仓库。

import { mkdirSync } from 'node:fs'
import { dataDir } from '../core/store.js'

export const IM_NOT_LOGGED_IN = '抖音 IM 还没登录。请到面板「IM 登录」扫码 / 短信登录后再私信、分享或回主人私信。'

/** 测用假 IM：不碰真包、不写 session。 */
export function createFakeImClient(script = {}) {
  const state = {
    loggedIn: script.loggedIn !== false && !script.needLogin,
    needLogin: !!script.needLogin,
    uid: script.uid || 'self_uid',
    nickname: script.nickname || '肥鱼IM',
    secUid: script.secUid || 'self_sec',
    inbox: (script.inbox || []).slice(),
    sent: [],
    shared: [],
    peers: new Map(), // key uid → { uid, secUid, nickname }
    failSend: !!script.failSend,
    failMessage: script.failMessage || '发送失败：无回执',
    log: [],
  }
  for (const p of script.peers || []) {
    const peer = { uid: String(p.uid), secUid: String(p.secUid || ''), nickname: p.nickname || '' }
    state.peers.set(peer.uid, peer)
    if (peer.secUid) state.peers.set(`sec:${peer.secUid}`, peer)
  }
  // 默认塞一个主人 peer，方便测
  if (script.owner) {
    const o = {
      uid: String(script.owner.uid || 'owner_uid'),
      secUid: String(script.owner.secUid || 'owner_sec'),
      nickname: script.owner.nickname || '主人',
    }
    state.peers.set(o.uid, o)
    if (o.secUid) state.peers.set(`sec:${o.secUid}`, o)
  }

  function resolvePeer({ uid, secUid } = {}) {
    if (uid && state.peers.has(String(uid))) return { ok: true, ...state.peers.get(String(uid)) }
    if (secUid && state.peers.has(`sec:${secUid}`)) return { ok: true, ...state.peers.get(`sec:${secUid}`) }
    if (uid) {
      const peer = { uid: String(uid), secUid: String(secUid || ''), nickname: '' }
      state.peers.set(peer.uid, peer)
      return { ok: true, ...peer }
    }
    if (secUid) return { ok: false, message: `IM 里认不出对方（sec_uid=${secUid}），请先有会话或填数字 uid` }
    return { ok: false, message: '没有对方 uid / sec_uid' }
  }

  return {
    status() {
      return {
        loggedIn: state.loggedIn && !state.needLogin,
        needLogin: !state.loggedIn || state.needLogin,
        uid: state.loggedIn ? state.uid : '',
        secUid: state.loggedIn ? state.secUid : '',
        nickname: state.loggedIn ? state.nickname : '',
        reason: state.needLogin || !state.loggedIn ? '还没登录 IM' : '',
      }
    },
    async ensureOnline() {
      const st = this.status()
      if (!st.loggedIn) return { ok: false, message: IM_NOT_LOGGED_IN }
      return { ok: true }
    },
    async sendText(target, text) {
      const online = await this.ensureOnline()
      if (!online.ok) throw new Error(online.message)
      const peer = resolvePeer(target)
      if (!peer.ok) throw new Error(peer.message)
      if (state.failSend) throw new Error(state.failMessage)
      const msg = String(text || '')
      state.sent.push({ uid: peer.uid, secUid: peer.secUid, text: msg, at: Date.now() })
      state.log.push(['sendText', peer.uid, msg])
      return { ok: true, receipt: { clientMessageId: `fake-${state.sent.length}` } }
    },
    async shareWork(target, work, text = '') {
      const online = await this.ensureOnline()
      if (!online.ok) throw new Error(online.message)
      const peer = resolvePeer(target)
      if (!peer.ok) throw new Error(peer.message)
      if (state.failSend) throw new Error(state.failMessage)
      const itemId = String(work?.itemId || work?.awemeId || '')
      if (!itemId) throw new Error('没有作品 id，不能分享')
      state.shared.push({ uid: peer.uid, secUid: peer.secUid, itemId, text: String(text || ''), at: Date.now() })
      state.log.push(['shareWork', peer.uid, itemId])
      if (text) {
        state.sent.push({ uid: peer.uid, secUid: peer.secUid, text: String(text), at: Date.now() })
      }
      return { ok: true, receipt: { clientMessageId: `fake-share-${state.shared.length}` } }
    },
    async listInbox() {
      const online = await this.ensureOnline()
      if (!online.ok) throw new Error(online.message)
      return state.inbox.map((x, i) => ({
        id: x.id || `in-${i}`,
        uid: x.uid || '',
        secUid: x.secUid || '',
        nickname: x.nickname || '',
        text: x.text || '',
        at: x.at || Date.now(),
      }))
    },
    async startLogin() {
      state.needLogin = false
      state.loggedIn = true
      return { ok: true, message: '假 IM 已登录' }
    },
    /** 测用 */
    _state: state,
    _resolvePeer: resolvePeer,
  }
}

/**
 * 真机包装：动态加载 douyin-im。失败时给出明确提示（Node 版本 / 未安装）。
 * 不在模块顶层 import，以便 Node 20 测试箱仍能跑假客户端。
 */
export async function createRealImClient({ dataPath } = {}) {
  const dir = dataPath || dataDir('douyin', 'im')
  mkdirSync(dir, { recursive: true })
  let mod
  try {
    mod = await import('douyin-im')
  } catch (error) {
    const msg = String(error?.message || error)
    throw new Error(
      `加载 douyin-im 失败（需要 Node ≥22.13 且已安装依赖）：${msg}`,
    )
  }
  const { createClient, segment } = mod
  const client = createClient({ dataDir: dir })
  let account = null

  function currentAccount() {
    if (account) return account
    // 多账号时取第一个在线的
    const list = typeof client.accounts === 'function'
      ? client.accounts()
      : (client.getAccounts?.() || [])
    const arr = Array.isArray(list) ? list : [...(list || [])]
    account = arr.find((a) => a?.uid) || arr[0] || null
    return account
  }

  async function resolvePeer(acc, { uid, secUid } = {}) {
    if (uid) {
      const f = acc.pickFriend?.(String(uid)) || acc.pickStranger?.(String(uid))
      if (f) return { ok: true, uid: String(uid), secUid: f.secUid || secUid || '', contact: f }
      // 尚未在列表：用 Friend 路径，首次 sendMsg 建会话
      const friend = acc.pickFriend?.(String(uid))
      if (friend) return { ok: true, uid: String(uid), secUid: secUid || '', contact: friend }
      return { ok: true, uid: String(uid), secUid: secUid || '', contact: null, lazyUid: String(uid) }
    }
    if (secUid) {
      await acc.getFriendList?.().catch(() => {})
      await acc.getStrangerList?.().catch(() => {})
      for (const f of [...(acc.fl?.values?.() || []), ...(acc.sl?.values?.() || [])]) {
        if (f?.secUid === secUid || f?.profile?.secUid === secUid) {
          return { ok: true, uid: String(f.uid || f.id), secUid, contact: f }
        }
      }
      return { ok: false, message: `IM 通讯录里找不到 sec_uid=${secUid} 的人，请填数字 uid 或先有会话` }
    }
    return { ok: false, message: '没有对方 uid / sec_uid' }
  }

  async function contactFor(acc, peer) {
    if (peer.contact?.sendMsg) return peer.contact
    if (peer.lazyUid || peer.uid) {
      // 确保 Friend 实例存在
      let c = acc.pickFriend?.(peer.uid) || acc.pickStranger?.(peer.uid)
      if (!c && typeof acc.pickFriend === 'function') {
        // 某些实现 pickFriend 对未知 uid 仍返回可发送对象
        c = acc.pickFriend(peer.uid)
      }
      if (!c?.sendMsg) throw new Error(`IM 无法打开与 ${peer.uid} 的会话`)
      return c
    }
    throw new Error('没有可发送的联系人')
  }

  return {
    client,
    status() {
      const acc = currentAccount()
      const uid = acc?.uid || ''
      return {
        loggedIn: Boolean(uid),
        needLogin: !uid,
        uid,
        secUid: acc?.profile?.secUid || '',
        nickname: acc?.nickname || '',
        reason: uid ? '' : '还没登录 IM',
      }
    },
    async ensureOnline() {
      const st = this.status()
      if (!st.loggedIn) return { ok: false, message: IM_NOT_LOGGED_IN }
      return { ok: true }
    },
    async sendText(target, text) {
      const online = await this.ensureOnline()
      if (!online.ok) throw new Error(online.message)
      const acc = currentAccount()
      const peer = await resolvePeer(acc, target)
      if (!peer.ok) throw new Error(peer.message)
      const contact = await contactFor(acc, peer)
      const r = await contact.sendMsg(String(text || ''))
      if (r && r.statusCode != null && Number(r.statusCode) !== 0) {
        throw new Error(r.statusMsg || `私信回执失败（${r.statusCode}）`)
      }
      return { ok: true, receipt: r }
    },
    async shareWork(target, work, text = '') {
      const online = await this.ensureOnline()
      if (!online.ok) throw new Error(online.message)
      const acc = currentAccount()
      const peer = await resolvePeer(acc, target)
      if (!peer.ok) throw new Error(peer.message)
      const contact = await contactFor(acc, peer)
      const itemId = String(work?.itemId || work?.awemeId || '')
      if (!itemId) throw new Error('没有作品 id，不能分享')
      const card = segment.share({
        itemId,
        title: work?.title || work?.desc || '',
        authorSecUid: work?.authorSecUid || '',
        authorName: work?.author || work?.authorName || '',
        coverUrl: work?.coverUrl || '',
      })
      const r = await contact.sendMsg(card)
      if (r && r.statusCode != null && Number(r.statusCode) !== 0) {
        throw new Error(r.statusMsg || `分享回执失败（${r.statusCode}）`)
      }
      if (text) await contact.sendMsg(String(text)).catch(() => {})
      return { ok: true, receipt: r }
    },
    async listInbox() {
      const online = await this.ensureOnline()
      if (!online.ok) throw new Error(online.message)
      const acc = currentAccount()
      // 从陌生人 / 好友缓存历史拼最近私信（简化：读 stranger + friend 缓存）
      const out = []
      const pushFrom = (contact) => {
        const hist = contact.getCachedHistory?.(20) || []
        for (const m of hist) {
          const from = m.senderUid || m.from_id || contact.uid || contact.id
          if (String(from) === String(acc.uid)) continue
          out.push({
            id: String(m.serverMessageId || m.clientMessageId || `${from}:${m.time || ''}`),
            uid: String(from || ''),
            secUid: contact.secUid || '',
            nickname: contact.nickname || contact.remark || '',
            text: m.text || m.raw_message || '',
            at: (m.time ? Number(m.time) * (String(m.time).length > 12 ? 1 : 1000) : Date.now()),
          })
        }
      }
      for (const f of acc.fl?.values?.() || []) pushFrom(f)
      for (const s of acc.sl?.values?.() || []) pushFrom(s)
      return out.slice(0, 40)
    },
    async startLogin(opts = {}) {
      client.createAccount?.({ login: { method: opts.method || 'qr' } })
      // 真正扫码由宿主面板 / 事件驱动；这里只触发 login
      client.login?.().catch(() => {})
      return { ok: true, message: '已开始 IM 登录，请按终端 / 面板提示扫码或填验证码' }
    },
  }
}

/** 统一入口：有注入用注入；否则尝试真机（失败则抛错，由调用方转提示）。 */
export async function openImClient({ injected, dataPath } = {}) {
  if (injected) return injected
  return createRealImClient({ dataPath })
}
