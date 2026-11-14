// US-017 接线验收：双轨记忆 —— 主观自传按人设隔离，客观事实跨人设共享。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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

/** 最小 archive：每个用例独立内存数据目录，人设可动态切换。 */
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
    personaText: () => (current === 'socrates' ? '你是苏格拉底' : '你是大肥鱼'),
    reflectionContext: true, styleContext: true,
  })
  return { archive, setPersona: (p) => { current = p }, getPersona: () => current }
}

const CHAT = 'private:1000'
const CHAT_VIEW = { kind: 'private', userId: '1000' }

test('客观事实跨人设共享：切换人设后仍可见', () => {
  const { archive, setPersona } = harness({ persona: 'socrates' })
  archive.add({ text: '主人住在杭州', source: 'tool', chatId: CHAT, scope: CHAT })
  setPersona('dafeiyu')
  const hits = archive.recall('杭州', { chat: CHAT_VIEW, limit: 5 })
  assert.ok(hits.some((h) => h.it.text.includes('杭州')), '客观事实在切换人设后仍应能召回')
})

test('主观条目（kind: insight 或 selfView: true）只对同人设可见，切回后恢复', () => {
  const { archive, setPersona } = harness({ persona: 'socrates' })
  archive.add({ text: '我觉得主人今天很累', source: 'auto', chatId: CHAT, scope: CHAT, kind: 'insight' })
  archive.add({ text: '我的哲学观点是知识即美德', source: 'auto', chatId: CHAT, scope: CHAT, selfView: true })

  // 同人设（socrates）：均应能召回
  const socratesHits = archive.recall('觉得主人累', { chat: CHAT_VIEW, limit: 10 })
  assert.ok(socratesHits.some((h) => h.it.text.includes('很累')), '同人设 recall 应成功召回主观条目')
  const socratesViewHits = archive.recall('哲学观点', { chat: CHAT_VIEW, limit: 10 })
  assert.ok(socratesViewHits.some((h) => h.it.text.includes('知识即美德')), '同人设 recall 应召回 selfView 主观条目')

  // 切换到另一个人设（dafeiyu）：主观条目应被严格隔离不可见
  setPersona('dafeiyu')
  const otherHits = archive.recall('觉得主人累', { chat: CHAT_VIEW, limit: 10 })
  assert.ok(!otherHits.some((h) => h.it.text.includes('很累')), '异人设下主观自传条目必须被隔离')
  const otherViewHits = archive.recall('哲学观点', { chat: CHAT_VIEW, limit: 10 })
  assert.equal(otherViewHits.length, 0, '异人设下 selfView 主观条目必须被隔离')

  // 切回原人设（socrates）：该人设的主观条目能够再次正常读取
  setPersona('socrates')
  const backHits = archive.recall('觉得主人累', { chat: CHAT_VIEW, limit: 10 })
  assert.ok(backHits.some((h) => h.it.text.includes('很累')), '切回原人设后主观条目应重新可见')
})

test('listFor 与 recall 完整闭环：主观按人设严格过滤，客观恒跨人设可见，切回恢复', () => {
  const { archive, setPersona } = harness({ persona: 'socrates' })
  archive.add({ text: '客观：主人喜欢猫', source: 'tool', chatId: CHAT, scope: CHAT, kind: 'fact' })
  archive.add({ text: '主观：我觉得主人今天很累', source: 'auto', chatId: CHAT, scope: CHAT, kind: 'insight' })

  // 1. 同人设（socrates）下两条均可见
  const before = archive.listFor([CHAT], { limit: 50 })
  assert.equal(before.length, 2, '同人设下主客观两条均可见')
  const socratesRecallCat = archive.recall('喜欢猫', { chat: CHAT_VIEW, limit: 5 })
  assert.ok(socratesRecallCat.some((h) => h.it.text.includes('喜欢猫')), '同人设下客观事实能召回')
  const socratesRecallTired = archive.recall('觉得主人累', { chat: CHAT_VIEW, limit: 5 })
  assert.ok(socratesRecallTired.some((h) => h.it.text.includes('很累')), '同人设下主观自传能召回')

  // 2. 切换到另一个人设（dafeiyu）：主观条目严格过滤，客观事实保留
  setPersona('dafeiyu')
  const after = archive.listFor([CHAT], { limit: 50 })
  assert.equal(after.length, 1, '切换人设后主观条目被严格过滤，仅余客观条目')
  assert.ok(after.some((m) => String(m.text).includes('喜欢猫')), '客观事实跨人设依然保留')
  assert.ok(!after.some((m) => String(m.text).includes('觉得主人累')), '异人设主观条目必须被过滤')

  // recall 验证：客观可召回，主观不可召回
  const dafeiyuRecallCat = archive.recall('喜欢猫', { chat: CHAT_VIEW, limit: 5 })
  assert.ok(dafeiyuRecallCat.some((h) => h.it.text.includes('喜欢猫')), '异人设下客观事实仍能正常召回')
  const dafeiyuRecallTired = archive.recall('觉得主人累', { chat: CHAT_VIEW, limit: 5 })
  assert.ok(!dafeiyuRecallTired.some((h) => h.it.text.includes('很累')), '异人设下主观自传条目不能被召回')

  // 3. 切回原人设（socrates）：该人设的主观条目能够再次正常读取
  setPersona('socrates')
  const back = archive.listFor([CHAT], { limit: 50 })
  assert.equal(back.length, 2, '切回原人设后两条均恢复可见')
  const backRecallTired = archive.recall('觉得主人累', { chat: CHAT_VIEW, limit: 5 })
  assert.ok(backRecallTired.some((h) => h.it.text.includes('很累')), '切回原人设后主观条目能再次正常召回')
})

