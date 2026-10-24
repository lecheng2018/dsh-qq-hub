// 插件配置：默认值 + 归一化 + 读写。配置文件 ~/.dsh/plugins-data/aurabot/config.json

import { dataDir, readJson, writeJson } from './store.js'
import { DEFAULT_GROUP_POLICY } from '../chat/group-policy.js'
import { LEVELS } from '../chat/access.js'

export const DEFAULTS = {
  enabled: false, // 总开关：关着一句都不发
  dryRun: true, // 试运行：只记日志不真发
  setupDone: false, // 首次使用向导走完了没有
  botQQ: '', // 机器人 QQ 号（向导里填）
  ownerQQ: '', // 主人 QQ 号（向导里填）
  ownerName: '主人',
  ownerLevel: 'full', // full | social | chat
  allow: { private: [], groups: [] }, // 主人永远能私聊，不用写进白名单
  snowluma: {
    dir: 'C:\\Aurabot\\snowluma', // 主人自己下载解压到这里（EULA 不允许自动部署）
    autoStart: true, // 随 DSH 启动它（只启动主人已安装并同意过协议的副本）
    webuiPort: 5099,
    webuiPassword: '', // 插件自动生成并保存（第一次启动 SnowLuma 时）；用来调 /api/processes 只给机器人号注入
    passwordAuto: false,
    autoAttach: true, // 自动给机器人号所在的 QQ 进程注入（绝不碰别的号）
    httpUrl: '', // 留空 = 从 SnowLuma 配置里自动读
    wsUrl: '',
    httpToken: '',
    wsToken: '',
  },
  model: { provider: '', model: '', reasoningEffort: 'low' }, // 留空 = 跟随 DSH 默认
  merge: { enabled: true, waitSec: 2.5, maxSec: 8, groupWaitSec: 5, groupMaxSec: 15 }, // 连发合并：对方停顿 waitSec 秒再一起回，最多等 maxSec 秒；群里等得久一点，把一段话攒齐
  imageGen: {
    enabled: false,
    provider: 'openai', // openai = 兼容 OpenAI /v1/images/generations 的服务（硅基流动、通义、本地 ComfyUI 代理……）
    baseUrl: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    stylePrompt: '', // 每次生图自动加在前面的风格描述
    ownerOnly: true, // 只有主人能让她画
  },
  persona: { current: 'dafeiyu' },
  group: { ...DEFAULT_GROUP_POLICY, overrides: {} },
  voice: {
    enabled: true,
    // auto = 先 edge-tts，不行用 Windows 语音；edge / windows / cosyvoice / gptsovits / http = 指定引擎（失败都会退回 Windows 语音）
    engine: 'auto',
    cosyvoice: { url: 'http://127.0.0.1:50000', mode: 'sft', spkId: '中文女', instruct: '', sampleRate: 22050 },
    gptsovits: { url: 'http://127.0.0.1:9880', refAudio: '', promptText: '', promptLang: 'zh', textLang: 'zh' },
    http: { urlTemplate: '' }, // 通用：GET 这个地址（{text} 会替换成要念的话），返回音频
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+0%',
    pitch: '+0Hz',
    autoChance: 0.15, // 短回复自动变语音的概率
    autoMaxChars: 80,
    asr: true, // 听语音
  },
  stickers: {
    enabled: true,
    autoChance: 0.35, // 文字回复自动配一张表情的概率
    collect: true, // 偷表情
    fromGroups: true,
    fromPrivate: true,
    maxPerHour: 20,
    caption: true, // 用视觉模型起备注
  },
  diary: {
    enabled: true,
    timesPerDay: 2,
    windowStart: '10:00',
    windowEnd: '23:30',
    minGapMinutes: 180,
    minChars: 60,
    maxChars: 140,
    visibility: 'all', // all | self（仅自己可见）
  },
  speakUp: {
    enabled: true, // 只在和主人的私聊里主动找你，群里不会
    idleMinutes: 40,
    minIntervalMinutes: 60,
    maxIntervalMinutes: 180,
    maxPerDay: 4,
    nudge: true, // 她问了你一句、你一直没回时，偶尔轻轻追一句
    awakeFrom: 8,
    awakeTo: 23,
  },
  mood: { enabled: true, halfLifeHours: 3, maxInjectPerDay: 6 },
  memory: { enabled: true, recallCount: 6, dailyConsolidate: true, consolidateTimes: ['04:00', '16:00'] }, // 每天这几个时间把临时记忆（聊天流水）整理进长期记忆、相处经验和说话方式；过了一天的流水整理完清空
  song: { enabled: false },
  tabs: {}, // 面板记住的小偏好
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function deepMerge(base, over) {
  if (!isObj(over)) return structuredClone(base)
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v)
    else if (v !== undefined) out[k] = v
  }
  return out
}

