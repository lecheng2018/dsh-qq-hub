// 表情库：偷表情（严格判定 + 尺寸兜底 + MD5 去重 + 每小时限额）→ 收藏到 QQ → 视觉模型起备注；
// 发送时按备注 / 标签模糊匹配。本地库：~/.dsh/plugins-data/aurabot/stickers/
//
// 写入纪律：所有「load → 改 → save」都走 withLock() 串行化。收表情是并发触发的
// （一条消息里多张、多个群同时来），过去在 await 收藏 QQ 时还拿着旧索引快照，
// 后写会把先写覆盖掉——图片文件还在，索引里却没了。锁只包住内存/磁盘的小段，
// 网络请求（下载、收藏 QQ、起名）都在锁外做。

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, readJsonWithBackup, writeJsonWithBackup } from '../core/store.js'
import { imageSize, mimeOf, stickerSizeOk } from '../chat/inbound.js'
import { segmentBytes, fetchImage } from '../core/net.js'
import { askModel, canSeeImages } from '../core/llm.js'
import { findFfmpeg, findSharp, shrinkImage, shrinkWithSharp } from '../core/img.js'
import { buildStickerPack, readStickerPack } from './sticker-pack.js'

const dir = () => dataDir('stickers')
const indexFile = () => join(dir(), 'index.json')
const ext = (mime) => ({ 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[mime] || 'jpg'

export const DEFAULT_TAGS = ['开心', '卖萌', '生气', '委屈', '无语', '嘲讽', '疑惑', '早晚安']
const GENERIC_NAMES = new Set(['动画表情', '表情', '图片', '贴纸'])
// 这些来源是主人亲手加/导入的，库满时优先淘汰「偷来的」，不悄悄清掉自己的收藏。
const PROTECTED_FROM = new Set(['manual', 'panel', 'qq', 'tool', 'pack'])

function validLibrary(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.items)
    && value.items.every((item) => item && typeof item === 'object' && !Array.isArray(item)
      && typeof item.md5 === 'string' && item.md5 && typeof item.file === 'string' && item.file
      && (item.name === undefined || typeof item.name === 'string')
      && (item.tags === undefined || (Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === 'string')))))
}

export function loadLibrary(onError) {
  return readJsonWithBackup(indexFile(), { validate: validLibrary, label: '表情库索引', fallback: () => ({ items: [] }), onError }).value
}

function saveLibrary(lib, onError) {
  writeJsonWithBackup(indexFile(), lib, { validate: validLibrary, label: '表情库索引', onError })
}

export function stickerPath(item) {
  return join(dir(), item.file)
}

/** 标签清洗：去 #、去重、截断。面板和工具共用同一口径。 */
export function cleanTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : [])
    .map((t) => String(t).replace(/^#/, '').trim().slice(0, 8))
    .filter(Boolean))].slice(0, 5)
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 12)
}

// ---------------- 发送去重：别老发同一张 ----------------
// 问题（2026-11-17 对照 MaiBot 的 emoji 选型复盘）：表情库再大，只要某个标签只有一张命中，
// 她就会**反复发同一张** —— 这是最容易让人看出「这是个机器人」的机械感来源。
// 两个补水：① 刚发过的降权（不清零，库里只有这一张时照样发得出去）；② 分数相近的候选一起抽样，
// 而不是永远取最高分。
// 注意：这套只作用于**自动配表情**（pickForReply）。matchSticker 保持确定性，
// 因为 qq_edit_sticker 靠它定位要改名/删除的那一张，随机取值会删错。
const RECENT_USE_WINDOW_MS = 30 * 60_000 // 半小时内发过的算「刚用过」
const RECENT_USE_PENALTY = 0.65 // 刚发过时最多压掉 65% 的分
const NEAR_TOP_WINDOW = 0.15 // 与最高分差在 15% 以内的一起参与抽样

/** 这张表情「刚用过」的程度：0 = 没用过或已经凉了，1 = 刚发出去。 */
export function recentUseDecay(item, now = Date.now()) {
  const last = Number(item?.lastUsed) || 0
  if (!last) return 0
  const age = now - last
  if (!(age >= 0) || age >= RECENT_USE_WINDOW_MS) return 0
  return 1 - age / RECENT_USE_WINDOW_MS
}

/** 降权后仍然 > 0：刚发过只是「更难被挑中」，不是「不可能被挑中」。 */
function recencyFactor(item, now) {
  return 1 - RECENT_USE_PENALTY * recentUseDecay(item, now)
}

/** 单张表情对某个词的匹配分（matchSticker 与 pickForReply 共用，保证两条路径口径一致）。 */
export function stickerScore(item, query) {
  const q = String(query || '').trim()
  if (!q || !item) return 0
  let s = 0
  for (const h of [item.name || '', ...(item.tags || [])]) {
    if (!h) continue
    if (h === q) s = Math.max(s, 10)
    else if (h.includes(q) || q.includes(h)) s = Math.max(s, 6)
    else {
      const common = [...q].filter((c) => h.includes(c)).length
      if (common >= 2) s = Math.max(s, common / Math.max(q.length, 1) * 4)
    }
  }
  return s
}

