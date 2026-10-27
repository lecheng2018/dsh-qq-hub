// 刷抖音：定时用专用 Edge 去推荐流刷几个视频；按人格决定点赞 / 评论（关注仅工具请求）；
// 私信主人、回主人私信、回别人回她的评论。看过的、做过的都记成她的经历。
// 浏览器细节在 cdp.js；这里只认 driver 接口，测时注入 createFakeDriver。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { isSilence } from '../chat/reply.js'
import {
  dayKey, between, pickJson, parseUserInput, findAwemeId, videoLink,
  ownerConfirmed, isOwnerSec, digestOf, cleanText, looksLikeVerify,
} from './util.js'
import { createBrowserDriver } from './cdp.js'

const WRITE_OPS = ['like', 'comment', 'replyComment', 'follow', 'dm', 'shareOwner', 'dmReply']
const emptyDay = () => ({
  day: '', runs: 0, watched: 0, writes: 0,
  like: 0, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0,
  lastWriteAt: 0,
  failStreak: Object.fromEntries(WRITE_OPS.map((k) => [k, 0])),
  disabledOps: Object.fromEntries(WRITE_OPS.map((k) => [k, false])),
  dmTargets: {}, // secUid → 今天已私信次数（任何人：每目标最多 1）
  ownerDmStreak: 0, // 连续回主人私信条数（主人没新话就停在 3）
  pauseNotified: false,
})

const emptyState = () => ({
  ...emptyDay(),
  lastRun: 0, nextDueAt: 0, lastSkipReason: '',
  lastReplyCheck: 0, lastDmCheck: 0,
  seen: [], history: [], repliedComments: [], repliedDms: [],
  pauseDay: '', pauseReason: '',
  selfSecUid: '', selfNickname: '',
  loginAt: 0, // 首次确认登录的时间戳；前 newAccountDays 天上限减半
})

