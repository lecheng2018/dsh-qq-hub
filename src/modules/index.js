// 内置模块清单（按启动顺序）。每个模块的说明见各自文件开头；写法和接口见 API.md。
//
// 已上商店的模块（不再内置，从插件面板「扩展 → 市场」按需安装）：
//   bili / douyin / heybox / multi-parser / qzone-social / delivery-inbox
// douyin / multi-parser / qzone-social 的实现库仍留在包内（src/douyin、
// src/modules/multi-parser/{parser,delivery}.js、src/features/qzone-social.js），供商店模块经 api.lib 引用。
// bili 1.2.0 / heybox 1.7.0 起实现整包搬进商店模块（dsh-qq-hub-mods），包内不再有 src/bili、src/heybox；
// 它们只用 api.lib 取通用能力（store、llm、img、net、reply、identity-guard 等）。
//
// 已移除的模块（1.4.6 曾内置，2026-11-17 按主人要求整体移除）：
//   flash-transfer / group-files / online-status / social-actions / ark-cards / ai-voice / workspace-files
// 这些能力依赖网关/QQ 版本扩展动作，在当前版本无法工作；源码已归档到
// dsh-qq-hub-mods 的 modules/_qq-enhance/（不发布），待日后重新开发。

import stickers from './stickers/index.js'
import voice from './voice/index.js'
import memory from './memory/index.js'
import { reflectionModule } from './reflection/index.js'
import { styleModule } from './style/index.js'
import qqTools from './qq-tools/index.js'
import groupAdmin from './group-admin/index.js'
import imagegen from './imagegen/index.js'
import diary from './diary/index.js'
import speakup from './speakup/index.js'
import purpose from './purpose/index.js'
import profile from './profile/index.js'
import contacts from './contacts/index.js'
import tokenGuardian from './token-guardian/index.js'
import tokenBilling from './token-billing/index.js'
import affectiveGraph from './affective-graph/index.js'
import completeGuard from './complete-guard/index.js'
import memoryPrivacy from './memory-privacy/index.js'

export const BUILTINS = [stickers, voice, memory, reflectionModule, styleModule, qqTools, groupAdmin, imagegen, diary, speakup, purpose, profile, contacts,
  // 移植自 h-D-ACE/dsh-qq 的增强套件（security-lock 已按主人要求移除）
  tokenGuardian, tokenBilling, affectiveGraph, completeGuard, memoryPrivacy]