/**
 * 模糊匹配列表：分数高的在前；同分时按「md5 命中 > 名字完全相等 > 标签完全相等 >
 * 名字更短 > md5」稳定排序，绝不随机。qq_edit_sticker 要拿它判断重名/歧义。
 * @param {Array<object>} items
 * @param {string} query 名字、标签或 md5 前缀（≥6 位）
 * @param {{limit?:number}} [opts]
 */
export function matchStickers(items, query, { limit = 8 } = {}) {
  const q = String(query || '').trim()
  if (!q || !Array.isArray(items) || !items.length) return []
  const md5Query = /^[a-f0-9]{6,32}$/i.test(q) ? q.toLowerCase() : ''
  const scored = []
  for (const item of items) {
    const md5Hit = Boolean(md5Query && String(item.md5 || '').toLowerCase().startsWith(md5Query))
    const score = md5Hit ? 20 : stickerScore(item, q)
    if (score < 1.5) continue
    scored.push({
      item,
      score,
      md5Hit,
      exactName: String(item.name || '') === q,
      exactTag: (item.tags || []).includes(q),
    })
  }
  scored.sort((a, b) => b.score - a.score
    || Number(b.md5Hit) - Number(a.md5Hit)
    || Number(b.exactName) - Number(a.exactName)
    || Number(b.exactTag) - Number(a.exactTag)
    || String(a.item.name || '').length - String(b.item.name || '').length
    || String(a.item.md5 || '').localeCompare(String(b.item.md5 || '')))
  return scored.slice(0, limit)
}

/** 兼容旧调用：只取最确定的一张。完全找不到返回 null。 */
export function matchSticker(items, query) {
  return matchStickers(items, query, { limit: 1 })[0]?.item || null
}

/** 在「分数相近」的候选里按降权后的分做软最大化抽样；只有一个候选时直接返回它。 */
function pickNearTop(candidates, now, rand) {
  if (!candidates.length) return null
  if (candidates.length === 1) return candidates[0].item
  const top = Math.max(...candidates.map((c) => c.adjusted))
  const near = candidates.filter((c) => c.adjusted >= top * (1 - NEAR_TOP_WINDOW))
  if (near.length === 1) return near[0].item
  // 指数化的权重：分差被放大，但仍然保留「次优也偶尔会被挑中」的余地
  const weights = near.map((c) => Math.exp((c.adjusted - top) / Math.max(0.5, top * NEAR_TOP_WINDOW)))
  const sum = weights.reduce((a, b) => a + b, 0)
  let r = rand() * sum
  for (let i = 0; i < near.length; i++) {
    r -= weights[i]
    if (r <= 0) return near[i].item
  }
  return near[near.length - 1].item
}

/**
 * 自动配表情：先按回复里的词匹配，匹配不到随机挑一张。
 * 未起名（pending）的表情不参与自动配图：它们还没有语义，发出去等于随机丢图。
 * @param {{now?:number, rand?:()=>number}} [opts] 测试注入口：固定时钟与随机源
 */
export function pickForReply(items, replyText, opts = {}) {
  const usable = (Array.isArray(items) ? items : []).filter((i) => i && !i.pending)
  if (!usable.length) return null
  const now = Number(opts.now) || Date.now()
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random
  const words = DEFAULT_TAGS.concat(usable.flatMap((i) => i.tags || []))
  const text = String(replyText ?? '')
  for (const w of words) {
    if (!w || !text.includes(w)) continue
    // 同一个词可能命中多张：以前直接取最高分那张，等于「这个情绪永远配这一张」。
    // 现在把够格的都收进来，用「刚用过的降权 + 相近分抽样」挑一张。
    const candidates = []
    for (const it of usable) {
      const score = stickerScore(it, w)
      if (score < 1.5) continue
      candidates.push({ item: it, adjusted: score * recencyFactor(it, now) })
    }
    const hit = pickNearTop(candidates, now, rand)
    if (hit) return hit
  }
  // 兜底随机挑时**只用有语义的**：库里有一批偷来的表情名字就叫「动画表情」、一个标签都没有，
  // 挑到它们等于发一张跟上下文毫无关系的图（匹配问题里最直接的观感损失）。
  // 空名字（还没起名）同样不进兜底池；全都没有才返回 null，让上层干脆不配图。
  const tagged = usable.filter((i) => (i.tags || []).length || (i.name && !GENERIC_NAMES.has(String(i.name))))
  const pool = tagged.length ? tagged : usable.filter((i) => i.name)
  if (!pool.length) return null
  // 兜底没有语义信号，唯一能做的就是避开刚发过的：只要还有「冷的」，就只从冷的里挑。
  // 全都刚发过（或库里就一两张）才退回全池 —— 宁可重复，也不能变成「没有表情可发」。
  const cold = pool.filter((it) => recentUseDecay(it, now) === 0)
  const from = cold.length ? cold : pool
  return from[Math.floor(rand() * from.length)]
}

