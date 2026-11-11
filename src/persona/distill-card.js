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

/** 画像 → 「【当前群聊语感微调 · 风格参考】」段落（RFC 蒸馏群友重构 模块三）。
 * 旧版开头写「我在这个群接话就照着他的应对方式来」——第一人称接管式表述会把底卡人设整个
 * 掀掉（底卡是撒娇弱妹、尾部是技术爹味，人格撕裂）。新版是「外挂滤镜」协议：底卡身份不动，
 * 语感只在语境契合时生效；且永不渲染他的真实经历（学的时候就不该提炼，渲染再拦一道）。 */
export function renderStyleBlock (entries, { syntaxOnly = false } = {}) {
  const parts = []
  for (const { name, profile } of entries || []) {
    const p = normalizeProfile(profile || {})
    const who = String(name || '那位群友').slice(0, 20)
    const footer = `（只借说话方式，不借身份：我不是${who}，不自称他、不替他表态、不提他个人隐私、不复述他的真实经历。）`
    if (syntaxOnly) {
      // 底卡冲突保护：强特化底卡只借节奏与断句习惯，性格类标签一律不注入（防双重人格）
      if (!p.syntax.length) continue
      parts.push(`【语感参考 · ${who}】\n- 发言节奏参考：\n  · ${p.syntax.join('\n  · ')}\n（只借说话节奏，不借身份：我不是${who}，不自称他、不替他表态。）`)
      continue
    }
    const blocks = []
    if (p.exchanges.length) blocks.push('- 接话示范参考（学其接话姿势与语调节奏，不照搬字面内容）：\n  ' + p.exchanges.map((x) => String(x).replace(/\n/g, '\n  ')).join('\n  '))
    if (p.syntax.length) blocks.push('- 发言节奏参考：\n  · ' + p.syntax.join('\n  · '))
    if (p.rhetoric.length) blocks.push('- 态度取向：\n  · ' + p.rhetoric.join('\n  · '))
    if (p.never.length) blocks.push('- 边界（不模仿他的私人经历；下列表达他从不使用，也不要从他身上学）：' + p.never.join('；'))
    if (p.catchphrases.length) blocks.push('- 口头禅（多场景复现过的，仍带使用语境）：' + p.catchphrases.join('；'))
    if (p.persona.length) blocks.push('- 可观察行为（旧画像遗留，逐条核对过依据的才保留）：' + p.persona.join('；'))
    if (p.samples.length) blocks.push('- 原话校准（只校准节奏，绝不引用）：' + p.samples.map((x) => '「' + x + '」').join(' '))
    if (p.style.length) blocks.push('- （旧画像）' + p.style.join('；') + (p.avoid.length ? '；他不会：' + p.avoid.join('；') : ''))
    if (!blocks.length) continue
    parts.push(`【语感参考 · ${who}】\n${blocks.join('\n')}\n${footer}`)
  }
  if (!parts.length) return ''
  return '\n\n' + '【当前群聊语感微调 · 风格参考】\n'
    + '（本段属于外部语感滤镜：你在本群发言时，在保持自身原本身份设定的前提下，自然融入以下说话风格与聊天节奏。'
    + '仅在语境契合时生效，日常闲聊切勿机械套用模板；严禁冒充对方真实身份或盗用其真实个人经历。）\n\n'
    + parts.join('\n\n') + '\n'
}

/** 强特化底卡标签：命中就只借节奏与断句，性格类借用全部跳过（RFC 模块三 6.2）。 */
export const STRONG_BASE_RE = /(妹妹|女仆|傲娇|萝莉|御姐|甜妹|撒娇|病娇|元气)/

/** 派生卡正文 = 底卡正文 + 借用段 + 增长段（蒸馏流水线 L3，可选）。 */
export function buildDerivedBody (baseBody, entries, growth) {
  const strong = STRONG_BASE_RE.test(String(baseBody || ''))
  let body = String(baseBody || '').trimEnd() + renderStyleBlock(entries, strong ? { syntaxOnly: true } : {})
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
  const base = readPersona(dec.baseId) || listPersonas()[0]
  if (!base) return { ok: false, message: '找不到底卡人设' }
  const body = buildDerivedBody(base.body, entries, growth)
  savePersona(cardId, {
    name: `语感·借自${entries.map((e) => e.name).filter(Boolean).join('、') || '群友'}`,
    tags: ['自动生成'],
    body,
  })
  log.info?.(`蒸馏语感已写进群人设卡 ${cardId}（底卡 ${base.id || dec.baseId} + ${entries.length} 个借用对象${growth?.length ? ' + ' + growth.length + ' 个增长段' : ''}）`)
  return { ok: true, message: '已生成群专属人设卡', cardId, baseId: base.id || dec.baseId }
}
