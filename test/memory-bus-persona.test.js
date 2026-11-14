// 缺陷 2 回归：记忆总线是「所有想记一条」的统一入口，必须透传双轨记忆的主观字段。
//
// 修复前 add() 是逐字段手抄，只抄了客观事实那几项，kind / selfView / perspective / personaId
// 全被丢掉 —— PR #119 在主库做的按人设隔离，到总线这层就退化成「人人都是客观事实」，
// 于是经 bus 写进来的相处经验照样跨人设串味。这批用例钉住透传，以及 bus.invalidate 的转发。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// dataDir() 在模块加载时读环境变量，必须先设好再动态 import
const BOOT = mkdtempSync(join(tmpdir(), 'bus-persona-boot-'))
process.env.DSH_QQ_HUB_DATA_DIR = BOOT
mkdirSync(join(BOOT, 'memory'), { recursive: true })
writeFileSync(join(BOOT, 'memory', 'migration.json'), JSON.stringify({ status: 'success' }))
writeFileSync(join(BOOT, 'memory', 'state.json'), JSON.stringify({ items: [] }))

const { createMemoryArchive } = await import('../src/features/memory-archive.js')
const { createMemoryBus } = await import('../src/features/memory-bus.js')

const CHAT = 'private:1000'
const CHAT_VIEW = { kind: 'private', userId: '1000' }

