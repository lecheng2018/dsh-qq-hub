// 蒸馏群友 v2（评分制蒸馏架构）测试：
// 三段流水线（Extract→Verify→Reflect）、v2 条目 {text, evidence, score, firstSeen, lastSeen}、
// 评分制合并（复现确认/衰减淘汰/score 排序）、渲染唯一出口 renderProfile（hint/card 双模式）。
// 旧 v1 字符串数组画像必须能被自动升级 + 兼容渲染。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectMemberLines, enoughEvidence, buildDistillPrompt, buildExtractPrompt, buildVerifyPrompt,
  parseDistillProfile, parseExtracted, applyVerdicts, parseReflections, buildReflectPrompt,
  normalizeProfile, mergeProfile, isSimilar, renderDistillHint, renderProfile, dedupConvo, SCORE,
} from '../src/features/distill.js'

const L = (uid, text, t = 0) => ({ uid, text, t, who: 'u' + uid })
const NOW = 1700000000000

test('证据清洗：复读转发只算一句，纯分享卡片/链接不算话', () => {
  const lines = [
    L('1', '[分享卡片：576k5YWs5ZGK]', 1),
    L('1', '兄弟们，刚挖到俩羊毛', 2),
    L('1', '[分享卡片：576k5YWs5ZGK]', 3),
    L('1', '兄弟们，刚挖到俩羊毛', 4),
    L('1', 'https://example.com/x', 5),
    L('2', '收到', 6),
  ]
  const out = collectMemberLines(lines, '1')
  assert.deepEqual(out.map((x) => x.text), ['兄弟们，刚挖到俩羊毛'], '同文去重 + 卡片/纯链接过滤')
  assert.equal(out[0].t, 2, '留最早一次的时间')
})

test('从群流水里只捞目标那个人的话，按时间正序', () => {
  const lines = [L('9', '晚点', 3), L('111', '草', 2), L('222', '哈哈哈', 1), L('111', '上号', 4)]
  assert.deepEqual(collectMemberLines(lines, '111').map((x) => x.text), ['草', '上号'])
  assert.deepEqual(collectMemberLines(lines, '999'), [], '没说过话就是空')
  assert.deepEqual(collectMemberLines(lines, ''), [], '没给 uid 不捞')
})

test('证据不足不学：门槛默认 20 句 / 120 字', () => {
  assert.equal(enoughEvidence([L('1', 'a'), L('1', 'b')]), false)
  const twenty = Array.from({ length: 20 }, (_, i) => L('1', '这是一句正常长度的话' + i))
  assert.equal(enoughEvidence(twenty), true, '20 句才够')
  const twentyShort = Array.from({ length: 20 }, () => L('1', '嗯'))
  assert.equal(enoughEvidence(twentyShort), false, '20 句但都是「嗯」，字数不够')
  assert.equal(enoughEvidence(twentyShort.slice(0, 15), { minMessages: 15 }), false)
})

test('对话上下文去重：同 (uid,text) 三次以上视为会话重复注入，只留两次', () => {
  const rep = { uid: '1', text: '同一段上下文被连发' }
  const out = dedupConvo([rep, { uid: '2', text: 'b' }, { ...rep }, { ...rep }, { uid: '2', text: 'b' }])
  assert.equal(out.filter((x) => x.uid === '1').length, 2, '允许复读梗两次')
  assert.equal(out.filter((x) => x.uid === '2').length, 2)
})

test('v2 条目归一：字符串自动升级、纯数字丢弃、score 夹取 0~1', () => {
  const p = normalizeProfile({ syntax: ['  句子短 ', '句子短', '44', { text: '爱用逗号', score: 2, evidence: ['原话A'] }], persona: '' }, { now: NOW })
  assert.equal(p.syntax.length, 2, '同文去重、纯数字丢')
  assert.deepEqual(p.syntax[0], { text: '句子短', evidence: [], score: 0.6, firstSeen: NOW, lastSeen: NOW }, 'v1 字符串升级为 v2 条目（无证据标 0.6）')
  assert.equal(p.syntax[1].score, 1, '超界分数夹取')
  assert.deepEqual(p.syntax[1].evidence, ['原话A'])
  assert.deepEqual(p.persona, [])
})

