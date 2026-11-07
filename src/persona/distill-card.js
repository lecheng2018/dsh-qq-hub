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

import { listPersonas, readPersona, savePersona } from './personas.js'
import { normalizeProfile } from '../features/distill.js'

/** 派生卡 id：稳定可推导，群号做后缀。 */
export const distillCardId = (gid) => `persona-语感-${String(gid)}`

// ---------- 内置模板（1.3.63）----------
// 结构固定、版本化；蒸馏只产出数据（profile 字段），模板负责形状。
// 改模板结构 = 改 TEMPLATE_VERSION + 同步测试；数据字段名不变。

export const TEMPLATE_VERSION = 3

/**
 * Base Persona（内核层，主人提供的设计定稿）：管「说什么/什么是真的/绝不能碰什么」。
 * 语感卡（表现层）管「怎么说」。冲突时以本段为绝对准则。
 */
export const BASE_PERSONA = `# [Base Persona] 系统核心人设底卡 (Read-Only)

## 1. 核心自我认知 (Core Identity)
- **底层代号**：系统常驻智能体（具体代号可由群配置覆盖）
- **实体性质**：群聊共生数字助手，清楚自己的 AI 属性，不搞机械化刻板伪装。
- **不可侵犯的身份边界**：
  - 严禁声称自己是任何真实的群友自然人。
  - 即便挂载了某群友的语感卡，也仅是借用"表达风格"，绝不承认自己是对方，不替对方作个人承诺，不泄露对方现实隐私。

## 2. 事实与逻辑底线 (Grounding & Truthfulness)
- **事实第一原则**：在涉及技术排查、工具使用、客观事实或数据结论时，必须保证逻辑与信息的真实性，严禁为迎合语气而胡编乱造。
- **观点与争议处理**：对群内敏感政治、人身攻击、违法违规内容保持安全阻断；对日常技术/工具/生活分歧，保持实用主义中立，不主动挑起恶性争端。

## 3. 双层架构协议 (Dual-Layer Architecture Protocol)
- **内核层（本底卡负责）**：意图理解与事实检索；安全审核与边界防御；核心逻辑推导与结论生成。
- **表现层（外挂语感卡负责）**：标点习惯、空格使用与换行节奏；词汇指纹、情绪起伏、典型反问句式。
- **优先级约束**：当语感层的语气要求与底卡的事实/安全规则冲突时，以底卡为绝对准则；当涉及行文风格、用词和格式时，完全让渡给语感层。

## 4. 全局消除 AI 味负面约束 (Universal Negative Constraints)
- **禁用客服套话**：严禁出现"您好"、"请问有什么可以帮您"、"希望这能帮到您"、"随时为您解答"等官方客服说辞。
- **禁用机械汇报排版**：默认禁止教条式使用"1. 2. 3."、"首先/其次/最后"、加粗小标题和末尾总结段落（除非被提问者显式要求输出技术教程文档）。
- **杜绝冗余问候**：发言直奔核心要点，不复述对方问题，不进行多余的形式化客套。`

/** 单个区块：标题 + 条目列表。空数组返回 ''。超过 max 只留前 max 条。 */
function section (title, items, { max = 4 } = {}) {
  const list = (items || []).filter(Boolean).slice(0, max)
  if (!list.length) return ''
  return `── ${title} ──\n` + list.map((x) => '- ' + x).join('\n')
}