/** 一个可切人设的 archive + 挂在它上面的总线。 */
function harness(t, { persona = 'socrates' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bus-persona-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'migration.json'), JSON.stringify({ status: 'success' }))
  writeFileSync(join(dir, 'memory', 'state.json'), JSON.stringify({ items: [] }))
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  let current = persona
  const archive = createMemoryArchive({
    dsh: {}, hub: {}, log: { info: () => {}, warn: () => {} },
    getConfig: () => ({ ownerQQ: '1000', persona: { current }, memory: { enabled: true, recallCount: 10 } }),
    personaText: () => (current === 'socrates' ? '你是苏格拉底' : '你是大肥鱼'),
    reflectionContext: true, styleContext: true,
  })
  const bus = createMemoryBus({ store: archive, log: { warn() {}, debug() {} } })
  t.after(() => {
    archive.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  return { archive, bus, setPersona: (p) => { current = p } }
}

test('bus.add 透传 kind / selfView / perspective / personaId（主观轨不被剥成客观事实）', (t) => {
  const { archive, bus } = harness(t, { persona: 'socrates' })
  const r = bus.add({
    text: '我觉得主人今天很累', source: 'auto', chatId: CHAT, scope: CHAT,
    kind: 'insight', selfView: true, perspective: 'self', personaId: 'socrates',
  })
  assert.equal(r.ok, true, 'bus.add 应成功')

  const [item] = archive.listFor([CHAT], { limit: 10 })
  assert.ok(item, '条目应写入主库')
  assert.equal(item.kind, 'insight', 'kind 不能被丢掉')
  assert.equal(item.selfView, true, 'selfView 不能被丢掉')
  assert.equal(item.perspective, 'self', 'perspective 不能被丢掉')
  assert.equal(item.personaId, 'socrates', 'personaId 不能被丢掉')
})

test('通过 bus 写的主观条目，换人设后 listFor/recall 都隔离（缺陷 2 的核心断言）', (t) => {
  const { archive, bus, setPersona } = harness(t, { persona: 'socrates' })
  bus.add({ text: '苏格拉底式相处：多用反问', source: 'auto', chatId: CHAT, scope: CHAT, kind: 'insight' })
  bus.add({ text: '主人住在杭州', source: 'tool', chatId: CHAT, scope: CHAT, kind: 'fact' })

  // 同人设：主观 + 客观都在
  const before = archive.listFor([CHAT], { limit: 50 })
  assert.equal(before.length, 2, '同人设下两条都能读到')
  assert.ok(before.some((m) => String(m.text).includes('多用反问')), '同人设下主观条目可见')

  // 换人设：只剩客观事实
  setPersona('dafeiyu')
  const after = archive.listFor([CHAT], { limit: 50 })
  assert.equal(after.length, 1, '换人设后主观条目必须被隔离，只剩客观事实')
  assert.ok(after.some((m) => String(m.text).includes('杭州')), '客观事实跨人设共享')
  assert.ok(!after.some((m) => String(m.text).includes('多用反问')), '主观条目不得跨人设可见')
  const hits = archive.recall('多用反问', { chat: CHAT_VIEW, limit: 5 })
  assert.ok(!hits.some((h) => h.it.text.includes('多用反问')), '主观条目不得跨人设召回')

  // 切回去恢复
  setPersona('socrates')
  assert.ok(archive.listFor([CHAT], { limit: 50 }).some((m) => String(m.text).includes('多用反问')), '切回原人设应恢复')
})

test('bus.add 不传主观字段时行为与改造前逐字段一致（默认值语义不变）', (t) => {
  const { archive, bus } = harness(t)
  const r = bus.add({ text: '主人喜欢冷萃咖啡', about: '1000', scope: CHAT, chatId: CHAT })
  assert.equal(r.ok, true)
  const [item] = archive.listFor([CHAT], { limit: 10 })
  assert.equal(item.kind, 'fact', '不声明 kind 仍是客观事实')
  // selfView 落盘时 false 被省略（memory-files 只写 true），读回是 undefined —— 都是 falsy，
  // 语义是「非自身视角」。这里断言 falsy 而不是严格 false，避免把存储优化当成契约。
  assert.ok(!item.selfView, 'selfView 缺省为假（落盘省略 false）')
  assert.equal(item.personaId, undefined, '客观事实不带 personaId')
  assert.equal(item.importance, 0.6, 'importance 默认值保持 0.6')
  assert.equal(item.source, 'tool', 'source 默认值保持 tool')
})

test('bus.add 只传 selfView 也能判成主观轨（与主库同一判定口径）', (t) => {
  const { archive, bus } = harness(t, { persona: 'socrates' })
  bus.add({ text: '我的哲学观点是知识即美德', source: 'auto', chatId: CHAT, scope: CHAT, selfView: true })
  const [item] = archive.listFor([CHAT], { limit: 10 })
  assert.equal(item.selfView, true)
  assert.equal(item.personaId, 'socrates', '只给 selfView 时也应由主库补上当前人设')
})

test('bus.invalidate 转发到主库：非 pinned 正常失效，pinned 默认拒绝（缺陷 3 的总线口径）', (t) => {
  const { archive, bus } = harness(t)
  const plain = bus.add({ text: '临时事实：明天的天气', scope: CHAT, chatId: CHAT })
  const pinned = bus.add({ text: '手工钉住：主人对花生过敏', scope: CHAT, chatId: CHAT, pinned: true })
  assert.equal(plain.ok, true)
  assert.equal(pinned.ok, true)

  assert.equal(bus.invalidate(plain.id, ''), true, '非 pinned 应能失效')
  // 注意 list() 必须**不传参**：list({}) 里的 {} 是 truthy，会被当成搜索词走 search 分支。
  const afterPlain = archive.list().find((m) => m.id === plain.id)
  assert.ok(afterPlain.invalidAt > 0, 'invalidAt 应被设置')

  assert.equal(bus.invalidate(pinned.id, ''), false, 'pinned 默认必须拒绝（自动路径）')
  const afterPinned = archive.list().find((m) => m.id === pinned.id)
  // assembleState 会把缺失的 invalidAt 归一成 0（不是 undefined），所以断言 falsy。
  assert.ok(!afterPinned.invalidAt, 'pinned 的 invalidAt 不能被设置')
})

test('主库没挂上时 bus 写读都明确失败，不静默吞', () => {
  const bus = createMemoryBus({ store: null, log: { warn() {}, debug() {} } })
  assert.deepEqual(bus.add({ text: 'x' }), { ok: false, message: '主记忆库没在跑' })
  assert.equal(bus.invalidate('any'), false, '没主库时 invalidate 返回 false 而不是抛')
  assert.deepEqual(bus.listFor([CHAT]), [])
})