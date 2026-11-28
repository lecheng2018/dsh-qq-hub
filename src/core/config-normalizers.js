// 按域拆分的配置归一化纯函数、主 normalize(raw) 编排与面板合并 mergeFromPanel。

import { DEFAULTS, PROFILE_PERMS_VERSION, deepMerge, isObj } from './config-defaults.js'
import { allSecrets, getAt, parentOf, splitBiliCookie } from './config-secrets.js'
import { migrateConfig, stripLegacyKeys } from './config-migrations.js'
import { DEFAULT_GROUP_POLICY } from '../chat/group-policy.js'
import { LEVELS, PROFILE_PERM_KEYS, PROFILE_PERM_LEVELS, profilePermDefault } from '../chat/access.js'
import { normalizeChatModels } from '../chat/chat-model.js'
import { DIARY_AUDIENCES } from '../features/qzone-audience.js'

// ---------------- 基础归一化工具 ----------------

/**
 * 数字配置归一化。
 * 空值（'' / null / undefined）一律当「没填」，回落默认值 d —— 这是面板「清空 = 恢复默认」的落点。
 * 注意只把空串当未填：数字 0 是合法取值（很多开关型字段「0 = 关掉」），照常走下界钳制。
 */
export const num = (v, d, lo, hi) => {
  if (v === '' || v === null || v === undefined) return d
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}

export const bool = (v, d) => (typeof v === 'boolean' ? v : d)
export const qq = (v) => String(v ?? '').replace(/\D/g, '')
export const qqList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,，;；]+/)).map(qq).filter(Boolean))]
export const hhmm = (v, d) => {
  const s = String(v ?? '')
  if (!/^\d{1,2}:\d{2}$/.test(s)) return d
  // 审计 T3.9：过去只校验「形状」，25:90 / 99:99 这类假时间会原样落盘，
  // 挂上去的定时器永不触发（日记窗口、整理时刻、问候语全静默失效）。
  const [hh, mm] = s.split(':').map(Number)
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 ? s : d
}
export const strList = (v, sep = /[\s,，]+/) => (Array.isArray(v) ? v : String(v || '').split(sep)).map((s) => String(s).trim()).filter(Boolean)

const absPath = (v) => {
  const s = String(v || '').trim()
  return s && /^([a-zA-Z]:[\\/]|\/)/.test(s) ? s : ''
}

// ---------------- 子域 normalizer ----------------

/**
 * 人设配置归一化。
 * 兼容三种老形状：字符串（直接是人设 id）、{ current }、以及新版带 personaMap 的对象。
 */
export function normalizePersona(p) {
  const ok = (id) => String(id || '').trim()
  if (typeof p === 'string') return { current: ok(p) || 'dafeiyu', privateDefault: '', groupDefault: '', privates: {}, groups: {} }
  const o = isObj(p) ? p : {}
  const mapIds = (m) => {
    const out = {}
    if (isObj(m)) {
      for (const [k, v] of Object.entries(m)) {
        if (String(k).startsWith('#')) continue // 临时占位行（如 #new...）绝不落盘，防止被洗成纯数字
        const key = qq(k)
        if (!key) continue
        // 值可以先空着：面板里「添加」一行、还没选人设就保存，那一行不该被悄悄丢掉
        out[key] = ok(v)
      }
    }
    return out
  }
  return {
    current: ok(o.current) || 'dafeiyu',
    privateDefault: ok(o.privateDefault),
    groupDefault: ok(o.groupDefault),
    privates: mapIds(o.privates),
    groups: mapIds(o.groups),
  }
}

function normalizeCore(c) {
  c.enabled = bool(c.enabled, false)
  c.dryRun = bool(c.dryRun, true)
  c.setupDone = bool(c.setupDone, false)
  c.botQQ = qq(c.botQQ)
  c.ownerQQ = qq(c.ownerQQ)
  c.ownerLevel = LEVELS.includes(c.ownerLevel) ? c.ownerLevel : 'full'
  c.longTasks = bool(c.longTasks, false)
  c.turnTimeoutMs = Math.round(num(c.turnTimeoutMs, 600000, 60000, 7200000))
  c.gateway = c.gateway === 'onebot' ? 'onebot' : 'snowluma'
  // 只认绝对路径（Windows 的 D:\… 或 Linux 的 /…），别的当没填
  c.workspaceDir = absPath(c.workspaceDir)
  c.workspacePerChat = bool(c.workspacePerChat, false)
  c.allow = { private: qqList(c.allow?.private), groups: qqList(c.allow?.groups) }
  c.safeMode = bool(c.safeMode, false)
  if (!isObj(c.snowluma)) c.snowluma = { ...DEFAULTS.snowluma }
  c.snowluma.webuiPort = num(c.snowluma.webuiPort, 5099, 1, 65535)
}

