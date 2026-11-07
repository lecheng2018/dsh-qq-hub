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

/** 派生卡 id：稳定可推导，群号做后缀。 */
export const distillCardId = (gid) => `persona-语感-${String(gid)}`

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

/** 派生卡正文 = 底卡正文 + 借用段。 */
export function buildDerivedBody (baseBody, entries) {
  return String(baseBody || '').trimEnd() + renderStyleBlock(entries)
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
 * 生成/刷新某群的派生人设卡。
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
  const body = buildDerivedBody(base.body, entries)
  savePersona(cardId, {
    name: `语感·借自${entries.map((e) => e.name).filter(Boolean).join('、') || '群友'}`,
    tags: ['自动生成'],
    body,
  })
  log.info?.(`蒸馏语感已写进群人设卡 ${cardId}（底卡 ${base.id || dec.baseId} + ${entries.length} 个借用对象）`)
  return { ok: true, message: '已生成群专属人设卡', cardId, baseId: base.id || dec.baseId }
}
