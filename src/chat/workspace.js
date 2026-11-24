// 工作区纯工具（1.3.65 重构 K-02）。
// 从 chat/hub.js 迁出，解除各模块因读取工作区目录对旧 hub.js 的大包 import。

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// QQ 会话的工作区目录，第一次收到消息时自动创建。面板「连接」页能改（config.workspaceDir，#32）；
// 没填就用环境变量 QQ_HUB_WORKSPACE（老名字 AURABOT_WORKSPACE 仍然认）。
// 默认位置：1.4.8 起从用户目录下 Aurabot/qq-chats 换成 QQ Hub/qq-chats（目录名跟项目名对齐）；
// 老的还没搬家的安装继续用老目录，不主动改，免得升级后历史会话和收到/发出的文件看着像全没了。
export const WORKSPACE_DIR_NAME = 'QQ Hub'
export const DEFAULT_WORKSPACE = join(homedir(), WORKSPACE_DIR_NAME, 'qq-chats')
/** 历代默认目录，从新到旧。只用来兼容读取，不会被自动写入。 */
export const LEGACY_WORKSPACES = [join(homedir(), 'Aurabot', 'qq-chats'), 'C:\\Aurabot\\qq-chats']

/**
 * 没在面板填、也没给环境变量时，按「新默认已存在 → 老默认还在 → 新默认」挑一个。
 * 现在的目录优先，避免已经手动搬过的人又被拉回老位置；老目录次之，保证升级不断档。
 */
export function pickWorkspaceDir({ env = process.env, exists = existsSync, defaultDir = DEFAULT_WORKSPACE, legacy = LEGACY_WORKSPACES } = {}) {
  const fromEnv = String(env.QQ_HUB_WORKSPACE || env.AURABOT_WORKSPACE || '').trim()
  if (fromEnv) return fromEnv
  if (exists(defaultDir)) return defaultDir
  return legacy.find((dir) => exists(dir)) || defaultDir
}

/** 现在生效的默认目录（面板/环境变量都没填时用它）。迁移成功后会被换成新位置。 */
export let WORKSPACE_DIR = pickWorkspaceDir()

/** 面板里填了就用填的，否则用当前生效的默认目录。 */
export const workspaceDirOf = (cfg) => String(cfg?.workspaceDir || '').trim() || WORKSPACE_DIR
export const WORKSPACE_TITLE = 'QQ Hub'

export function workspaceDirForChat(cfg, chatId) {
  const root = workspaceDirOf(cfg)
  if (!chatId || String(chatId).startsWith('system:') || cfg?.workspacePerChat !== true) return root
  const safe = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(root, `chat-${safe}`)
}

/** 换掉当前生效的默认目录（迁移成功后调用，让本次运行立刻用上新位置）。 */
export function activateWorkspaceDir(dir) {
  const next = String(dir || '').trim()
  if (next) WORKSPACE_DIR = next
  return WORKSPACE_DIR
}

/**
 * 判断要不要把老工作区搬到新默认位置。纯函数，不碰磁盘（exists 可注入）。
 * 面板填了路径、或给了环境变量的人，说明位置是自己定的，一律不动。
 */
export function planWorkspaceMigration(cfg, { env = process.env, exists = existsSync, defaultDir = DEFAULT_WORKSPACE, legacy = LEGACY_WORKSPACES } = {}) {
  if (String(cfg?.workspaceDir || '').trim()) return { move: false, reason: 'configured' }
  if (String(env.QQ_HUB_WORKSPACE || env.AURABOT_WORKSPACE || '').trim()) return { move: false, reason: 'env' }
  const from = legacy.find((dir) => exists(dir))
  if (!from) return { move: false, reason: 'no-legacy' }
  if (exists(defaultDir)) return { move: false, reason: 'target-exists' }
  return { move: true, from, to: defaultDir, reason: 'legacy' }
}

/**
 * 启动时调一次：老默认目录还在、新默认目录还没建，就把整个目录改名过去（聊天记录、收到发的文件、
 * 每会话子目录都在里面，一次 rename 全带走）。改名失败（跨盘 EXDEV、文件被占用）就退回老位置继续跑，
 * 不复制、不删任何东西——宁可位置旧一点，也不能把主人的东西搬丢。
 *
 * isRegistered 是宿主的「这个目录在 DSH 里登记成工作区了吗」检查：登记过就不能改名，
 * 那条工作区记录和它下面的会话还指着老路径，而宿主只开放了改标题/删登记，没有改路径的接口，
 * 改名等于把旧会话的落脚点弄没。调用方应传真实的检查（host.js 传的是 workspaceRegistry.list()）。
 * @returns {{moved: boolean, from?: string, to?: string, reason: string, error?: string}}
 */
export function migrateLegacyWorkspace(cfg, { env = process.env, exists = existsSync, rename = renameSync, mkdir = mkdirSync, log, isRegistered = () => false } = {}) {
  const plan = planWorkspaceMigration(cfg, { env, exists })
  if (!plan.move) return { moved: false, reason: plan.reason }
  if (isRegistered(plan.from)) {
    log?.info?.(`工作区还在老位置 ${plan.from}：DSH 里已经登记过这个目录，改名会让旧会话找不到落脚点，这次不搬`)
    return { moved: false, from: plan.from, to: plan.to, reason: 'registered' }
  }
  try {
    mkdir(dirname(plan.to), { recursive: true })
    rename(plan.from, plan.to)
  } catch (error) {
    const message = error?.message || String(error)
    log?.warn?.(`工作区还在老位置 ${plan.from}，搬到 ${plan.to} 失败（${message}），继续用老的`)
    return { moved: false, from: plan.from, to: plan.to, reason: 'rename-failed', error: message }
  }
  activateWorkspaceDir(plan.to)
  log?.info?.(`工作区已从 ${plan.from} 搬到 ${plan.to}`)
  return { moved: true, from: plan.from, to: plan.to, reason: 'migrated' }
}
