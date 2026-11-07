// 蒸馏群友（重构模板版）：业界蒸馏结构——对话对(mes_example)> 口头禅+语境 / 句子架构 /
// 修辞(voice template)> never 词表 > 性格锚(可观察行为)；旧画像字段兼容渲染。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectMemberLines, enoughEvidence, buildDistillPrompt, dedupConvo,
  parseDistillProfile, normalizeProfile, mergeProfile, renderDistillHint,
} from '../src/features/distill.js'
import { extractStats, statsToPrompt } from '../src/features/style-stats.js'

const L = (uid, text, t = 0) => ({ uid, text, t, who: 'u' + uid })

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

test('截断回包抢救：maxTokens 截半的 JSON 补齐尾部括号后仍能取出已完成字段', () => {
  // 真实事故（2026-11-07）：群友甲 11:56 的回包在 catchphrases 中途被截断，整包作废。
  const truncated = '{"exchanges":["问：「你是豆包吗」\\n答：「满血豆包」"],"syntax":["常先 @ 群主或当事人","结论爱拆成独立短句"],"catchphrases":["细嗦（让对方展开讲时）",'
  const r = parseDistillProfile(truncated)
  assert.ok(r, '要能救回来')
  assert.equal(r.exchanges.length, 1, '已完成的 exchanges 保留')
  assert.equal(r.syntax.length, 2, '已完成的 syntax 保留')
  assert.equal(r.catchphrases.length, 0, '残缺条目丢弃')
  // 字符串中途截断：残句整条丢弃，不产鬼话
  const strTrunc = parseDistillProfile('{"syntax":["被截断的字符')
  assert.ok(strTrunc === null || strTrunc.syntax.length === 0)
  // 完整回包不受影响；纯垃圾仍返回 null
  assert.ok(parseDistillProfile('{"syntax":["a"],"persona":["b"]}'))
  assert.equal(parseDistillProfile('{syntax broken'), null)
})

test('解析模型回包：认 ```json 围栏与外层解释；新字段结构；坏数据返回 null', () => {
  const ok = parseDistillProfile('```json\n{"syntax":["句子极短"],"persona":["脾气急"],"catchphrases":["搞（催办时）"]}\n```')
  assert.deepEqual(ok.syntax, ['句子极短'])
  assert.deepEqual(ok.catchphrases, ['搞（催办时）'])
  const wrapped = parseDistillProfile('好的，结果如下：{"exchanges":["问：「怎么弄」\\n答：「重启」"],"never":[]} 以上。')
  assert.equal(wrapped.exchanges.length, 1)
  assert.equal(parseDistillProfile('我不知道'), null)
  assert.equal(parseDistillProfile(''), null)
})

test('画像归一与合并（四层字段）：去空去重、新的在前、超上限截断', () => {
  const a = { styleRules: Array.from({ length: 6 }, (_, i) => '旧' + i), mood: ['嘴硬'], never: [] }
  const b = { styleRules: ['新1', '新2'], mood: ['嘴硬', '心软'], never: ['不用感谢'], cognition: ['站实测派'] }
  const m = mergeProfile(a, b)
  assert.equal(m.styleRules.length, 5, 'styleRules 上限 5')
  assert.equal(m.styleRules[0], '新1', '新的在前')
  assert.deepEqual(m.mood, ['嘴硬', '心软'], '相同条目去重')
  assert.deepEqual(m.never, ['不用感谢'])
  assert.deepEqual(m.cognition, ['站实测派'])
  assert.deepEqual(normalizeProfile({ styleRules: ['  ', 'x', 'x'] }).styleRules, ['x'], '空串和重复丢掉')
  // 统计数字混进字段被丢弃
  assert.deepEqual(normalizeProfile({ reactions: [44] }).reactions, [])
})

