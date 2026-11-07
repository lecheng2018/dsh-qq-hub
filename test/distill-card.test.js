// 蒸馏→语感人设卡 v3 测试：内置「模仿人底板」，蒸馏数据按槽位填卡（打字习惯/口头禅/接话/
// 修辞/性格/负向/校准原话），身份锚取底卡首段；接管判定与底卡保护沿袭。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// personas.js 的目录来自 dataDir('personas')，用环境变量隔离
const dir = mkdtempSync(join(tmpdir(), 'dcard-'))
process.env.AURABOT_DATA_DIR = dir
mkdirSync(join(dir, 'personas'), { recursive: true })
writeFileSync(join(dir, 'personas', 'dafeiyu.md'), '---\nname: 大肥鱼\ntags: []\n---\n\n你是大肥鱼，住在 QQ 里的女孩子。\n\n【怎么说话：像人在打字】\n短句对仗。')
const dc = await import('../src/persona/distill-card.js')
const { distillCardId, voiceTemplate, identityOf, renderStyleBlock, buildDerivedBody, takeoverDecision, styleEntries, refreshDistillCard } = dc

const PROFILE = {
  exchanges: [{ text: '问：「号全封了吗」\n答：「空了好几天，我没看呢」', score: 1 }],
  syntax: [{ text: '长句靠逗号串，不分点', score: 0.8 }],
  catchphrases: [{ text: '斩（随口催办时）', score: 0.9 }, { text: '我瞅瞅（答应看一眼）', score: 0.8 }],
  rhetoric: [{ text: '被封号就自嘲', score: 0.7 }],
  never: [{ text: '从不说感谢、请问', score: 0.9 }],
  persona: [{ text: '热心答疑，谁问都回', score: 0.8 }],
  samples: [{ text: '毕竟是别人的卡，对你肯定没影响啊', score: 0.6 }], style: [], tone: [], avoid: [],
}
const ENTRIES = styleEntries([{ gid: '249729644', uid: '1040489623', name: '炙心', profile: PROFILE }])

test('身份锚：取底卡第一个非空段落，截长保护；空卡给兜底', () => {
  assert.equal(identityOf('你是大肥鱼，住在 QQ 里的女孩子。\n\n【怎么说话】'), '你是大肥鱼，住在 QQ 里的女孩子。')
  const long = 'x'.repeat(200)
  assert.ok(identityOf(long).length <= 160, '超长截断')
  assert.ok(identityOf('').length > 0, '空卡兜底')
})