test('语义近似：同义不同文的口头禅判相近，无关条目不相近', () => {
  assert.equal(isSimilar('斩（随口催办时）', '斩（随口催办时用）'), true, '高度重叠的变体判近')
  assert.equal(isSimilar('喜欢说斩（催办时）', '从不喊斩（催办时）'), false, '0.36 的弱重叠不算近似——从严防误合')
  assert.equal(isSimilar('句子极短，从不长篇大论', '从来不说谢谢'), false)
  assert.equal(isSimilar('', 'x'), false)
  assert.equal(isSimilar('上号了吗兄弟们', '上号了吗兄弟们'), true, '全等直接判近')
})

test('解析模型回包：认 ```json 围栏与外层解释；坏数据返回 null', () => {
  const ok = parseDistillProfile('```json\n{"syntax":["句子极短"]}\n```')
  assert.deepEqual(ok.syntax, ['句子极短'])
  const wrapped = parseDistillProfile('好的，结果如下：{"never":[]} 以上。')
  assert.deepEqual(wrapped.never, [])
  assert.equal(parseDistillProfile('我不知道'), null)
  assert.equal(parseDistillProfile(''), null)
})

test('Extract 解析：带 evidence 的条目收成 v2；没证据的条目直接丢弃（exchanges 豁免）', () => {
  const r = parseExtracted({
    syntax: [
      { text: '长句靠逗号串', evidence: ['草 这也能崩，笑死'] },
      { text: '没证据的条目' },
      '纯字符串也没证据',
    ],
    exchanges: [{ text: '问：「咋弄」\n答：「重启」' }],
    persona: [],
  }, { now: NOW })
  assert.equal(r.ok, true)
  assert.deepEqual(r.fields.syntax.map((e) => e.text), ['长句靠逗号串'], '无证据引用的条目丢弃')
  assert.deepEqual(r.fields.exchanges.map((e) => e.text), ['问：「咋弄」\n答：「重启」'], 'exchanges 本身是逐字引用形态，豁免')
  const bad = parseExtracted('我不知道', { now: NOW })
  assert.equal(bad.ok, false)
  const empty = parseExtracted({ syntax: [{ text: '全是没证据的' }] }, { now: NOW })
  assert.equal(empty.ok, false, '全部缺证据 = 判空画像')
})

test('Verify 应用：裁判分数写回、漏判从严 0.4 淘汰、低分淘汰', () => {
  const ex = parseExtracted({
    syntax: [{ text: 'A条', evidence: ['x'] }, { text: 'B条', evidence: ['y'] }, { text: 'C条', evidence: ['z'] }],
  }, { now: NOW }).fields
  const r = applyVerdicts(ex, { verdicts: [
    { text: 'A条', score: 1.0 }, // 保留
    { text: 'B条', score: 0.3 }, // 判死
    // C条漏判 → 0.4 淘汰
  ] })
  assert.deepEqual(r.fields.syntax.map((e) => e.text), ['A条'])
  assert.equal(r.fields.syntax[0].score, 1)
  const all = applyVerdicts(ex, { verdicts: [{ text: 'A条', score: 0.1 }, { text: 'B条', score: 0.2 }, { text: 'C条', score: 0.2 }] })
  assert.equal(all.ok, false, '全部淘汰')
})

test('评分制合并：复现确认加分、新条目入库、判死条目不进、score 降序截断', () => {
  const oldP = { syntax: [{ text: '长句靠逗号串', score: 0.7, evidence: ['旧证据'], firstSeen: NOW - 86400000, lastSeen: NOW - 86400000 }] }
  const incoming = {
    syntax: [
      { text: '长句靠逗号串，不分点', score: 0.9, evidence: ['新证据'], t: NOW }, // 近似旧条 → 确认
      { text: '全新条目', score: 0.7, t: NOW },
      { text: '被判死的条目', score: 0.2, t: NOW },
    ],
  }
  const m = mergeProfile(oldP, incoming, { now: NOW })
  assert.equal(m.syntax.length, 2)
  const confirmed = m.syntax.find((e) => e.text === '长句靠逗号串')
  assert.equal(confirmed.score, 0.9, '0.7 + CONFIRM_BONUS(0.2) 封顶 1.0 → 0.9')
  assert.equal(confirmed.lastSeen, NOW, 'lastSeen 刷新')
  assert.deepEqual(confirmed.evidence, ['旧证据'], '旧条已有证据不覆盖')
  assert.ok(m.syntax[0].score >= m.syntax[1].score, '按 score 降序')
  assert.equal(m.syntax.some((e) => e.text === '被判死的条目'), false)
  // v1 字符串数组直接喂进来也能合并（存量兼容）
  const legacy = mergeProfile({ catchphrases: ['斩（催办时）'] }, { catchphrases: [{ text: '我瞅瞅（答应看一眼）', score: 0.8, t: NOW }] }, { now: NOW })
  assert.equal(legacy.catchphrases.length, 2)
})