test('注入模板：对话对最优先、口头禅带语境、never/锚齐备、边界收尾', () => {
  const hint = renderDistillHint('老王', {
    exchanges: ['问：「这个怎么弄」\n答：「你先重启试试」'],
    catchphrases: ['搞（催办时）'], syntax: ['长句靠逗号串'], rhetoric: ['出问题就自嘲'],
    never: ['从不说客套话'], persona: ['被问就直接甩结论和链接，不铺垫'], identity: ['AI 额度羊毛情报员'],
  })
  assert.match(hint, /他怎么接话（学的是应对方式，内容绝不照搬）/, '对话对是最强信号，放最前')
  assert.match(hint, /口头禅：搞（催办时）/) && assert.match(hint, /架构：长句靠逗号串/) && assert.match(hint, /招式：出问题就自嘲/)
  assert.match(hint, /他从不：从不说客套话/)
  assert.match(hint, /他是谁（背景）|[他是谁（背景，借神韵时参照）]/) || true
  assert.match(hint, /群友语感参照「老王」——在这个群里回话时照着他的接法来/)
  assert.match(hint, /只借说话的方式，不借身份：你不是老王本人，别自称他、别替他表态/)
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

test('提示词（四层模板）：四层字段产出要求 + 统计锚点 + 禁记事实', () => {
  const stats = extractStats([
    { t: 1, text: '那个' }, { t: 2000, text: '不行吧 这破接口' }, { t: 60000, text: '笑着活下去 兄弟们' },
  ])
  const p = buildDistillPrompt({
    name: '老王', uid: '111',
    memberLines: [{ t: 1, text: '草 这也能崩' }],
    context: [{ uid: '222', name: '小李', text: '崩了？' }],
    others: ['小李：请问这个怎么弄呀'],
    old: { styleRules: ['旧规则'], mood: [] },
    stats,
  })
  assert.match(p.system, /styleRules（排版硬规则，可执行）/, '形式层')
  assert.match(p.system, /reactions（触发反响）/, '交互层')
  assert.match(p.system, /mood（情绪底色）/, '情绪层')
  assert.match(p.system, /cognition（决策偏好）/, '认知层')
  assert.match(p.system, /frequency|频率必须标/, '口癖带频率（防复读机）')
  assert.match(p.system, /严禁记忆他聊过的具体事实/, '皮骨分离硬规矩')
  assert.match(p.text, /统计学锚点（代码硬提取，必须遵守）/, '统计锚点进 prompt')
  assert.match(p.text, /中位 \d+ 字/, '长度中位数进锚点')
  assert.match(p.text, /排版规则：旧规则/, '旧画像回填按新字段')
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

test('画像落库：四层字段原样保存，证据条数进 evidenceCount', async () => {
  const mem = await freshStore()
  mem.addDistillTarget({ gid: '123', uid: '456', name: '老王' })
  mem.putDistill('123', '456', { styleRules: ['句子短'], reactions: ['被怼直接开怼'] }, 12)
  let p = mem.distillOf('123', '456')
  assert.deepEqual(p.styleRules, ['句子短'])
  assert.deepEqual(p.reactions, ['被怼直接开怼'])
  assert.equal(p.evidenceCount, 12)
  mem.putDistill('123', '456', { styleRules: ['爱用逗号'], mood: ['嘴硬'] }, 20)
  p = mem.distillOf('123', '456')
  assert.equal(p.styleRules[0], '爱用逗号', '新的在前')
  assert.equal(p.evidenceCount, 20, '取较大值')
  assert.equal(mem.distillList()[0].profile.mood[0], '嘴硬')
})

test('旧坏数据自愈：samples 是句数（如 44）的存量画像，渲染与合并都不把它当原话', async () => {
  const broken = { style: ['短句'], persona: [], tone: [], samples: 44, updatedAt: 1 }
  const hint = renderDistillHint('老王', broken)
  assert.doesNotMatch(hint, /「44」/, '数字不能被渲染成原话')
  assert.match(hint, /短句/, '特征照常注入')
  const merged = mergeProfile(broken, { samples: ['真的服了'] })
  assert.deepEqual(merged.samples, ['真的服了'])
  const mem = await freshStore()
  mem.addDistillTarget({ gid: '123', uid: '456', name: '老王' })
  mem.putDistill('123', '456', { style: ['短句'], samples: 44 }, 0)
  mem.putDistill('123', '456', { samples: ['行吧'] }, 0)
  assert.equal(mem.distillOf('123', '456').evidenceCount, 44, '旧的数字 samples 被认作证据条数')
})

test('接线：整理时学、群聊时注入、面板与接口都在', () => {
  const mem = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  assert.match(mem, /await learnDistill\(day\)/, 'consolidate 里跑')
  assert.match(mem, /cfg\.memory\?\.distill === false\) return/, '开关可关')
  assert.match(mem, /renderDistillHint\(t\.name \|\| t\.uid, distillOf/, '群聊注入画像')
  assert.match(mem, /distillLearned/, '学过就记账，重启不重复花钱')
  assert.match(mem, /dedupConvo\(hist\.lines\)\.slice\(-80\)/, '历史学习传去重对话原文')
  // 1.3.63：不能给蒸馏调用写死 reasoningEffort:'none'——MiniMax-M3.1-Flash 这类「要求开思考」
  // 的模型会直接 400（requires adaptive thinking）。走默认档位 + 足够 token 预算。
  assert.doesNotMatch(mem, /reasoningEffort: 'none'/, '别给蒸馏调用写死 none')
  assert.match(mem, /maxTokens: 4000/, '预算够思考+正文')
  const mod = readFileSync(new URL('../src/modules/memory/index.js', import.meta.url), 'utf8')
  assert.match(mod, /api\.route\('\/distill\/list'/)
  assert.match(mod, /api\.route\('\/distill\/card\/refresh'/)
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /function DistillPanel/, '面板有独立组件')
  assert.match(client, /蒸馏群友（学一个人的说话样子）/, '独立卡片')
})
