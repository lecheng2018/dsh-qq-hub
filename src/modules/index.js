// 内置模块清单（按启动顺序）。每个模块的说明见各自文件开头；写法和接口见 API.md。

import stickers from './stickers/index.js'
import voice from './voice/index.js'
import mood from './mood/index.js'
import memory from './memory/index.js'
import qqTools from './qq-tools/index.js'
import groupAdmin from './group-admin/index.js'
import imagegen from './imagegen/index.js'
import diary from './diary/index.js'
import qzoneSocial from './qzone-social/index.js'
import speakup from './speakup/index.js'
import purpose from './purpose/index.js'
import pet from './pet/index.js'
import bili from './bili/index.js'
import song from './song/index.js'
import profile from './profile/index.js'
import contacts from './contacts/index.js'
import douyin from './douyin/index.js'
import heybox from './heybox/index.js'
import tokenGuardian from './token-guardian/index.js'
import completeGuard from './complete-guard/index.js'
import memoryPrivacy from './memory-privacy/index.js'
import scheduler from './scheduler/index.js'
import multiParser from './multi-parser/index.js'
import rss from './rss/index.js'

export const BUILTINS = [stickers, voice, mood, memory, qqTools, groupAdmin, imagegen, diary, qzoneSocial, speakup, purpose, pet, bili, song, profile, contacts, douyin, heybox,
  // 移植自 h-D-ACE/dsh-qq 的增强套件（security-lock 已按主人要求移除）
  tokenGuardian, completeGuard, memoryPrivacy, scheduler,
  // 移植自 astrbot_plugin_multi_parser 的多平台内容解析器
  multiParser,
  // 资讯池：RSS/Atom 订阅拉进池子，她自己按需查（不主动推送）
  rss]
