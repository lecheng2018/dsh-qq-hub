import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'
import { search, buildIndex } from '../src/features/memory-core.js'

let dir, store, cfg

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-supersede-test-'))
  process.env.AURABOT_DATA_DIR = dir
  cfg = { ownerQQ: '10001', memory: { enabled: true, recallCount: 4 } }
  store = createMemoryStore({
    dsh: {},
    getConfig: () => cfg,
    hub: { chatLogOf: () => [], chatLogDays: () => [] },
    log: console,
    personaText: () => '',
  })
})

test('supersede: 事实替代原子操作，旧事实失效且新旧关联明确', () => {
  // 1. 添加一条初始事实
  const addRes = store.add({
    text: '小明喜欢喝可乐',
    about: '10002',
    aboutName: '小明',
    scope: 'private:10001',
    importance: 0.6,
  })
  assert.ok(addRes.ok && addRes.id)
  const oldId = addRes.id

  // 初始时能检索到
  const hits1 = store.recall('可乐', { chat: { kind: 'private', userId: '10001' } })
  assert.equal(hits1.length, 1)
  assert.equal(hits1[0].it.id, oldId)

  // 2. 执行原子替代 (小明改口不喝可乐了，改喝乌龙茶)
  const superRes = store.supersede({
    oldId,
    text: '小明已经戒掉可乐了，现在只喝无糖乌龙茶',
    about: '10002',
    aboutName: '小明',
    scope: 'private:10001',
    importance: 0.8,
    evidence: '本人亲口确认：“早戒了，现在只喝茶”',
    entity: '乌龙茶',
    topic: '饮食',
  })
  assert.ok(superRes.ok)
  const newId = superRes.id
  assert.notEqual(newId, oldId)

  // 3. 验证检索行为：默认不召回已失效的旧事实，只召回新事实
  const hitsCola = store.recall('可乐', { chat: { kind: 'private', userId: '10001' } })
  // 新事实也包含可乐（说明戒了），但旧事实绝对退出
  assert.ok(hitsCola.every((h) => h.it.id !== oldId), '旧事实不应被默认召回')
  assert.ok(hitsCola.some((h) => h.it.id === newId), '新事实应当被召回')

  // 4. 验证存储记录中的替代关系
  const all = store.indexAll()
  const oldDoc = all.docs.find((d) => d.it.id === oldId)
  assert.ok(oldDoc)
  assert.ok(oldDoc.it.invalidAt > 0, '旧事实必须打上 invalidAt 标记')
  assert.equal(oldDoc.it.supersededBy, newId, '旧事实必须记录 supersededBy 指向新事实')
})

test('supersede: 手工固定的事实（pinned）受保护，禁止被自动替代', () => {
  const pinRes = store.add({
    text: '主人的生日是10月24日',
    about: '10001',
    aboutName: '主人',
    scope: 'private:10001',
    pinned: true,
  })
  assert.ok(pinRes.id)

  const failRes = store.supersede({
    oldId: pinRes.id,
    text: '主人的生日是1月1日',
    scope: 'private:10001',
  })
  assert.equal(failRes.ok, false)
  assert.ok(failRes.message.includes('手工固定的重要事实不能自动被替代'))
})

test('supersede: 跨作用域防护，不同作用域事实禁止相互替代', () => {
  const grpRes = store.add({
    text: '群里推荐买中兴F50随身WiFi',
    scope: 'group:111222333',
  })
  assert.ok(grpRes.id)

  const crossRes = store.supersede({
    oldId: grpRes.id,
    text: '别买F50',
    scope: 'group:995845542', // 不同的群
  })
  assert.equal(crossRes.ok, false)
  assert.ok(crossRes.message.includes('不同作用域'))
})

test('entity-slot: 实体槽位直召测试（C-03 规范）', () => {
  const testItems = [
    {
      id: 'r_g7615',
      text: '这款光猫发热挺大的，买二手注意看芯片批次。',
      entity: 'g7615',
      topic: '数码硬件',
      importance: 0.6,
      at: Date.now(),
    },
    {
      id: 'r_other',
      text: '今天天气真不错，出去散步了一圈。',
      importance: 0.5,
      at: Date.now(),
    },
  ]

  const idx = buildIndex(testItems)
  const results = search(idx, '请问G7615怎么样啊')

  assert.ok(results.length > 0)
  assert.equal(results[0].it.id, 'r_g7615')
  assert.ok(results[0].why.includes('（实体命中）'), '检索原因中必须包含实体命中标记')
  assert.ok(results[0].score > 1.5, '实体命中必须获得高置信度打分加权')
})

test('non-destructive clarity: 整理记忆时不截断、不破坏原始正文', async () => {
  const evRes = store.addEvent({
    text: '在B站看了关于软路由与低功耗NAS装机长文，讲了很长一段配置思路与踩坑实录',
    importance: 0.45,
    scope: 'private:10001',
    ephemeral: true,
  })
  assert.ok(evRes.id)

  // 执行一次整理
  await store.consolidate({ includeToday: true })

  // 验证正文完整无损，没有被切成 “...（记不太清了）”
  const items = store.recall('软路由', { chat: { kind: 'private', userId: '10001' } })
  assert.ok(items.length > 0)
  const item = items[0].it
  assert.ok(item.text.includes('低功耗NAS装机长文'), '原始正文必须完整无损')
  assert.ok(!item.text.includes('记不太清了'), '绝对不应篡改或破坏正文')
})
