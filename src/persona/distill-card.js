// 蒸馏→人设卡联动 v4（2026-11-07）：**底卡 = 纯模板，蒸馏数据 = 变量填充**。
//
// 主人定调的架构：
//   「底卡只是模板，里面的提示词是根据蒸馏数据往上填的；预设量只是变量，
//     蒸馏数据分析汇总/分类后，是什么就往什么变量里填。」
//
// 落地：
//   · 模板独立成文件 `_voice-template.md`（personas 数据目录），主人可编辑措辞；
//     首次运行时释放内置默认模板。
//   · 模板支持条件槽位语法：
//       {{#syntax}} ... {{items}} ... {{/syntax}}   —— 该字段有数据时才渲染，{{items}} 是逐条列表
//       {{exchanges}}                                —— 单值变量（对话对等多行文本）
//       {{identity}}                                 —— 身份锚（底卡首段）
//   · 蒸馏数据的「分类」在 Extract 阶段完成（字段=分类：打字习惯/口头禅/接话/修辞/性格/负向/原话），
//     「汇总」在评分制合并完成（同类多条碎特征合并确认、按置信排序），
//     填卡就是把汇总好的每类数据填进模板对应变量——纯数据驱动，模板与数据完全解耦。

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { listPersonas, readPersona, savePersona, personaIdFor } from './personas.js'
import { dataDir } from '../core/store.js'
import { normalizeProfile } from '../features/distill.js'

/** 派生卡 id：稳定可推导，群号做后缀。 */
export const distillCardId = (gid) => `persona-语感-${String(gid)}`

/** 模板文件名（personas 数据目录下，_ 前缀不会被人设列表捡到？——会，故 listPersonas 需排除。 */
export const TEMPLATE_FILE = '_voice-template.md'

/** 内置默认模板（首次释放用）。槽位与蒸馏字段一一对应。 */
export const DEFAULT_TEMPLATE = `# 身份

{{identity}}

以下是你在这些群里说话的样子——身份是自己的，语感是借来的，两层都守住。

{{#exchanges}}## 接话方式（借自「{{who}}」，学应对方式，内容绝不照搬）

{{items}}

{{/exchanges}}{{#syntax}}## 打字习惯（借自「{{who}}」）

{{items}}

{{/syntax}}{{#catchphrases}}## 口头禅（借自「{{who}}」，什么时候用什么）

{{items}}

{{/catchphrases}}{{#rhetoric}}## 修辞招式（借自「{{who}}」）

{{items}}

{{/rhetoric}}{{#persona}}## 性格神韵（借自「{{who}}」，可观察行为）

{{items}}

{{/persona}}{{#never}}## 绝不用（借自「{{who}}」的负向词表）

{{items}}

{{/never}}{{#samples}}## 校准原话（借自「{{who}}」，找节奏用，绝不照抄内容）

{{items}}

{{/samples}}> 硬边界：只借说话方式，不借身份。你不是他们中的任何一个，不自称、不替其表态、不提其隐私。拿不准的场合退回自己的口吻。
`

/** 模板读取：数据目录有就用主人的，没有就释放内置默认。 */
export function loadTemplate () {
  const f = join(dataDir('personas'), TEMPLATE_FILE)
  if (existsSync(f)) {
    try { return readFileSync(f, 'utf8') } catch {}
  }
  try {
    mkdirSync(dataDir('personas'), { recursive: true })
    writeFileSync(f, DEFAULT_TEMPLATE, 'utf8')
  } catch {}
  return DEFAULT_TEMPLATE
}

/** 底卡正文 → 身份锚：取第一个非空段落，截 160 字。 */
export function identityOf (baseBody) {
  const para = String(baseBody || '').split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('---') && !s.startsWith('#'))
  const text = (para || '你是一个说话接地气的群聊常客。').replace(/\s+/g, ' ')
  return text.length > 160 ? text.slice(0, 158) + '……' : text
}

