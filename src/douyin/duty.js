// 刷抖音：定时用专用 Edge 去推荐流刷几个视频；按人格决定点赞 / 评论 / 关注；
// 私信主人、回主人私信、回别人回她的评论。看过的、做过的都记成她的经历。
// 浏览器细节在 cdp.js；这里只认 driver 接口，测时注入 createFakeDriver。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { isSilence } from '../chat/reply.js'
import {
  dayKey, between, pickJson, parseUserInput, findAwemeId, videoLink,
  ownerConfirmed, isOwnerSec, digestOf, cleanText, looksLikeVerify,
} from './util.js'
import { createBrowserDriver } from './cdp.js'

const emptyDay = () => ({
  day: '', runs: 0, watched: 0,
  like: 0, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0,
})

const emptyState = () => ({
  ...emptyDay(),
  lastRun: 0, nextDueAt: 0, lastSkipReason: '',
  lastReplyCheck: 0, lastDmCheck: 0,
  seen: [], history: [], repliedComments: [], repliedDms: [],
  pauseDay: '', pauseReason: '',
  selfSecUid: '', selfNickname: '',
})

export function createDouyin({ getConfig, hub, memory, log, driver: injected, dataFile } = {}) {
  const cfg = () => getConfig().douyin
  const file = () => dataFile || dataDir('douyin.json')
  const load = () => readJson(file(), emptyState)
  const save = (s) => writeJson(file(), s)
  const today = (s) => {
    if (s.day !== dayKey()) Object.assign(s, emptyDay(), { day: dayKey() })
    return s
  }
  let busy = false
  let driver = injected || null

  const ownerName = () => getConfig().ownerName || '主人'
  const profileDir = () => dataDir('douyin', 'edge-profile')

  function ensureDriver() {
    if (driver) return driver
    const c = cfg()
    driver = createBrowserDriver({
      profileDir: profileDir(),
      browserPath: c.browserPath,
      minimize: c.minimize !== false,
      log,
    })
    return driver
  }

  const record = (s, item) => { s.history.unshift({ at: Date.now(), ...item }); s.history = s.history.slice(0, 40) }
  const perm = (key) => {
    // 工具侧走 profilePerms；自主刷流在总闸 + dryRun + 日上限下跑，不按「谁让她」再挡
    const p = getConfig().profilePerms?.[key]
    return p === 'off' ? 'off' : (p || 'owner')
  }
  const paused = (s) => s.pauseDay === dayKey()
  const pause = (s, why) => {
    s.pauseDay = dayKey()
    s.pauseReason = why || '风控'
    log.warn(`今天先不在抖音动手了：${s.pauseReason}`)
  }
  const left = (s, key) => {
    const cap = Number(cfg().caps?.[key] ?? 0)
    return Math.max(0, cap - (s[key] || 0))
  }
  const canWrite = () => !getConfig().dryRun

  async function think(prompt) {
    return hub.runSystemTurn('douyin', 'QQ · 刷抖音', `【刷抖音，不是聊天，这一轮不会发到聊天里】\n${prompt}`, { timeoutMs: 180000 })
  }

  async function boot() {
    const d = ensureDriver()
    const r = await d.launch()
    if (!r.ok) return r
    const gate = await d.checkGate()
    if (!gate.ok) return gate
    return { ok: true }
  }

  async function account(force = false) {
    try {
      const d = ensureDriver()
      if (force || !d._state) await d.launch()
      const self = await d.selfInfo()
      const gate = await d.checkGate()
      return {
        isLogin: !gate.needLogin && Boolean(self?.secUid || !gate.needLogin),
        needLogin: !!gate.needLogin,
        verify: !!gate.verify,
        reason: gate.reason || '',
        secUid: self?.secUid || '',
        nickname: self?.nickname || '',
      }
    } catch (error) {
      return { isLogin: false, error: error.message }
    }
  }

  /** 面板：核对主人抖音号 / 主页链接 → 写入 secUid（只认 sec_uid，不认昵称）。 */
  async function confirmOwner(input) {
    const raw = String(input ?? cfg().owner?.input ?? '').trim()
    const parsed = parseUserInput(raw)
    if (!parsed) return { ok: false, message: '请填抖音号，或主页链接（douyin.com/user/…）' }
    const d = ensureDriver()
    const launched = await d.launch()
    if (!launched.ok) return launched
    const r = await d.resolveUser(parsed)
    if (!r.ok) return r
    // 写回配置：只有这条路由能改 secUid
    getConfig._setOwner?.({ input: raw, secUid: r.secUid, nickname: r.nickname || '', avatar: r.avatar || '', confirmedInput: raw })
    return { ok: true, message: `已核对：${r.nickname || r.secUid}`, secUid: r.secUid, nickname: r.nickname, avatar: r.avatar }
  }

  async function watchOne(s, v, decisions) {
    const d = decisions || {}
    const feeling = cleanText(d.feeling, 60)
    memory?.addEvent?.({ text: `在抖音看了 ${v.author || '有人'} 的视频${feeling ? '：' + feeling : ''}`, tags: ['抖音'], importance: 0.4 })
    if (d.remember && !isSilence(d.remember)) memory?.add?.({ text: String(d.remember).slice(0, 200), tags: ['抖音'], importance: 0.5, source: 'event' })
    record(s, { kind: 'watch', awemeId: v.awemeId, author: v.author, text: feeling || v.desc?.slice(0, 40) || '' })
    s.watched = (s.watched || 0) + 1
    // 立刻落盘：#4「计数一直是 0」——每个视频看完就 save
    save(s)

    const drv = ensureDriver()
    const doLike = d.like && perm('douyinLike') !== 'off' && left(s, 'like') > 0
    const doComment = cleanText(d.comment) && perm('douyinComment') !== 'off' && left(s, 'comment') > 0
    const doFollow = d.follow && perm('douyinFollow') !== 'off' && left(s, 'follow') > 0
    const doShare = cleanText(d.share) && perm('douyinShareOwner') !== 'off' && left(s, 'shareOwner') > 0 && ownerConfirmed(getConfig())

    if (paused(s)) return

    if (doLike) {
      try {
        if (!canWrite()) log.info(`试运行：本来要点赞 ${v.awemeId}`)
        else {
          const ok = await drv.clickLike()
          if (!ok) throw new Error('找不到点赞按钮')
        }
        s.like++; record(s, { kind: 'like', awemeId: v.awemeId, author: v.author }); save(s)
      } catch (error) { await onActionError(s, error, 'like', v) }
    }
    if (doComment && !paused(s)) {
      const text = cleanText(d.comment, 100)
      try {
        if (!canWrite()) log.info(`试运行：本来要评论 ${v.awemeId}：${text}`)
        else {
          await drv.openComments()
          const ok = await drv.typeAndSend(text)
          if (!ok) throw new Error('评论框打不开')
        }
        s.comment++
        memory?.addEvent?.({ text: `在抖音评论：${text.slice(0, 60)}`, tags: ['抖音'], importance: 0.4 })
        record(s, { kind: 'comment', awemeId: v.awemeId, author: v.author, text }); save(s)
      } catch (error) { await onActionError(s, error, 'comment', v) }
    }
    if (doFollow && !paused(s) && v.authorSecUid) {
      try {
        if (!canWrite()) log.info(`试运行：本来要关注 ${v.author}`)
        else {
          const ok = await drv.clickFollow()
          if (!ok) throw new Error('找不到关注按钮')
        }
        s.follow++
        memory?.addEvent?.({ text: `在抖音关注了 ${v.author}`, tags: ['抖音'], importance: 0.35 })
        record(s, { kind: 'follow', awemeId: v.awemeId, author: v.author, secUid: v.authorSecUid }); save(s)
      } catch (error) { await onActionError(s, error, 'follow', v) }
    }
    if (doShare && !paused(s)) {
      const text = cleanText(d.share, 80)
      try {
        if (!canWrite()) log.info(`试运行：本来要私信分享给主人 ${v.awemeId}：${text}`)
        else {
          const r = await drv.openShareTo(getConfig().douyin.owner.secUid)
          if (!r.ok) throw new Error(r.message || '分享打不开')
          // 附一句再发（有的版本分享后可留言）
          await drv.typeAndSend(text).catch(() => {})
        }
        s.shareOwner++
        memory?.addEvent?.({ text: `把抖音视频私信分享给${ownerName()}：${text.slice(0, 40)}`, tags: ['抖音'], importance: 0.45 })
        record(s, { kind: 'share', awemeId: v.awemeId, text }); save(s)
      } catch (error) { await onActionError(s, error, 'share', v) }
    }
  }

  async function onActionError(s, error, kind, v) {
    const msg = String(error?.message || error)
    log.warn(`抖音${kind}失败：`, msg)
    record(s, { kind: 'error', awemeId: v?.awemeId, text: `${kind}没成功：${msg}` })
    const drv = ensureDriver()
    if (drv.paused || looksLikeVerify(msg) || /验证|风控|频繁|异常/.test(msg)) {
      pause(s, drv.pauseReason || msg.slice(0, 40))
      try { await hub.sendText?.(`private:${getConfig().ownerQQ}`, `抖音这边要验证 / 被限制了，今天先不动手：${s.pauseReason}`) } catch (e) {}
    }
    save(s)
  }

  /** 刷一轮。force = 面板手动（不占每天的「轮」数，但仍计 watched / 各操作上限）。 */
  async function run({ force = false } = {}) {
    const c = cfg()
    if (busy) return { ok: false, message: '正在刷' }
    if (!c.enabled && !force) return { ok: false, message: '抖音没打开' }
    if (perm('douyinBrowse') === 'off' && !force) return { ok: false, message: '刷抖音在权限里关掉了' }
    busy = true
    const s = today(load())
    try {
      if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
      if ((s.watched || 0) >= c.maxWatchPerDay) return { ok: false, message: `今天已经看了 ${s.watched} 个（上限 ${c.maxWatchPerDay}）` }

      const booted = await boot()
      if (!booted.ok) {
        s.lastSkipReason = booted.reason || booted.message || '启动失败'
        if (booted.verify) pause(s, booted.reason)
        return { ok: false, message: s.lastSkipReason }
      }
      const drv = ensureDriver()
      const rec = await drv.ensureRecommend()
      if (!rec.ok) {
        s.lastSkipReason = rec.message || '不在推荐页'
        return { ok: false, message: s.lastSkipReason }
      }

      const seen = new Set(s.seen || [])
      const want = Math.min(c.perRun, Math.max(0, c.maxWatchPerDay - (s.watched || 0)))
      const list = await drv.nextAwemes({ seen, want })
      if (!list.length) {
        s.lastSkipReason = '这次没刷到新视频'
        return { ok: false, message: s.lastSkipReason }
      }

      // 先看完（停留），再让她一起决定
      const looked = []
      for (const v of list) {
        const dwell = between(c.dwellMin, c.dwellMax) * 1000
        // 测时 driver 没有真等待；真机略等
        if (!drv._state) await new Promise((r) => setTimeout(r, Math.min(dwell, 5000)))
        // 确认当前真的是这条（#4 同视频误判）
        const active = await drv.activeAwemeId().catch(() => '')
        if (active && active !== v.awemeId && list.every((x) => x.awemeId !== active)) {
          // 三个兜底都对不上就跳过这条，避免对错视频动手
          log.debug(`当前播的是 ${active}，和预期 ${v.awemeId} 不一致，跳过`)
          continue
        }
        seen.add(v.awemeId)
        looked.push(v)
        s.seen = [...seen].slice(-500)
        save(s)
      }
      if (!looked.length) return { ok: false, message: '视频对不上，这轮没看' }

      const likeLeft = left(s, 'like')
      const commentLeft = left(s, 'comment')
      const followLeft = left(s, 'follow')
      const shareLeft = ownerConfirmed(getConfig()) ? left(s, 'shareOwner') : 0
      const out = await think(
        `你在抖音刷到了这几个视频：\n\n${looked.map((v, i) => `【${i + 1}】${digestOf(v)}`).join('\n\n')}\n\n` +
        `看完说说你的想法。对每个视频给一个对象：{"i":序号,"feeling":"一句真实感受","like":true/false,"comment":"想发的评论（不想就空字符串）","follow":true/false,"share":"想私信分享给${ownerName()}的话（觉得${ownerName()}会喜欢才写，不然空）","remember":"值得记住的（没有就空）"}。` +
        `这次最多点赞 ${likeLeft}、评论 ${commentLeft}、关注 ${followLeft}、分享 ${shareLeft}。只输出 JSON 数组。`)
      const decisions = pickJson(out, [])
      const byI = new Map((Array.isArray(decisions) ? decisions : []).map((d) => [Number(d.i) || 0, d]))

      for (let i = 0; i < looked.length; i++) {
        if (paused(s)) break
        await watchOne(s, looked[i], byI.get(i + 1) || {})
      }

      if (!force) {
        s.runs++
        // 下一轮：间隔 × 0.8~1.3，落盘（#4 定时不触发）
        const jitter = 0.8 + Math.random() * 0.5
        s.nextDueAt = Date.now() + Math.round(c.intervalHours * 3600_000 * jitter)
      }
      s.lastRun = Date.now()
      s.lastSkipReason = ''
      log.info(`刷了一轮抖音：看了 ${looked.length} 个`)
      return { ok: true, message: `看了 ${looked.length} 个视频`, watched: looked.length }
    } catch (error) {
      log.warn('刷抖音出错：', error.message)
      s.lastSkipReason = error.message
      return { ok: false, message: error.message }
    } finally {
      save(s)
      busy = false
    }
  }

  /** 回主人私信：只认 confirmed sec_uid。 */
  async function checkOwnerDms() {
    if (perm('douyinReplyOwnerDm') === 'off') return { ok: false, message: '回主人私信在权限里关掉了' }
    if (!ownerConfirmed(getConfig())) return { ok: false, message: '还没核对主人的抖音号' }
    const s = today(load())
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    s.lastDmCheck = Date.now()
    const booted = await boot()
    if (!booted.ok) return { ok: false, message: booted.reason || booted.message }
    const drv = ensureDriver()
    let n = 0
    try {
      const done = new Set(s.repliedDms || [])
      const inbox = await drv.listOwnerDms()
      const ownerSec = getConfig().douyin.owner.secUid
      const fresh = inbox.filter((x) => isOwnerSec(getConfig(), x.secUid) && x.text && !done.has(`${x.secUid}:${x.text}`)).slice(0, 5)
      // 若列表里认不出 sec_uid，绝不回（避免回错人）
      if (inbox.length && !inbox.some((x) => x.secUid)) {
        return { ok: false, message: '私信列表认不出对方 sec_uid，回主人私信先不开' }
      }
      for (const m of fresh) {
        if (left(s, 'dmReply') <= 0) break
        done.add(`${m.secUid}:${m.text}`)
        hub.logChat?.('douyin', m.nickname || '主人抖音', `抖音私信你：${m.text}`, '')
        const out = await think(`这是${ownerName()}在抖音给你发的私信：「${m.text}」\n用你的口气回一句（像平时私聊，别太长）；不想回就只输出 [沉默]。只输出回复正文。`)
        const reply = cleanText(String(out || '').split(/\n+/)[0], 100)
        if (!reply || isSilence(reply)) continue
        try {
          if (!canWrite()) log.info(`试运行：本来要回主人抖音私信：${reply}`)
          else {
            await drv.openDmThread(ownerSec)
            const ok = await drv.typeAndSend(reply)
            if (!ok) throw new Error('私信发送失败')
          }
          s.dmReply++; n++
          memory?.addEvent?.({ text: `在抖音回了${ownerName()}的私信：${reply.slice(0, 50)}`, tags: ['抖音'], importance: 0.5 })
          record(s, { kind: 'dmReply', text: `${m.text} → ${reply}` }); save(s)
        } catch (error) { await onActionError(s, error, 'dmReply', {}) }
      }
      s.repliedDms = [...done].slice(-200)
      return { ok: true, message: `回了 ${n} 条主人私信`, replied: n }
    } catch (error) {
      return { ok: false, message: error.message }
    } finally { save(s) }
  }

  /** 回别人回她视频 / 评论的评论（低频率）。 */
  async function checkCommentReplies() {
    if (perm('douyinReplyComment') === 'off') return { ok: false, message: '回评论在权限里关掉了' }
    const s = today(load())
    s.lastReplyCheck = Date.now()
    // v1：没有稳定的「别人回我」接口时，先占位——真机靠页面消息中心再补。测里用 driver._state.commentReplies。
    const drv = ensureDriver()
    const list = drv._state?.commentReplies || []
    let n = 0
    const done = new Set(s.repliedComments || [])
    for (const x of list) {
      if (done.has(x.id) || left(s, 'replyComment') <= 0 || paused(s)) continue
      done.add(x.id)
      const out = await think(`有人在抖音回你的评论：「${x.text}」（对方：${x.name}）\n想回就用你的口气回一句，不想回就 [沉默]。只输出回复正文。`)
      const reply = cleanText(String(out || '').split(/\n+/)[0], 100)
      if (!reply || isSilence(reply)) continue
      try {
        if (!canWrite()) log.info(`试运行：本来要回评论：${reply}`)
        else await drv.typeAndSend(reply)
        s.replyComment++; n++
        record(s, { kind: 'replyComment', text: `${x.name}：${x.text} → ${reply}` }); save(s)
      } catch (error) { await onActionError(s, error, 'replyComment', {}) }
    }
    s.repliedComments = [...done].slice(-300)
    save(s)
    return { ok: true, message: `回了 ${n} 条评论`, replied: n }
  }

  /** 工具：主动私信某人（要对方 sec_uid 或主页链接）。 */
  async function dmTo(target, text) {
    if (perm('douyinDm') === 'off') return { ok: false, message: '私信在权限里关掉了' }
    const s = today(load())
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    if (left(s, 'dm') <= 0) return { ok: false, message: '今天私信次数用完了' }
    const parsed = parseUserInput(target) || (String(target).length > 20 ? { secUid: String(target).trim() } : null)
    if (!parsed) return { ok: false, message: '请给对方抖音主页链接或 sec_uid' }
    const msg = cleanText(text, 100)
    if (!msg) return { ok: false, message: '私信内容不能是空的' }
    const booted = await boot()
    if (!booted.ok) return { ok: false, message: booted.reason || booted.message }
    const drv = ensureDriver()
    try {
      const user = parsed.secUid ? { ok: true, secUid: parsed.secUid } : await drv.resolveUser(parsed)
      if (!user.ok) return user
      if (!canWrite()) {
        log.info(`试运行：本来要私信 ${user.secUid}：${msg}`)
      } else {
        await drv.openDmThread(user.secUid)
        const ok = await drv.typeAndSend(msg)
        if (!ok) return { ok: false, message: '私信没发出去' }
      }
      s.dm++; record(s, { kind: 'dm', secUid: user.secUid, text: msg }); save(s)
      memory?.addEvent?.({ text: `在抖音私信了别人：${msg.slice(0, 40)}`, tags: ['抖音'], importance: 0.4 })
      return { ok: true, message: '私信发出去了' }
    } catch (error) {
      await onActionError(s, error, 'dm', {})
      return { ok: false, message: error.message }
    }
  }

  /** 工具：看一个视频链接。 */
  async function watch(text) {
    const id = findAwemeId(text)
    if (!id) return { ok: false, message: '没认出抖音视频链接' }
    const booted = await boot()
    if (!booted.ok) return { ok: false, message: booted.reason || booted.message }
    const drv = ensureDriver()
    let awemeId = id.awemeId
    if (id.short) {
      await drv.navigate(id.short)
      await new Promise((r) => setTimeout(r, 1200))
      awemeId = (await drv.activeAwemeId()) || awemeId
    } else {
      await drv.navigate(videoLink(awemeId))
    }
    if (!awemeId) return { ok: false, message: '打不开这个视频' }
    const s = today(load())
    const v = { awemeId, author: '', desc: '', likes: 0, comments: 0, tags: [] }
    // 尝试从最近 feed 补信息
    const hit = (drv.recentFeed?.() || []).find((x) => x.awemeId === awemeId)
    if (hit) Object.assign(v, hit)
    memory?.addEvent?.({ text: `看了别人发来的抖音视频 ${awemeId}`, tags: ['抖音'], importance: 0.4 })
    record(s, { kind: 'watch', awemeId, text: '（点开链接看的）' })
    s.watched = (s.watched || 0) + 1
    s.seen = [...new Set([...(s.seen || []), awemeId])].slice(-500)
    save(s)
    return { ok: true, message: digestOf(v), awemeId }
  }

  /** 每分钟：醒着时按 nextDueAt 刷；按间隔看私信 / 回评论。15 分钟卡死看门狗。 */
  let runStartedAt = 0
  async function tick() {
    const g = getConfig()
    const c = g.douyin
    if (!g.enabled || !c.enabled) return
    const h = new Date().getHours()
    if (h < g.speakUp.awakeFrom || h >= g.speakUp.awakeTo) return
    const s = today(load())

    // 看门狗：一轮跑超过 15 分钟就放行（#4）
    if (busy && runStartedAt && Date.now() - runStartedAt > 15 * 60_000) {
      log.warn('刷抖音超过 15 分钟还没结束，强制解锁')
      busy = false
    }

    const dmEvery = (c.dmPollMinutes || 7) * 60_000
    const replyEvery = (c.replyPollMinutes || 25) * 60_000
    if (Date.now() - (s.lastDmCheck || 0) > dmEvery * (0.7 + Math.random() * 0.7)) {
      if (ownerConfirmed(g) && perm('douyinReplyOwnerDm') !== 'off') await checkOwnerDms().catch((e) => log.debug(e.message))
    }
    if (Date.now() - (s.lastReplyCheck || 0) > replyEvery) {
      if (perm('douyinReplyComment') !== 'off') await checkCommentReplies().catch((e) => log.debug(e.message))
    }

    if (!c.autoBrowse || perm('douyinBrowse') === 'off') return
    if (s.runs >= c.maxRunsPerDay) { s.lastSkipReason = '今天轮数满了'; save(s); return }
    if (paused(s)) return
    const due = s.nextDueAt || 0
    // 从未跑过 / 到点 / 漏跑补跑
    if (due && Date.now() < due) return
    if (!due && s.lastRun && Date.now() - s.lastRun < c.intervalHours * 3600_000) return
    runStartedAt = Date.now()
    await run()
    runStartedAt = 0
  }

  function state() {
    const s = today(load())
    return {
      runs: s.runs, watched: s.watched,
      like: s.like, comment: s.comment, replyComment: s.replyComment,
      follow: s.follow, dm: s.dm, shareOwner: s.shareOwner, dmReply: s.dmReply,
      lastRun: s.lastRun, nextDueAt: s.nextDueAt, lastSkipReason: s.lastSkipReason,
      history: (s.history || []).slice(0, 20),
      pauseReason: paused(s) ? s.pauseReason : '',
      ownerConfirmed: ownerConfirmed(getConfig()),
      owner: {
        input: cfg().owner?.input || '',
        secUid: cfg().owner?.secUid || '',
        nickname: cfg().owner?.nickname || '',
        hasAvatar: Boolean(cfg().owner?.avatar),
      },
    }
  }

  return {
    run, tick, watch, dmTo, checkOwnerDms, checkCommentReplies, confirmOwner, account, state,
    /** 测用：换成别的驱动 */
    setDriver: (d) => { driver = d },
  }
}
