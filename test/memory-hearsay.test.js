// 传闻标记（上游 607090a 语义移植）：写入时归因 speaker/status，
// 传闻不进人物档案链路（fail-closed 加固），普通召回仍命中并带「听X说」标注。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'
import { memoryLine } from '../src/features/memory-core.js'

function fixture(t, stream) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-hearsay-'))
  const previous = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const store = createMemoryStore({
    dsh: { llm: { stream: stream || (async function* () { yield { type: 'text-delta', text: '小张的当前画像。' } }) } },
    getConfig: () => ({ ownerQQ: '10001', model: { provider: 'test', model: 'm' }, memory: { enabled: true, recallCount: 4 } }),
    log: { info() {}, warn() {} },
  })
  t.after(() => {
    store.dispose()
    if (previous === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

test('add 归因字段落盘：speaker/status 持久化，普通召回仍命中 hearsay', (t) => {
  const store = fixture(t)
  const chat = { kind: 'private', userId: '10002', chatId: 'private:10002' }
  const r = store.add({ text: '小张喜欢喝乌龙茶', about: '10002', scope: 'private:10002', speaker: '小李', status: 'hearsay' })
  assert.equal(r.ok, true)
  const hits = store.recall('乌龙茶', { chat })
  assert.equal(hits.length, 1, '传闻仍可被普通召回搜到')
  assert.equal(hits[0].it.speaker, '小李')
  assert.equal(hits[0].it.status, 'hearsay')
})

test('老数据兼容：无 status 字段视为 direct，不加传闻标注', (t) => {
  const store = fixture(t)
  const chat = { kind: 'private', userId: '10002', chatId: 'private:10002' }
  store.add({ text: '小张喜欢喝乌龙茶', about: '10002', scope: 'private:10002' })
  const it = store.recall('乌龙茶', { chat })[0].it
  assert.equal(it.status, undefined)
  assert.equal(it.speaker, undefined)
  assert.doesNotMatch(memoryLine(it), /听.*说/)
})

test('memoryLine 传闻标注：带说话人/不带说话人', () => {
  const base = { at: Date.now(), aboutName: '小张', text: '喜欢乌龙茶' }
  assert.match(memoryLine({ ...base, status: 'hearsay', speaker: '小李' }), /（听小李说）/)
  assert.match(memoryLine({ ...base, status: 'hearsay' }), /（听别人说）/)
  assert.doesNotMatch(memoryLine({ ...base, status: 'guess' }), /听.*说/)
})

test('buildProfile 排除 hearsay：来源事实不含传闻条目', async (t) => {
  const prompts = []
  const store = fixture(t, async function* (opts) { prompts.push(JSON.stringify(opts)); yield { type: 'text-delta', text: '小张的当前画像。' } })
  const ids = []
  for (const text of ['小张喜欢乌龙茶', '小张常去北郊骑车', '小张最近在学习摄影']) {
    ids.push(store.add({ text, about: '10002', aboutName: '小张', scope: 'private:10002' }).id)
  }
  const hearsay = store.add({ text: '小张好像要出国', about: '10002', aboutName: '小张', scope: 'private:10002', speaker: '路人', status: 'hearsay' })
  assert.equal(await store.buildProfile('10002', 'private:10002'), true)
  const prof = store.profileOf('10002', 'private:10002')
  assert.deepEqual(prof.sourceFactIds, ids, '传闻不进档案来源')
  assert.equal(prompts.some((p) => p.includes('小张好像要出国')), false, '传闻不喂给档案模型')
})

test('只有传闻事实时不写档案（fail-closed）', async (t) => {
  const store = fixture(t)
  for (const text of ['听说小张喜欢乌龙茶', '听说小张常去骑车', '听说小张在学摄影']) {
    store.add({ text, about: '10002', aboutName: '小张', scope: 'private:10002', status: 'hearsay' })
  }
  assert.equal(await store.buildProfile('10002', 'private:10002'), false)
  assert.equal(store.profileOf('10002', 'private:10002'), null)
})

test('guess 状态持久化（bot 自动提炼标记）', (t) => {
  const store = fixture(t)
  const chat = { kind: 'private', userId: '10002', chatId: 'private:10002' }
  store.add({ text: '小张可能喜欢摄影', about: '10002', scope: 'private:10002', status: 'guess' })
  assert.equal(store.recall('摄影', { chat })[0].it.status, 'guess')
})

test('/remember 命令归因：群聊 speaker、--hearsay、听X说前缀', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hearsay-cmd-'))
  const prev = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const { parseCommand, runCommand, createMutes } = await import('../src/chat/commands.js')
  t.after(() => {
    if (prev === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
  const entries = []
  const deps = {
    getConfig: () => ({ ownerQQ: '10001', ownerName: '主人', group: { overrides: {} } }),
    setConfig: () => {},
    mutes: createMutes(),
    hub: { resetChat() {} },
    memory: { add: (x) => { entries.push(x); return { ok: true, id: 'm1' } } },
    qzone: null,
  }
  const grp = { kind: 'group', chatId: 'group:555', groupId: '555', userId: '10000001' }
  const priv = { kind: 'private', chatId: 'private:10001', userId: '10001' }

  assert.match(await runCommand(parseCommand('/记住小张喜欢乌龙茶'), grp, deps), /记住了/)
  assert.equal(entries.at(-1).speaker, '10000001', '群聊记录实际发言人')
  assert.equal(entries.at(-1).status, '')

  await runCommand(parseCommand('/remember --hearsay 小张喜欢乌龙茶'), grp, deps)
  assert.equal(entries.at(-1).status, 'hearsay')
  assert.equal(entries.at(-1).text, '小张喜欢乌龙茶')

  await runCommand(parseCommand('/记住听小李说小张喜欢乌龙茶'), grp, deps)
  assert.equal(entries.at(-1).status, 'hearsay')
  assert.equal(entries.at(-1).speaker, '小李')
  assert.equal(entries.at(-1).text, '小张喜欢乌龙茶')

  await runCommand(parseCommand('/记住我不吃香菜'), priv, deps)
  assert.equal(entries.at(-1).speaker, '', '私聊默认主人亲述')
  assert.equal(entries.at(-1).status, '')

  assert.match(await runCommand(parseCommand('/remember --hearsay'), grp, deps), /要我记住什么/)
})