function normalizeModelsAndSession(c) {
  if (!isObj(c.model)) c.model = { ...DEFAULTS.model }
  // 视觉能力：auto = 问 DSH 的模型元数据；on / off = 主人手动声明（覆盖元数据）
  c.model.vision = c.model.vision === 'on' || c.model.vision === 'off' ? c.model.vision : 'auto'
  c.chatModels = normalizeChatModels(c.chatModels)

  if (!isObj(c.visionHelper)) c.visionHelper = {}
  c.visionHelper.enabled = bool(c.visionHelper.enabled, false)
  c.visionHelper.provider = String(c.visionHelper.provider || '').trim()
  c.visionHelper.model = String(c.visionHelper.model || '').trim()
  c.visionHelper.maxImages = Math.round(num(c.visionHelper.maxImages, 4, 1, 8))
  c.visionHelper.maxChars = Math.round(num(c.visionHelper.maxChars, 600, 100, 2000))
  c.visionHelper.keepOriginal = bool(c.visionHelper.keepOriginal, true)

  if (!isObj(c.sessionRotation)) c.sessionRotation = {}
  c.sessionRotation.enabled = bool(c.sessionRotation.enabled, true)
  c.sessionRotation.migrated = true
  c.sessionRotation.maxTurns = Math.round(num(c.sessionRotation.maxTurns, 60, 0, 100000))
  c.sessionRotation.maxAgeHours = num(c.sessionRotation.maxAgeHours, 24, 0, 8760)

  if (!isObj(c.orphanSweep)) c.orphanSweep = {}
  c.orphanSweep.enabled = bool(c.orphanSweep.enabled, true)
  c.orphanSweep.idleHours = num(c.orphanSweep.idleHours, 6, 1, 8760)
  c.orphanSweep.intervalHours = num(c.orphanSweep.intervalHours, 6, 1, 168)
  c.orphanSweep.maxPerPass = Math.round(num(c.orphanSweep.maxPerPass, 20, 1, 200))

  if (!isObj(c.imageBudget)) c.imageBudget = {}
  c.imageBudget.enabled = bool(c.imageBudget.enabled, true)
  c.imageBudget.maxImages = Math.round(num(c.imageBudget.maxImages, 24, 0, 200))
  c.imageBudget.maxMiB = Math.round(num(c.imageBudget.maxMiB, 12, 0, 128))
}

function normalizeBrowser(c) {
  if (!isObj(c.browser)) c.browser = {}
  c.browser.enabled = bool(c.browser.enabled, true)
  c.browser.chromePath = String(c.browser.chromePath || '').trim()
  c.browser.headless = bool(c.browser.headless, false)
  c.browser.chrome = bool(c.browser.chrome, true)
  c.browser.maxConcurrent = Math.round(num(c.browser.maxConcurrent, 2, 1, 4))
  c.browser.idleMinutes = Math.round(num(c.browser.idleMinutes, 10, 0, 240))
  c.browser.minFreeMB = Math.round(num(c.browser.minFreeMB, 600, 0, 8192))
  c.browser.vncLan = bool(c.browser.vncLan, false)
}

function normalizeAccess(c, raw) {
  c.persona = normalizePersona(c.persona)
  c.profilePerms = Object.fromEntries(
    PROFILE_PERM_KEYS.map((k) => [k, PROFILE_PERM_LEVELS.includes(c.profilePerms?.[k]) ? c.profilePerms[k] : profilePermDefault(k)]),
  )
  // 旧版 douyinDm 是「回别人私信」的权限，含义已不同（现在是主动发私信），仅旧版本迁移一次回到默认「仅主人」；
  // 迁移后写入 profilePermsVersion，后续用户修改 douyinDm 不再被 normalize 强行覆写。
  const rawPermsVersion = Number(raw?.profilePermsVersion || 0)
  if (rawPermsVersion < PROFILE_PERMS_VERSION && isObj(raw?.profilePerms) && 'douyinDm' in raw.profilePerms) {
    c.profilePerms.douyinDm = profilePermDefault('douyinDm')
  }
  c.profilePermsVersion = PROFILE_PERMS_VERSION
}

function normalizeFilesAndSecurity(c) {
  if (!isObj(c.files)) c.files = {}
  c.files.enabled = bool(c.files.enabled, true)
  c.files.maxMB = num(c.files.maxMB, 50, 1, 2048)
  // 入站上限与 inboundFileMaxBytes() 的硬顶对齐（256MB），0 / 空串当作「没配」
  const inboundMaxMB = Number(c.files.inboundMaxMB)
  c.files.inboundMaxMB = num(inboundMaxMB > 0 ? inboundMaxMB : undefined, 50, 1, 256)
  c.files.dirs = strList(c.files.dirs, /[\n,，;；]+/).filter((s) => /^([a-zA-Z]:[\\/]|\/)/.test(s)).slice(0, 20)

  if (!isObj(c.security)) c.security = {}
  c.security.dangerConfirm = bool(c.security.dangerConfirm, false)
  if (!isObj(c.security.identityGuard)) c.security.identityGuard = { enabled: true, mode: 'block' }
  c.security.identityGuard.enabled = bool(c.security.identityGuard.enabled, true)
  c.security.identityGuard.mode = c.security.identityGuard.mode === 'warn' ? 'warn' : 'block'
  if (!isObj(c.security.panel)) c.security.panel = { allowedHosts: [] }
  c.security.panel.allowedHosts = strList(c.security.panel.allowedHosts, /[\s,，;；]+/)
    .map((s) => s.toLowerCase())
    .slice(0, 20)
}

// 全局群策略与单群覆盖共用的数值字段规格表：[key, defaultValue, min, max]
const GROUP_POLICY_NUM_SPECS = [
  ['interjectChance', 0.15, 0, 1],
  ['cooldownSec', 90, 0, 86400],
  ['maxPerHour', DEFAULT_GROUP_POLICY.maxPerHour, 0, 200],
  ['engagedMaxReplies', DEFAULT_GROUP_POLICY.engagedMaxReplies, 0, 20],
  ['engagedMaxMs', DEFAULT_GROUP_POLICY.engagedMaxMs, 0, 3600000],
  ['minRecentMessages', 3, 0, 100],
  ['activeWindowSec', 300, 30, 86400],
  ['minRelevance', 0.25, 0, 1],
  ['burstMax', 8, 1, 50],
  ['burstWindowSec', 120, 10, 3600],
]

