// 蒸馏→语感人设卡（1.3.63）：学成群友后自动生成「底卡 + 借用段」的群专属人设卡，
// 把语感搬进系统提示词的最高优先级层；主人手动指定过人设的群绝不抢槽位。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// personas.js 的目录来自 dataDir('personas')，用环境变量隔离
const dir = mkdtempSync(join(tmpdir(), 'dcard-'))
process.env.AURABOT_DATA_DIR = dir
mkdirSync(join(dir, 'personas'), { recursive: true })
writeFileSync(join(dir, 'personas', 'dafeiyu.md'), '---\nname: 大肥鱼\ntags: []\n---\n\n你是大肥鱼。\n\n【怎么说话：像人在打字】\n短句对仗。')
const dc = await import('../src/persona/distill-card.js')
const { distillCardId, renderStyleBlock, buildDerivedBody, takeoverDecision, styleEntries, refreshDistillCard } = dc

const PROFILE = {
  exchanges: ['问：「号全封了吗」\n答：「空了好几天，我没看呢」'],
  syntax: ['长句靠逗号串，不分点'], catchphrases: ['斩（随口催办时）', '我瞅瞅（答应看一眼）'],
  rhetoric: ['被封号就自嘲'], never: ['从不说感谢、请问'], persona: ['热心答疑，谁问都回'],
  // 旧字段也塞一点，验证兼容
  samples: ['毕竟是别人的卡，对你肯定没影响啊'], style: [], tone: [], avoid: [],
}
const ENTRIES = styleEntries([{ gid: '249729644', uid: '1040489623', name: '炙心', profile: PROFILE }])

test('借用段（新模板）：对话对在最前、口头禅带语境、never/锚齐备、边界收尾', () => {
  const block = renderStyleBlock(ENTRIES)
  assert.match(block, /【语感·借自「炙心」】/)
  assert.match(block, /我在这个群接话就照着他的应对方式来（学应对方式，聊天内容绝不照搬）：\n- 问：「号全封了吗」/, '对话对是首要块')
  assert.match(block, /口头禅：斩（随口催办时）；我瞅瞅（答应看一眼）/, '口头禅带使用语境')
  assert.match(block, /句子架构：长句靠逗号串，不分点/)
  assert.match(block, /修辞招式：被封号就自嘲/)
  assert.match(block, /我不用他绝不会用的东西：从不说感谢、请问/, 'never 词表')
  assert.match(block, /我借他神韵的地方：热心答疑，谁问都回/, '性格锚')
  assert.match(block, /旧原话|校准节奏|毕竟是别人的卡/, '旧 samples 兼容渲染')
  assert.match(block, /只借说话方式，不借身份：我不是炙心，不自称他、不替他表态、不提他个人隐私/, '边界随段走')
  assert.equal(renderStyleBlock([]), '')
  assert.equal(renderStyleBlock([{ name: '甲', profile: {} }]), '', '空画像不出段')
})

test('派生卡 = 底卡正文 + 借用段；底卡本体一个字不动', () => {
  const body = buildDerivedBody('你是大肥鱼。\n\n【怎么说话：像人在打字】\n短句对仗。', ENTRIES)
  assert.ok(body.startsWith('你是大肥鱼。'), '底卡原文在前且原样')
  assert.match(body, /【从群友身上借来的说话方式】/)
  const base = readFileSync(join(dir, 'personas', 'dafeiyu.md'), 'utf8')
  assert.doesNotMatch(base, /借来的说话方式/, '底卡文件没被改写')
})

test('接管判定：没指定过才接管；手动指定过（哪怕和默认撞值）绝不抢', () => {
  const cardId = distillCardId('249729644')
  const open = { persona: { current: 'dafeiyu', groupDefault: 'dafeiyu', groups: {} } }
  assert.equal(takeoverDecision(open, '249729644', cardId).takeover, true, '没指定 → 可接管，底卡=groupDefault')
  assert.equal(takeoverDecision(open, '249729644', cardId).baseId, 'dafeiyu')
  const mine = { persona: { current: 'dafeiyu', groupDefault: 'dafeiyu', groups: { '249729644': 'persona-gen2' } } }
  const d = takeoverDecision(mine, '249729644', cardId)
  assert.equal(d.takeover, false, '明确指定了别的卡 → 不抢')
  assert.match(d.reason, /不抢它的槽位/)
  const already = { persona: { current: 'dafeiyu', groups: { '249729644': cardId } } }
  assert.equal(takeoverDecision(already, '249729644', cardId).takeover, true, '槽位已经是派生卡 → 允许更新自己')
})

test('refresh 端到端：生成卡文件（front-matter 带自动生成标签与借用对象名）', () => {
  const cfg = { persona: { current: 'dafeiyu', groupDefault: 'dafeiyu', groups: {} } }
  const r = refreshDistillCard({ gid: '249729644', entries: ENTRIES, cfg, log: { info: () => {} } })
  assert.equal(r.ok, true)
  assert.equal(r.cardId, 'persona-语感-249729644')
  const raw = readFileSync(join(dir, 'personas', 'persona-语感-249729644.md'), 'utf8')
  assert.match(raw, /name: 语感·借自炙心/)
  assert.match(raw, /tags: \[自动生成\]/)
  assert.match(raw, /短句对仗/)
  assert.match(raw, /我瞅瞅（答应看一眼）/)
  // 无画像时明确拒绝
  const r2 = refreshDistillCard({ gid: '999', entries: [], cfg, log: { info: () => {} } })
  assert.equal(r2.ok, false)
  assert.match(r2.message, /还没有学成的画像/)
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
