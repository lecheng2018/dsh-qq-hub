// 蒸馏群友（1.3.59）：指定某个群的某一个人当数据源，学他的说话方式/性格/语气。
// 和「群黑话本」是两件事——黑话本学词，蒸馏群友学人。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectMemberLines, enoughEvidence, buildDistillPrompt,
  parseDistillProfile, normalizeProfile, mergeProfile, renderDistillHint,
} from '../src/features/distill.js'

const L = (uid, text, t = 0) => ({ uid, text, t, who: 'u' + uid })

test('从群流水里只捞目标那个人的话，按时间正序', () => {
  const lines = [L('9', '晚点', 3), L('111', '草', 2), L('222', '哈哈哈', 1), L('111', '上号', 4)]
  assert.deepEqual(collectMemberLines(lines, '111').map((x) => x.text), ['草', '上号'])
  assert.deepEqual(collectMemberLines(lines, '999'), [], '没说过话就是空')
  assert.deepEqual(collectMemberLines(lines, ''), [], '没给 uid 不捞')
})

test('证据不足不学：门槛 20 句 / 120 字（对齐 molroo 的 20~30 条建议）', () => {
  assert.equal(enoughEvidence([L('1', 'a'), L('1', 'b')]), false)
  const eight = Array.from({ length: 8 }, (_, i) => L('1', '这是一句正常长度的话' + i))
  assert.equal(eightEvidenceFalse(eight), true)
  const twenty = Array.from({ length: 20 }, (_, i) => L('1', '这是一句正常长度的话' + i))
  assert.equal(enoughEvidence(twenty), true, '20 句才够')
  const twentyShort = Array.from({ length: 20 }, () => L('1', '嗯'))
  assert.equal(enoughEvidence(twentyShort), false, '20 句但都是「嗯」，字数不够')
})
// 8 句应当不再够（旧门槛）
function eightEvidenceFalse (lines) { return !enoughEvidence(lines) }

test('解析模型回包：认 ```json 围栏、外层带解释；坏数据返回 null', () => {
  const ok = parseDistillProfile('```json\n{"style":["句子极短"],"persona":["脾气急"],"tone":["对熟人随意"]}\n```')
  assert.deepEqual(ok.style, ['句子极短'])
  const wrapped = parseDistillProfile('好的，结果如下：{"style":["爱用逗号"],"persona":[],"tone":[]} 以上。')
  assert.deepEqual(wrapped.style, ['爱用逗号'])
  assert.equal(parseDistillProfile('我不知道'), null)
  assert.equal(parseDistillProfile(''), null)
})

test('画像归一与合并：去空去重、新的在前、超上限截断', () => {
  const a = { style: Array.from({ length: 6 }, (_, i) => '旧' + i), persona: ['脾气急'], tone: [] }
  const b = { style: ['新1', '新2'], persona: ['脾气急', '爱较真'], tone: ['对熟人随意'] }
  const m = mergeProfile(a, b)
  assert.equal(m.style.length, 6, '上限 6 条')
  assert.equal(m.style[0], '新1', '新的在前')
  assert.deepEqual(m.persona, ['脾气急', '爱较真'], '相同条目去重')
  assert.deepEqual(m.tone, ['对熟人随意'])
  assert.deepEqual(normalizeProfile({ style: ['  ', 'x', 'x'] }).style, ['x'], '空串和重复丢掉')
})

test('注入文本：原话优先（few-shot）、带负向约束、带「学样子不冒充」的硬边界', () => {
  const hint = renderDistillHint('老王', {
    samples: ['草 这也能崩', '行吧 你牛逼'],
    style: ['句子极短'], persona: ['脾气急'], tone: ['对熟人随意'], avoid: ['从不长篇解释'],
  })
  assert.match(hint, /他的原话（照这个语感说，别照抄内容）/, '原话是主信号')
  assert.match(hint, /- 「草 这也能崩」/, '逐字带引号')
  assert.match(hint, /特征：说话方式：句子极短｜性格：脾气急｜语气：对熟人随意/)
  assert.match(hint, /他不会：从不长篇解释/, '负向约束')
  assert.match(hint, /你不是老王、也不能替老王表态/)
  assert.match(hint, /别自称他、别冒用他的身份/)
  assert.equal(renderDistillHint('老王', { style: [], persona: [], tone: [], samples: [], avoid: [] }), '', '没学到就不注入')
  // 只有原话也算学到（特征为空但样本在）
  assert.match(renderDistillHint('老王', { samples: ['就这？'] }), /就这？/)
})