/** 一个对象的槽位变量集：{items: 逐条列表文本, who: 对象名}。 */
function slotVars (field, entriesOf, who) {
  if (!entriesOf.length) return null
  return { items: entriesOf.map((x) => '- ' + x).join('\n'), who }
}

/**
 * 底板填卡：模板 + 蒸馏数据（分类汇总后） → 卡正文。
 * @param {Array<{name,profile}>} entries 学习对象（每个对象一块，条件槽位按数据有无自动显隐）
 * @param {string} identity 身份锚
 * @param {string} template 模板文本（缺省读数据目录）
 * @returns {string} 空串=没有任何可填数据
 */
export function voiceTemplate (entries, identity, template = '') {
  const tpl = template || loadTemplate()
  const blocks = []
  for (const { name, profile } of entries || []) {
    const p = normalizeProfile(profile || {})
    const texts = (f) => p[f].map((e) => e.text)
    const who = String(name || '那位群友').slice(0, 20)
    // 该对象至少要有一个槽有货
    if (!['exchanges', 'syntax', 'catchphrases', 'rhetoric', 'persona', 'never', 'samples'].some((f) => texts(f).length)) continue
    let block = tpl
    // 1) 条件槽位：{{#field}}...{{/field}}——有数据才渲染，{{items}}/{{who}} 展开成逐条列表
    for (const f of ['exchanges', 'syntax', 'catchphrases', 'rhetoric', 'persona', 'never', 'samples']) {
      const re = new RegExp(`\{\{#${f}\}\}([\\s\\S]*?)\{\{/${f}\}\}`, 'g')
      const vars = slotVars(f, texts(f), who)
      block = vars ? block.replace(re, (_, inner) => inner.replace(/\{\{items\}\}/g, vars.items).replace(/\{\{who\}\}/g, vars.who)) : block.replace(re, '')
    }
    // 2) 单值变量
    block = block.replace(/\{\{identity\}\}/g, identity || '你是一个说话接地气的群聊常客。')
    // 残留未识别变量清掉（模板写错了也不出花括号垃圾）
    block = block.replace(/\{\{[^}]*\}\}/g, '')
    blocks.push(block.trim())
  }
  return blocks.join('\n\n') + (blocks.length ? '\n' : '')
}

// v2/v3 API 兼容别名
export const renderStyleBlock = (entries) => {
  const body = voiceTemplate(entries)
  return body ? '\n\n' + body : ''
}
export const buildDerivedBody = (baseBody, entries) => voiceTemplate(entries, identityOf(baseBody)) || String(baseBody || '')

/**
 * 能不能接管这个群的人设槽位。
 */
export function takeoverDecision (cfg, gid, currentId) {
  const p = (cfg && cfg.persona) || {}
  const explicit = String((p.groups || {})[String(gid)] || '').trim()
  const baseId = personaIdFor({ kind: 'group', groupId: String(gid) }, cfg)
  if (explicit && explicit !== currentId) {
    return { takeover: false, baseId: explicit, currentId, reason: `这个群已手动指定人设「${explicit}」，蒸馏不抢它的槽位（想借语感就把人设切到「${currentId}」或删掉手动指定）` }
  }
  return { takeover: true, baseId, currentId, reason: '' }
}

/** 从学习目标列表构建条目（distillList 的形态）。 */
export function styleEntries (targets) {
  return (targets || [])
    .filter((t) => t && t.profile)
    .map((t) => ({ name: String(t.name || t.uid || ''), profile: t.profile }))
}

/**
 * 生成/刷新某群的派生人设卡：模板 + 最新蒸馏数据 → 整卡重填。
 * 模板是主人可编辑的（数据目录 _voice-template.md），数据是机器蒸馏的——两层解耦。
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
  log.info?.(`蒸馏模板卡已重填 ${cardId}（模板=数据目录 ${TEMPLATE_FILE}，身份锚 ← ${base.id || dec.baseId}，${entries.length} 个借用对象）`)
  return { ok: true, message: '已生成群专属人设卡', cardId, baseId: base.id || dec.baseId }
}
