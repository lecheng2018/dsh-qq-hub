import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildDistillPrompt } from '../prompt.mjs'
import { verifyAndCleanRules } from '../verifier.mjs'
import { createDistillStore } from '../store.mjs'
import { scanHistoryGroups, sampleGroupHistory } from '../history-miner.mjs'
import distillModule from '../index.mjs'

test('prompt: 正确生成带 [id:xx] 的提取提示词', () => {
  const lines = [
    { name: '群友A', text: '这把真的太难了' },
    { name: '群友B', text: '菜就多练，输不起别玩' }
  ]
  const { system, text } = buildDistillPrompt(lines)
  assert.match(text, /当 "AAAAA" 时，可以使用 "BBBBB"/)
  assert.match(text, /\[id:1\] \[name:群友A\]/)
  assert.match(text, /\[id:2\] \[name:群友B\]/)
})

test('verifier: 严格防自投毒（排除 Bot 自己）与排除真实生活经历', () => {
  const lines = [
    { name: 'Bot', isBot: true, text: '你好，我是大肥鱼' },
    { name: '群友A', isBot: false, text: '笑死我了，昨天我被封号了' },
    { name: '群友B', isBot: false, text: '确实有点东西' }
  ]

  const rawRules = [
    { situation: '打招呼', style: '使用 你好呀', source_id: 1 }, // 来源于 Bot -> 必须剔除
    { situation: '倒霉经历', style: '抱怨我被封号了', source_id: 2 }, // 冒充群友经历 -> 必须剔除
    { situation: '表示认可且带调侃', style: '使用 确实有点东西', source_id: 3 }, // 合法群友风格 -> 保留
    { situation: '瞎编的', style: '无源之水', source_id: 99 }, // 越界 ID -> 必须剔除
  ]

  const cleaned = verifyAndCleanRules(rawRules, lines)
  assert.equal(cleaned.length, 1)
  assert.equal(cleaned[0].situation, '表示认可且带调侃')
  assert.equal(cleaned[0].style, '使用 确实有点东西')
})