const num = (v, d, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const qq = (v) => String(v ?? '').replace(/\D/g, '')
const qqList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,，;；]+/)).map(qq).filter(Boolean))]
const hhmm = (v, d) => (/^\d{1,2}:\d{2}$/.test(String(v)) ? String(v) : d)

export function normalize(raw) {
  const c = deepMerge(DEFAULTS, raw)
  c.enabled = bool(c.enabled, false)
  c.dryRun = bool(c.dryRun, true)
  c.botQQ = qq(c.botQQ)
  c.ownerQQ = qq(c.ownerQQ)
  c.setupDone = bool(c.setupDone, false)
  c.ownerLevel = LEVELS.includes(c.ownerLevel) ? c.ownerLevel : 'full'
  c.allow = { private: qqList(c.allow.private), groups: qqList(c.allow.groups) }
  const g = c.group
  g.wakeWords = (Array.isArray(g.wakeWords) ? g.wakeWords : String(g.wakeWords || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean)
  g.interjectChance = num(g.interjectChance, 0.15, 0, 1)
  g.cooldownSec = num(g.cooldownSec, 90, 0, 86400)
  g.maxPerHour = num(g.maxPerHour, 6, 0, 120)
  g.minRecentMessages = num(g.minRecentMessages, 3, 0, 100)
  g.activeWindowSec = num(g.activeWindowSec, 300, 30, 86400)
  if (!Array.isArray(g.quietHours) || g.quietHours.length !== 2) g.quietHours = DEFAULT_GROUP_POLICY.quietHours
  g.quietHours = g.quietHours.map((h) => num(h, 0, 0, 23))
  if (!isObj(g.overrides)) g.overrides = {}
  c.voice.autoChance = num(c.voice.autoChance, 0.15, 0, 1)
  c.voice.autoMaxChars = num(c.voice.autoMaxChars, 80, 1, 500)
  c.stickers.autoChance = num(c.stickers.autoChance, 0.35, 0, 1)
  c.stickers.maxPerHour = num(c.stickers.maxPerHour, 20, 0, 200)
  c.diary.timesPerDay = num(c.diary.timesPerDay, 2, 0, 6)
  c.diary.windowStart = hhmm(c.diary.windowStart, '10:00')
  c.diary.windowEnd = hhmm(c.diary.windowEnd, '23:30')
  c.diary.minGapMinutes = num(c.diary.minGapMinutes, 180, 0, 1440)
  c.diary.minChars = num(c.diary.minChars, 60, 10, 500)
  c.diary.maxChars = num(c.diary.maxChars, 140, 20, 1000)
  c.diary.visibility = c.diary.visibility === 'self' ? 'self' : 'all'
  c.speakUp.idleMinutes = num(c.speakUp.idleMinutes, 40, 5, 1440)
  c.speakUp.nudge = bool(c.speakUp.nudge, true)
  c.speakUp.minIntervalMinutes = num(c.speakUp.minIntervalMinutes, 90, 5, 1440)
  c.speakUp.maxIntervalMinutes = Math.max(c.speakUp.minIntervalMinutes, num(c.speakUp.maxIntervalMinutes, 240, 5, 2880))
  c.speakUp.maxPerDay = num(c.speakUp.maxPerDay, 3, 0, 20)
  c.mood.halfLifeHours = num(c.mood.halfLifeHours, 3, 0.25, 72)
  c.mood.maxInjectPerDay = num(c.mood.maxInjectPerDay, 6, 0, 50)
  c.snowluma.webuiPort = num(c.snowluma.webuiPort, 5099, 1, 65535)
  // 老配置只有一个 consolidateAt：换成两个时间点（它 + 12 小时后）
  if (!Array.isArray(raw?.memory?.consolidateTimes) && raw?.memory?.consolidateAt) {
    const [hh, mm] = hhmm(raw.memory.consolidateAt, '04:00').split(':').map(Number)
    c.memory.consolidateTimes = [`${hh}:${String(mm).padStart(2, '0')}`, `${(hh + 12) % 24}:${String(mm).padStart(2, '0')}`]
  }
  delete c.memory.consolidateAt
  c.memory.consolidateTimes = [...new Set((Array.isArray(c.memory.consolidateTimes) ? c.memory.consolidateTimes : String(c.memory.consolidateTimes || '').split(/[\s,，]+/)).map((t) => hhmm(t, '')).filter(Boolean).map((t) => t.padStart(5, '0')))].sort().slice(0, 4)
  if (!c.memory.consolidateTimes.length) c.memory.consolidateTimes = ['04:00', '16:00']
  c.memory.recallCount = num(c.memory.recallCount, 6, 0, 20)
  g.interests = (Array.isArray(g.interests) ? g.interests : String(g.interests || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean)
  g.minRelevance = num(g.minRelevance, 0.25, 0, 1)
  c.merge.enabled = bool(c.merge.enabled, true)
  c.merge.waitSec = num(c.merge.waitSec, 2.5, 0, 30)
  c.merge.maxSec = Math.max(c.merge.waitSec, num(c.merge.maxSec, 8, 0, 60))
  c.merge.groupWaitSec = num(c.merge.groupWaitSec, 5, 0, 60)
  c.merge.groupMaxSec = Math.max(c.merge.groupWaitSec, num(c.merge.groupMaxSec, 15, 0, 120))
  g.burstMax = num(g.burstMax, 8, 1, 50)
  g.burstWindowSec = num(g.burstWindowSec, 120, 10, 3600)
  if (!['auto', 'edge', 'windows', 'cosyvoice', 'gptsovits', 'http'].includes(c.voice.engine)) c.voice.engine = 'auto'
  c.voice.cosyvoice.sampleRate = num(c.voice.cosyvoice.sampleRate, 22050, 8000, 48000)
  if (!['sft', 'instruct'].includes(c.voice.cosyvoice.mode)) c.voice.cosyvoice.mode = 'sft'
  c.imageGen.enabled = bool(c.imageGen.enabled, false)
  c.imageGen.ownerOnly = bool(c.imageGen.ownerOnly, true)
  if (!/^\d{3,4}x\d{3,4}$/.test(String(c.imageGen.size))) c.imageGen.size = '1024x1024'
  return c
}

// 面板里不回传原文的字段：[分组, 字段]
const SECRETS = [['snowluma', 'webuiPassword'], ['snowluma', 'httpToken'], ['snowluma', 'wsToken'], ['imageGen', 'apiKey']]

const FILE = () => dataDir('config.json')

export function loadConfig() {
  const raw = readJson(FILE(), {})
  // 老配置（向导上线前就填好了两个号）直接算向导已完成
  if (raw && raw.setupDone === undefined && raw.botQQ && raw.ownerQQ) raw.setupDone = true
  return normalize(raw)
}

export function saveConfig(cfg) {
  const c = normalize(cfg)
  writeJson(FILE(), c)
  return c
}

/** 给面板看的版本：密码 / token 不回传原文，只告诉有没有填。 */
export function publicConfig(cfg) {
  const c = structuredClone(cfg)
  for (const [g, k] of SECRETS) {
    c[g][`${k}Set`] = Boolean(c[g][k])
    c[g][k] = ''
  }
  return c
}

/** 面板保存时：没改的密码字段（空串）保留原值。 */
export function mergeFromPanel(current, incoming) {
  const next = deepMerge(current, incoming || {})
  for (const [g, k] of SECRETS) {
    const v = incoming?.[g]?.[k]
    if (v === null) next[g][k] = '' // 明确传 null = 清空
    else if (v === undefined || v === '') next[g][k] = current[g][k]
    delete next[g][`${k}Set`]
  }
  if (incoming?.group?.overrides) next.group.overrides = incoming.group.overrides
  if (incoming?.allow) next.allow = { ...current.allow, ...incoming.allow }
  return normalize(next)
}