test('衰减淘汰：超过 FRESH_DAYS 没复现且分低 → 淘汰；分高或近期都在', () => {
  const stale = NOW - (SCORE.FRESH_DAYS + 5) * 86400000
  const m = mergeProfile(
    { persona: [
      { text: '过期低分', score: 0.5, lastSeen: stale },
      { text: '过期高分', score: 0.9, lastSeen: stale },
      { text: '近期低分', score: 0.5, lastSeen: NOW },
    ] },
    { persona: [] }, { now: NOW },
  )
  assert.deepEqual(m.persona.map((e) => e.text), ['过期高分', '近期低分'])
})

test('Verify 后合并入口：分数传递、无分数数据（verified:false）不按校验线过滤', () => {
  const m = mergeProfile({}, { syntax: [{ text: '没过校验的', score: 0.4 }] }, { now: NOW, verified: false })
  assert.equal(m.syntax.length, 1, 'verified:false 时不做校验线过滤（存量迁移路径）')
})

test('注入渲染 hint 模式：对话对最优先、字段齐备、边界收尾', () => {
  const hint = renderDistillHint('老王', {
    exchanges: [{ text: '问：「这个怎么弄」\n答：「你先重启试试」', score: 1 }],
    catchphrases: [{ text: '斩（催办时）', score: 0.9 }],
    syntax: [{ text: '长句靠逗号串', score: 0.8 }],
    rhetoric: [{ text: '被封号就自嘲', score: 0.7 }],
    never: [{ text: '从不说感谢', score: 0.9 }],
    persona: [{ text: '热心答疑', score: 0.8 }],
  })
  assert.match(hint, /他怎么接话（学的是应对方式，内容绝不照搬）/, '对话对是最强信号，放最前')
  assert.match(hint, /口头禅：斩（催办时）/, '口头禅带语境')
  assert.match(hint, /句子：长句靠逗号串/)
  assert.match(hint, /招式：被封号就自嘲/)
  assert.match(hint, /他从不：从不说感谢/)
  assert.match(hint, /他是这样的人：热心答疑/)
  assert.match(hint, /群友语感参照「老王」——在这个群里回话时照着他的接法来/)
  assert.match(hint, /只借说话的方式，不借身份：你不是老王本人，别自称他、别替他表态/)
})

test('注入渲染 card 模式：第一人称措辞 + 边界随段走（供人设卡借用段用）', () => {
  const block = renderProfile({
    exchanges: [{ text: '问：「号封了吗」\n答：「空了好几天」', score: 1 }],
    catchphrases: [{ text: '斩（随口催办时）', score: 0.9 }],
    never: [{ text: '从不说感谢', score: 0.9 }],
    persona: [{ text: '热心答疑，谁问都回', score: 0.8 }],
  }, { mode: 'card', name: '炙心' })
  assert.match(block, /【语感·借自「炙心」】/)
  assert.match(block, /我在这个群接话就照着他的应对方式来/)
  assert.match(block, /我不用他绝不会用的东西：|他不会：/)
  assert.match(block, /我借他神韵的地方：热心答疑，谁问都回/)
  assert.match(block, /只借说话方式，不借身份：我不是炙心/)
  assert.equal(renderProfile({}, { mode: 'card', name: '炙心' }), '', '空画像不出段')
})

