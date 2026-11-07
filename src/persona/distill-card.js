// 蒸馏→人设卡联动 v3（2026-11-07）：**内置「模仿人底板」**，蒸馏数据填槽生成声音卡。
//
// 设计（主人定调）：派生卡不再「底卡正文 + 末尾借用段」打补丁，而是用一张为蒸馏/模仿
// 专门设计的底板（voice template），把学到的数据按槽位填进去：
//
//   ┌ 身份槽：她还是谁（取底卡首段作锚，防止学语感学到丢身份）
//   ├ 打字习惯槽（syntax：句长、断句、@ 习惯——打字习惯的机械化描述）
//   ├ 口头禅槽（catchphrases：词/句式 + 使用语境）
//   ├ 接话槽（exchanges：一问一答，mes_example 形态，教「怎么接」）
//   ├ 修辞槽（rhetoric：反复用的表达套路）
//   ├ 性格槽（persona：可观察行为）
//   ├ 负向槽（never：绝不用词/绝不做的事，防通用聊天腔渗入）
//   ├ 校准槽（samples：原话，校准节奏用，不引用）
//   └ 硬边界（只借方式不借身份，随卡走、拆不开）
//
// 业界依据：SillyTavern 声音卡的专用骨架（mes_example 教接话 > 形容词）；vox-machina
// 人声模板的 SENTENCE ARCHITECTURE / Signature phrase(语境) / NEVER-use 结构。
// 底板是机器拥有的：每次刷新整体重填（数据源就是评分制画像），主人要调人格去改底卡。

import { listPersonas, readPersona, savePersona, personaIdFor } from './personas.js'
import { normalizeProfile } from '../features/distill.js'

/** 派生卡 id：稳定可推导，群号做后缀。 */
export const distillCardId = (gid) => `persona-语感-${String(gid)}`

/** 底卡正文 → 身份锚：取第一个非空段落，截 160 字（身份只要锚点，不要整张卡）。 */
export function identityOf (baseBody) {
  const para = String(baseBody || '').split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('---') && !s.startsWith('#'))
  const text = (para || '你是一个说话接地气的群聊常客。').replace(/\s+/g, ' ')
  return text.length > 160 ? text.slice(0, 158) + '……' : text
}

/** 单个目标的画像 → 底板各槽位的填充内容（空槽返回空串，渲染时整节跳过）。 */
function fillSlots (profile) {
  const p = normalizeProfile(profile || {})
  const texts = (f) => p[f].map((e) => e.text)
  return {
    syntax: texts('syntax'),
    catchphrases: texts('catchphrases'),
    exchanges: texts('exchanges'),
    rhetoric: texts('rhetoric'),
    persona: texts('persona'),
    never: texts('never'),
    samples: texts('samples'),
  }
}

const bullets = (arr) => arr.map((x) => '- ' + x).join('\n')

/**
 * 内置模仿人底板：把（多个）学习对象的蒸馏数据填进槽位，产出整张声音卡正文。
 * 单目标时槽位直接填；多目标时每个对象一个分块（她的群一般只学 1~2 个人，不复杂化）。
 */
export function voiceTemplate (entries, identity) {
  const parts = []
  for (const { name, profile } of entries || []) {
    const s = fillSlots(profile)
    const who = String(name || '那位群友').slice(0, 20)
    if (!s.syntax.length && !s.catchphrases.length && !s.exchanges.length && !s.persona.length && !s.samples.length) continue
    const sec = []
    if (s.syntax.length) sec.push('### 打字习惯\n' + bullets(s.syntax))
    if (s.catchphrases.length) sec.push('### 口头禅（什么时候用）\n' + bullets(s.catchphrases))
    if (s.exchanges.length) sec.push('### 接话方式（学应对方式，内容绝不照搬）\n' + s.exchanges.map((x) => '- ' + x).join('\n'))
    if (s.rhetoric.length) sec.push('### 修辞招式\n' + bullets(s.rhetoric))
    if (s.persona.length) sec.push('### 性格神韵（可观察行为）\n' + bullets(s.persona))
    if (s.never.length) sec.push('### 绝不用\n' + bullets(s.never))
    if (s.samples.length) sec.push('### 校准原话（找节奏用，绝不照抄内容）\n' + s.samples.map((x) => '「' + x + '」').join(' '))
    parts.push(`## 说话的样子：借自「${who}」\n\n${sec.join('\n\n')}\n\n> 只借说话方式，不借身份：你不是${who}本人，不自称他、不替他表态、不提他个人隐私。拿不准的场合退回自己的口吻。`)
  }
  if (!parts.length) return ''
  return `# 身份\n\n${identity || '你是一个说话接地气的群聊常客。'}\n\n以下是你在这些群里说话的样子——身份是自己的，语感是借来的，两层都守住。\n\n`
    + parts.join('\n\n') + '\n'
}

