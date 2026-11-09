// 蒸馏群友流水线（L1→L2→L3）：纯逻辑层，模型调用与存储在 features/memory.js。
//
// 分层（依据主人给的三段子代理提示词规格，按插件实际适配）：
//   L1 原子特征：单目标累计 ~10 条新消息触发；语言/话题特征由 LLM 提取，
//      行为特征（时段/间隔/插话率）由**代码精确统计**（时间戳算得准、零 token），
//      LLM 只对统计结果做模式归纳，不猜时间。
//   L2 场景聚合：累计 5 批 L1 触发；输出 casual_chat / topic_discuss / gossip_interact 三场景模板。
//   L3 人格增长段：每日一次；输出第二人称指令式 persona_segment（core_character/speech_rules/
//      behavior_boundary），写进派生人设卡的增长区段——只调说话风格与行为倾向，
//      绝不修改基础身份与安全规则（与 1.3.65 派生卡的硬边界同源）。
//
// 三段提示词都按主人的规格：最小 token、结构化纯 JSON 输出、可被 parse* 直接入库。

const CAPS = {
  l1: { language: 8, behavior: 6, topic: 6 },
  l2: { scenes: 3, perScene: 5 },
  l3: { core: 300, rules: 500, boundary: 300 },
}

/** L1 触发判定：新增条数达标 + 距上次蒸馏 ≥ 最小间隔（防刷屏狂聊连续烧钱）。 */
export function shouldTriggerL1(progress, { threshold = 10, minGapMs = 3600_000, now = Date.now() } = {}) {
  const p = progress || {}
  if ((p.newCount || 0) < threshold) return false
  return now - (p.lastL1At || 0) >= minGapMs
}

/** L2 触发判定：累计 L1 批数达标且还没有未消费的 L2 产物。 */
export function shouldTriggerL2(progress, { batches = 5 } = {}) {
  const p = progress || {}
  return (p.batches?.length || 0) >= batches && (p.batchesSinceL2 || 0) >= batches
}

/**
 * 行为统计（纯代码，零 token）：从群流水里统计目标用户的行为节奏。
 * @param {Array<{t:number, uid:string, name?:string}>} lines 群聊流水（同群、按 t 升序或乱序均可）
 * @param {string} uid 目标
 * @returns {{activeHours:number[], medianIntervalMs:number, interjectRate:number, msgs:number}}
 *   activeHours：24 桶发言占比（0~1，已归一）；medianIntervalMs：本人相邻两条的中位间隔；
 *   interjectRate：60 秒内接话别人（前一条是别人）的比例。
 */
export function behaviorStats(lines, uid) {
  const want = String(uid || '')
  const mine = (lines || []).filter((l) => l && String(l.uid || '') === want && Number(l.t) > 0).sort((a, b) => a.t - b.t)
  if (!mine.length) return { activeHours: [], medianIntervalMs: 0, interjectRate: 0, msgs: 0 }
  const hours = new Array(24).fill(0)
  for (const m of mine) hours[new Date(m.t).getHours()]++
  const total = mine.length
  const activeHours = hours.map((n) => Math.round((n / total) * 100) / 100)
  const gaps = []
  let interject = 0
  let pairable = 0
  const byT = (lines || []).filter((l) => l && Number(l.t) > 0).sort((a, b) => a.t - b.t)
  const idxOf = new Map()
  byT.forEach((l, i) => idxOf.set(l, i))
  for (let i = 1; i < mine.length; i++) gaps.push(mine[i].t - mine[i - 1].t)
  for (const m of mine) {
    const i = idxOf.get(m)
    if (i > 0) {
      const prev = byT[i - 1]
      if (String(prev.uid || '') !== want) {
        pairable++
        if (m.t - prev.t <= 60_000) interject++
      }
    }
  }
  gaps.sort((a, b) => a - b)
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0
  return {
    activeHours,
    medianIntervalMs: median,
    interjectRate: pairable ? Math.round((interject / pairable) * 100) / 100 : 0,
    msgs: total,
  }
}

/** 行为统计 → 给 LLM 的一段中文摘要（它只做归纳，不猜数字）。 */
export function renderBehaviorDigest(stats) {
  if (!stats || !stats.msgs) return ''
  const top = stats.activeHours
    .map((v, h) => ({ h, v }))
    .sort((a, b) => b.v - a.v)
    .filter((x) => x.v > 0)
    .slice(0, 3)
    .map((x) => `${x.h} 点（${Math.round(x.v * 100)}%）`)
  const gapMin = stats.medianIntervalMs ? Math.round(stats.medianIntervalMs / 60000) : 0
  const parts = [
    top.length ? `活跃时段：${top.join('、')}` : '',
    gapMin ? `本人相邻发言中位间隔：约 ${gapMin} 分钟` : '',
    `接话率（60 秒内接别人的话）：${Math.round(stats.interjectRate * 100)}%`,
  ].filter(Boolean)
  return parts.join('；')
}