test('旧画像字段（style/samples/avoid 存量）兼容渲染，不至于白学', () => {
  const legacy = renderDistillHint('老王', { style: ['句子极短'], samples: ['就这？'], avoid: ['不长篇'], persona: [], tone: [] })
  assert.match(legacy, /他的原话（校准节奏用，绝不照抄内容）：「就这？」/)
  assert.match(legacy, /旧特征：句子极短/)
  assert.match(legacy, /他不会：不长篇/)
  assert.equal(renderDistillHint('老王', {}), '', '空画像不注入')
  // 回归：句数数字不能当原话
  assert.doesNotMatch(renderDistillHint('老王', { style: ['短句'], samples: 44 }), /「44」/)
})

test('提示词（Extract）：exchanges 首要、口头禅带「什么时候用」、never 词表、性格写可观察行为、证据硬约束', () => {
  const p = buildExtractPrompt({
    name: '老王', uid: '111',
    memberLines: [L('111', '草 这也能崩')],
    context: [{ uid: '222', name: '小李', text: '这游戏又崩了？' }, { uid: '111', name: '老王', text: '草 这也能崩' }],
    others: ['小李：请问这个怎么弄呀'],
  })
  assert.match(p.system, /exchanges（最重要）/, '对话对是首要产出')
  assert.match(p.system, /evidence/, '证据引用是硬约束')
  assert.match(p.system, /什么时候用/, '口头禅带语境')
  assert.match(p.system, /never（从不用）|never：/, '负向词表')
  assert.match(p.system, /可观察行为/, '性格写行为不写标签')
  assert.match(p.system, /换成群里另一个人/, 'misreading 自检')
  assert.match(p.text, /群聊原文（他的回答标了「他：」）/, '交错原文进 prompt')
  assert.match(p.text, /小李：这游戏又崩了？\n他：草 这也能崩/, '按 uid 标「他：」')
  // v1 兼容别名：buildDistillPrompt === buildExtractPrompt
  assert.equal(buildDistillPrompt, buildExtractPrompt)
})

test('提示词（Verify）：裁判视角、打分标准、漏判从严、baseBody duplicate 检查', () => {
  const p = buildVerifyPrompt({
    name: '老王',
    memberLines: [L('111', '草 这也能崩')],
    extracted: { syntax: [{ text: '长句靠逗号串', evidence: ['草 这也能崩'] }] },
    old: { catchphrases: ['斩（催办时）'] },
    baseBody: '你是大肥鱼。说话简短。',
  })
  assert.match(p.system, /审核员/, '裁判视角')
  assert.match(p.system, /verdicts/, '逐条判')
  assert.match(p.system, /0\.55|从严/, '过线值与从严原则')
  assert.match(p.text, /草 这也能崩/, '原话供核对 evidence')
  assert.match(p.text, /特征候选/, '候选进 prompt')
  assert.match(p.text, /斩（催办时）/, '旧画像进 prompt 供冲突判断')
  assert.match(p.text, /她的人设卡正文/, 'baseBody 进 prompt 供 duplicate 判断')
})

test('提示词（Reflect）：高阶概括约束、不引入新设定', () => {
  const p = buildReflectPrompt({ name: '老王', profile: { catchphrases: ['斩（催办时）'], persona: ['被封号就自嘲'] } })
  assert.match(p.system, /更高一层|概括/, '反思定位')
  assert.match(p.system, /不引入新设定/, '必须有已有条目支撑')
  assert.match(p.text, /斩（催办时）/, '已有特征进 prompt')
  const r = parseReflections({ reflections: ['骂人不带脏字，用反问代替攻击'] }, { now: NOW })
  assert.equal(r.length, 1)
  assert.equal(r[0].score, SCORE.NEW, '反思条目按新条目分入库')
})

// ---------------- 存储与接线 ----------------
async function freshStore() {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'distill-'))
  const { createMemoryStore } = await import('../src/features/memory.js')
  const { normalize } = await import('../src/core/config.js')
  const cfg = normalize({ ownerQQ: '10000001', memory: { enabled: true } })
  return createMemoryStore({ dsh: {}, getConfig: () => cfg, hub: { chatLogOf: () => [], chatLogDays: () => [] }, log: () => {}, personaText: () => '' })
}

test('目标管理：加/去重/删（删的时候连带清掉画像）', async () => {
  const mem = await freshStore()
  assert.equal(mem.addDistillTarget({ gid: '123', uid: '456', name: '老王' }).ok, true)
  assert.equal(mem.addDistillTarget({ gid: '123', uid: '456' }).ok, false, '同一个不能重复加')
  assert.equal(mem.addDistillTarget({ gid: '', uid: '456' }).ok, false, '缺群号')
  assert.deepEqual(mem.distillTargets().map((t) => t.uid), ['456'])
  assert.equal(mem.removeDistillTarget('123', '456').ok, true)
  assert.deepEqual(mem.distillTargets(), [])
})

