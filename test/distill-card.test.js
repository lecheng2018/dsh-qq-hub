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
const { distillCardId, renderStyleBlock, renderDistillData, buildDerivedBody, takeoverDecision, styleEntries, refreshDistillCard } = dc

const PROFILE = {
  // 新结构四层
  rhythm: ['单条消息极短（8-20字），多用换行', '习惯用空格代替逗号，句尾常留白'],
  sentenceTemplates: ['质疑/嘲讽起手：“纯纯…”“想啥呢…”', '状态判定：失效叫“寄”'],
  styleRules: ['一条一事，短句连发'],
  catchphrases: ['斩（随口催办时偶发）', '我瞅瞅（答应看一眼时偶发）'],
  reactions: ['被 @ 时先发「？」再解题', '被反驳时直接开怼'],
  mood: ['嘴硬心软'],
  cognition: ['技术争论站实测派'],
  identity: ['AI 额度羊毛情报员'],
  // 旧字段也塞一点，验证兼容渲染
  exchanges: ['问：「号全封了吗」\n答：「空了好几天，我没看呢」'],
  syntax: [], rhetoric: [], never: [], persona: [],
  samples: ['毕竟是别人的卡，对你肯定没影响啊'], style: [], tone: [], avoid: [],
}
const ENTRIES = styleEntries([{ gid: '249729644', uid: '1040489623', name: '炙心', profile: PROFILE }])

test('借用段（v3 按理想卡样例）：节奏/句式/交互/决策/背景，边界收尾', async () => {
  const block = renderStyleBlock(ENTRIES)
  assert.match(block, /【语感·借自「炙心」】/)
  // 区块顺序（v3 按理想卡样例）：节奏与排版 → 句式与口癖 → 交互反应 → 决策偏好 → 他是谁
  const order = ['── 节奏与排版', '── 句式与口癖', '── 交互反应', '── 决策偏好', '── 他是谁'].map((k) => block.indexOf(k))
  assert.ok(order.every((i) => i >= 0), '区块全渲染: ' + JSON.stringify(order))
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), '区块按顺序出现')
  assert.match(block, /节奏与排版/, '呼吸感区块')
  assert.match(block, /句式与口癖（按语境触发，严禁句句复读）/, '句式模板区块')
  assert.match(block, /质疑\/嘲讽起手：/, '起手式进卡')
  assert.match(block, /纯纯/, '句式骨架真实例')
  assert.match(block, /交互反应/, '触发反响区块')
  // Base Persona 由 buildDerivedBody 组装进派生卡（renderStyleBlock 只产借用段）
  const { buildDerivedBody: bdb } = await import('../src/persona/distill-card.js')
  assert.match(bdb('底卡正文', ENTRIES), /# \[Base Persona\]/, '三段式含 Base Persona 内核层')
  assert.match(block, /── 决策偏好 ──/, '认知区块')
  assert.match(block, /── 他是谁（背景参照） ──/, '身份区块')
  assert.match(block, /只借说话方式，不借身份：我不是炙心，不自称他、不替他表态、不提他个人隐私/, '边界随段走')
  assert.equal(renderStyleBlock([]), '')
  assert.equal(renderStyleBlock([{ name: '甲', profile: {} }]), '', '空画像不出段')
})

test('数据/模板分离：renderDistillData 只产数据段，字段增删不碰结构', () => {
  const d = renderDistillData(PROFILE)
  assert.match(d, /── 节奏与排版 ──/)
  assert.doesNotMatch(d, /【语感·借自/, '数据段不含卡壳（壳由 renderStyleBlock 负责）')
})

test('派生卡 = Base Persona + 底卡正文 + 借用段（三段式）；底卡本体一个字不动', () => {
  const body = buildDerivedBody('你是大肥鱼。\n\n【怎么说话：像人在打字】\n短句对仗。', ENTRIES)
  assert.ok(body.indexOf('# [Base Persona]') === 0, 'Base Persona 在最前（内核层优先级语义）')
  assert.match(body, /Dual-Layer Architecture Protocol/, '双层架构协议写进卡')
  assert.ok(body.includes('你是大肥鱼。'), '底卡原文原样保留')
  assert.match(body, /【从群友身上借来的说话方式】/)
  const base = readFileSync(join(dir, 'personas', 'dafeiyu.md'), 'utf8')
  assert.doesNotMatch(base, /借来的说话方式/, '底卡文件没被改写')
})

test('接管判定：没指定过才接管；手动指定过（哪怕和默认撞值）绝不抢', () => {
  const cardId = distillCardId('249729644')
  const open = { persona: { current: 'dafeiyu', groupDefault: 'persona-gen2', groups: {} } }
  assert.equal(takeoverDecision(open, '249729644', cardId).takeover, true, '没指定 → 可接管')
  assert.equal(takeoverDecision(open, '249729644', cardId).baseId, 'dafeiyu', '底卡=current（1.3.63 修正：不再落 groupDefault 鲸鱼二代）')
  const mine = { persona: { current: 'dafeiyu', groupDefault: 'dafeiyu', groups: { '249729644': 'persona-gen2' } } }
  const d = takeoverDecision(mine, '249729644', cardId)
  assert.equal(d.takeover, false, '明确指定了别的卡 → 不抢')
  assert.match(d.reason, /不抢它的槽位/)
  const already = { persona: { current: 'dafeiyu', groups: { '249729644': cardId } } }
  assert.equal(takeoverDecision(already, '249729644', cardId).takeover, true, '槽位已经是派生卡 → 允许更新自己')
})

test('refresh 端到端：生成卡文件（front-matter 带自动生成标签与借用对象名）', () => {
  const cfg = { persona: { current: 'dafeiyu', groupDefault: 'persona-gen2', groups: {} } }
  const r = refreshDistillCard({ gid: '249729644', entries: ENTRIES, cfg, log: { info: () => {} } })
  assert.equal(r.ok, true)
  assert.equal(r.cardId, 'persona-语感-249729644')
  assert.equal(r.baseId, 'dafeiyu', '底卡是 current，不是 groupDefault')
  const raw = readFileSync(join(dir, 'personas', 'persona-语感-249729644.md'), 'utf8')
  assert.match(raw, /name: 语感·借自炙心/)
  assert.match(raw, /tags: \[自动生成\]/)
  assert.match(raw, /短句对仗/)
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