test('底板填槽：七槽齐备、槽位标题、硬边界收尾', () => {
  const body = voiceTemplate(ENTRIES, '你是大肥鱼，住在 QQ 里的女孩子。')
  assert.match(body, /^# 身份\n\n你是大肥鱼，住在 QQ 里的女孩子。/, '身份槽在最前')
  assert.match(body, /身份是自己的，语感是借来的/, '两层关系说清')
  assert.match(body, /## 说话的样子：借自「炙心」/)
  assert.match(body, /### 打字习惯\n- 长句靠逗号串，不分点/, '打字习惯槽')
  assert.match(body, /### 口头禅（什么时候用）\n- 斩（随口催办时）/, '口头禅槽带语境')
  assert.match(body, /### 接话方式（学应对方式，内容绝不照搬）\n- 问：「号全封了吗」/, '接话槽')
  assert.match(body, /### 修辞招式\n- 被封号就自嘲/, '修辞槽')
  assert.match(body, /### 性格神韵（可观察行为）\n- 热心答疑，谁问都回/, '性格槽')
  assert.match(body, /### 绝不用\n- 从不说感谢、请问/, '负向槽')
  assert.match(body, /### 校准原话（找节奏用，绝不照抄内容）\n「毕竟是别人的卡，对你肯定没影响啊」/, '校准槽')
  assert.match(body, /只借说话方式，不借身份：你不是炙心本人/, '硬边界随卡走')
  assert.equal(voiceTemplate([], 'x'), '', '无条目出空卡')
  assert.equal(voiceTemplate([{ name: '甲', profile: {} }], 'x'), '', '空画像不出卡')
})

test('v2 兼容出口：renderStyleBlock / buildDerivedBody 走底板', () => {
  const block = renderStyleBlock(ENTRIES)
  assert.match(block, /# 身份/, '借用段=整张底板卡')
  const body = buildDerivedBody('你是大肥鱼，住在 QQ 里的女孩子。', ENTRIES)
  assert.match(body, /^# 身份\n\n你是大肥鱼，住在 QQ 里的女孩子。/, '底卡首段变身份锚')
  assert.match(body, /### 口头禅（什么时候用）/)
  assert.equal(buildDerivedBody('底卡', []), '底卡', '空画像退回原文')
})

test('接管判定：没指定过才接管；手动指定过（哪怕和默认撞值）绝不抢', () => {
  const cardId = distillCardId('249729644')
  const open = { persona: { current: 'dafeiyu', groupDefault: 'dafeiyu', groups: {} } }
  assert.equal(takeoverDecision(open, '249729644', cardId).takeover, true)
  assert.equal(takeoverDecision(open, '249729644', cardId).baseId, 'dafeiyu')
  const mine = { persona: { current: 'dafeiyu', groupDefault: 'dafeiyu', groups: { '249729644': 'persona-gen2' } } }
  const d = takeoverDecision(mine, '249729644', cardId)
  assert.equal(d.takeover, false)
  assert.match(d.reason, /不抢它的槽位/)
  const already = { persona: { current: 'dafeiyu', groups: { '249729644': cardId } } }
  assert.equal(takeoverDecision(already, '249729644', cardId).takeover, true)
})

test('refresh 端到端：底板卡落盘（front-matter、身份锚、槽位、标记无需存在）', () => {
  const cfg = { persona: { current: 'dafeiyu', groupDefault: 'dafeiyu', groups: {} } }
  const r = refreshDistillCard({ gid: '249729644', entries: ENTRIES, cfg, log: { info: () => {} } })
  assert.equal(r.ok, true)
  assert.equal(r.cardId, 'persona-语感-249729644')
  const raw = readFileSync(join(dir, 'personas', 'persona-语感-249729644.md'), 'utf8')
  assert.match(raw, /name: 语感·借自炙心/)
  assert.match(raw, /tags: \[自动生成\]/)
  assert.match(raw, /# 身份\n\n你是大肥鱼，住在 QQ 里的女孩子。/, '身份锚来自底卡首段')
  assert.match(raw, /### 打字习惯/)
  assert.match(raw, /斩（随口催办时）/)
  const base = readFileSync(join(dir, 'personas', 'dafeiyu.md'), 'utf8')
  assert.doesNotMatch(base, /借自|打字习惯/, '底卡文件没被改写')
  // 无画像时明确拒绝
  const r2 = refreshDistillCard({ gid: '999', entries: [], cfg, log: { info: () => {} } })
  assert.equal(r2.ok, false)
  assert.match(r2.message, /还没有学成的画像/)
})

test('重复刷新：画像变化 → 整卡重填（底板是机器拥有的），槽位反映最新数据', () => {
  const cfg = { persona: { current: 'dafeiyu', groupDefault: 'dafeiyu', groups: { '249729644': distillCardId('249729644') } } }
  const updated = styleEntries([{ gid: '249729644', uid: '1040489623', name: '炙心', profile: { ...PROFILE, catchphrases: [{ text: '斩（随口催办时）', score: 0.9 }] } }])
  const r = refreshDistillCard({ gid: '249729644', entries: updated, cfg, log: { info: () => {} } })
  assert.equal(r.ok, true)
  const raw = readFileSync(join(dir, 'personas', 'persona-语感-249729644.md'), 'utf8')
  assert.doesNotMatch(raw, /我瞅瞅/, '删掉的口头禅不再出现')
  assert.match(raw, /斩（随口催办时）/)
  assert.match(raw, /# 身份/, '重填后仍是底板结构')
})

test('接线：学习成功自动刷卡 + 路由 + setConfig 只在接管时发生', () => {
  const mem = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  assert.equal((mem.match(/onDistillLearned && await onDistillLearned/g) || []).length, 2, '历史学习+日常整理两处都挂')
  const mod = readFileSync(new URL('../src/modules/memory/index.js', import.meta.url), 'utf8')
  assert.match(mod, /api\.setConfig\(\{ persona: \{ groups: \{ \[String\(gid\)\]: r\.cardId \} \} \}\)/, '只有 r.ok 才写槽位')
  assert.match(mod, /api\.route\('\/distill\/card\/refresh'/)
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /写进群人设卡/)
  assert.match(client, /语感人设卡/)
})

test('派生卡会出现在人设列表里（面板人设页能看到、可手动切走）', async () => {
  const { listPersonas } = await import('../src/persona/personas.js')
  const ids = listPersonas().map((p) => p.id)
  assert.ok(ids.includes('persona-语感-249729644'), '列表里有派生卡')
  const card = listPersonas().find((p) => p.id === 'persona-语感-249729644')
  assert.ok(card.tags.includes('自动生成'))
})