/** 超过上限时该清掉哪张：只看偷来的，最少被发过的里最老的那张。 */
export function pickEvict(items) {
  // 主人加的、从 QQ 收藏导进来的、从图包导入的不清（那些是主人自己的收藏）
  const pool = items.filter((i) => !PROTECTED_FROM.has(String(i.from || '')))
  if (!pool.length) return null
  return pool.slice().sort((a, b) => (a.uses || 0) - (b.uses || 0) || (a.lastUsed || a.at || 0) - (b.lastUsed || b.at || 0))[0]
}

function num(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function createStickerStore({ dsh, getConfig, onebot, log }) {
  const warn = (error) => log?.warn ? log.warn(error.message) : console.warn(error.message)
  const load = () => loadLibrary(warn)
  const save = (lib) => saveLibrary(lib, warn)
  const config = () => (typeof getConfig === 'function' ? getConfig() : {}) || {}
  const stickerConfig = () => config().stickers || {}
  const maxLibrary = () => Math.max(1, Math.round(num(stickerConfig().maxLibrary, 300, 1, 100000)))

  // 写入串行化：所有 load→改→save 都排进同一条链，网络请求不占锁。
  let writeChain = Promise.resolve()
  function withLock(fn) {
    const run = writeChain.then(fn, fn)
    writeChain = run.then(() => {}, () => {})
    return run
  }

  // 每小时的收集额度按聊天分别算：一个热闹群不该把别的群的额度吃光。
  const collectTimes = new Map()
  function pruneCollects(chatId, now) {
    const key = String(chatId || '')
    const list = (collectTimes.get(key) || []).filter((t) => now - t < 3600_000)
    if (list.length) collectTimes.set(key, list)
    else collectTimes.delete(key)
    return list
  }

  // 自动配表情的节流：冷却按聊天、每小时发送上限按聊天；只影响自动配图，显式发不受影响。
  const lastSentAt = new Map()
  const sentTimes = new Map()
  function pruneSends(chatId, now) {
    const key = String(chatId || '')
    const list = (sentTimes.get(key) || []).filter((t) => now - t < 3600_000)
    if (list.length) sentTimes.set(key, list)
    else sentTimes.delete(key)
    return list
  }

  /**
   * 某个聊天的表情策略：全局 stickers 配置 + 群覆盖（stickers.overrides[群号]）。
   * 私聊没有群覆盖，直接用全局。
   */
  function policyFor(chatId) {
    const base = stickerConfig()
    const gid = (/^group:(\d+)$/.exec(String(chatId || '')) || [])[1] || ''
    const overrides = base && typeof base.overrides === 'object' && !Array.isArray(base.overrides) ? base.overrides : {}
    const o = gid && overrides[gid] && typeof overrides[gid] === 'object' ? overrides[gid] : {}
    const pick = (key, fallback) => (o[key] !== undefined ? o[key] : (base[key] !== undefined ? base[key] : fallback))
    return {
      ...base,
      ...o,
      enabled: pick('enabled', true) !== false,
      collect: pick('collect', true) !== false,
      collectMode: ['auto', 'ask', 'owner'].includes(o.collectMode)
        ? o.collectMode
        : (['auto', 'ask', 'owner'].includes(base.collectMode) ? base.collectMode : 'auto'),
      fromGroups: pick('fromGroups', true) !== false,
      fromPrivate: pick('fromPrivate', true) !== false,
      autoChance: num(pick('autoChance', 0.35), 0.35, 0, 1),
      maxPerHour: num(pick('maxPerHour', 20), 20, 0, 200),
      cooldownSec: num(pick('cooldownSec', 0), 0, 0, 3600),
      sendMaxPerHour: num(pick('sendMaxPerHour', 0), 0, 0, 500),
      maxSide: num(pick('maxSide', 1920), 1920, 32, 10000),
      maxBytes: num(pick('maxBytes', 5 * 1024 * 1024), 5 * 1024 * 1024, 1024, 50 * 1024 * 1024),
      maxGifBytes: num(pick('maxGifBytes', 10 * 1024 * 1024), 10 * 1024 * 1024, 1024, 50 * 1024 * 1024),
    }
  }

  /** 自动配表情前检查：总开关、冷却、每小时发送上限。 */
  function canAutoSend(chatId, now = Date.now()) {
    const pol = policyFor(chatId)
    if (!pol.enabled) return false
    const key = String(chatId || '')
    const last = Number(lastSentAt.get(key)) || 0
    if (pol.cooldownSec > 0 && last && now - last < pol.cooldownSec * 1000) return false
    if (pol.sendMaxPerHour > 0 && pruneSends(key, now).length >= pol.sendMaxPerHour) return false
    return true
  }

  function noteSent(chatId, now) {
    const key = String(chatId || '')
    if (!key) return
    lastSentAt.set(key, now)
    const list = pruneSends(key, now)
    list.push(now)
    sentTimes.set(key, list.slice(-500))
  }

  function deleteLocalFiles(item) {
    for (const file of [item?.file, item?.sendFile, item?.md5 ? `thumb-${item.md5}.jpg` : '']) {
      if (!file) continue
      try { unlinkSync(join(dir(), file)) } catch (error) {}
    }
  }

  async function deleteQQFaces(items) {
    if (config().dryRun || !onebot?.call) return
    for (const item of Array.isArray(items) ? items : []) {
      if (!item?.emojiId) continue
      try { await onebot.call('delete_custom_face', { emoji_id: item.emojiId }) } catch (error) {
        log.warn('从 QQ 收藏里删除失败：', error.message)
      }
    }
  }

  /** 在锁内腾出位置；淘汰的条目先只从索引/磁盘移除，QQ 收藏在锁外删。 */
  function makeRoomLocked(lib) {
    const max = maxLibrary()
    const evicted = []
    while (lib.items.length >= max) {
      const out = pickEvict(lib.items)
      if (!out) {
        return { ok: false, reason: `表情库满了（上限 ${max}，手动添加/导入的表情不会被自动清理）`, evicted }
      }
      lib.items = lib.items.filter((i) => i.md5 !== out.md5)
      deleteLocalFiles(out)
      evicted.push(out)
    }
    return { ok: true, evicted }
  }

  function removeLocked(lib, md5) {
    const idx = lib.items.findIndex((i) => i.md5 === md5)
    if (idx < 0) return null
    const [item] = lib.items.splice(idx, 1)
    deleteLocalFiles(item)
    return item
  }

  // ---------------- 起名队列 ----------------
  // 附件服务把图登记成附件时失败（例如工作区目录不可写 → EACCES），
  // 逐张重试只会刷满日志、一张也起不了名。失败一次就熔断，进程重启前不再试。
  let captionBlocked = ''
  let captionChain = Promise.resolve()
  let sharpPromise = null
  const getSharp = () => {
    if (!sharpPromise) sharpPromise = findSharp().catch(() => null)
    return sharpPromise
  }

  async function caption(buf, mime, hint) {
    try {
      if (captionBlocked) return { name: '', tags: [] }
      // 模型看不了图就别硬发：会报错，名字也起不出来
      if ((await canSeeImages(dsh, getConfig())) === false) {
        log.debug?.('模型不支持看图，跳过表情起名')
        return { name: '', tags: [] }
      }
      let imageFailed = ''
      // 超大 GIF (>4MB) 跳过耗时的视觉大模型 base64 传输，避免模型上下文/超时报错
      if (buf.length > 4 * 1024 * 1024 && mime === 'image/gif') {
        log.debug?.('超大 GIF 动图（' + Math.round(buf.length / 1024) + 'KB）跳过视觉模型起名，采用默认提示词')
        return { name: hint ? String(hint).replace(/[\[\]]/g, '').trim().slice(0, 12) : '动图表情', tags: ['动画表情'] }
      }
      const text = await askModel(dsh, {
        cfg: getConfig(),
        onImageError: (error) => {
          // 图登记不进去，这一批都别再试了，只记一条
          imageFailed = error?.message || '图片登记失败'
          captionBlocked = imageFailed
          log.warn(`看图起名停用：图片没能交给模型（${imageFailed}）。修好工作区目录或重启后再试。`)
        },
        system: '你给表情包起名字。只输出一行：不超过 12 个字的中文备注，描述这个表情表达的情绪或内容（例如「委屈巴巴的小猫」「得意地叉腰」）。然后空格，再写 1~3 个标签，从这些里挑：' + DEFAULT_TAGS.join('、') + '。格式：备注 #标签1 #标签2',
        text: hint ? `QQ 给的描述是「${hint}」。请看图起名。` : '请看图起名。',
        images: [{ data: buf.toString('base64'), mediaType: mime }],
        // ⚠ 别给太小：模型会先思考，120 这种上限会被思考吃光，正文是空的（实测踩过）
        maxTokens: 1000,
        temperature: 0.2,
      })
      // 模型根本没看到图：这时它回的名字是瞎猜的，宁可不起名
      if (imageFailed) return { name: '', tags: [] }
      if (!text) log.warn('看图起名：模型没给出文字')
      const line = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''
      const tags = [...line.matchAll(/#\s*([^\s#]+)/g)].map((m) => m[1]).filter((t) => t.length <= 6).slice(0, 3)
      const name = line.replace(/#\s*[^\s#]+/g, '').replace(/[「」"'“”]/g, '').trim().slice(0, 12)
      return { name, tags }
    } catch (error) {
      log.warn('看图起名失败：', error.message)
      return { name: '', tags: [] }
    }
  }

  async function captionAndSave(md5, buf, mime, hint) {
    const current = load().items.find((i) => i.md5 === md5)
    if (!current || current.name) return
    const { name, tags } = await caption(buf, mime, hint)
    let desc = ''
    let emojiId = ''
    await withLock(async () => {
      const lib = load()
      const it = lib.items.find((i) => i.md5 === md5)
      if (!it) return
      // 起名期间主人可能已经手动改过名：不要用模型的旧结果覆盖。
      if (it.name) {
        it.pending = false
        save(lib)
        return
      }
      if (name) it.name = cleanName(name)
      if (tags.length) it.tags = cleanTags(tags)
      // 起名失败也解除 pending：空名字不会进自动池，但也不会永远卡在「正在起名」。
      it.pending = false
      save(lib)
      desc = it.name
      emojiId = it.emojiId
    })
    if (desc && emojiId && !config().dryRun && onebot?.call) {
      try { await onebot.call('modify_custom_face', { emoji_id: emojiId, desc: desc.slice(0, 20) }) } catch (error) {
        log.warn('写回 QQ 备注失败：', error.message)
      }
    }
    if (desc) log.info(`表情 ${md5.slice(0, 8)} 起名「${desc}」${tags.length ? ' #' + tags.join(' #') : ''}`)
  }

  function scheduleCaption(md5, buf, mime, hint) {
    captionChain = captionChain
      .then(() => captionAndSave(md5, buf, mime, hint))
      .catch((error) => log.warn('表情起名收尾出错：', error.message))
    return captionChain
  }

  async function toJpeg(buf) {
    let small = null
    const ffmpeg = findFfmpeg(config().bili?.ffmpegPath || '')
    if (ffmpeg) small = await shrinkImage(buf, 1280, ffmpeg)
    if (!small) small = await shrinkWithSharp(await getSharp(), buf, 1280)
    return small
  }

  /** 收一张表情。seg 必须已经过 isStickerSegment / isStickerCandidate 判定。 */
  async function collect(seg, from) {
    const pol = policyFor(from)
    if (!pol.enabled || !pol.collect) return { ok: false, reason: '偷表情关着' }
    const isGroup = String(from || '').startsWith('group:')
    if (isGroup ? !pol.fromGroups : !pol.fromPrivate) return { ok: false, reason: '这个来源不偷表情' }
    const now = Date.now()
    if (pruneCollects(from, now).length >= pol.maxPerHour) return { ok: false, reason: '这小时收够了' }
    const d = seg.data || {}
    let buf
    try {
      // 下载预留上限：支持 GIF 时放宽到 10MB，普通静态图放宽到 5MB
      buf = await segmentBytes(seg, onebot, { maxBytes: Math.max(pol.maxGifBytes, pol.maxBytes) })
    } catch (error) {
      return { ok: false, reason: '下载失败：' + error.message }
    }
    const mime = mimeOf(buf)
    const isGif = mime === 'image/gif'
    // 默认静态表情放宽到 5MB，只有判定是 GIF 动图时才允许 10MB 以下
    const allowedBytes = isGif ? pol.maxGifBytes : pol.maxBytes
    const { width, height } = imageSize(buf)
    if (!stickerSizeOk({ width, height, bytes: buf.length, mime }, { maxSide: pol.maxSide, maxBytes: allowedBytes, isGif })) {
      return { ok: false, reason: `尺寸或体积不像表情（${width}x${height}，${Math.round(buf.length / 1024)}KB，类型 ${mime}，允许上限 ${Math.round(allowedBytes / 1024 / 1024)}MB）` }
    }
    const md5 = createHash('md5').update(buf).digest('hex')
    const wantCaption = Boolean(stickerConfig().caption)
    const pre = await withLock(async () => {
      const lib = load()
      if (lib.items.some((i) => i.md5 === md5)) return { existed: true }
      // 锁内再查一次额度：并发下载可能都通过了下载前的预检。
      if (pruneCollects(from, now).length >= pol.maxPerHour) return { ok: false, reason: '这小时收够了' }
      const room = makeRoomLocked(lib)
      if (!room.ok) return room
      mkdirSync(dir(), { recursive: true })
      const file = `collected-${md5}.${ext(mime)}`
      writeFileSync(join(dir(), file), buf)
      const item = {
        md5, file, name: '', tags: [], from, at: now, width, height, bytes: buf.length,
        emojiId: '', summary: String(d.summary || '').replace(/[[\]]/g, ''), pending: wantCaption,
      }
      // 商城表情（QQ 表情商店里的）：存下来的只是一张预览图，原样发回去才会按商城表情播放动画（#31）
      const marketId = String(d.emoji_id ?? d.emojiId ?? '').trim()
      if (marketId) item.market = { emojiId: marketId, packageId: Number(d.emoji_package_id ?? d.emojiPackageId ?? 0) || 0, key: String(d.key ?? '') }
      lib.items.push(item)
      save(lib)
      const list = pruneCollects(from, now)
      list.push(now)
      collectTimes.set(String(from || ''), list.slice(-500))
      return { ok: true, item, evicted: room.evicted }
    })
    if (pre.existed) return { ok: false, reason: '已经有了' }
    if (!pre.ok) return pre
    await deleteQQFaces(pre.evicted)
    log.info(`收了一张表情 ${md5.slice(0, 8)}（${width}x${height}）`)
    // 收藏到 QQ（网络请求在锁外）
    let warning = ''
    if (!config().dryRun && onebot?.call) {
      try {
        const r = await onebot.call('add_custom_face', { file: 'base64://' + buf.toString('base64') })
        const emojiId = String(r?.emoji_id || '')
        if (emojiId) {
          pre.item.emojiId = emojiId
          await withLock(async () => {
            const lib = load()
            const it = lib.items.find((i) => i.md5 === md5)
            if (!it) return
            it.emojiId = emojiId
            save(lib)
          })
        }
      } catch (error) {
        warning = 'QQ 收藏失败：' + error.message
        pre.item.qqError = error.message
        await withLock(async () => {
          const lib = load()
          const it = lib.items.find((i) => i.md5 === md5)
          if (!it) return
          it.qqError = error.message
          save(lib)
        })
        log.warn('收藏到 QQ 失败（本地已留档）：', error.message)
      }
    }
    if (pre.item.pending) scheduleCaption(md5, buf, mime, pre.item.summary)
    return { ok: true, item: pre.item, ...(warning ? { warning } : {}) }
  }

  /** 手动添加（工具 / 面板上传 / 图包导入）。 */
  async function addFromBuffer(buf, { name = '', tags = [], from = 'manual', toQQ = true, skipCaption = false } = {}) {
    const mime = mimeOf(buf)
    if (!mime.startsWith('image/')) return { ok: false, reason: '不是图片' }
    const md5 = createHash('md5').update(buf).digest('hex')
    const now = Date.now()
    const clean = cleanName(name)
    const wantCaption = !skipCaption && !clean && Boolean(stickerConfig().caption)
    // WebP 兼容优先：只在用户明确打开时转 JPEG；原文件保留，发送时用 sendFile。
    let sendFile = ''
    if (mime === 'image/webp' && stickerConfig().webpToJpeg) {
      const jpg = await toJpeg(buf)
      if (jpg) sendFile = `send-${md5}.jpg`
      if (jpg) {
        try {
          mkdirSync(dir(), { recursive: true })
          writeFileSync(join(dir(), sendFile), jpg)
        } catch (error) {
          sendFile = ''
        }
      }
    }
    const pre = await withLock(async () => {
      const lib = load()
      const exist = lib.items.find((i) => i.md5 === md5)
      if (exist) return { existed: true, item: exist }
      const room = makeRoomLocked(lib)
      if (!room.ok) return room
      mkdirSync(dir(), { recursive: true })
      const file = `manual-${md5}.${ext(mime)}`
      writeFileSync(join(dir(), file), buf)
      const { width, height } = imageSize(buf)
      const item = {
        md5, file, name: clean, tags: cleanTags(tags), from, at: now, width, height,
        bytes: buf.length, emojiId: '', pending: wantCaption,
      }
      if (sendFile) item.sendFile = sendFile
      lib.items.push(item)
      save(lib)
      return { ok: true, item, evicted: room.evicted }
    })
    if (pre.existed) return { ok: true, item: pre.item, existed: true }
    if (!pre.ok) return pre
    await deleteQQFaces(pre.evicted)
    let warning = ''
    if (toQQ && !config().dryRun && onebot?.call) {
      try {
        const r = await onebot.call('add_custom_face', { file: 'base64://' + buf.toString('base64') })
        const emojiId = String(r?.emoji_id || '')
        if (emojiId) {
          pre.item.emojiId = emojiId
          await withLock(async () => {
            const lib = load()
            const it = lib.items.find((i) => i.md5 === md5)
            if (!it) return
            it.emojiId = emojiId
            save(lib)
          })
          if (pre.item.name) await onebot.call('modify_custom_face', { emoji_id: emojiId, desc: pre.item.name }).catch(() => {})
        }
      } catch (error) {
        warning = 'QQ 收藏失败：' + error.message
        pre.item.qqError = error.message
        await withLock(async () => {
          const lib = load()
          const it = lib.items.find((i) => i.md5 === md5)
          if (!it) return
          it.qqError = error.message
          save(lib)
        })
        log.warn('收藏到 QQ 失败（本地已留档）：', error.message)
      }
    }
    if (pre.item.pending) scheduleCaption(md5, buf, mime, '')
    return { ok: true, item: pre.item, ...(warning ? { warning } : {}) }
  }

  /** 表情库超过上限就清掉最少用的（QQ 收藏表情有数量上限，满了就收不进去了）。 */
  async function trim() {
    const result = await withLock(async () => {
      const lib = load()
      const max = maxLibrary()
      const evicted = []
      while (lib.items.length > max) {
        const out = pickEvict(lib.items)
        if (!out) break
        lib.items = lib.items.filter((i) => i.md5 !== out.md5)
        deleteLocalFiles(out)
        evicted.push(out)
      }
      if (evicted.length) save(lib)
      return { evicted, over: Math.max(0, lib.items.length - max) }
    })
    await deleteQQFaces(result.evicted)
    if (result.over > 0) log.warn(`表情库超过上限 ${maxLibrary()} 张，剩下的都是手动添加/导入的表情，需要主人自己删`)
    return { ok: true, evicted: result.evicted.length, over: result.over }
  }

  /** 发出去一次：记下来，常用的不会被清掉；同时给自动配图记冷却/额度。 */
  async function markUsed(md5, chatId, at = Date.now()) {
    noteSent(chatId, at)
    await withLock(async () => {
      const lib = load()
      const it = lib.items.find((i) => i.md5 === md5)
      if (!it) return
      it.uses = (it.uses || 0) + 1
      it.lastUsed = at
      save(lib)
    })
  }

  async function remove(md5, { fromQQ = true } = {}) {
    const item = await withLock(async () => {
      const lib = load()
      const removed = removeLocked(lib, md5)
      if (removed) save(lib)
      return removed
    })
    if (!item) return { ok: false, reason: '没有这张' }
    if (fromQQ) await deleteQQFaces([item])
    return { ok: true }
  }

  async function removeMany(md5s, { fromQQ = true } = {}) {
    const wanted = new Set((Array.isArray(md5s) ? md5s : []).map(String).filter(Boolean))
    if (!wanted.size) return { ok: false, reason: '没选要删的表情' }
    const removed = await withLock(async () => {
      const lib = load()
      const out = []
      for (const md5 of [...wanted]) {
        const item = removeLocked(lib, md5)
        if (item) out.push(item)
      }
      if (out.length) save(lib)
      return out
    })
    if (fromQQ) await deleteQQFaces(removed)
    return { ok: true, removed: removed.length, missing: wanted.size - removed.length }
  }

  async function rename(md5, name, tags) {
    let item = null
    let conflict = ''
    await withLock(async () => {
      const lib = load()
      const it = lib.items.find((i) => i.md5 === md5)
      if (!it) return
      if (name !== undefined) {
        const nextName = cleanName(name)
        const duplicate = nextName && lib.items.find((o) => o.md5 !== md5 && o.name === nextName)
        if (duplicate) { conflict = nextName; return }
        it.name = nextName
        if (!it.name) it.pending = false
      }
      if (tags !== undefined) it.tags = cleanTags(tags)
      it.pending = false
      save(lib)
      item = it
    })
    if (conflict) return { ok: false, reason: `已有同名表情「${conflict}」，换一个名字或用 md5 指定` }
    if (!item) return { ok: false }
    if (item.emojiId && !config().dryRun && onebot?.call) onebot.call('modify_custom_face', { emoji_id: item.emojiId, desc: item.name }).catch(() => {})
    return { ok: true, item }
  }

  /** 发表情用的消息段：商城表情按商城表情原样发（带 emoji_id，网关会认回成 mface）；其余本地图片按表情（sub_type=1）发。 */
  function segmentFor(item) {
    if (item.market?.emojiId) return { type: 'image', data: { emoji_id: item.market.emojiId, emoji_package_id: item.market.packageId, key: item.market.key, summary: `[${item.name || '表情'}]` } }
    const file = item.sendFile && existsSync(join(dir(), item.sendFile)) ? join(dir(), item.sendFile) : stickerPath(item)
    if (!existsSync(file)) return null
    return { type: 'image', data: { file: 'base64://' + readFileSync(file).toString('base64'), sub_type: 1, summary: `[${item.name || '表情'}]` } }
  }

  /** 面板缩略图：优先用 ffmpeg / DSH 自带 sharp 缩到 256，失败就退回原图。 */
  async function thumbFor(md5) {
    const item = load().items.find((i) => i.md5 === md5)
    if (!item) return null
    const source = item.sendFile && existsSync(join(dir(), item.sendFile)) ? join(dir(), item.sendFile) : stickerPath(item)
    if (!existsSync(source)) return null
    const thumb = join(dir(), `thumb-${md5}.jpg`)
    if (existsSync(thumb)) return { buf: readFileSync(thumb), mime: 'image/jpeg' }
    let buf
    try { buf = readFileSync(source) } catch (error) { return null }
    let small = null
    const ffmpeg = findFfmpeg(config().bili?.ffmpegPath || '')
    if (ffmpeg) small = await shrinkImage(buf, 256, ffmpeg)
    if (!small) small = await shrinkWithSharp(await getSharp(), buf, 256)
    if (small) {
      try { writeFileSync(thumb, small) } catch (error) {}
      return { buf: small, mime: 'image/jpeg' }
    }
    return { buf, mime: mimeOf(buf) }
  }

  /** 按名字/标签/md5 找一张；多张同分且不是 md5/全名精确命中时判为歧义。 */
  function resolve(query) {
    const matches = matchStickers(load().items, query, { limit: 8 })
    if (!matches.length) return { item: null, candidates: [] }
    const top = matches[0]
    const tied = matches.filter((m) => m.score === top.score)
    if (tied.length > 1 && !top.md5Hit && !top.exactName) {
      return {
        item: null,
        ambiguous: true,
        candidates: tied.map((m) => ({ md5: m.item.md5, name: m.item.name || '', tags: m.item.tags || [] })),
      }
    }
    return { item: top.item, candidates: matches.map((m) => ({ md5: m.item.md5, name: m.item.name || '', tags: m.item.tags || [] })) }
  }

  /**
   * 把机器人号 QQ「我喜欢的」里已有的表情导进表情库（fetch_custom_face）。已经有的跳过；
   * 不再往 QQ 收藏里加一遍。开了「看图起名」就在后台一张张起名。
   */
  let importing = null
  async function importFromQQ({ limit = maxLibrary() } = {}) {
    if (importing) return importing
    importing = (async () => {
      let urls
      try {
        const r = await onebot.call('fetch_custom_face', { count: Math.max(1, Math.min(500, Number(limit) || 300)) }, { timeoutMs: 30000 })
        urls = (Array.isArray(r) ? r : r?.data || []).map((x) => (typeof x === 'string' ? x : x?.url || '')).filter(Boolean)
      } catch (error) {
        return { ok: false, message: '读不到机器人号的 QQ 收藏表情：' + error.message }
      }
      let added = 0
      let existed = 0
      let failed = 0
      let skipped = 0
      const named = []
      for (const url of urls) {
        let buf
        // 网关返回的地址属半可信输入：不放开本地路径，避免把本机文件当图片读。
        try { buf = await fetchImage(url, { maxBytes: Math.max(policyFor('').maxGifBytes, policyFor('').maxBytes) }) } catch (error) { failed++; log.warn('导入单张失败：', error.message); continue }
        const r = await addFromBuffer(buf, { from: 'qq', toQQ: false, skipCaption: true })
        if (r.ok && r.existed) existed++
        else if (r.ok) {
          added++
          named.push({ md5: r.item.md5, buf, mime: mimeOf(buf) })
        } else if (/表情库满了/.test(String(r.reason || ''))) skipped++
        else { failed++; log.warn('导入单张没存成：', r.reason || '未知原因') }
      }
      log.info(`从 QQ 收藏导入表情：新加 ${added} 张，已有 ${existed} 张${skipped ? `，库满跳过 ${skipped} 张` : ''}${failed ? `，${failed} 张失败` : ''}`)
      if (named.length && stickerConfig().caption) {
        for (const { md5, buf, mime } of named) scheduleCaption(md5, buf, mime, '')
      }
      return {
        ok: true, added, existed, failed, skipped, total: urls.length,
        message: urls.length
          ? `QQ 收藏里有 ${urls.length} 张：新导入 ${added} 张，已经有 ${existed} 张${skipped ? `，库满跳过 ${skipped} 张` : ''}${failed ? `，${failed} 张下载/解析失败` : ''}${added && stickerConfig().caption ? '。名字在后台慢慢起' : ''}`
          : 'QQ 收藏里没有表情',
      }
    })().finally(() => { importing = null })
    return importing
  }

  /** 导出图包（manifest + 原图），供面板下载或换机器迁移。 */
  async function exportPack() {
    const lib = load()
    const entries = []
    for (const item of lib.items) {
      // 导出始终用原图（WebP 的 sendFile 只是发送副本，换了会改变 MD5，也让图包丢动画）。
      const file = item.file
      if (!file || !existsSync(join(dir(), file))) continue
      entries.push({ name: `stickers/${item.md5}.${String(file).split('.').pop() || 'bin'}`, data: readFileSync(join(dir(), file)), item })
    }
    return buildStickerPack(entries.map((e) => ({ name: e.name, data: e.data, item: e.item })))
  }

  /** 导入图包：逐张走 addFromBuffer（MD5 去重、容量检查、QQ 收藏、起名队列都复用）。 */
  async function importPack(buf, { toQQ = true } = {}) {
    let pack
    try { pack = readStickerPack(buf) } catch (error) { return { ok: false, message: '图包读不了：' + error.message } }
    let added = 0
    let existed = 0
    let failed = 0
    let skipped = 0
    for (const entry of pack.items) {
      const r = await addFromBuffer(entry.data, { name: entry.name, tags: entry.tags, from: 'pack', toQQ })
      if (r.ok && r.existed) existed++
      else if (r.ok) added++
      else if (/表情库满了/.test(String(r.reason || ''))) skipped++
      else failed++
    }
    return {
      ok: true, added, existed, failed, skipped, total: pack.items.length,
      message: `图包里有 ${pack.items.length} 张：新导入 ${added} 张，已有 ${existed} 张${skipped ? `，库满跳过 ${skipped} 张` : ''}${failed ? `，${failed} 张失败` : ''}`,
    }
  }

  return {
    importFromQQ, importPack, exportPack, collect, addFromBuffer,
    remove, removeMany, rename, segmentFor, thumbFor, markUsed, trim,
    policyFor, canAutoSend, resolve,
    library: load,
    match: (q) => matchSticker(load().items, q),
    matchAll: (q) => matchStickers(load().items, q),
    pickForReply: (t) => pickForReply(load().items, t),
  }
}