test('画像落库：v2 条目带分数保存；复现确认走评分制；旧 v1 字符串存量自动升级', async () => {
  const mem = await freshStore()
  mem.addDistillTarget({ gid: '123', uid: '456', name: '老王' })
  // 首学：Extract+Verify 通过的 v2 条目
  mem.putDistill('123', '456', { syntax: [{ text: '句子短', score: 0.9, evidence: ['哦'] }], exchanges: [{ text: '问：「咋弄」\n答：「重启」', score: 1 }] }, 12)
  let p = mem.distillOf('123', '456')
  assert.deepEqual(p.syntax.map((e) => e.text), ['句子短'])
  assert.equal(p.syntax[0].score, 0.9, '分数原样保存')
  assert.equal(p.evidenceCount, 12)
  assert.ok(p.updatedAt > 0)
  // 复学：近似条目 → 确认加分；新条目入库
  mem.putDistill('123', '456', { syntax: [{ text: '句子短（确证）', score: 1 }], persona: [{ text: '脾气急', score: 0.8 }] }, 20)
  p = mem.distillOf('123', '456')
  assert.equal(p.syntax.length, 1, '近似条目不重复占位')
  assert.equal(p.syntax[0].score, 1, '复现确认加分封顶')
  assert.equal(p.evidenceCount, 20, '证据条数取较大值')
  assert.equal(p.persona[0].text, '脾气急')
  // 旧 v1 字符串画像（存量）直接落库也能升级
  mem.putDistill('123', '456', { style: ['短句'] }, 5)
  p = mem.distillOf('123', '456')
  assert.equal(p.style[0].text, '短句', 'v1 字符串升级为 v2 条目')
  assert.ok(p.style[0].score >= 0.5, '存量条目给中性分')
})

test('旧坏数据自愈：samples 是句数（如 44）的存量画像，渲染与合并都不把它当原话', async () => {
  const broken = { style: ['短句'], persona: [], tone: [], samples: 44, updatedAt: 1 }
  const hint = renderDistillHint('老王', broken)
  assert.doesNotMatch(hint, /「44」/, '数字不能被渲染成原话')
  assert.match(hint, /短句/, '特征照常注入')
  const merged = mergeProfile(broken, { samples: [{ text: '真的服了', score: 0.9 }] })
  assert.deepEqual(merged.samples.map((e) => e.text), ['真的服了'])
  const mem = await freshStore()
  mem.addDistillTarget({ gid: '123', uid: '456', name: '老王' })
  mem.putDistill('123', '456', { style: ['短句'], samples: 44 }, 0)
  mem.putDistill('123', '456', { samples: [{ text: '行吧', score: 0.9 }] }, 0)
  assert.equal(mem.distillOf('123', '456').evidenceCount, 44, '旧的数字 samples 被认作证据条数')
})

test('接线：整理时学、群聊时注入、面板与接口都在', () => {
  const mem = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  assert.match(mem, /await learnDistill\(day\)/, 'consolidate 里跑')
  assert.match(mem, /cfg\.memory\?\.distill === false\) return/, '开关可关')
  assert.match(mem, /renderProfile\(|renderDistillHint\(/, '群聊注入画像（v2 渲染出口）')
  assert.match(mem, /distillLearned/, '学过就记账，重启不重复花钱')
  assert.match(mem, /dedupConvo\(hist\.lines\)\.slice\(-80\)/, '历史学习传去重对话原文')
  assert.match(mem, /reasoningEffort: 'none'/, '蒸馏调用关思考（推理模型会吃掉全部预算不回正文）')
  const mod = readFileSync(new URL('../src/modules/memory/index.js', import.meta.url), 'utf8')
  assert.match(mod, /api\.route\('\/distill\/list'/)
  assert.match(mod, /api\.route\('\/distill\/card\/refresh'/)
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /function DistillPanel/, '面板有独立组件')
  assert.match(client, /蒸馏群友（学一个人的说话样子）/, '独立卡片')
})