function applyGroupPolicyFields(target, source, { partial }) {
  for (const [key, defVal, lo, hi] of GROUP_POLICY_NUM_SPECS) {
    if (!partial || source[key] !== undefined) target[key] = num(source[key], defVal, lo, hi)
  }
  for (const listKey of ['wakeWords', 'interests']) {
    if (!partial || source[listKey] !== undefined) target[listKey] = strList(source[listKey])
  }
  if (!partial || source.quietHours !== undefined) {
    const qh = Array.isArray(source.quietHours) && source.quietHours.length === 2
      ? source.quietHours
      : DEFAULT_GROUP_POLICY.quietHours
    target.quietHours = qh.map((h) => num(h, 0, 0, 23))
  }
}

/**
 * 单群覆盖的数值字段上下界：与全局群策略同口径，但 maxPerHour / engagedMaxReplies / burstMax
 * 放宽上限——单群可以自己调得更激进（面板已暴露连聊与爆发预算）。
 */
const GROUP_OVERRIDE_NUM_SPECS = GROUP_POLICY_NUM_SPECS.map(([key, defVal, lo, hi]) => {
  const wide = { maxPerHour: 10000, engagedMaxReplies: 10000, burstMax: 200 }[key]
  return [key, defVal, lo, wide ?? hi]
})

/** 覆盖项里「像数字」的值：空串 / 纯空白 / 布尔都不算填了——避免面板清空后被落成一条默认值。 */
const hasGroupOverrideNum = (v) => v !== '' && v !== null && v !== undefined
  && typeof v !== 'boolean' && !(typeof v === 'string' && !v.trim())

/**
 * 统一归一化按群覆盖 `group.overrides[gid]`：群号只留数字、数值字段以「全局群策略当前值」为兜底、
 * 字段上下界复用群策略（上表放宽三项）、空对象不落盘。
 */
export function normalizeGroupOverrides(rawOverrides, group = {}) {
  if (!isObj(rawOverrides)) return {}
  const g = isObj(group) ? group : {}
  const out = {}
  for (const [rawId, raw] of Object.entries(rawOverrides)) {
    const gid = qq(rawId)
    if (!gid || !isObj(raw)) continue
    const o = {}
    for (const [key, defVal, lo, hi] of GROUP_OVERRIDE_NUM_SPECS) {
      if (!hasGroupOverrideNum(raw[key])) continue
      const groupVal = g[key]
      const fallback = hasGroupOverrideNum(groupVal) && Number.isFinite(Number(groupVal)) ? groupVal : defVal
      o[key] = num(raw[key], fallback, lo, hi)
    }
    if (Array.isArray(raw.quietHours) && raw.quietHours.length === 2) {
      o.quietHours = raw.quietHours.map((h) => num(h, 0, 0, 23))
    }
    if (raw.wakeWords !== undefined) {
      const ww = strList(raw.wakeWords)
      if (ww.length || Array.isArray(raw.wakeWords)) o.wakeWords = ww
    }
    if (raw.interests !== undefined) {
      const ints = strList(raw.interests)
      if (ints.length || Array.isArray(raw.interests)) o.interests = ints
    }
    if (Object.keys(o).length) out[gid] = o
  }
  return out
}

function normalizeGroup(c) {
  if (!isObj(c.group)) c.group = {}
  const g = c.group
  applyGroupPolicyFields(g, g, { partial: false })
  if (!isObj(g.quota)) g.quota = {}
  g.quota.enabled = bool(g.quota.enabled, true)
  g.quota.perMinute = num(g.quota.perMinute, 10, 1, 200)
  g.quota.reserve = num(g.quota.reserve, 1, 0, 10)
  if (!isObj(g.fishGuard)) g.fishGuard = { enabled: true }
  g.fishGuard.enabled = bool(g.fishGuard.enabled, true)
  g.overrides = normalizeGroupOverrides(g.overrides, g)
  if (!isObj(g.ownerBrief)) g.ownerBrief = { enabled: false, lines: 12, groups: [] }
  g.ownerBrief.enabled = bool(g.ownerBrief.enabled, false)
  g.ownerBrief.lines = num(g.ownerBrief.lines, 12, 1, 30)
  g.ownerBrief.groups = qqList(g.ownerBrief.groups)
}

function normalizeMergeAndReply(c) {
  if (!isObj(c.merge)) c.merge = {}
  c.merge.enabled = bool(c.merge.enabled, true)
  c.merge.waitSec = num(c.merge.waitSec, 2.5, 0, 30)
  c.merge.maxSec = Math.max(c.merge.waitSec, num(c.merge.maxSec, 8, 0, 60))
  c.merge.groupWaitSec = num(c.merge.groupWaitSec, 5, 0, 60)
  c.merge.groupMaxSec = Math.max(c.merge.groupWaitSec, num(c.merge.groupMaxSec, 15, 0, 120))

  if (!isObj(c.reply)) c.reply = {}
  c.reply.groupMaxChars = num(c.reply.groupMaxChars, 40, 10, 500)
  c.reply.privateMaxChars = num(c.reply.privateMaxChars, 120, 20, 2000)
  c.reply.maxBubbles = Math.round(num(c.reply.maxBubbles, 6, 1, 12))
  c.reply.keepReports = bool(c.reply.keepReports, true)
}