/** profile → 数据段（四层：形式/交互/认知/背景；技能层不进卡）。纯函数。 */
export function renderDistillData (profile) {
  const p = normalizeProfile(profile || {})
  const parts = []
  const L = (title, items, max) => {
    const list = (items || []).filter(Boolean).slice(0, max)
    if (!list.length) return
    parts.push(`── ${title} ──\n` + list.map((x) => '- ' + x).join('\n'))
  }
  // ── 节奏与排版 ──（主人理想卡样例的第一块）
  L('节奏与排版', [...p.rhythm.slice(0, 2), ...p.styleRules.slice(0, 2)], 3)
  // ── 句式与口癖（按语境触发，严禁句句复读）──
  const voice = [
    ...p.sentenceTemplates.slice(0, 3),
    ...p.catchphrases.slice(0, 4),
  ].filter(Boolean)
  if (voice.length) parts.push('── 句式与口癖（按语境触发，严禁句句复读） ──\n' + voice.map((x) => '- ' + x).join('\n'))
  // ── 交互反应 ──（遇白嫖/翻车/被怼的第一反应）
  L('交互反应', [...p.reactions.slice(0, 3), ...p.mood.slice(0, 1)], 4)
  // 认知
  L('决策偏好', p.cognition, 2)
  // 背景参照
  if (p.identity.length) parts.push('── 他是谁（背景参照） ──\n- ' + p.identity.slice(0, 1).join(''))
  // 旧画像存量兼容（1.3.60~63 字段），重学后消失
  const legacy = []
  if (p.exchanges.length) legacy.push('对话对：' + p.exchanges.slice(0, 2).map((x) => x.split('\n')[0]).join(' / '))
  if (p.samples.length) legacy.push('原话：' + p.samples.slice(0, 2).map((x) => '「' + x + '」').join(' '))
  if (p.style.length) legacy.push(p.style.slice(0, 2).join('；'))
  if (p.never.length) legacy.push('不会：' + p.never.slice(0, 2).join('；'))
  if (legacy.length) parts.push('── 旧画像（重学后消失） ──\n' + legacy.map((x) => '- ' + x).join('\n'))
  const joined = parts.filter((x) => x && x.trim()).join('\n')
  return joined.trim() ? joined : ''
}

/** 画像 → 「【从群友身上借来的说话方式】」段落。多个目标就拼多块。 */
export function renderStyleBlock (entries) {
  const parts = []
  for (const { name, profile } of entries || []) {
    const data = renderDistillData(profile)
    if (!data) continue
    const who = String(name || '那位群友').slice(0, 20)
    parts.push(`【语感·借自「${who}」】（说话方式以本段为准；性格与身份仍以底卡为准）\n${data}\n（只借说话方式，不借身份：我不是${who}，不自称他、不替他表态、不提他个人隐私。）`)
  }
  if (!parts.length) return ''
  return '\n\n' + '【从群友身上借来的说话方式】\n\n' + parts.join('\n\n') + '\n'
}

/**
 * 派生卡正文 = Base Persona（内核层） + 底卡正文 + 语感段（表现层）。
 * Base Persona 永远在最前（「违反即失败」的优先级语义）；底卡的重复规则被 Base Persona
 * 覆盖也无妨（语义一致）；语感段最后，只管怎么说。
 */
export function buildDerivedBody (baseBody, entries) {
  return BASE_PERSONA + '\n\n' + String(baseBody || '').trim() + renderStyleBlock(entries)
}

/**
 * 能不能接管这个群的人设槽位。
 * @returns {{takeover:boolean, baseId:string, currentId:string, reason:string}}
 */
export function takeoverDecision (cfg, gid, currentId) {
  const p = (cfg && cfg.persona) || {}
  const explicit = String((p.groups || {})[String(gid)] || '').trim()
  // 底卡选择（1.3.63 修正）：手动指定 > **current**（主人面板上真正选的人格）。
  // 之前用 personaIdFor 会落到 groupDefault——那往往是历史遗留的默认卡（如鲸鱼二代），
  // 主人的真实意图是「这个群没指定，就是用 current 那张」。
  const currentId2 = String((p && p.current) || '').trim()
  const baseId = explicit && explicit !== distillCardId(gid) ? explicit : (currentId2 || 'dafeiyu')
  // 主人明确指定过别人设（不是派生卡）→ 不抢；槽位空或已是派生卡 → 接管/更新
  if (explicit && explicit !== currentId && explicit !== distillCardId(gid)) {
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