// v2 API 兼容：老调用方/测试还在用这两个名字。v3 里借用段=整张底板卡。
export const renderStyleBlock = (entries) => {
  const body = voiceTemplate(entries)
  return body ? '\n\n' + body : ''
}
export const buildDerivedBody = (baseBody, entries) => voiceTemplate(entries, identityOf(baseBody)) || String(baseBody || '')

/** 从现卡正文里取出「标记以外的部分」（v2 遗留：标记卡兼容读取）。 */
export function stripDistillBlock (body) {
  const s = String(body || '')
  const i = s.indexOf('<!-- distill:v2 begin -->')
  if (i < 0) return null
  return s.slice(0, i).trimEnd()
}

/**
 * 能不能接管这个群的人设槽位。
 * @returns {{takeover:boolean, baseId:string, currentId:string, reason:string}}
 */
export function takeoverDecision (cfg, gid, currentId) {
  const p = (cfg && cfg.persona) || {}
  const explicit = String((p.groups || {})[String(gid)] || '').trim()
  const baseId = personaIdFor({ kind: 'group', groupId: String(gid) }, cfg)
  // 只要主人给这个群**明确指定过**别的卡（哪怕和默认撞值，那是「我指定了」的表态），就不抢
  if (explicit && explicit !== currentId) {
    return { takeover: false, baseId: explicit, currentId, reason: `这个群已手动指定人设「${explicit}」，蒸馏不抢它的槽位（想借语感就把人设切到「${currentId}」或删掉手动指定）` }
  }
  return { takeover: true, baseId, currentId, reason: '' }
}

/** 从学习目标列表构建条目（distillList 的形态：{gid, uid, name, profile}）。 */
export function styleEntries (targets) {
  return (targets || [])
    .filter((t) => t && t.profile)
    .map((t) => ({ name: String(t.name || t.uid || ''), profile: t.profile }))
}

/**
 * 生成/刷新某群的派生人设卡（v3：底板填槽，整体重填）。
 * 身份锚取底卡首段；底卡本体永远不动。
 * @param {{gid:string, entries:{name,profile}[], cfg:object, log?:object}} opts
 * @returns {{ok:boolean, message:string, cardId?:string, baseId?:string}}
 */
export function refreshDistillCard ({ gid, entries, cfg, log = console }) {
  const cardId = distillCardId(gid)
  const dec = takeoverDecision(cfg, gid, cardId)
  if (!dec.takeover) return { ok: false, message: dec.reason }
  if (!entries || !entries.length) return { ok: false, message: '这个群还没有学成的画像，先蒸馏一个群友再说' }
  const base = readPersona(dec.baseId) || listPersonas()[0]
  if (!base) return { ok: false, message: '找不到底卡人设' }
  const body = voiceTemplate(entries, identityOf(base.body))
  if (!body) return { ok: false, message: '学到的画像还是空的，填不进底板' }
  savePersona(cardId, {
    name: `语感·借自${entries.map((e) => e.name).filter(Boolean).join('、') || '群友'}`,
    tags: ['自动生成'],
    body,
  })
  log.info?.(`蒸馏底板已填槽写入群人设卡 ${cardId}（身份锚 ← ${base.id || dec.baseId}，${entries.length} 个借用对象）`)
  return { ok: true, message: '已生成群专属人设卡', cardId, baseId: base.id || dec.baseId }
}