/** L1 提示词（主人的规格 + 插件的证据硬规矩）。 */
export function buildL1Prompt({ uid, batchId, messages = [], context = [], behaviorDigest = '' } = {}) {
  const said = (messages || []).slice(-20).map((m) => `- ${m}`).join('\n')
  const convo = (context || []).slice(-40).map((x) => (typeof x === 'string' ? x : `${x.name || ''}：${x.text}`)).join('\n')
  return {
    system: [
      '你是群聊特征蒸馏引擎，仅基于输入的原始消息做客观特征提取，禁止脑补、禁止主观评价、不输出任何无关内容。',
      '严格从原文提取两类特征，偶发内容不纳入：',
      '1. language_features：高频口头禅/语气词、句式偏好（短句/长句/反问/附和）、用词风格（口语/梗/黑话/书面）、标点断句习惯',
      '2. topic_features：高频参与的话题方向、明确回避的话题、擅长的输出类型',
      'behavior_features 由系统用时间戳精确统计好了（见输入末尾），你只把它归纳成 1~3 条稳定规律，不要自己估计数字。',
      '三条硬规矩：1) 每条都要能在原文里找到依据；2) 换成群里另一个人也成立的描述就删；3) 证据不足给空数组，不要编。',
      '只输出标准 JSON，无任何解释、前后缀：',
      '{"user_id":"' + String(uid) + '","batch_id":"' + String(batchId) + '","language_features":[],"behavior_features":[],"topic_features":[]}',
    ].join('\n'),
    text: [
      `目标用户ID：${String(uid)}`,
      `本批次消息ID：${String(batchId)}`,
      '他的原话：',
      said || '（无）',
      convo ? `\n群聊上下文（别人和他的交错，用来判断他在回应什么）：\n${convo}` : '',
      behaviorDigest ? `\n系统统计的行为数据（归纳成规律用，数字以这里为准）：${behaviorDigest}` : '',
    ].join('\n'),
  }
}

const pickList = (v, cap) => {
  const list = Array.isArray(v) ? v : v ? [v] : []
  const seen = new Set()
  const out = []
  for (const x of list) {
    const t = String(x == null ? '' : x).trim().slice(0, 90)
    if (!t || /^\d+$/.test(t) || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= cap) break
  }
  return out
}

/** 容忍 ```json 围栏/前后缀，取第一个 JSON 对象。 */
function parseJsonLoose(raw) {
  let t = String(raw == null ? '' : '').trim()
  t = String(raw ?? '').trim()
  if (!t) return null
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(t.slice(start, end + 1)) } catch { return null }
}

export function parseL1(raw, { uid, batchId } = {}) {
  const obj = parseJsonLoose(raw)
  if (!obj) return null
  return {
    user_id: String(obj.user_id ?? uid ?? ''),
    batch_id: String(obj.batch_id ?? batchId ?? ''),
    language_features: pickList(obj.language_features, CAPS.l1.language),
    behavior_features: pickList(obj.behavior_features, CAPS.l1.behavior),
    topic_features: pickList(obj.topic_features, CAPS.l1.topic),
    at: Date.now(),
  }
}

/** L2 提示词：把 L1 批次聚合成三场景行为模板。 */
export function buildL2Prompt({ uid, l1List = [], behaviorDigest = '' } = {}) {
  const features = (l1List || []).map((b, i) => `【第${i + 1}批】语言：${(b.language_features || []).join('；') || '（无）'}\n话题：${(b.topic_features || []).join('；') || '（无）'}\n行为：${(b.behavior_features || []).join('；') || '（无）'}`).join('\n\n')
  return {
    system: [
      '你是群聊场景聚合引擎，负责把原子特征按群聊场景归类，提炼稳定的场景化行为模式。',
      '按三类核心群聊场景拆分：casual_chat（闲聊水群：日常扯淡、接梗、碎片化互动）、',
      'topic_discuss（话题讨论：针对具体事件/问题的观点交流）、gossip_interact（互动调侃：吃瓜、调侃、跟风互动）。',
      '每个场景提炼：length（发言长度偏好）、tone（语气倾向）、participation（参与概率倾向，如「很高/看话题/很少」）、phrases（常用话术类型，数组）。',
      '只保留重复出现的稳定特征，单次偶发不纳入；证据不足的场景给空对象。',
      '只输出标准 JSON，无任何多余文本：',
      '{"user_id":"' + String(uid) + '","scene_templates":{"casual_chat":{},"topic_discuss":{},"gossip_interact":{}}}',
    ].join('\n'),
    text: [
      `目标用户ID：${String(uid)}`,
      '历史 L1 原子特征集合：',
      features || '（无）',
      behaviorDigest ? `\n系统统计的行为数据：${behaviorDigest}` : '',
    ].join('\n'),
  }
}

