// 蒸馏→人设卡联动（1.3.65）：把学来的群友语感**写进人设卡**，而不只是当轮的小抄。
//
// 为什么要这一步：人设卡（complete 模式）就是整个系统提示词，是模型眼里「我是谁」的最高
// 权威；蒸馏画像走 contextFor 只是文末附件，权重天然低。想让语感真的稳定偏移，
// 就得把「借来的说话方式」放进最高优先级那一层。
//
// 三条硬规矩：
//   1) **不改动主人的底卡**。派生卡是独立文件（persona-语感-<群号>.md）＝底卡正文 + 借用段。
//   2) **尊重手动配置**。这个群的人设槽位如果主人指定过别的卡，绝不抢；只在「没指定」或
//      「本来就指着派生卡」时接管/更新。
//   3) **边界随卡走**。借用段自带「只借说话方式、不冒充本人」，写在哪都拆不开。

import { listPersonas, readPersona, savePersona, personaIdFor } from './personas.js'
import { normalizeProfile } from '../features/distill.js'
import { renderGrowthSegment } from '../features/distill-pipeline.js'

/** 派生卡 id：稳定可推导，群号做后缀。 */
export const distillCardId = (gid) => `persona-语感-${String(gid)}`

// 派生卡里由蒸馏追加的两个段落头。刷新时必须先切掉，否则「底卡=派生卡」时
// 每次刷新都会把上次的借用段再叠一遍（1.3.66 修：实测同一张卡里堆了 5 份互相矛盾的语感块）。
const STYLE_SECTION_HEAD = '【从群友身上借来的说话方式】'
const GROWTH_SECTION_HEAD = '【从群友身上蒸馏的人格增长段'

/**
 * 从一段人设正文里切掉蒸馏追加的段落，还原出真正的底卡正文。
 * 底卡不是派生卡时（正文里没有这两个头）原样返回。
 */
export function stripDistillSections (body) {
  let out = String(body || '')
  for (const head of [STYLE_SECTION_HEAD, GROWTH_SECTION_HEAD]) {
    const at = out.indexOf(head)
    if (at >= 0) out = out.slice(0, at)
  }
  return out.trimEnd()
}

// 派生卡（persona-语感-<群号>）自己就是蒸馏产物，不能当底卡用：
// 拿它当底卡会把别的群/上一次的语感带进来，还会越刷越厚。
export const isDistillCardId = (id) => String(id || '').startsWith('persona-语感-')

/** 画像 → 「【从群友身上借来的说话方式】」段落。多个目标就拼多块。 */
export function renderStyleBlock (entries) {
  const parts = []
  for (const { name, profile } of entries || []) {
    const p = normalizeProfile(profile || {})
    if (!p.exchanges.length && !p.syntax.length && !p.catchphrases.length && !p.persona.length && !p.samples.length && !p.style.length) continue
    const who = String(name || '那位群友').slice(0, 20)
    const blocks = []
    if (p.exchanges.length) blocks.push('我在这个群接话就照着他的应对方式来（学应对方式，聊天内容绝不照搬）：\n' + p.exchanges.map((x) => '- ' + x).join('\n'))
    const voice = []
    if (p.catchphrases.length) voice.push('口头禅：' + p.catchphrases.join('；'))
    if (p.syntax.length) voice.push('句子架构：' + p.syntax.join('；'))
    if (p.rhetoric.length) voice.push('修辞招式：' + p.rhetoric.join('；'))
    if (voice.length) blocks.push(voice.join('\n'))
    if (p.never.length) blocks.push('我不用他绝不会用的东西：' + p.never.join('；'))
    if (p.persona.length) blocks.push('我借他神韵的地方：' + p.persona.join('；'))
    if (p.samples.length) blocks.push('他的原话（校准节奏用，不引用）：' + p.samples.map((x) => '「' + x + '」').join(' '))
    if (p.style.length) blocks.push('（旧画像）' + p.style.join('；') + (p.avoid.length ? '；他不会：' + p.avoid.join('；') : ''))
    parts.push(`【语感·借自「${who}」】\n${blocks.join('\n')}\n（只借说话方式，不借身份：我不是${who}，不自称他、不替他表态、不提他个人隐私。）`)
  }
  if (!parts.length) return ''
  return '\n\n' + '【从群友身上借来的说话方式】\n\n' + parts.join('\n\n') + '\n'
}

/** 派生卡正文 = 底卡正文（剥掉旧蒸馏段）+ 借用段 + 增长段（蒸馏流水线 L3，可选）。 */
export function buildDerivedBody (baseBody, entries, growth) {
  let body = stripDistillSections(baseBody) + renderStyleBlock(entries)
  for (const g of growth || []) {
    const block = renderGrowthSegment(g.uid || g.name, g.segment)
    if (block) body += '\n\n' + block
  }
  return body
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
 * 挑一张真正的底卡：跳过派生卡自己，按群默认 > 全局 current 往下找。
 * 全都指向派生卡时才退到第一张非派生的卡（否则底卡=派生卡，语感会一层层叠上去）。
 */
export function pickBaseCard (cfg, gid) {
  const p = (cfg && cfg.persona) || {}
  const g = String(gid || '')
  const candidates = [p.groups && p.groups[g], p.groupDefault, p.current, 'dafeiyu']
  for (const id of candidates) {
    const sid = String(id || '').trim()
    if (!sid || isDistillCardId(sid)) continue
    const card = readPersona(sid)
    if (card) return card
  }
  const fallback = listPersonas().find((x) => x && x.id && !isDistillCardId(x.id))
  return fallback || null
}

/**
 * 生成/刷新某群的派生人设卡。
 * @param {{gid:string, entries:{name,profile}[], growth?:{uid,segment}[], cfg:object, log?:object}} opts
 *   growth：蒸馏流水线 L3 的人格增长段（第二人称指令式），附在借用段之后。
 * @returns {{ok:boolean, message:string, cardId?:string, baseId?:string}}
 */
export function refreshDistillCard ({ gid, entries, growth, cfg, log = console }) {
  const cardId = distillCardId(gid)
  const dec = takeoverDecision(cfg, gid, cardId)
  if (!dec.takeover) return { ok: false, message: dec.reason }
  if ((!entries || !entries.length) && (!growth || !growth.length)) return { ok: false, message: '这个群还没有学成的画像，先蒸馏一个群友再说' }
  // 底卡绝不能是派生卡本身（那会把上次的语感再叠一遍）。takeoverDecision 允许
  // groups[gid] == cardId，所以这里单独挑真正底卡。
  const base = pickBaseCard(cfg, gid)
  if (!base) return { ok: false, message: '找不到底卡人设' }
  const body = buildDerivedBody(base.body, entries, growth)
  savePersona(cardId, {
    name: `语感·借自${entries.map((e) => e.name).filter(Boolean).join('、') || '群友'}`,
    tags: ['自动生成'],
    body,
  })
  const baseLabel = base.id || '(第一张非派生卡)'
  const cleaned = body.length !== String(base.body || '').trimEnd().length
  log.info?.(`蒸馏语感已写进群人设卡 ${cardId}（底卡 ${baseLabel} + ${entries.length} 个借用对象${growth?.length ? ' + ' + growth.length + ' 个增长段' : ''}${cleaned ? '；已清掉旧的蒸馏段' : ''}）`)
  return { ok: true, message: '已生成群专属人设卡', cardId, baseId: base.id || '' }
}