function normalizeVoice(c) {
  if (!isObj(c.voice)) c.voice = {}
  const v = c.voice
  v.autoChance = num(v.autoChance, 0.15, 0, 1)
  v.autoMaxChars = num(v.autoMaxChars, 80, 1, 500)
  if (!['auto', 'edge', 'windows', 'cosyvoice', 'gptsovits', 'http', 'doubao', 'qwentts', 'mimo'].includes(v.engine)) v.engine = 'auto'

  if (!isObj(v.http)) v.http = { urlTemplate: '', method: 'GET', headers: '', body: '' }
  v.http.urlTemplate = String(v.http.urlTemplate ?? '').trim()
  v.http.method = String(v.http.method ?? '').trim().toUpperCase() === 'POST' ? 'POST' : 'GET'
  const headerText = (val) => {
    if (typeof val === 'string') return val
    if (Array.isArray(val)) return val.map(String).join('\n')
    if (val && typeof val === 'object') return Object.entries(val).map(([k, item]) => `${k}: ${item}`).join('\n')
    return val == null ? '' : String(val)
  }
  const bodyText = (val) => {
    if (typeof val === 'string') return val
    if (val && typeof val === 'object') { try { return JSON.stringify(val) } catch { return '' } }
    return val == null ? '' : String(val)
  }
  v.http.headers = headerText(v.http.headers)
  v.http.body = bodyText(v.http.body)

  if (!isObj(v.qwentts)) v.qwentts = { ...DEFAULTS.voice.qwentts }
  v.qwentts.audioOrigin = String(v.qwentts.audioOrigin ?? '').trim()
  if (!isObj(v.cosyvoice)) v.cosyvoice = { ...DEFAULTS.voice.cosyvoice }
  v.cosyvoice.sampleRate = num(v.cosyvoice.sampleRate, 22050, 8000, 48000)
  if (!['sft', 'instruct'].includes(v.cosyvoice.mode)) v.cosyvoice.mode = 'sft'

  // ⚠ 0 也必须带正号：面板选项与 edge-tts 均要求 '+0%' / '+0Hz'
  const signed = (n, unit) => (n < 0 ? '-' : '+') + Math.abs(n) + unit
  const pct = /^([+-]?\d{1,3})\s*%$/.exec(String(v.rate || '').trim())
  v.rate = signed(pct ? Math.max(-50, Math.min(50, Number(pct[1]))) : 0, '%')
  const hz = /^([+-]?\d{1,3})\s*Hz$/i.exec(String(v.pitch || '').trim())
  v.pitch = signed(hz ? Math.max(-80, Math.min(80, Number(hz[1]))) : 0, 'Hz')
}