const normScene = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const out = {
    length: String(v.length ?? '').trim().slice(0, 60),
    tone: String(v.tone ?? '').trim().slice(0, 60),
    participation: String(v.participation ?? '').trim().slice(0, 40),
    phrases: pickList(v.phrases, CAPS.l2.perScene),
  }
  return (out.length || out.tone || out.participation || out.phrases.length) ? out : null
}

export function parseL2(raw, { uid } = {}) {
  const obj = parseJsonLoose(raw)
  if (!obj) return null
  const st = obj.scene_templates && typeof obj.scene_templates === 'object' ? obj.scene_templates : {}
  return {
    user_id: String(obj.user_id ?? uid ?? ''),
    scene_templates: {
      casual_chat: normScene(st.casual_chat),
      topic_discuss: normScene(st.topic_discuss),
      gossip_interact: normScene(st.gossip_interact),
    },
    at: Date.now(),
  }
}

/** L3 提示词：L2 模板 → 第二人称人格增长段（不碰身份与安全规则）。 */
export function buildL3Prompt({ uid, oldSegment, sceneTemplates, behaviorDigest = '' } = {}) {
  const scenes = sceneTemplates || {}
  const sceneText = ['casual_chat', 'topic_discuss', 'gossip_interact']
    .map((k) => `${k}：${scenes[k] ? JSON.stringify(scenes[k]) : '（无）'}`).join('\n')
  return {
    system: [
      '你是群友人格蒸馏引擎，负责把行为特征转化为 Agent 可直接调用的人格约束片段。',
      '只调整说话风格与行为逻辑，绝不修改基础身份与安全规则；绝不输出让 Agent 声称自己是被学的那个人。',
      '用第二人称指令式表述（「你在群里……」），可直接注入 Agent 的系统提示。',
      '拆成三个模块：core_character（核心性格，可观察行为，不写空形容词）、',
      'speech_rules（说话规则：语气/句长/口头禅使用语境/禁用书面腔）、behavior_boundary（行为边界：什么话题参与、什么情况潜水、什么时候主动搭话）。',
      '仅保留重复出现的稳定特征，单次偶发行为不纳入；自动过滤违规、隐私、人身攻击类内容。',
      '只输出标准 JSON，无任何多余文本：',
      '{"user_id":"' + String(uid) + '","persona_segment":{"core_character":"","speech_rules":"","behavior_boundary":""},"update_note":""}',
    ].join('\n'),
    text: [
      `目标用户ID：${String(uid)}`,
      oldSegment ? `现有历史人格段（增量更新，仍成立的保留、被推翻的丢掉）：\n${JSON.stringify(oldSegment)}` : '现有历史人格段：首次生成',
      `\n最新场景行为模板：\n${sceneText}`,
      behaviorDigest ? `\n系统统计的行为数据：${behaviorDigest}` : '',
    ].join('\n'),
  }
}

export function parseL3(raw, { uid } = {}) {
  const obj = parseJsonLoose(raw)
  if (!obj) return null
  const seg = obj.persona_segment && typeof obj.persona_segment === 'object' ? obj.persona_segment : {}
  const core = String(seg.core_character ?? '').trim().slice(0, CAPS.l3.core)
  const rules = String(seg.speech_rules ?? '').trim().slice(0, CAPS.l3.rules)
  const boundary = String(seg.behavior_boundary ?? '').trim().slice(0, CAPS.l3.boundary)
  if (!core && !rules && !boundary) return null
  return {
    user_id: String(obj.user_id ?? uid ?? ''),
    persona_segment: { core_character: core, speech_rules: rules, behavior_boundary: boundary },
    update_note: String(obj.update_note ?? '').trim().slice(0, 200),
    at: Date.now(),
  }
}

/** L3 段落 → 派生人设卡的增长区段文本（第二人称指令式 + 边界声明）。 */
export function renderGrowthSegment(uid, seg) {
  if (!seg) return ''
  const s = seg.persona_segment || seg
  const blocks = []
  if (s.core_character) blocks.push('性格基调：' + s.core_character)
  if (s.speech_rules) blocks.push('说话规则：' + s.speech_rules)
  if (s.behavior_boundary) blocks.push('行为边界：' + s.behavior_boundary)
  if (!blocks.length) return ''
  const who = String(uid || '').slice(0, 20)
  return `【从群友身上蒸馏的人格增长段（学「${who}」的说话方式与节奏）】\n${blocks.join('\n')}\n（此段只调说话风格与行为倾向：不改变你的身份、记忆与安全规则；你不是${who}本人，别自称他、别替他表态、不提他的隐私。）`
}
