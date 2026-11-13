// 角色身份元数据解析器（阶段 0a：身份中枢）。
//
// 为什么要有它：后台的记忆提炼、长期反思、语感学习、目的引擎各自把角色名写死过。
// 面板换成别的人设卡以后，前台已经换人、后台还在念旧名字，提炼出的记忆和沉淀的语感
// 全部串味（这就是「精神分裂」的根因）。这里按「这个聊天实际用哪张卡」动态解析出
// 名字 / 唤醒词 / 自称正则，后台链路只认这一份，不再各自硬编码。
//
// 约定：解析绝不抛。卡片读不到就退回默认名，宁可少一点个性，也不能让提炼整条链路挂掉。
//
// v3.4 要求：入参严格通过 chat/adapters/legacy-context.js 的 chatViewFromKey 解析。
// 理由见该函数注释——身份中枢与 legacy 上下文必须看到同一份 chat 视图，
// 否则同一个 chatKey 在两边被认成不同 kind，人设分流就会劈叉。

import { personaIdFor, readPersona } from './personas.js'
import { chatViewFromKey } from '../chat/adapters/legacy-context.js'
import { DEFAULT_CHARACTER_NAME } from './identity-defaults.js'

// 默认名住在 identity-defaults.js（personas.js 也要用，放这里会和它成环）。
// 这里继续 re-export，老代码 import { DEFAULT_CHARACTER_NAME } from 'identity-context' 不受影响。
export { DEFAULT_CHARACTER_NAME }

/** 正则转义：人设名里的 . * + ? ( ) [ ] { } ^ $ | \ / 都要当字面量看待。 */
export function escapeRegExp(string) {
  return String(string ?? '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/**
 * 拼一个「以自身开头」的自称正则。
 *
 * 纯 ASCII 名字（`A`、`bot2`）后面加 `(?![A-Za-z0-9_])`：否则角色名叫 A 时，
 * 「AXBXC 家的猫」会被当成她的自称——英文名必须整词才算。
 * 中文名、含符号的名字（`A.B*C+`）没有词边界概念，转义后按字面量前缀匹配即可。
 */
export function selfRefPattern(names) {
  const alts = (Array.isArray(names) ? names : [names])
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => {
      const lit = escapeRegExp(n.trim())
      return /^[A-Za-z0-9_]+$/.test(n.trim()) ? `${lit}(?![A-Za-z0-9_])` : lit
    })
  // 没有名字时只能认「我」。绝不能退化成 `^(?:我|)`——空分支会匹配任何开头，
  // 后台的记忆去重就变成「所有条目都是她自己」，等于把事实全丢掉。
  if (!alts.length) return /^(?:我)/i
  return new RegExp(`^(?:我|${alts.join('|')})`, 'i')
}

/** 去掉已经带着的前缀，只留裸 id（`group:123` → `123`）。 */
function bareId(value, prefix) {
  const s = String(value ?? '').trim()
  return prefix && s.startsWith(prefix) ? s.slice(prefix.length) : s
}

/**
 * 把「chatKey 字符串 或 已解析的 chat 视图对象」收敛成 chatKey 字符串。
 * chatViewFromKey 只吃字符串，遇上对象会 String() 成 "[object Object]" 而误判 system；
 * 这里先把对象写回 key 形态，再交给它解析，保证只有一条解析路径。
 *
 * 剥前缀是必须的：调用方可能拿 chatViewFromKey 的输出（chatId 是完整 key、groupId 是裸号）
 * 回喂进来，也可能自己拼了带前缀的 groupId。不剥就会拼出 `group:group:123`，
 * chatViewFromKey 认成「群 group:123」，personaIdFor 查不到按群人设、静默回落全局卡——
 * 症状恰好是「群里换的卡不生效」。
 */
function chatKeyOf(chat) {
  if (chat && typeof chat === 'object') {
    const kind = String(chat.kind || '')
    if (kind === 'group') {
      const id = bareId(chat.groupId, 'group:') || bareId(chat.chatId, 'group:')
      return `group:${id}`
    }
    if (kind === 'private') {
      const id = bareId(chat.userId, 'private:') || bareId(chat.chatId, 'private:')
      return `private:${id}`
    }
    return String(chat.chatId ?? '')
  }
  return String(chat ?? '')
}

/** cfg.group.wakeWords 兼容数组与「逗号/空格分隔的字符串」两种形状。 */
function customWakeWords(cfg) {
  const raw = cfg?.group?.wakeWords
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,，]+/)
  return list.map((w) => String(w ?? '').trim()).filter(Boolean)
}

/**
 * 解析某个聊天当前用的人设身份。
 * @param {string|{kind?:string,groupId?:string,userId?:string}} chatKey 聊天键或聊天视图
 * @param {object} cfg QQ Hub 配置（可以缺省，缺省时走全局人设）
 * @param {{personaIdFor?:Function, readPersona?:Function, chatViewFromKey?:Function}} [deps]
 *   测试注入点（读卡失败路径 / 视图派生失败路径）
 * @returns {{id:string, name:string, hasCard:boolean, wakeWords:string[], rolePrompt:string,
 *   selfRefRegex:RegExp, shortBio:string}}
 */
export function resolveCharacterIdentity(chatKey, cfg = {}, deps = {}) {
  const pickId = deps.personaIdFor || personaIdFor
  const readCard = deps.readPersona || readPersona
  const viewOf = deps.chatViewFromKey || chatViewFromKey
  let id = ''
  let card = null
  try {
    // v3.4：视图一律由 chatViewFromKey 派生，身份中枢不另写一套 kind 判定。
    id = String(pickId(viewOf(chatKeyOf(chatKey)), cfg) || '')
    card = id ? readCard(id) : null
  } catch (error) {
    card = null // 卡片读取失败（目录不存在、文件损坏）：当成没有卡
  }
  const hasCard = Boolean(String(card?.name || '').trim())
  const name = hasCard ? String(card.name).trim() : DEFAULT_CHARACTER_NAME
  const wakeWords = Array.from(new Set([name, ...customWakeWords(cfg)])).filter(Boolean)
  // 自称判定：以「我」或她自己（角色名 + 唤醒词）开头，大小写不敏感。
  const selfRefRegex = selfRefPattern(wakeWords)
  return {
    id,
    name,
    hasCard,
    wakeWords,
    rolePrompt: String(card?.body || ''),
    selfRefRegex,
    // 名字和指代必须是同一份真相：没卡时两处都说「AI伴侣」，不再一处「AI伴侣」一处「该聊天角色」。
    shortBio: `「${name}」`,
  }
}

/** 只要名字时的快捷方式（提示词里插一句「你是谁」的大多数场景够用）。 */
export function characterName(chatKey, cfg = {}, deps = {}) {
  return resolveCharacterIdentity(chatKey, cfg, deps).name
}