export function createDouyin({ getConfig, hub, memory, log, driver: injected, dataFile, now: nowFn } = {}) {
  const now = () => (nowFn ? nowFn() : Date.now())
  const cfg = () => getConfig().douyin
  const file = () => dataFile || dataDir('douyin.json')
  const load = () => readJson(file(), emptyState)
  const save = (s) => writeJson(file(), s)
  const today = (s) => {
    if (s.day !== dayKey(new Date(now()))) {
      Object.assign(s, emptyDay(), { day: dayKey(new Date(now())) })
    }
    if (!s.failStreak) s.failStreak = Object.fromEntries(WRITE_OPS.map((k) => [k, 0]))
    if (!s.disabledOps) s.disabledOps = Object.fromEntries(WRITE_OPS.map((k) => [k, false]))
    if (!s.dmTargets) s.dmTargets = {}
    return s
  }
  let busy = false
  let driver = injected || null

  const ownerName = () => getConfig().ownerName || '主人'
  const profileDir = () => dataDir('douyin', 'edge-profile')
  const isFake = () => Boolean(driver && driver._state)

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

  const record = (s, item) => { s.history.unshift({ at: now(), ...item }); s.history = s.history.slice(0, 40) }
  const perm = (key) => {
    const p = getConfig().profilePerms?.[key]
    return p === 'off' ? 'off' : (p || 'owner')
  }
  const paused = (s) => s.pauseDay === dayKey(new Date(now()))
  const isNewAccount = (s) => {
    const days = Number(cfg().gate?.newAccountDays ?? 3)
    if (!s.loginAt || days <= 0) return false
    return now() - s.loginAt < days * 86400_000
  }
  const capOf = (s, key) => {
    let cap = Number(cfg().caps?.[key] ?? 0)
    if (isNewAccount(s)) cap = Math.floor(cap / 2)
    return cap
  }
  const left = (s, key) => Math.max(0, capOf(s, key) - (s[key] || 0))
  const writeBudget = (s) => {
    let max = Number(cfg().gate?.maxWritesPerDay ?? 60)
    if (isNewAccount(s)) max = Math.floor(max / 2)
    return Math.max(0, max - (s.writes || 0))
  }
  const dry = () => Boolean(getConfig().dryRun)

  /** 验证码 / 风控：停全部写操作，只通知主人一次。 */
  function pauseAll(s, why) {
    s.pauseDay = dayKey(new Date(now()))
    s.pauseReason = why || '风控'
    log.warn(`今天先不在抖音动手了：${s.pauseReason}`)
    if (!s.pauseNotified && getConfig().ownerQQ) {
      s.pauseNotified = true
      hub.sendText?.(`private:${getConfig().ownerQQ}`, `抖音这边要验证 / 被限制了，今天所有动手的操作都停了：${s.pauseReason}`).catch?.(() => {})
    }
    save(s)
  }

  /** 写操作总闸：日总上限、间隔、单项上限、连续失败禁用、验证码、试运行不计次。 */
  async function doWrite(s, kind, act, meta = {}) {
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    if (s.disabledOps?.[kind]) return { ok: false, message: `${kind} 今天连续失败太多次，先停了` }
    if (left(s, kind) <= 0) return { ok: false, message: `今天 ${kind} 次数用完了` }
    if (writeBudget(s) <= 0) return { ok: false, message: '今天写操作总次数用完了' }
    const gapSec = Number(cfg().gate?.minWriteGapSec ?? 20)
    const since = now() - (s.lastWriteAt || 0)
    if (gapSec > 0 && s.lastWriteAt && since < gapSec * 1000) {
      return { ok: false, message: `写太勤了，再等 ${Math.ceil((gapSec * 1000 - since) / 1000)} 秒` }
    }
    // 试运行：只记日志，不占真实日上限 / 总闸 / 间隔
    if (dry()) {
      log.info(`试运行：本来要 ${kind}`, meta.awemeId || meta.secUid || meta.text || '')
      record(s, { kind: 'dry:' + kind, awemeId: meta.awemeId, author: meta.author, text: meta.text || '', secUid: meta.secUid })
      save(s)
      return { ok: true, dryRun: true }
    }
    try {
      await act()
    } catch (error) {
      const msg = String(error?.message || error)
      log.warn(`抖音${kind}失败：`, msg)
      record(s, { kind: 'error', awemeId: meta.awemeId, text: `${kind}没成功：${msg}` })
      const drv = ensureDriver()
      if (drv.paused || looksLikeVerify(msg) || /验证|风控|频繁|异常/.test(msg)) {
        pauseAll(s, drv.pauseReason || msg.slice(0, 40))
      } else {
        s.failStreak[kind] = (s.failStreak[kind] || 0) + 1
        if (s.failStreak[kind] >= 3) {
          s.disabledOps[kind] = true
          log.warn(`${kind} 连续失败 3 次，今天先禁用`)
        }
        save(s)
      }
      return { ok: false, message: msg }
    }
    s[kind] = (s[kind] || 0) + 1
    s.writes = (s.writes || 0) + 1
    s.lastWriteAt = now()
    s.failStreak[kind] = 0
    record(s, { kind, awemeId: meta.awemeId, author: meta.author, text: meta.text || '', secUid: meta.secUid })
    save(s)
    return { ok: true }
  }

  async function think(prompt) {
    return hub.runSystemTurn('douyin', 'QQ · 刷抖音', `【刷抖音，不是聊天，这一轮不会发到聊天里】\n${prompt}`, { timeoutMs: 180000 })
  }

  async function boot() {
    const d = ensureDriver()
    const r = await d.launch()
    if (!r.ok) return r
    const gate = await d.checkGate()
    if (!gate.ok) {
      if (gate.verify) {
        const s = today(load())
        pauseAll(s, gate.reason || '要验证')
      }
      return gate
    }
    return { ok: true }
  }

  async function account(force = false) {
    try {
      const d = ensureDriver()
      if (force || !d._state) await d.launch()
      const self = await d.selfInfo()
      const gate = await d.checkGate()
      const isLogin = !gate.needLogin && !gate.verify
      if (isLogin) {
        const s = today(load())
        if (!s.loginAt) { s.loginAt = now(); save(s) }
        if (self?.secUid) { s.selfSecUid = self.secUid; s.selfNickname = self.nickname || ''; save(s) }
      }
      return {
        isLogin,
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

  async function confirmOwner(input) {
    const raw = String(input ?? cfg().owner?.input ?? '').trim()
    const parsed = parseUserInput(raw)
    if (!parsed) return { ok: false, message: '请填抖音号，或主页链接（douyin.com/user/…）' }
    const d = ensureDriver()
    const launched = await d.launch()
    if (!launched.ok) return launched
    const r = await d.resolveUser(parsed)
    if (!r.ok) return r
    getConfig._setOwner?.({ input: raw, secUid: r.secUid, nickname: r.nickname || '', avatar: r.avatar || '', confirmedInput: raw })
    return { ok: true, message: `已核对：${r.nickname || r.secUid}`, secUid: r.secUid, nickname: r.nickname, avatar: r.avatar }
  }

  async function dwellMs() {
    const c = cfg()
    return between(c.dwellMin, c.dwellMax) * 1000
  }

  /** 刷流里对一条视频做点赞 / 评论 / 分享（关注不在刷流里，只走 douyin_follow 工具）。 */
  async function watchOne(s, v, decisions) {
    const d = decisions || {}
    const feeling = cleanText(d.feeling, 60)
    memory?.addEvent?.({ text: `在抖音看了 ${v.author || '有人'} 的视频${feeling ? '：' + feeling : ''}`, tags: ['抖音'], importance: 0.4 })
    if (d.remember && !isSilence(d.remember)) memory?.add?.({ text: String(d.remember).slice(0, 200), tags: ['抖音'], importance: 0.5, source: 'event' })
    record(s, { kind: 'watch', awemeId: v.awemeId, author: v.author, text: feeling || v.desc?.slice(0, 40) || '' })
    s.watched = (s.watched || 0) + 1
    save(s)

    const drv = ensureDriver()
    if (paused(s)) return

    if (d.like && perm('douyinLike') !== 'off') {
      const r = await doWrite(s, 'like', async () => {
        const ok = await drv.clickLike()
        if (!ok) throw new Error('找不到点赞按钮')
      }, { awemeId: v.awemeId, author: v.author })
      if (!r.ok && paused(s)) return
    }
    if (cleanText(d.comment) && perm('douyinComment') !== 'off' && !paused(s)) {
      const text = cleanText(d.comment, 100)
      const r = await doWrite(s, 'comment', async () => {
        await drv.openComments()
        const ok = await drv.typeAndSend(text)
        if (!ok) throw new Error('评论框打不开')
      }, { awemeId: v.awemeId, author: v.author, text })
      if (r.ok && !r.dryRun) memory?.addEvent?.({ text: `在抖音评论：${text.slice(0, 60)}`, tags: ['抖音'], importance: 0.4 })
      if (!r.ok && paused(s)) return
    }
    if (cleanText(d.share) && perm('douyinShareOwner') !== 'off' && ownerConfirmed(getConfig()) && !paused(s)) {
      const text = cleanText(d.share, 80)
      const secUid = getConfig().douyin.owner.secUid
      const r = await doWrite(s, 'shareOwner', async () => {
        const sh = await drv.openShareTo(secUid)
        if (!sh?.ok) throw new Error(sh?.message || '没选中主人就分享了')
        await drv.typeAndSend(text).catch(() => {})
      }, { awemeId: v.awemeId, text, secUid })
      if (r.ok && !r.dryRun) memory?.addEvent?.({ text: `把抖音视频私信分享给${ownerName()}：${text.slice(0, 40)}`, tags: ['抖音'], importance: 0.45 })
    }
  }

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

      const looked = []
      for (const v of list) {
        // 真机按面板停留；假驱动跳过以免拖慢测试
        const waitMs = await dwellMs()
        if (!isFake()) await new Promise((r) => setTimeout(r, waitMs))
        const active = await drv.activeAwemeId().catch(() => '')
        if (active && active !== v.awemeId && list.every((x) => x.awemeId !== active)) {
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
      const shareLeft = ownerConfirmed(getConfig()) ? left(s, 'shareOwner') : 0
      const out = await think(
        `你在抖音刷到了这几个视频：\n\n${looked.map((v, i) => `【${i + 1}】${digestOf(v)}`).join('\n\n')}\n\n` +
        `看完说说你的想法。对每个视频给一个对象：{"i":序号,"feeling":"一句真实感受","like":true/false,"comment":"想发的评论（不想就空字符串）","share":"想私信分享给${ownerName()}的话（觉得${ownerName()}会喜欢才写，不然空）","remember":"值得记住的（没有就空）"}。` +
        `（关注不在刷流里做，有人让你关注再用工具。）这次最多点赞 ${likeLeft}、评论 ${commentLeft}、分享 ${shareLeft}。只输出 JSON 数组。`)
      const decisions = pickJson(out, [])
      const byI = new Map((Array.isArray(decisions) ? decisions : []).map((d) => [Number(d.i) || 0, d]))

      for (let i = 0; i < looked.length; i++) {
        if (paused(s)) break
        await watchOne(s, looked[i], byI.get(i + 1) || {})
      }

      if (!force) {
        s.runs++
        const jitter = 0.8 + Math.random() * 0.5
        s.nextDueAt = now() + Math.round(c.intervalHours * 3600_000 * jitter)
      }
      s.lastRun = now()
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

  async function checkOwnerDms() {
    if (perm('douyinReplyOwnerDm') === 'off') return { ok: false, message: '回主人私信在权限里关掉了' }
    if (!ownerConfirmed(getConfig())) return { ok: false, message: '还没核对主人的抖音号' }
    const s = today(load())
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    s.lastDmCheck = now()
    const booted = await boot()
    if (!booted.ok) return { ok: false, message: booted.reason || booted.message }
    const drv = ensureDriver()
    let n = 0
    try {
      const done = new Set(s.repliedDms || [])
      const inbox = await drv.listOwnerDms()
      const ownerSec = getConfig().douyin.owner.secUid
      if (inbox.length && !inbox.some((x) => x.secUid)) {
        return { ok: false, message: '私信列表认不出对方 sec_uid，回主人私信先不开' }
      }
      const cutoff = now() - 30 * 60_000
      const fresh = inbox.filter((x) => {
        if (!isOwnerSec(getConfig(), x.secUid) || !x.text) return false
        if (done.has(`${x.secUid}:${x.text}`)) return false
        const at = Number(x.at) || now() // 没带时间的按「刚到」处理（假驱动）
        if (at < cutoff) return false
        return true
      }).slice(0, 5)
      if (fresh.length) s.ownerDmStreak = 0 // 主人有新话，重新计数

      for (const m of fresh) {
        if (left(s, 'dmReply') <= 0) break
        if ((s.ownerDmStreak || 0) >= 3) break
        done.add(`${m.secUid}:${m.text}`)
        hub.logChat?.('douyin', m.nickname || '主人抖音', `抖音私信你：${m.text}`, '')
        const out = await think(`这是${ownerName()}在抖音给你发的私信：「${m.text}」\n用你的口气回一句（像平时私聊，别太长）；不想回就只输出 [沉默]。只输出回复正文。`)
        const reply = cleanText(String(out || '').split(/\n+/)[0], 100)
        if (!reply || isSilence(reply)) continue
        const r = await doWrite(s, 'dmReply', async () => {
          await drv.openDmThread(ownerSec)
          const ok = await drv.typeAndSend(reply)
          if (!ok) throw new Error('私信发送失败')
        }, { text: `${m.text} → ${reply}`, secUid: ownerSec })
        if (r.ok) {
          n++
          s.ownerDmStreak = (s.ownerDmStreak || 0) + 1
          if (!r.dryRun) memory?.addEvent?.({ text: `在抖音回了${ownerName()}的私信：${reply.slice(0, 50)}`, tags: ['抖音'], importance: 0.5 })
          save(s)
        }
        if (paused(s)) break
      }
      s.repliedDms = [...done].slice(-200)
      return { ok: true, message: `回了 ${n} 条主人私信`, replied: n }
    } catch (error) {
      return { ok: false, message: error.message }
    } finally { save(s) }
  }

  /** 回别人回她的评论：走 driver.listCommentReplies（真机 CDP 翻消息中心；假驱动吐脚本）。 */
  async function checkCommentReplies() {
    if (perm('douyinReplyComment') === 'off') return { ok: false, message: '回评论在权限里关掉了' }
    const s = today(load())
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    s.lastReplyCheck = now()
    const booted = await boot()
    if (!booted.ok) { save(s); return { ok: false, message: booted.reason || booted.message } }
    const drv = ensureDriver()
    let n = 0
    try {
      const list = typeof drv.listCommentReplies === 'function' ? await drv.listCommentReplies() : []
      const done = new Set(s.repliedComments || [])
      for (const x of list || []) {
        if (!x?.id || done.has(x.id) || left(s, 'replyComment') <= 0 || paused(s)) continue
        done.add(x.id)
        const out = await think(`有人在抖音回你的评论：「${x.text}」（对方：${x.name || '?'}）\n想回就用你的口气回一句，不想回就 [沉默]。只输出回复正文。`)
        const reply = cleanText(String(out || '').split(/\n+/)[0], 100)
        if (!reply || isSilence(reply)) continue
        const r = await doWrite(s, 'replyComment', async () => {
          if (x.awemeId) await drv.navigate(videoLink(x.awemeId)).catch(() => {})
          await drv.openComments().catch(() => {})
          const ok = await drv.typeAndSend(reply)
          if (!ok) throw new Error('回评论没发出去')
        }, { text: `${x.name}：${x.text} → ${reply}`, awemeId: x.awemeId })
        if (r.ok) n++
        if (paused(s)) break
      }
      s.repliedComments = [...done].slice(-300)
      return { ok: true, message: `回了 ${n} 条评论`, replied: n }
    } catch (error) {
      return { ok: false, message: error.message }
    } finally { save(s) }
  }

  async function resolveTarget(target) {
    const parsed = parseUserInput(target) || (String(target).length > 20 ? { secUid: String(target).trim() } : null)
    if (!parsed) return { ok: false, message: '请给对方抖音主页链接或 sec_uid' }
    const drv = ensureDriver()
    if (parsed.secUid) return { ok: true, secUid: parsed.secUid }
    return drv.resolveUser(parsed)
  }

  /** 工具：主动私信（每目标每天最多 1 次）。 */
  async function dmTo(target, text) {
    if (perm('douyinDm') === 'off') return { ok: false, message: '私信在权限里关掉了' }
    const s = today(load())
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    const msg = cleanText(text, 100)
    if (!msg) return { ok: false, message: '私信内容不能是空的' }
    const booted = await boot()
    if (!booted.ok) return { ok: false, message: booted.reason || booted.message }
    const user = await resolveTarget(target)
    if (!user.ok) return user
    if ((s.dmTargets[user.secUid] || 0) >= 1) return { ok: false, message: '今天已经给这个人发过私信了（每人每天最多 1 条）' }
    const drv = ensureDriver()
    const r = await doWrite(s, 'dm', async () => {
      await drv.openDmThread(user.secUid)
      const ok = await drv.typeAndSend(msg)
      if (!ok) throw new Error('私信没发出去')
    }, { secUid: user.secUid, text: msg })
    if (r.ok) {
      // 试运行也不记「已对该目标发过」，这样真跑时还能发；但若 dryRun 也不占 dm 计数（doWrite 已处理）
      if (!r.dryRun) {
        s.dmTargets[user.secUid] = (s.dmTargets[user.secUid] || 0) + 1
        memory?.addEvent?.({ text: `在抖音私信了别人：${msg.slice(0, 40)}`, tags: ['抖音'], importance: 0.4 })
        save(s)
      }
    }
    return r.ok ? { ok: true, message: r.dryRun ? '试运行：本来要发私信' : '私信发出去了' } : r
  }

  /** 工具：关注某人（仅请求，刷流不自动关注）。 */
  async function followUser(target) {
    if (perm('douyinFollow') === 'off') return { ok: false, message: '关注在权限里关掉了' }
    const s = today(load())
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    const booted = await boot()
    if (!booted.ok) return { ok: false, message: booted.reason || booted.message }
    const user = await resolveTarget(target)
    if (!user.ok) return user
    const drv = ensureDriver()
    const r = await doWrite(s, 'follow', async () => {
      await drv.navigate(`https://www.douyin.com/user/${user.secUid}`)
      const ok = await drv.clickFollow()
      if (!ok) throw new Error('找不到关注按钮（可能已关注）')
    }, { secUid: user.secUid, author: user.nickname })
    if (r.ok && !r.dryRun) memory?.addEvent?.({ text: `在抖音关注了 ${user.nickname || user.secUid}`, tags: ['抖音'], importance: 0.35 })
    return r.ok ? { ok: true, message: r.dryRun ? '试运行：本来要关注' : '关注好了' } : r
  }

  /** 工具：给当前 / 指定视频点赞。 */
  async function likeVideo(link) {
    if (perm('douyinLike') === 'off') return { ok: false, message: '点赞在权限里关掉了' }
    const s = today(load())
    const w = await watch(link)
    if (!w.ok) return w
    const drv = ensureDriver()
    const r = await doWrite(s, 'like', async () => {
      const ok = await drv.clickLike()
      if (!ok) throw new Error('找不到点赞按钮')
    }, { awemeId: w.awemeId })
    return r.ok ? { ok: true, message: r.dryRun ? '试运行：本来要点赞' : '点赞好了' } : r
  }

  /** 工具：在视频下评论。 */
  async function commentVideo(link, text) {
    if (perm('douyinComment') === 'off') return { ok: false, message: '评论在权限里关掉了' }
    const msg = cleanText(text, 100)
    if (!msg) return { ok: false, message: '评论不能是空的' }
    const s = today(load())
    const w = await watch(link)
    if (!w.ok) return w
    const drv = ensureDriver()
    const r = await doWrite(s, 'comment', async () => {
      await drv.openComments()
      const ok = await drv.typeAndSend(msg)
      if (!ok) throw new Error('评论框打不开')
    }, { awemeId: w.awemeId, text: msg })
    if (r.ok && !r.dryRun) memory?.addEvent?.({ text: `在抖音评论：${msg.slice(0, 60)}`, tags: ['抖音'], importance: 0.4 })
    return r.ok ? { ok: true, message: r.dryRun ? '试运行：本来要评论' : '评论发出去了' } : r
  }

  /** 工具：把视频分享到主人抖音。 */
  async function shareToOwner(link, text) {
    if (perm('douyinShareOwner') === 'off') return { ok: false, message: '分享在权限里关掉了' }
    if (!ownerConfirmed(getConfig())) return { ok: false, message: '还没核对主人的抖音号' }
    const s = today(load())
    const w = await watch(link)
    if (!w.ok) return w
    const msg = cleanText(text || '分享给你', 80)
    const secUid = getConfig().douyin.owner.secUid
    const drv = ensureDriver()
    const r = await doWrite(s, 'shareOwner', async () => {
      const sh = await drv.openShareTo(secUid)
      if (!sh?.ok) throw new Error(sh?.message || '没选中主人')
      await drv.typeAndSend(msg).catch(() => {})
    }, { awemeId: w.awemeId, text: msg, secUid })
    return r.ok ? { ok: true, message: r.dryRun ? '试运行：本来要分享' : '分享出去了' } : r
  }

  async function watch(text) {
    const id = findAwemeId(text)
    if (!id) return { ok: false, message: '没认出抖音视频链接' }
    const booted = await boot()
    if (!booted.ok) return { ok: false, message: booted.reason || booted.message }
    const drv = ensureDriver()
    let awemeId = id.awemeId
    if (id.short) {
      await drv.navigate(id.short)
      if (!isFake()) await new Promise((r) => setTimeout(r, 1200))
      awemeId = (await drv.activeAwemeId()) || awemeId
    } else {
      await drv.navigate(videoLink(awemeId))
    }
    if (!awemeId) return { ok: false, message: '打不开这个视频' }
    const s = today(load())
    const v = { awemeId, author: '', desc: '', likes: 0, comments: 0, tags: [] }
    const hit = (drv.recentFeed?.() || []).find((x) => x.awemeId === awemeId)
    if (hit) Object.assign(v, hit)
    memory?.addEvent?.({ text: `看了别人发来的抖音视频 ${awemeId}`, tags: ['抖音'], importance: 0.4 })
    record(s, { kind: 'watch', awemeId, text: '（点开链接看的）' })
    s.watched = (s.watched || 0) + 1
    s.seen = [...new Set([...(s.seen || []), awemeId])].slice(-500)
    save(s)
    return { ok: true, message: digestOf(v), awemeId }
  }

  let runStartedAt = 0
  async function tick() {
    const g = getConfig()
    const c = g.douyin
    if (!g.enabled || !c.enabled) return
    const h = new Date(now()).getHours()
    if (h < g.speakUp.awakeFrom || h >= g.speakUp.awakeTo) return
    const s = today(load())

    if (busy && runStartedAt && now() - runStartedAt > 15 * 60_000) {
      log.warn('刷抖音超过 15 分钟还没结束，强制解锁')
      busy = false
    }

    const dmEvery = (c.dmPollMinutes || 7) * 60_000
    const replyEvery = (c.replyPollMinutes || 25) * 60_000
    if (now() - (s.lastDmCheck || 0) > dmEvery * (0.7 + Math.random() * 0.7)) {
      if (ownerConfirmed(g) && perm('douyinReplyOwnerDm') !== 'off') await checkOwnerDms().catch((e) => log.debug(e.message))
    }
    if (now() - (s.lastReplyCheck || 0) > replyEvery) {
      if (perm('douyinReplyComment') !== 'off') await checkCommentReplies().catch((e) => log.debug(e.message))
    }

    if (!c.autoBrowse || perm('douyinBrowse') === 'off') return
    if (s.runs >= c.maxRunsPerDay) { s.lastSkipReason = '今天轮数满了'; save(s); return }
    if (paused(s)) return
    const due = s.nextDueAt || 0
    if (due && now() < due) return
    if (!due && s.lastRun && now() - s.lastRun < c.intervalHours * 3600_000) return
    runStartedAt = now()
    await run()
    runStartedAt = 0
  }

  function state() {
    const s = today(load())
    return {
      runs: s.runs, watched: s.watched, writes: s.writes || 0,
      like: s.like, comment: s.comment, replyComment: s.replyComment,
      follow: s.follow, dm: s.dm, shareOwner: s.shareOwner, dmReply: s.dmReply,
      lastRun: s.lastRun, nextDueAt: s.nextDueAt, lastSkipReason: s.lastSkipReason,
      history: (s.history || []).slice(0, 20),
      pauseReason: paused(s) ? s.pauseReason : '',
      disabledOps: { ...s.disabledOps },
      newAccount: isNewAccount(s),
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
    run, tick, watch, dmTo, followUser, likeVideo, commentVideo, shareToOwner,
    checkOwnerDms, checkCommentReplies, confirmOwner, account, state,
    setDriver: (d) => { driver = d },
  }
}
