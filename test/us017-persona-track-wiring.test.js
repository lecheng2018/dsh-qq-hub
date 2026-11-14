// US-017 接线验收：双轨记忆 —— 主观自传按人设隔离，客观事实跨人设共享。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 数据目录在模块加载时读环境变量，必须在 import 之前设好
const DATA = mkdtempSync(join(tmpdir(), 'persona-track-'))
process.env.DSH_QQ_HUB_DATA_DIR = DATA
// 迁移闸：memory/state.json 与 migration.json 必须先存在，否则 archive 拒绝启动
mkdirSync(join(DATA, 'memory'), { recursive: true })
writeFileSync(join(DATA, 'memory', 'migration.json'), JSON.stringify({ status: 'success' }))
writeFileSync(join(DATA, 'memory', 'state.json'), JSON.stringify({ items: [] }))

const { createMemoryArchive } = await import('../src/features/memory-archive.js')
const { DEFAULT_PERSONA_ID } = await import('../src/features/memory-persona-track.js')

/** 最小 archive：每个用例独立内存数据目录，人设可切换。 */
function harness({ persona = 'socrates' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'persona-harness-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'migration.json'), JSON.stringify({ status: 'success' }))
  writeFileSync(join(dir, 'memory', 'state.json'), JSON.stringify({ items: [] }))
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  let current = persona
  const archive = createMemoryArchive({
    dsh: {}, hub: {}, log: { info: () => {}, warn: () => {} },
    getConfig: () => ({ ownerQQ: '1000', persona: { current }, memory: { enabled: true, recallCount: 10 } }),
    personaText: () => '你是苏格拉底',
    reflectionContext: true, styleContext: true,
  })
  return { archive, setPersona: (p) => { current = p } }
}

const CHAT = 'private:1000'

test('客观事实跨人设共享：切换人设后仍可见', () => {
  const { archive, setPersona } = harness({ persona: 'socrates' })
  archive.add({ text: '主人住在杭州', source: 'tool', chatId: CHAT, scope: CHAT })
  setPersona('dafeiyu')
  const hits = archive.recall('杭州', { chat: { kind: 'private', userId: '1000' }, limit: 5 })
  assert.ok(hits.some((h) => h.it.text.includes('杭州')), '客观事实在切换人设后仍应能召回')
})

test('主观条目（insight）只对同人设可见', () => {
  const { archive, setPersona } = harness({ persona: 'socrates' })
  archive.add({ text: '我觉得主人今天很累', source: 'auto', chatId: CHAT, scope: CHAT, kind: 'insight' })
  // 同人设：应能召回
  const same = archive.recall('觉得主人累', { chat: { kind: 'private', userId: '1000' }, limit: 10 })
  assert.ok(same.some((h) => h.it.text.includes('很累')), '同人设 recall 应成功召回主观条目')
  // 切换到另一个人设：主观条目应被隔离不可见
  setPersona('dafeiyu')
  const other = archive.recall('觉得主人累', { chat: { kind: 'private', userId: '1000' }, limit: 10 })
  assert.equal(other.length, 0, '异人设下主观自传条目必须被隔离')
})

test('listFor 按人设过滤主观条目，客观事实保留', () => {
  const { archive, setPersona } = harness({ persona: 'socrates' })
  archive.add({ text: '客观：主人喜欢猫', source: 'tool', chatId: CHAT, scope: CHAT, kind: 'fact' })
  archive.add({ text: '主观：我觉得主人今天很累', source: 'auto', chatId: CHAT, scope: CHAT, kind: 'insight' })
  const before = archive.listFor([CHAT], { limit: 50 })
  assert.equal(before.length, 2, '同人设下两条均可见')
  setPersona('dafeiyu')
  const after = archive.listFor([CHAT], { limit: 50 })
  assert.equal(after.length, 1, '切换人设后主观条目被过滤')
  assert.ok(after.some((m) => String(m.text).includes('喜欢猫')), '客观事实跨人设依然保留')
  assert.ok(!after.some((m) => String(m.text).includes('觉得主人累')), '异人设主观条目必须被过滤')
})

test('add 接受显式 personaId 覆盖当前人设', () => {
  const { archive, setPersona } = harness({ persona: 'socrates' })
  const r = archive.add({ text: '这条属于旧人设', source: 'auto', chatId: CHAT, scope: CHAT, personaId: 'oldpersona' })
  assert.equal(r.ok, true, 'add 应成功')
  // 在 socrates 人设下查不到
  const socratesHits = archive.listFor([CHAT], { limit: 10 })
  assert.ok(!socratesHits.some((m) => m.text.includes('属于旧人设')), 'socrates 人设下不应看到 oldpersona 条目')
  // 切到 oldpersona 人设下可以查到
  setPersona('oldpersona')
  const oldHits = archive.listFor([CHAT], { limit: 10 })
  assert.ok(oldHits.some((m) => m.text.includes('属于旧人设')), 'oldpersona 人设下应能看到归属于它自己的条目')
})

test('非法 personaId 回落到当前人设（不写坏数据）', () => {
  const { archive } = harness({ persona: 'socrates' })
  assert.doesNotThrow(() => archive.add({ text: '非法人设测试', source: 'auto', chatId: CHAT, scope: CHAT, personaId: '非法 id 带空格' }))
})

test('默认人设常量可用（历史存量归属）', () => {
  assert.equal(typeof DEFAULT_PERSONA_ID, 'string')
  assert.ok(DEFAULT_PERSONA_ID.length > 0)
})

test('没配 persona.current 时回落到默认人设，不抛', () => {
  const archive = createMemoryArchive({
    dsh: {}, hub: {}, log: { info: () => {}, warn: () => {} },
    getConfig: () => ({ ownerQQ: '1000', memory: { enabled: true } }),
    personaText: () => '', reflectionContext: true, styleContext: true,
  })
  assert.doesNotThrow(() => archive.add({ text: '无配置测试', source: 'tool', chatId: CHAT, scope: CHAT }))
  assert.doesNotThrow(() => archive.listFor([CHAT], { limit: 10 }))
})