function normalizeImageGen(c) {
  if (!isObj(c.imageGen)) c.imageGen = {}
  const ig = c.imageGen
  ig.enabled = bool(ig.enabled, false)
  ig.ownerOnly = bool(ig.ownerOnly, true)
  ig.seeOwn = bool(ig.seeOwn, true)
  if (!/^\d{3,4}x\d{3,4}$/.test(String(ig.size))) ig.size = '1024x1024'
  ig.galleryShown = Math.round(num(ig.galleryShown, 20, 1, 50))
  ig.shape = ['her', 'square', 'portrait', 'landscape', 'wide'].includes(ig.shape) ? ig.shape : 'her'
  ig.provider = ['custom', 'codex'].includes(ig.provider) ? ig.provider : 'openai'

  if (!isObj(ig.codex)) ig.codex = { ...DEFAULTS.imageGen.codex }
  ig.codex.model = ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'].includes(ig.codex.model) ? ig.codex.model : 'gpt-image-2'
  ig.codex.quality = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(ig.codex.quality) ? ig.codex.quality : 'auto'
  ig.codex.background = ['auto', 'transparent', 'opaque'].includes(ig.codex.background) ? ig.codex.background : 'auto'

  if (!ig.custom || typeof ig.custom !== 'object') ig.custom = { ...DEFAULTS.imageGen.custom }
  ig.custom.method = String(ig.custom.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
  ig.custom.bodyType = ig.custom.bodyType === 'form' ? 'form' : 'json'
  ig.custom.url = String(ig.custom.url || '').trim().slice(0, 2000)
  ig.custom.responsePath = String(ig.custom.responsePath || '').trim().slice(0, 200)
  ig.custom.params = (Array.isArray(ig.custom.params) ? ig.custom.params : [])
    .map((p) => ({ key: String((p && p.key) || '').trim().slice(0, 60), value: String(p && p.value != null ? p.value : '').slice(0, 500) }))
    .filter((p) => p.key)
    .slice(0, 30)
}

function normalizeStickers(c) {
  if (!isObj(c.stickers)) c.stickers = {}
  const s = c.stickers
  s.autoChance = num(s.autoChance, 0.35, 0, 1)
  s.faces = s.faces !== false
  s.collectMode = ['ask', 'auto', 'owner'].includes(s.collectMode) ? s.collectMode : 'auto'
  s.maxPerHour = num(s.maxPerHour, 20, 0, 200)
  s.maxLibrary = num(s.maxLibrary, 300, 20, 2000)
  s.maxSide = num(s.maxSide, 1920, 32, 10000)
  s.maxBytes = num(s.maxBytes, 5 * 1024 * 1024, 1024, 50 * 1024 * 1024)
  s.maxGifBytes = num(s.maxGifBytes, 10 * 1024 * 1024, 1024, 50 * 1024 * 1024)
  s.cooldownSec = num(s.cooldownSec, 0, 0, 3600)
  s.sendMaxPerHour = num(s.sendMaxPerHour, 0, 0, 500)
  s.webpToJpeg = bool(s.webpToJpeg, false)

  if (!isObj(s.overrides)) s.overrides = {}
  const stickerOverrides = {}
  for (const [rawId, raw] of Object.entries(s.overrides)) {
    const gid = qq(rawId)
    if (!gid || !isObj(raw)) continue
    const o = {}
    for (const k of ['enabled', 'collect', 'fromGroups', 'fromPrivate']) {
      if (typeof raw[k] === 'boolean') o[k] = raw[k]
    }
    if (['auto', 'ask', 'owner'].includes(raw.collectMode)) o.collectMode = raw.collectMode
    if (raw.autoChance !== undefined) o.autoChance = num(raw.autoChance, 0.35, 0, 1)
    if (raw.maxPerHour !== undefined) o.maxPerHour = num(raw.maxPerHour, 20, 0, 200)
    if (raw.cooldownSec !== undefined) o.cooldownSec = num(raw.cooldownSec, 0, 0, 3600)
    if (raw.sendMaxPerHour !== undefined) o.sendMaxPerHour = num(raw.sendMaxPerHour, 0, 0, 500)
    if (Object.keys(o).length) stickerOverrides[gid] = o
  }
  s.overrides = stickerOverrides
}

function normalizeSocialAndDiary(c) {
  if (!isObj(c.diary)) c.diary = {}
  c.diary.timesPerDay = num(c.diary.timesPerDay, 2, 0, 6)
  c.diary.windowStart = hhmm(c.diary.windowStart, '10:00')
  c.diary.windowEnd = hhmm(c.diary.windowEnd, '23:30')
  c.diary.minGapMinutes = num(c.diary.minGapMinutes, 180, 0, 1440)
  c.diary.attachImage = bool(c.diary.attachImage, true)
  c.diary.minChars = num(c.diary.minChars, 60, 10, 500)
  c.diary.maxChars = num(c.diary.maxChars, 140, 20, 1000)
  c.diary.visibility = DIARY_AUDIENCES.includes(c.diary.visibility) ? c.diary.visibility : 'self'
  c.diary.audienceQQs = qqList(c.diary.audienceQQs).slice(0, 200).join('\n')
  c.diary.includeChats = [...new Set(
    (Array.isArray(c.diary.includeChats) ? c.diary.includeChats : [])
      .map((x) => String(x || '').trim())
      .filter((x) => /^(private|group):\d+$/.test(x)),
  )].slice(0, 100)

  if (!isObj(c.speakUp)) c.speakUp = {}
  // 审计 T3.9：enabled / awakeFrom / awakeTo / greeting 过去完全没有归一化，
  // 面板传字符串或越界小时都能落盘（'false' 当真、25 点当醒着），主动搭话判定被带偏。
  c.speakUp.enabled = bool(c.speakUp.enabled, DEFAULTS.speakUp.enabled)
  c.speakUp.awakeFrom = Math.round(num(c.speakUp.awakeFrom, DEFAULTS.speakUp.awakeFrom, 0, 23))
  c.speakUp.awakeTo = Math.round(num(c.speakUp.awakeTo, DEFAULTS.speakUp.awakeTo, 0, 23))
  if (!isObj(c.speakUp.greeting)) c.speakUp.greeting = {}
  c.speakUp.greeting.enabled = bool(c.speakUp.greeting.enabled, DEFAULTS.speakUp.greeting.enabled)
  c.speakUp.greeting.morning = hhmm(c.speakUp.greeting.morning, DEFAULTS.speakUp.greeting.morning)
  c.speakUp.greeting.night = hhmm(c.speakUp.greeting.night, DEFAULTS.speakUp.greeting.night)
  c.speakUp.idleMinutes = num(c.speakUp.idleMinutes, DEFAULTS.speakUp.idleMinutes, 5, 1440)
  c.speakUp.nudge = bool(c.speakUp.nudge, DEFAULTS.speakUp.nudge)
  c.speakUp.minIntervalMinutes = num(c.speakUp.minIntervalMinutes, DEFAULTS.speakUp.minIntervalMinutes, 5, 1440)
  c.speakUp.maxIntervalMinutes = Math.max(c.speakUp.minIntervalMinutes, num(c.speakUp.maxIntervalMinutes, DEFAULTS.speakUp.maxIntervalMinutes, 5, 2880))
  c.speakUp.maxPerDay = num(c.speakUp.maxPerDay, DEFAULTS.speakUp.maxPerDay, 0, 20)

  if (!isObj(c.qzoneSocial)) c.qzoneSocial = {}
  const q = c.qzoneSocial
  q.enabled = bool(q.enabled, true)
  q.replyOwn = bool(q.replyOwn, true)
  q.commentFriends = bool(q.commentFriends, true)
  q.like = bool(q.like, true)
  q.friendChance = num(q.friendChance, 0.3, 0, 1)
  q.ownerChance = num(q.ownerChance, 0.7, 0, 1)
  q.maxPerDay = num(q.maxPerDay, 8, 0, 50)
  q.intervalMin = num(q.intervalMin, 30, 5, 1440)

  if (!isObj(c.local)) c.local = {}
  for (const k of ['tts', 'image', 'asr']) c.local[k] = bool(c.local[k], false)
}

function normalizeBili(c) {
  if (!isObj(c.bili)) c.bili = {}
  const b = c.bili
  Object.assign(b, splitBiliCookie(b))
  for (const k of ['enabled', 'autoBrowse', 'comment', 'reply', 'shareToOwner', 'like', 'vision']) {
    b[k] = bool(b[k], DEFAULTS.bili[k])
  }
  b.visionFrames = Math.round(num(b.visionFrames, 6, 2, 12))
  b.ffmpegPath = String(b.ffmpegPath || '').trim()
  b.shotChance = num(b.shotChance, 0.35, 0, 1)
  b.shotLibrary = Math.round(num(b.shotLibrary, 300, 20, 2000))
  b.intervalHours = num(b.intervalHours, 4, 1, 48)
  b.maxRunsPerDay = num(b.maxRunsPerDay, 3, 0, 24)
  b.perRun = num(b.perRun, 3, 1, 8)
  b.minViews = num(b.minViews, 5000, 0, 1e8)
  b.maxAgeDays = num(b.maxAgeDays, 60, 0, 3650)
  b.maxCommentsPerDay = num(b.maxCommentsPerDay, 3, 0, 50)
  b.maxRepliesPerDay = num(b.maxRepliesPerDay, 6, 0, 100)
  b.keywords = strList(b.keywords, /[\n,，]+/).slice(0, 30)

  if (!isObj(b.model)) b.model = {}
  b.model.provider = String(b.model.provider || '').trim()
  b.model.model = String(b.model.model || '').trim()
  b.model.reasoningEffort = ['low', 'high', 'max', ''].includes(b.model.reasoningEffort) ? b.model.reasoningEffort : ''
  if (!b.model.provider || !b.model.model) b.model.provider = b.model.model = ''
}

/**
 * 刷小黑盒归一化。
 * 审计 T3.9：整个 heybox 域过去没有 normalizer，面板传来的字符串开关、越界数值、
 * 空 Topic 都会原样落进配置 —— 定时任务按 msgPerRun='3' 之类的值算预算直接算错。
 */
function normalizeHeybox(c) {
  if (!isObj(c.heybox)) c.heybox = {}
  const h = c.heybox
  h.enabled = bool(h.enabled, DEFAULTS.heybox.enabled)
  h.autoBrowse = bool(h.autoBrowse, DEFAULTS.heybox.autoBrowse)
  h.cookie = String(h.cookie || '').trim()
  h.intervalHours = Math.round(num(h.intervalHours, DEFAULTS.heybox.intervalHours, 1, 48))
  h.maxRunsPerDay = Math.round(num(h.maxRunsPerDay, DEFAULTS.heybox.maxRunsPerDay, 0, 24))
  h.perRun = Math.round(num(h.perRun, DEFAULTS.heybox.perRun, 1, 10))
  h.likeDaily = Math.round(num(h.likeDaily, DEFAULTS.heybox.likeDaily, 0, 100))
  h.commentDaily = Math.round(num(h.commentDaily, DEFAULTS.heybox.commentDaily, 0, 30))
  h.maxPostsPerDay = Math.round(num(h.maxPostsPerDay, DEFAULTS.heybox.maxPostsPerDay, 0, 10))
  h.defaultTopic = Math.round(num(h.defaultTopic, DEFAULTS.heybox.defaultTopic, 1, 1e9))
  h.postStyle = ['diary', 'news', 'mix'].includes(h.postStyle) ? h.postStyle : DEFAULTS.heybox.postStyle
}

function normalizeDouyin(c) {
  if (!isObj(c.douyin)) c.douyin = {}
  const d = c.douyin
  d.enabled = bool(d.enabled, false)
  d.autoBrowse = bool(d.autoBrowse, true)
  d.intervalHours = num(d.intervalHours, 4, 1, 48)
  d.maxRunsPerDay = num(d.maxRunsPerDay, 3, 0, 24)
  d.perRun = num(d.perRun, 5, 1, 10)
  d.maxWatchPerDay = num(d.maxWatchPerDay, 30, 0, 200)
  d.dwellMin = num(d.dwellMin, 8, 3, 120)
  d.dwellMax = Math.max(d.dwellMin, num(d.dwellMax, 40, 3, 300))
  d.browserPath = String(d.browserPath || '').trim()
  d.shareTo = ['douyin', 'qq', 'both'].includes(d.shareTo) ? d.shareTo : 'douyin'
  d.ownerDm = bool(d.ownerDm, true)
  d.commentReply = bool(d.commentReply, false)
  d.commentReplyPollMinutes = Math.round(num(d.commentReplyPollMinutes, 5, 1, 60))
  d.shareDmText = bool(d.shareDmText, false)
  d.shareDmTextChance = num(d.shareDmTextChance, 0.6, 0, 1)
  d.dmPollMinutes = num(d.dmPollMinutes, 3, 1, 60)
  d.shareBias = ['stingy', 'normal', 'proactive'].includes(d.shareBias) ? d.shareBias : d.shareBias === 'off' ? 'stingy' : 'proactive'

  if (!isObj(d.caps)) d.caps = {}
  d.caps = {
    like: num(d.caps.like, 30, 0, 300),
    comment: num(d.caps.comment, 3, 0, 30),
    share: num(d.caps.share, 5, 0, 30),
    atOwner: num(d.caps.atOwner, 3, 0, 30),
  }
  if (!isObj(d.owner)) d.owner = {}
  d.owner = Object.fromEntries(['input', 'secUid', 'uid', 'nickname', 'confirmedInput'].map((k) => [k, String(d.owner[k] ?? '').trim().slice(0, 400)]))
  if (!isObj(d.gate)) d.gate = {}
  d.gate = {
    maxWritesPerDay: num(d.gate.maxWritesPerDay, 40, 1, 500),
    minWriteGapSec: num(d.gate.minWriteGapSec, 20, 0, 600),
    newAccountDays: num(d.gate.newAccountDays, 3, 0, 30),
  }
}

function normalizeMemoryAndChatlog(c) {
  if (!isObj(c.chatlog)) c.chatlog = {}
  c.chatlog.keepDays = Math.round(num(c.chatlog.keepDays, 30, 14, 365))

  if (!isObj(c.memory)) c.memory = {}
  c.memory.consolidateTimes = [...new Set(
    strList(c.memory.consolidateTimes)
      .map((t) => hhmm(t, ''))
      .filter(Boolean)
      .map((t) => t.padStart(5, '0')),
  )].sort().slice(0, 4)
  if (!c.memory.consolidateTimes.length) c.memory.consolidateTimes = ['04:00', '16:00']
  c.memory.recallCount = num(c.memory.recallCount, 6, 0, 20)
  c.memory.hintCount = Math.round(num(c.memory.hintCount, 8, 1, 20))
  c.memory.hintMaxChars = Math.round(num(c.memory.hintMaxChars, 600, 120, 2000))

  if (!isObj(c.memory.embeddings)) c.memory.embeddings = {}
  const embCfg = c.memory.embeddings
  embCfg.enabled = bool(embCfg.enabled, false)
  embCfg.url = String(embCfg.url ?? '').trim()
  embCfg.apiKey = String(embCfg.apiKey ?? '').trim()
  embCfg.model = String(embCfg.model ?? '').trim()
  embCfg.dim = Math.round(num(embCfg.dim, 1024, 64, 4096))
  embCfg.timeoutMs = Math.round(num(embCfg.timeoutMs, 8000, 1000, 60000))
  embCfg.batch = Math.round(num(embCfg.batch, 16, 1, 64))
  embCfg.maxChars = Math.round(num(embCfg.maxChars, 200, 60, 400))
}

function normalizeModulesAndExt(c) {
  if (!isObj(c.modules)) c.modules = {}
  for (const [id, m] of Object.entries(c.modules)) {
    if (id === 'market') continue
    if (!isObj(m)) { delete c.modules[id]; continue }
    m.enabled = bool(m.enabled, true)
    m.useBuiltin = bool(m.useBuiltin, false)
  }
  if (!isObj(c.modules.market)) c.modules.market = {}
  const market = c.modules.market
  market.enabled = bool(market.enabled, false)
  market.indexUrls = Array.isArray(market.indexUrls)
    ? market.indexUrls.map((s) => String(s).trim()).filter((s) => /^https:\/\//i.test(s)).slice(0, 10)
    : []
  try {
    const proxy = new URL(String(market.httpProxy || '').trim())
    market.httpProxy = ['http:', 'https:'].includes(proxy.protocol) && !proxy.username && !proxy.password && !proxy.search && !proxy.hash && proxy.pathname === '/'
      ? proxy.origin : ''
  } catch { market.httpProxy = '' }
  if (!isObj(market.installed)) market.installed = {}

  if (!isObj(c.ext)) c.ext = {}
  for (const k of Object.keys(c.ext)) if (!isObj(c.ext[k])) delete c.ext[k] // 传 null = 删掉这个模块的设置
}

function normalizeMultiParser(c) {
  if (!isObj(c.multiParser)) c.multiParser = {}
  const mp = c.multiParser
  mp.enabled = bool(mp.enabled, false)
  mp.inGroups = bool(mp.inGroups, true)
  mp.inPrivate = bool(mp.inPrivate, true)
  mp.disabledGroups = (Array.isArray(mp.disabledGroups) ? mp.disabledGroups : [])
    .map(qq)
    .filter((g) => g.length >= 4)
    .slice(0, 100)
  mp.feedToAi = bool(mp.feedToAi, true)
  mp.sendMedia = bool(mp.sendMedia, true)
  mp.forwardMode = ['threshold', 'always', 'never'].includes(mp.forwardMode) ? mp.forwardMode : 'threshold'
  mp.imageThreshold = num(mp.imageThreshold, 2, 1, 30)
  mp.maxVideoMB = num(mp.maxVideoMB, 100, 5, 500)
  mp.videoOverLimit = ['direct_link', 'group_file', 'notice'].includes(mp.videoOverLimit) ? mp.videoOverLimit : 'direct_link'
  if (!isObj(mp.platforms)) mp.platforms = {}
  for (const k of ['bilibili', 'douyin', 'redbook', 'weibo', 'zhihu', 'wechat', 'tieba', 'fanqie', 'github', 'xiaoheihe']) {
    mp.platforms[k] = bool(mp.platforms[k], true)
  }
  if (!isObj(mp.cookies)) mp.cookies = {}
  for (const k of ['bilibili', 'weibo', 'redbook', 'zhihu', 'tieba', 'douyin', 'xiaoheihe']) {
    mp.cookies[k] = String(mp.cookies[k] || '').trim()
  }
}

function normalizeBridge(c) {
  if (!isObj(c.bridge)) c.bridge = {}
  c.bridge.dshTools = bool(c.bridge.dshTools, false)
  c.bridge.http = bool(c.bridge.http, false)
  c.bridge.token = String(c.bridge.token || '')
  if (!['whitelist', 'owner'].includes(c.bridge.allowTargets)) c.bridge.allowTargets = 'whitelist'
}

// ---------------- 主编排与面板合并 ----------------

/** 把任意输入配置归一化为合法完整结构（含版本迁移与死键清理）。 */
export function normalize(raw) {
  const c = deepMerge(DEFAULTS, raw)
  migrateConfig(c, raw)
  normalizeCore(c)
  normalizeModelsAndSession(c)
  normalizeBrowser(c)
  normalizeAccess(c, raw)
  normalizeFilesAndSecurity(c)
  normalizeGroup(c)
  normalizeMergeAndReply(c)
  normalizeVoice(c)
  normalizeImageGen(c)
  normalizeStickers(c)
  normalizeSocialAndDiary(c)
  normalizeBili(c)
  normalizeDouyin(c)
  normalizeHeybox(c)
  normalizeMemoryAndChatlog(c)
  normalizeModulesAndExt(c)
  normalizeMultiParser(c)
  normalizeBridge(c)
  stripLegacyKeys(c)
  return c
}

/** 面板保存时：没改的密码字段（空串）保留原值，并保护只读字段与分群/分聊天表语义。 */
export function mergeFromPanel(current, incoming) {
  const next = deepMerge(current, incoming || {})
  if (Number.isInteger(current?.configVersion)) next.configVersion = current.configVersion
  for (const path of allSecrets()) {
    const v = getAt(incoming || {}, path)
    const p = parentOf(next, path, v !== undefined)
    if (!p) continue
    const k = path.at(-1)
    if (v === null) p[k] = '' // 明确传 null = 清空
    else if (v === undefined || v === '') p[k] = getAt(current, path) ?? ''
    delete p[`${k}Set`]
    delete p[`${k}Hint`]
  }
  // 主人的抖音 secUid / uid / 昵称只能由「核对」写入，面板存配置时保留原值
  if (!isObj(next.douyin)) next.douyin = {}
  next.douyin.owner = {
    ...next.douyin.owner,
    ...Object.fromEntries(['secUid', 'uid', 'nickname', 'confirmedInput'].map((k) => [k, current.douyin?.owner?.[k] ?? ''])),
  }
  // 联动密钥只由插件生成，面板不能改
  if (!isObj(next.bridge)) next.bridge = {}
  next.bridge.token = current.bridge?.token || ''
  // B 站：只改了其中一个值时，另一个保留；整串粘进来的会在 normalize 里拆开。
  // 审计 T3.9：显式传 null 表示「清空」，但 splitBiliCookie 看到空 sessdata/biliJct
  // 会从旧 cookie 里反解回来 → 面板清空凭证后旧 Cookie 复活。这里同时认 null，
  // 并在面板没带新 cookie 时先把旧 cookie 抹掉（带了新 cookie 就以新的为准）。
  if (incoming?.bili
    && (incoming.bili.sessdata || incoming.bili.biliJct
      || incoming.bili.sessdata === null || incoming.bili.biliJct === null)
    && !incoming.bili.cookie) {
    if (!isObj(next.bili)) next.bili = {}
    next.bili.cookie = ''
  }
  // 按群单独设置：防局部 PATCH 抹掉其它群，同时保留群原有的内部字段（如 minRelevance）
  if (incoming?.group?.overrides !== undefined) {
    if (isObj(incoming.group.overrides)) {
      // 审计 T3.9：过去把顶层 incoming.enabled 也当成「整表提交」的信号，
      // 而保存配置时 enabled 几乎总会带上 → 局部 PATCH 一个群就把其它群覆盖抹掉。
      const isFullGroupSubmit = incoming.group.interjectChance !== undefined || incoming.group.wakeWords !== undefined
      const baseOverrides = isFullGroupSubmit ? {} : { ...(current.group?.overrides || {}) }
      const merged = { ...baseOverrides }
      for (const [rawGid, over] of Object.entries(incoming.group.overrides)) {
        const gid = qq(rawGid)
        if (!gid) continue
        if (over === null) {
          delete merged[gid]
        } else if (isObj(over)) {
          merged[gid] = { ...(current.group?.overrides?.[gid] || {}), ...over }
        }
      }
      next.group.overrides = merged
    } else {
      next.group.overrides = {}
    }
  }
  // 按聊天选模型 / 按聊天选人设：两张表整张替换（deepMerge 会让删掉的条目又回来）
  if (incoming?.chatModels?.privates !== undefined) next.chatModels.privates = incoming.chatModels.privates
  if (incoming?.chatModels?.groups !== undefined) next.chatModels.groups = incoming.chatModels.groups
  if (incoming?.persona?.privates !== undefined) next.persona.privates = incoming.persona.privates
  if (incoming?.persona?.groups !== undefined) next.persona.groups = incoming.persona.groups
  if (incoming?.allow) next.allow = { ...current.allow, ...incoming.allow }
  return normalize(next)
}
