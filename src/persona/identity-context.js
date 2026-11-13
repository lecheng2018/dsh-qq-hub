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

/** 读不到人设卡时的兜底名字（提示词里统一用「该聊天角色」指代）。 */
export const DEFAULT_CHARACTER_NAME = 'AI伴侣'

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
function selfRefPattern(names) {
  const alts = names
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => {
      const lit = escapeRegExp(n.trim())
      return /^[A-Za-z0-9_]+$/.test(n.trim()) ? `${lit}(?![A-Za-z0-9_])` : lit
    })
  return new RegExp(`^(?:我|${alts.join('|')})`, 'i')
}

/**
 * 把「chatKey 字符串 或 已解析的 chat 视图对象」收敛成 chatKey 字符串。
 * chatViewFromKey 只吃字符串，遇上对象会 String() 成 "[object Object]" 而误判 system；
 * 这里先把对象写回 key 形态，再交给它解析，保证只有一条解析路径。
 */
function chatKeyOf(chat) {
  if (chat && typeof chat === 'object') {
    const kind = String(chat.kind || '')
    if (kind === 'group') return `group:${chat.groupId || chat.chatId?.toString().slice(6) || ''}`
    if (kind === 'private') return `private:${chat.userId || chat.chatId?.toString().slice(8) || ''}`
    return String(chat.chatId || '')
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
 * @returns {{id:string, name:string, wakeWords:string[], rolePrompt:string,
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
  const name = String(card?.name || '').trim() || DEFAULT_CHARACTER_NAME
  const wakeWords = Array.from(new Set([name, ...customWakeWords(cfg)])).filter(Boolean)
  // 自称判定：以「我」或她自己（角色名 + 唤醒词）开头，大小写不敏感。
  const selfRefRegex = selfRefPattern(wakeWords)
  return {
    id,
    name,
    wakeWords,
    rolePrompt: String(card?.body || ''),
    selfRefRegex,
    shortBio: card?.name ? `「${name}」` : '该聊天角色',
  }
}
