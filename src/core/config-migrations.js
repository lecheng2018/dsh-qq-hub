// 版本化配置迁移：一次性结构/口径迁移与历史死键清理。

import { CONFIG_VERSION, GROUP_BUDGET_VERSION, OPT_IN_ON_UPDATE, isObj } from './config-defaults.js'
import { profilePermDefault } from '../chat/access.js'

/**
 * 一次性迁移：`group.maxPerHour` 的口径从「每小时插话次数」改成「每小时说话总条数」。
 *
 * 老口径下这个数只数 interjectTimes，而每次插话成功还会白送 engagedMaxReplies 条「连聊」，
 * 所以真实上限是 `maxPerHour × (1 + engagedMaxReplies)`（实测 6 → 22.5 条/小时）。
 * 新口径直接数总条数，按同一个系数折算一次，升级后观感不变 —— 用户自己调过的大值同样折算，
 * 想再调低就去面板改（面板现在能看到连聊预算了）。
 *
 * 只折算一次：迁移完写 `budgetVersion`，以后不再碰用户的值。
 */
export function migrateGroupBudget(raw) {
  if (!isObj(raw?.group)) return raw
  const g = raw.group
  if (g.budgetVersion === GROUP_BUDGET_VERSION) return raw
  const perHour = Number(g.maxPerHour)
  if (Number.isFinite(perHour) && perHour > 0) {
    const rawEngaged = Number(g.engagedMaxReplies)
    const engaged = Number.isFinite(rawEngaged) && rawEngaged > 0 ? rawEngaged : 0
    g.maxPerHour = Math.min(200, Math.round(perHour * (1 + engaged)))
  }
  g.budgetVersion = GROUP_BUDGET_VERSION
  return raw
}

/**
 * 加载磁盘配置前的历史迁移：
 * - 向导上线前就填好两个号的老配置直接标记 setupDone
 * - 已完成向导的老用户遇到 OPT_IN_ON_UPDATE 新增功能时默认关闭
 * - 群发言预算口径迁移（budgetVersion）
 */
export function migrateRawOnLoad(raw) {
  if (!isObj(raw)) return raw
  if (raw.setupDone === undefined && raw.botQQ && raw.ownerQQ) raw.setupDone = true
  if (raw.setupDone) {
    for (const k of OPT_IN_ON_UPDATE) {
      if (raw[k] === undefined) raw[k] = { enabled: false }
    }
  }
  migrateGroupBudget(raw)
  return raw
}

/** v0 -> v1：早期无版本号配置的一次性语义迁移。 */
function migrateToV1(c, raw) {
  // 会话轮换：老默认是 300 轮 / 168h（等于永不轮换，人设改动只能等手动重置）。
  // 只有「原样没动过老默认」且没迁移标记时才替换，主人自己调过的值一律不动。
  // 注意要看原始输入：DEFAULTS 里已经带了 migrated:true，deepMerge 之后永远是 true。
  const rawRot = isObj(raw?.sessionRotation) ? raw.sessionRotation : null
  if (rawRot && rawRot.migrated !== true) {
    const hasTurns = rawRot.maxTurns !== '' && rawRot.maxTurns !== null && rawRot.maxTurns !== undefined
    const hasAge = rawRot.maxAgeHours !== '' && rawRot.maxAgeHours !== null && rawRot.maxAgeHours !== undefined
    if (hasTurns && hasAge && Math.round(Number(rawRot.maxTurns)) === 300 && Number(rawRot.maxAgeHours) === 168) {
      if (isObj(c.sessionRotation)) {
        c.sessionRotation.maxTurns = 60
        c.sessionRotation.maxAgeHours = 24
      }
    }
  }

  // 旧版 douyinDm 是「回别人私信」的权限，含义已不同（现在是主动发私信），老配置一律回到默认「仅主人」。
  if (isObj(raw?.profilePerms) && 'douyinDm' in raw.profilePerms && isObj(c.profilePerms)) {
    c.profilePerms.douyinDm = profilePermDefault('douyinDm')
  }

  // 1.0.x 的 douyin.caps.shareOwner 迁移到 share
  if (raw?.douyin?.caps?.share == null && raw?.douyin?.caps?.shareOwner != null && isObj(c.douyin)) {
    if (!isObj(c.douyin.caps)) c.douyin.caps = {}
    c.douyin.caps.share = raw.douyin.caps.shareOwner
  }

  // 老配置只有一个 memory.consolidateAt：换成两个时间点（它 + 12 小时后）
  if (!Array.isArray(raw?.memory?.consolidateTimes) && raw?.memory?.consolidateAt && isObj(c.memory)) {
    const rawAt = String(raw.memory.consolidateAt)
    const val = /^\d{1,2}:\d{2}$/.test(rawAt) ? rawAt : '04:00'
    const [hh, mm] = val.split(':').map(Number)
    c.memory.consolidateTimes = [`${hh}:${String(mm).padStart(2, '0')}`, `${(hh + 12) % 24}:${String(mm).padStart(2, '0')}`]
  }
}

const MIGRATIONS = [
  { toVersion: 1, run: migrateToV1 },
]

/**
 * 按 configVersion 顺序执行版本化配置迁移。
 * 仅当原始输入缺少 configVersion 或版本号低于目标步骤时才执行，避免无版本标记导致升级后反复覆写用户新改的值。
 */
export function migrateConfig(c, raw) {
  const fromVersion = Number.isInteger(raw?.configVersion) && raw.configVersion >= 0 ? raw.configVersion : 0
  for (const step of MIGRATIONS) {
    if (fromVersion < step.toVersion) step.run(c, raw)
  }
  c.configVersion = CONFIG_VERSION
  return c
}

/** 清理已下线功能/旧版本残留死键（幂等执行，避免旧凭据绕过脱敏回显）。 */
export function stripLegacyKeys(c) {
  // 1.3.63：按头衔过滤整条下线
  delete c.titleFilter
  // 1.3.43：删掉了「多问一次模型挑断点」
  if (isObj(c.reply)) delete c.reply.llmSplit
  // 老单时间点整理键
  if (isObj(c.memory)) delete c.memory.consolidateAt
  // 1.0.x 的 douyin-im / 私信相关设置都不用了
  if (isObj(c.douyin)) {
    for (const k of ['atOwnerOnLikeChance', 'minimize', 'socialInterruptBrowse', 'replyPollMinutes']) delete c.douyin[k]
  }
  // 1.4.0-beta.4 起部分功能整体移除，残留的 song / neteaseCookie 等必须显式丢掉，防止明文回传面板
  delete c.song
  if (isObj(c.local)) delete c.local.song
  delete c.mood
  if (isObj(c.modules)) {
    delete c.modules.song
    delete c.modules.mood
  }
  if (isObj(c.voice)) {
    delete c.voice.songVoice
    delete c.voice.songPitch
  }
  return c
}