test('store: 规则存储、频次递增、锁定与容量淘汰机制', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'distill-test-'))
  try {
    const store = createDistillStore(dir)
    const gid = '123456'

    // 1. 添加初始规则
    store.addRules(gid, [
      { situation: '游戏逆风', style: '菜就多练' },
      { situation: '代码报错', style: '重启大法' },
      { situation: '抽卡爆死', style: '好似开香槟' }
    ], 3)

    let rules = store.getRawRules(gid)
    assert.equal(rules.length, 3)

    // 2. 锁定第一条规则
    const ruleA = rules.find(r => r.situation === '游戏逆风')
    const locked = store.toggleLock(gid, ruleA.id)
    assert.equal(locked, true)

    // 3. 重复添加近义规则 -> 频次累加
    store.addRules(gid, [{ situation: '游戏快输了时', style: '调侃 菜就多练' }], 3)
    rules = store.getRawRules(gid)
    const ruleAAfter = rules.find(r => r.id === ruleA.id)
    assert.equal(ruleAAfter.count, 2)

    // 4. 超容量添加情境D（总上限3条）：ruleA被锁定必保留，ruleA频次高（count=2）保留，代码报错最冷门被淘汰
    await new Promise(r => setTimeout(r, 5))
    store.addRules(gid, [{ situation: '吃饭点外卖', style: '直接点疯狂星期四' }], 3)
    rules = store.getRawRules(gid)
    assert.equal(rules.length, 3)
    assert.ok(rules.some(r => r.id === ruleA.id)) // locked A 保留
    assert.ok(rules.some(r => r.situation === '吃饭点外卖')) // 新规则 D 保留

    // 5. 门槛过滤验证：minCount = 2 时，只有 A 生效
    const active = store.getActiveRules(gid, 2)
    assert.equal(active.length, 1)
    assert.equal(active[0].id, ruleA.id)

    // 6. 情境匹配：严格命中
    const matched = store.matchRelevantRules(active, '今天游戏逆风局真难打', 2)
    assert.equal(matched.length, 1)
    assert.equal(matched[0].id, ruleA.id)

    // 7. 未命中时绝不盲目返回
    const noMatch = store.matchRelevantRules(active, '今天天气真不错适合散步', 2)
    assert.equal(noMatch.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('history-miner: 正确扫描群聊并采样过滤', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatlog-test-'))
  try {
    const fakeLog = [
      JSON.stringify({ t: 1000, chatId: 'group:999', who: '群友1', uid: '111', text: '群里今天真热闹' }),
      JSON.stringify({ t: 2000, chatId: 'group:999', who: '大肥鱼', uid: '222', text: '大家好呀' }), // Bot -> 应过滤
      JSON.stringify({ t: 3000, chatId: 'group:999', who: '群友2', uid: '333', text: '[图片]' }), // 纯表情 -> 应过滤
      JSON.stringify({ t: 4000, chatId: 'group:999', who: '群友1', uid: '111', text: '确实好活' }),
      JSON.stringify({ t: 5000, chatId: 'group:888', who: '群友3', uid: '444', text: '另一个群的消息' }),
    ].join('\n')
    writeFileSync(join(dir, '2026-11-16.jsonl'), fakeLog)

    const groups = scanHistoryGroups(dir)
    assert.equal(groups.length, 2)
    assert.equal(groups.find(g => g.groupId === '999').totalCount, 4)

    const samples = sampleGroupHistory(dir, '999', { days: 1, sampleSize: 10, botQQ: '222' })
    assert.equal(samples.length, 2)
    assert.equal(samples[0].text, '群里今天真热闹')
    assert.equal(samples[1].text, '确实好活')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('module runtime: 实时消息监听与缓冲累积', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'module-test-'))
  try {
    const listeners = new Map()
    const routes = new Map()
    let contextFn = null

    const mockApi = {
      dataDir: () => dir,
      settings: () => ({ enabled: true, batchSize: 5, activeGroups: '123' }),
      config: () => ({ botQQ: '10001' }),
      log: { info() {}, warn() {}, debug() {} },
      on: (event, fn) => { listeners.set(event, fn) },
      context: (fn) => { contextFn = fn },
      route: (path, fn) => { routes.set(path, fn) },
      later: (ms, fn) => setTimeout(fn, ms),
      ask: async () => '[]'
    }

    const mod = distillModule.setup(mockApi)
    const onMessage = listeners.get('message')
    assert.ok(typeof onMessage === 'function')

    // 1. 测试私聊消息 -> 被忽略
    const r1 = await onMessage({ kind: 'private', userId: '888', text: '你好' })
    assert.equal(r1, false)

    // 2. 测试 Bot 自身发言 -> 被忽略
    const r2 = await onMessage({ kind: 'group', groupId: '123', userId: '10001', text: '我是Bot' })
    assert.equal(r2, false)

    // 3. 测试未生效群 -> 被忽略
    const r3 = await onMessage({ kind: 'group', groupId: '456', userId: '888', text: '其他群发言' })
    assert.equal(r3, false)

    // 4. 测试合法群友发言 -> 正常接收并进入缓存
    const r4 = await onMessage({ kind: 'group', groupId: '123', userId: '888', nickname: '群友A', text: '第一句' })
    assert.equal(r4, false)

    const statusHandler = routes.get('/status')
    const status = await statusHandler()
    const groupStat = status.list.find(g => g.groupId === '123')
    assert.ok(groupStat)
    assert.equal(groupStat.bufferCount, 1)

    mod.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store: 分层规则库（全局共享底座 + 群专属优先覆盖 + 跨群频次累加 + 规则流转）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiered-distill-test-'))
  try {
    const store = createDistillStore(dir)

    // 1. 全局底座添加通用规则（count 初始 1）
    store.addRules('global', [
      { situation: '遇到bug', style: '调侃 重启电脑' },
      { situation: '抽卡出金', style: '发开香槟表情' },
    ], 10, { originGroup: 'groupA' })

    // 2. groupB 再次提炼出相近的全局规则 -> 频次聚类累加且合并来源群
    store.addRules('global', [
      { situation: '遇到代码bug时', style: '说重启电脑' },
    ], 10, { originGroup: 'groupB' })

    const globalRules = store.getRawRules('global')
    const bugRule = globalRules.find(r => r.situation.includes('bug'))
    assert.ok(bugRule)
    assert.equal(bugRule.count, 2)
    assert.deepEqual(bugRule.sourceGroups.sort(), ['groupA', 'groupB'].sort())

    // 3. 群 999 继承全局规则
    let activeIn999 = store.getActiveRules('999', 2, { includeGlobal: true })
    assert.equal(activeIn999.length, 1) // bugRule 频次达到 2
    assert.equal(activeIn999[0].isGlobal, true)

    // 4. 群 999 自定义群专属规则（覆盖全局的 bug 规则）
    store.addRules('999', [
      { situation: '遇到bug', style: '本群专属黑话 找群主修' },
    ], 10)
    store.promoteCandidate('999', store.getRawRules('999')[0].id) // 锁定转正

    // 再次读取群 999 的正式规则：本地近义优先，全局被遮蔽
    activeIn999 = store.getActiveRules('999', 2, { includeGlobal: true })
    const activeBug = activeIn999.find(r => r.situation.includes('bug'))
    assert.equal(activeBug.style, '本群专属黑话 找群主修')
    assert.equal(activeBug.isGlobal, false)

    // 5. 将群 999 的专属规则设为全局共享 (scopeRule)
    const localRuleId = activeBug.id
    const migrated = store.scopeRule('999', 'global', localRuleId)
    assert.equal(migrated, true)
    // 999 本地已移除
    assert.equal(store.getRawRules('999').length, 0)
    // global 已增加/合并
    assert.ok(store.getRawRules('global').some(r => r.id === localRuleId || r.style.includes('找群主修')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('module: 全局共享底座与分层路由与注入验证', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiered-mod-test-'))
  try {
    const listeners = new Map()
    const routes = new Map()
    let contextFn = null

    const mockApi = {
      dataDir: () => dir,
      settings: () => ({ enabled: true, globalSharing: true, minPromotionCount: 2 }),
      config: () => ({ botQQ: '10001' }),
      log: { info() {}, warn() {}, debug() {} },
      on: (event, fn) => { listeners.set(event, fn) },
      context: (fn) => { contextFn = fn },
      route: (path, fn) => { routes.set(path, fn) },
      later: (ms, fn) => setTimeout(fn, ms),
      ask: async () => '[]'
    }

    const mod = distillModule.setup(mockApi)

    // 手动录入一条全局规则
    const addManualHandler = routes.get('/add-manual')
    await addManualHandler({
      scope: 'global',
      situation: '聊到发工资',
      style: '请客吃大餐'
    })

    // 1. 测试 /status 路由：首项为 global，且 isGlobal 为 true
    const statusHandler = routes.get('/status')
    const statusRes = await statusHandler()
    assert.equal(statusRes.ok, true)
    assert.equal(statusRes.list[0].groupId, 'global')
    assert.equal(statusRes.list[0].isGlobal, true)
    assert.equal(statusRes.list[0].activeCount, 1)

    // 2. 测试 /rules 路由：对于新群 777，在 globalSharing 开启时继承 global 规则
    const rulesHandler = routes.get('/rules')
    const rulesRes = await rulesHandler({ url: 'http://localhost/rules?groupId=777' })
    assert.equal(rulesRes.ok, true)
    assert.equal(rulesRes.activeRules.length, 1)
    assert.equal(rulesRes.activeRules[0].isGlobal, true)
    assert.equal(rulesRes.activeRules[0].situation, '聊到发工资')

    // 3. 测试上下文注入命中
    const onMessage = listeners.get('message')
    await onMessage({
      kind: 'group',
      groupId: '777',
      userId: '888',
      nickname: '群友小王',
      text: '今天公司发工资啦！',
    })

    const ctx = contextFn({ chat: { kind: 'group', groupId: '777' } })
    assert.match(ctx, /聊到「发工资」时群友常带的语调：请客吃大餐/)

    mod.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