test('contextFor 上下文注入隔离：杜绝跨人设串味（缺陷 B）', () => {
  const { archive, setPersona } = harness({ persona: 'socrates' })

  // 写入专属 socrates 的 profile、insight、style
  archive.setProfile('1000', '苏格拉底对主人的印象：很有哲思', '主人', CHAT, 'socrates')
  archive.setInsights('qq:1000', [{ id: 'ins1', text: '多用产婆术提问探讨', at: Date.now() }], '主人', { personaId: 'socrates' })
  archive.setStyle('self', ['知识即美德', '我唯一知道的就是我一无所知'], { personaId: 'socrates' })

  // 在 socrates 人设下：contextFor 应包含苏格拉底的内容
  const socratesCtx = archive.contextFor({ kind: 'private', userId: '1000' }, 'sess1')
  assert.ok(socratesCtx.includes('很有哲思'), 'socrates 上下文应注入自身的小档案')
  assert.ok(socratesCtx.includes('产婆术提问'), 'socrates 上下文应注入自身的相处经验')
  assert.ok(socratesCtx.includes('知识即美德'), 'socrates 上下文应注入自身的说话风格')

  // 切换到 dafeiyu 人设：上述属于 socrates 的主观条目不得注入
  setPersona('dafeiyu')
  const dafeiyuCtx = archive.contextFor({ kind: 'private', userId: '1000' }, 'sess1')
  assert.ok(!dafeiyuCtx.includes('很有哲思'), 'dafeiyu 上下文严禁注入 socrates 小档案')
  assert.ok(!dafeiyuCtx.includes('产婆术提问'), 'dafeiyu 上下文严禁注入 socrates 相处经验')
  assert.ok(!dafeiyuCtx.includes('知识即美德'), 'dafeiyu 上下文严禁注入 socrates 说话风格')

  // 切回 socrates：重新可见
  setPersona('socrates')
  const backCtx = archive.contextFor({ kind: 'private', userId: '1000' }, 'sess1')
  assert.ok(backCtx.includes('很有哲思'), '切回原人设后上下文恢复注入')
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
  const { archive, setPersona } = harness({ persona: 'socrates' })
  const r = archive.add({ text: '非法人设测试', source: 'auto', chatId: CHAT, scope: CHAT, personaId: '非法 id 带空格' })
  assert.equal(r.ok, true)
  // 回落到当前人设 socrates：在 socrates 下可见
  const socratesHits = archive.listFor([CHAT], { limit: 10 })
  assert.ok(socratesHits.some((m) => m.text.includes('非法人设测试')), '非法 personaId 应回落到当前人设')
  // 切换到 dafeiyu 不可见
  setPersona('dafeiyu')
  const dafeiyuHits = archive.listFor([CHAT], { limit: 10 })
  assert.ok(!dafeiyuHits.some((m) => m.text.includes('非法人设测试')), '异人设下不可见')
})

test('不同人设下的主观相似条目去重隔离（不发生跨人设合并）', () => {
  const { archive, setPersona } = harness({ persona: 'socrates' })
  archive.add({ text: '我觉得主人今天心情很好', source: 'auto', chatId: CHAT, scope: CHAT, kind: 'insight' })
  setPersona('dafeiyu')
  archive.add({ text: '我觉得主人今天心情很好', source: 'auto', chatId: CHAT, scope: CHAT, kind: 'insight' })

  // dafeiyu 下只有 1 条
  const dafeiyuList = archive.listFor([CHAT], { limit: 10 })
  assert.equal(dafeiyuList.length, 1)
  assert.equal(dafeiyuList[0].personaId, 'dafeiyu')

  // 切回 socrates 下也有 1 条，且 personaId 是 socrates
  setPersona('socrates')
  const socratesList = archive.listFor([CHAT], { limit: 10 })
  assert.equal(socratesList.length, 1)
  assert.equal(socratesList[0].personaId, 'socrates')
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