test('提示词：要逐字原话、要负向约束、要自检「换成谁都成立就删」、带对照', () => {
  const p = buildDistillPrompt({
    name: '老王',
    memberLines: [L('1', '草 这也能崩')],
    context: ['路人：这游戏又崩了'],
    others: ['小李：请问这个怎么弄呀'],
    old: { style: ['旧特征'], persona: [], tone: [] },
  })
  assert.match(p.system, /samples（最重要）：\*\*逐字摘\*\*/, '原话是主信号')
  assert.match(p.system, /不要改写、不要加标点/, '逐字约束')
  assert.match(p.system, /avoid（他从不做的）/, '负向约束')
  assert.match(p.system, /换成群里任何另一个人试一遍/, 'Test for misreading 自检')
  assert.match(p.system, /必须能在他上面某句原话里找到依据/, '每条要有依据')
  assert.match(p.text, /群里别人说的话（用来对照出他跟别人的不同，不要学这些）/, '对照信号')
  assert.match(p.text, /已有的旧画像/)
  assert.match(p.text, /他：草 这也能崩/)
})

test('解析与合并支持 samples/avoid', () => {
  const prof = parseDistillProfile(JSON.stringify({
    samples: ['就这？', '草'], style: ['短'], persona: [], tone: [], avoid: ['不解释'],
  }))
  assert.deepEqual(prof.samples, ['就这？', '草'])
  assert.deepEqual(prof.avoid, ['不解释'])
  const merged = mergeProfile({ samples: ['旧句子'], avoid: [] }, { samples: ['新句子'], avoid: ['不解释'] })
  assert.deepEqual(merged.samples, ['新句子', '旧句子'], '新的在前')
  assert.deepEqual(merged.avoid, ['不解释'])
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

test('画像落库：合并、记录证据条数与时间', async () => {
  const mem = await freshStore()
  mem.addDistillTarget({ gid: '123', uid: '456', name: '老王' })
  mem.putDistill('123', '456', { style: ['句子短'], persona: [], tone: [] }, 12)
  let p = mem.distillOf('123', '456')
  assert.deepEqual(p.style, ['句子短'])
  assert.equal(p.samples, 12)
  assert.ok(p.updatedAt > 0)
  mem.putDistill('123', '456', { style: ['爱用逗号'], persona: ['脾气急'], tone: [] }, 20)
  p = mem.distillOf('123', '456')
  assert.equal(p.style[0], '爱用逗号', '新的在前')
  assert.equal(p.samples, 20, '证据条数取较大值')
  // 面板视图把目标和画像合在一起
  assert.equal(mem.distillList()[0].profile.persona[0], '脾气急')
})

test('接线：整理时学、群聊时注入、面板与接口都在', () => {
  const mem = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  assert.match(mem, /await learnDistill\(day\)/, 'consolidate 里跑')
  assert.match(mem, /cfg\.memory\?\.distill === false\) return/, '开关可关')
  assert.match(mem, /renderDistillHint\(t\.name \|\| t\.uid, distillOf/, '群聊注入画像')
  assert.match(mem, /distillLearned/, '学过就记账，重启不重复花钱')
  const mod = readFileSync(new URL('../src/modules/memory/index.js', import.meta.url), 'utf8')
  assert.match(mod, /api\.route\('\/distill\/list'/)
  assert.match(mod, /api\.route\('\/distill\/add'/)
  assert.match(mod, /api\.route\('\/distill\/remove'/)
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /function DistillPanel/, '面板有独立组件')
  assert.match(client, /蒸馏群友（学一个人的说话样子）/, '独立卡片')
})
