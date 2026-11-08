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

test('解析模型回包：认 ```json 围栏与外层解释；新字段结构；坏数据返回 null', () => {
  const ok = parseDistillProfile('```json\n{"syntax":["句子极短"],"persona":["脾气急"],"catchphrases":["斩（催办时）"]}\n```')
  assert.deepEqual(ok.syntax, ['句子极短'])
  assert.deepEqual(ok.catchphrases, ['斩（催办时）'])
  const wrapped = parseDistillProfile('好的，结果如下：{"exchanges":["问：「怎么弄」\\n答：「重启」"],"never":[]} 以上。')
  assert.equal(wrapped.exchanges.length, 1)
  assert.equal(parseDistillProfile('我不知道'), null)
  assert.equal(parseDistillProfile(''), null)
})

test('画像归一与合并：新字段集，去空去重、新的在前、超上限截断', () => {
  const a = { syntax: Array.from({ length: 4 }, (_, i) => '旧' + i), persona: ['脾气急'], never: [] }
  const b = { syntax: ['新1', '新2'], persona: ['脾气急', '爱较真'], never: ['不用感谢'] }
  const m = mergeProfile(a, b)
  assert.equal(m.syntax.length, 3, 'syntax 上限 3 条')
  assert.equal(m.syntax[0], '新1', '新的在前')
  assert.deepEqual(m.persona, ['脾气急', '爱较真'], '相同条目去重')
  assert.deepEqual(m.never, ['不用感谢'])
  assert.deepEqual(normalizeProfile({ syntax: ['  ', 'x', 'x'] }).syntax, ['x'], '空串和重复丢掉')
})

test('注入模板：对话对最优先、口头禅带语境、never/锚齐备、边界收尾', () => {
  const hint = renderDistillHint('老王', {
    exchanges: ['问：「这个怎么弄」\n答：「你先重启试试」'],
    catchphrases: ['斩（催办时）'], syntax: ['长句靠逗号串'], rhetoric: ['被封号就自嘲'],
    never: ['从不说感谢'], persona: ['热心答疑'],
  })
  assert.match(hint, /他怎么接话（学的是应对方式，内容绝不照搬）/, '对话对是最强信号，放最前')
  assert.match(hint, /口头禅：斩（催办时）｜句子：长句靠逗号串｜招式：被封号就自嘲/)
  assert.match(hint, /他从不：从不说感谢/)
  assert.match(hint, /他是这样的人：热心答疑/)
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

test('提示词（新模板）：exchanges 首要、口头禅带「什么时候用」、never 词表、性格写可观察行为', () => {
  const p = buildDistillPrompt({
    name: '老王', uid: '111',
    memberLines: [L('111', '草 这也能崩')],
    context: [{ uid: '222', name: '小李', text: '这游戏又崩了？' }, { uid: '111', name: '老王', text: '草 这也能崩' }],
    others: ['小李：请问这个怎么弄呀'],
    old: { syntax: ['旧架构'], persona: [] },
  })
  assert.match(p.system, /exchanges（最重要）/, '对话对是首要产出')
  assert.match(p.system, /他的原话（逐字，别改写）/, '回答逐字')
  assert.match(p.system, /什么时候用/, '口头禅带语境')
  assert.match(p.system, /never（从不用）/, '负向词表')
  assert.match(p.system, /可观察行为/, '性格写行为不写标签')
  assert.match(p.system, /换成群里另一个人/, 'misreading 自检')
  assert.match(p.text, /群聊原文（用来挑一问一答的对话对/, '交错原文进 prompt')
  assert.match(p.text, /小李：这游戏又崩了？\n他：草 这也能崩/, '按 uid 标「他：」')
  assert.match(p.text, /句子架构：旧架构/, '旧画像按新字段回填')
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

test('画像落库：新字段结构原样保存，证据条数进 evidenceCount', async () => {
  const mem = await freshStore()
  mem.addDistillTarget({ gid: '123', uid: '456', name: '老王' })
  mem.putDistill('123', '456', { syntax: ['句子短'], exchanges: ['问：「咋弄」\n答：「重启」'] }, 12)
  let p = mem.distillOf('123', '456')
  assert.deepEqual(p.syntax, ['句子短'])
  assert.deepEqual(p.exchanges, ['问：「咋弄」\n答：「重启」'])
  assert.equal(p.evidenceCount, 12)
  assert.ok(p.updatedAt > 0)
  mem.putDistill('123', '456', { syntax: ['爱用逗号'], persona: ['脾气急'] }, 20)
  p = mem.distillOf('123', '456')
  assert.equal(p.syntax[0], '爱用逗号', '新的在前')
  assert.equal(p.evidenceCount, 20, '证据条数取较大值')
  assert.equal(mem.distillList()[0].profile.persona[0], '脾气急')
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

test('接线：整理不再学（管线移交 distill 模块）、群聊时注入、面板与接口都在', () => {
  const mem = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  // 结构红线：consolidate 不再耦合蒸馏管线（避免两边各跑一遍重复花钱），学习调度移交 distill 模块自身 tick
  assert.doesNotMatch(mem, /learnDistill\(/, 'consolidate 不再调用 learnDistill')
  assert.doesNotMatch(mem, /reasoningEffort: 'none'/, '蒸馏不再钉死关思考（推理模型会吃掉全部预算不回正文）')
  assert.match(mem, /renderDistillHint\(t\.name \|\| t\.uid, distillOf/, '群聊注入画像')
  assert.match(mem, /dedupConvo\(hist\.lines\)\.slice\(-80\)/, '历史学习传去重对话原文')
  // distill 模块自持 L0/L1 调度（activity 计数 + 定时 tick）
  const dist = readFileSync(new URL('../src/modules/distill/index.js', import.meta.url), 'utf8')
  assert.match(dist, /api\.on\('activity'/, '模块 L0 计数挂 activity')
  assert.match(dist, /shouldTriggerL1/, 'L1 批阈值在模块')
  // 新核心补 activity 发射（开旗后 hub 不被调用，否则模块永远收不到计数）
  const mc = readFileSync(new URL('../src/host/modular-core.js', import.meta.url), 'utf8')
  assert.match(mc, /emitActivity\(mods, inbound\)/, '新核心 realtime 入口发 activity')
  const mod = readFileSync(new URL('../src/modules/memory/index.js', import.meta.url), 'utf8')
  assert.match(mod, /api\.route\('\/distill\/list'/)
  assert.match(mod, /api\.route\('\/distill\/card\/refresh'/)
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /function DistillPanel/, '面板有独立组件')
  assert.match(client, /蒸馏群友（学一个人的说话样子）/, '独立卡片')
})
