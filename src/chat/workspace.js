// 工作区纯工具（1.3.65 重构 K-02）。
// 从 chat/hub.js 迁出，解除各模块因读取工作区目录对旧 hub.js 的大包 import。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// QQ 会话的工作区目录，第一次收到消息时自动创建。面板「连接」页能改（config.workspaceDir，#32）；
// 没填就用环境变量 AURABOT_WORKSPACE，再没有：老安装沿用 C:\Aurabot\qq-chats，新安装放在用户目录下（不用往 C 盘根目录写）
const LEGACY_WORKSPACE = 'C:\\Aurabot\\qq-chats'
export const WORKSPACE_DIR = process.env.QQ_HUB_WORKSPACE || process.env.AURABOT_WORKSPACE || (existsSync(LEGACY_WORKSPACE) ? LEGACY_WORKSPACE : join(homedir(), 'Aurabot', 'qq-chats'))

/** 现在用的工作区目录：面板里填了就用填的，否则默认。 */
export const workspaceDirOf = (cfg) => String(cfg?.workspaceDir || '').trim() || WORKSPACE_DIR
export const WORKSPACE_TITLE = 'QQ Hub'
