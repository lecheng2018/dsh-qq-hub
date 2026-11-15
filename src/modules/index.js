// 内置模块清单（按启动顺序）。每个模块的说明见各自文件开头；写法和接口见 API.md。

import stickers from './stickers/index.js'
import voice from './voice/index.js'
import memory from './memory/index.js'
import { reflectionModule } from './reflection/index.js'
import { styleModule } from './style/index.js'
import qqTools from './qq-tools/index.js'
import groupAdmin from './group-admin/index.js'
import imagegen from './imagegen/index.js'
import diary from './diary/index.js'
import qzoneSocial from './qzone-social/index.js'
import speakup from './speakup/index.js'
import purpose from './purpose/index.js'
import bili from './bili/index.js'
import profile from './profile/index.js'
import contacts from './contacts/index.js'
import douyin from './douyin/index.js'
import heybox from './heybox/index.js'
import tokenGuardian from './token-guardian/index.js'
import tokenBilling from './token-billing/index.js'
import affectiveGraph from './affective-graph/index.js'
import completeGuard from './complete-guard/index.js'
import memoryPrivacy from './memory-privacy/index.js'
import multiParser from './multi-parser/index.js'
import deliveryInbox from './delivery-inbox/index.js'
import flashTransfer from './flash-transfer/index.js'
import groupFiles from './group-files/index.js'
import onlineStatus from './online-status/index.js'
import socialActions from './social-actions/index.js'
import arkCards from './ark-cards/index.js'
import aiVoice from './ai-voice/index.js'

export const BUILTINS = [stickers, voice, memory, reflectionModule, styleModule, qqTools, groupAdmin, imagegen, diary, qzoneSocial, speakup, purpose, bili, profile, contacts, douyin, heybox,
  // 移植自 h-D-ACE/dsh-qq 的增强套件（security-lock 已按主人要求移除）
  tokenGuardian, tokenBilling, affectiveGraph, completeGuard, memoryPrivacy,
  // 移植自 astrbot_plugin_multi_parser 的多平台内容解析器
  multiParser,
  // 投递异常收件箱：只读查看没送出去/不确定送达的消息（不提供重发）
  deliveryInbox,
  // 闪传（SnowLuma 专属）：入站清单进上下文；主人可下载到工作区、转发白名单会话
  flashTransfer,
  // 群文件盘：browse/download 只读工具；主人可开 manage（建夹/移动/转存/删除）
  groupFiles,
  // 在线与已读：已读上报（账号级防抖合并）+ 自定义在线状态
  onlineStatus,
  // 社交动作：温度联动的表情回应（可关）+ 精华/QZone 写扩展（仅主人）
  socialActions,
  // Ark 卡片：原生图文卡片 + 三级降级（分享卡 → 文字摘要）
  arkCards,
  // AI 语音：QQ 官方变声（/变声 命令触发，群聊专用），零成本 TTS 备选
  aiVoice]
