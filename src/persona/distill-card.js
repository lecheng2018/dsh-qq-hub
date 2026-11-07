// 蒸馏→人设卡联动 v2（2026-11-07 重构）：把学来的群友语感**写进人设卡**，而不只是当轮的小抄。
//
// 为什么要这一步：人设卡（complete 模式）就是整个系统提示词，是模型眼里「我是谁」的最高
// 权威；蒸馏画像走 contextFor 只是文末附件，权重天然低。想让语感真的稳定偏移，
// 就得把「借来的说话方式」放进最高优先级那一层。
//
// v2 变化：
//   · 渲染统一：借用段直接走 renderProfile(mode='card') 唯一出口，和当轮注入（hint）共享
//     同一套字段渲染逻辑，杜绝 v1 两套渲染漂移。
//   · 增量写入：借用段用 <!-- distill:v2 --> 标记包围；刷新时只替换标记块，
//     主人对派生卡正文的其它手改（换称呼、调语气）不再被整卡覆盖冲掉。
//   · 底卡去重：刷新时把底卡正文交给 Verify 裁判判「duplicate」（在 memory.js 管线里），
//     底卡已经覆盖的要求不再重复进借用段。
//
// 三条硬规矩（沿袭 v1，测试锁定）：
//   1) **不改动主人的底卡**。派生卡是独立文件（persona-语感-<群号>.md）＝底卡正文 + 借用段。
//   2) **尊重手动配置**。这个群的人设槽位如果主人指定过别的卡，绝不抢；只在「没指定」或
//      「本来就指着派生卡」时接管/更新。
//   3) **边界随卡走**。借用段自带「只借说话方式、不冒充本人」，写在哪都拆不开。

import { listPersonas, readPersona, savePersona, personaIdFor } from './personas.js'
import { renderProfile } from '../features/distill.js'

/** 借用段标记：增量更新时靠它定位「哪一段是蒸馏写的」。 */
export const DISTILL_MARK_BEGIN = '<!-- distill:v2 begin -->'
export const DISTILL_MARK_END = '<!-- distill:v2 end -->'

/** 派生卡 id：稳定可推导，群号做后缀。 */
export const distillCardId = (gid) => `persona-语感-${String(gid)}`

/** 画像条目列表 → 借用段（带标记）。多个目标就拼多块。 */
export function renderStyleBlock (entries) {
  const parts = []
  for (const { name, profile } of entries || []) {
    const block = renderProfile(profile, { mode: 'card', name })
    if (block) parts.push(block)
  }
  if (!parts.length) return ''
  return '\n\n' + DISTILL_MARK_BEGIN + '\n\n【从群友身上借来的说话方式】\n\n' + parts.join('\n\n') + '\n\n' + DISTILL_MARK_END + '\n'
}

/**
 * 派生卡正文 = 基座正文 + 借用段（标记包围）。
 * 增量语义：baseBody 传现派生卡正文（主人手改过的版本）时，标记外的内容原样保留；
 * 传底卡正文（首次生成或主人没动过派生卡）时就是全新构建。
 */
export function buildDerivedBody (baseBody, entries) {
  return String(baseBody || '').trimEnd() + renderStyleBlock(entries)
}

/** 从现卡正文里取出「标记以外的部分」（主人手改过的基座）。没有标记就返回 null。 */
export function stripDistillBlock (body) {
  const s = String(body || '')
  const i = s.indexOf(DISTILL_MARK_BEGIN)
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
 * 生成/刷新某群的派生人设卡（v2 增量写入）。
 * 基座选取优先级：现派生卡标记前的部分（主人手改保留）> 底卡正文 > 第一个人设。
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
  // 增量基座：派生卡已存在 → 保留主人手改的标记前内容；否则用底卡正文
  const existing = readPersona(cardId)
  const baseBody = (existing && stripDistillBlock(existing.body) != null)
    ? stripDistillBlock(existing.body)
    : base.body
  const body = buildDerivedBody(baseBody, entries)
  savePersona(cardId, {
    name: `语感·借自${entries.map((e) => e.name).filter(Boolean).join('、') || '群友'}`,
    tags: ['自动生成'],
    body,
  })
  log.info?.(`蒸馏语感已写进群人设卡 ${cardId}（基座 ${existing && stripDistillBlock(existing.body) != null ? '现卡手改版' : (base.id || dec.baseId)} + ${entries.length} 个借用对象）`)
  return { ok: true, message: '已生成群专属人设卡', cardId, baseId: base.id || dec.baseId }
}
