// 回归测试：PR2（记忆 CAS 自愈、防空烧风暴、中文人设隔离、删卡安全、淘汰/缓存/向量/梦境、LLM 超时信号、config 一次性迁移）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeJsonWithBackup } from '../src/core/store.js'
import { openMemoryFiles } from '../src/features/memory-files.js'
import { createMemoryStore, evictScopeItems } from '../src/features/memory.js'
import { createMemoryLearning } from '../src/features/memory-learning.js'
import { createMemoryExtractor } from '../src/features/memory-extractor.js'
import { createVectorChannel } from '../src/features/memory-vector.js'
import { consolidate as dreamConsolidatePure } from '../src/features/memory-dream.js'
import { normalizePersonaId, withPersonaId, isEntryVisibleToPersona } from '../src/features/memory-persona-track.js'
import { registerPersonaRoutes } from '../src/host/panel/routes-persona.js'
import { savePersona } from '../src/persona/personas.js'
import { askModel, describeWithHelper, clearVisionCache } from '../src/core/llm.js'
import { DEFAULTS, PROFILE_PERMS_VERSION, normalize, mergeFromPanel } from '../src/core/config.js'

function withTempDataDir(t, prefix = 'pr2-mem-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const prevDsh = process.env.DSH_QQ_HUB_DATA_DIR
  const prevAura = process.env.AURABOT_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (prevDsh === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevDsh
    if (prevAura === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevAura
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

const quietLog = () => {
  const warns = []
  const infos = []
  return {
    warns,
    infos,
    warn: (...args) => warns.push(args.map(String).join(' ')),
    info: (...args) => infos.push(args.map(String).join(' ')),
    debug: () => {},
    error: (...args) => warns.push(args.map(String).join(' ')),
  }
}

// ---------------- 1. P0: store.js .bak 容错 & memory-files.js CAS 自愈合并 ----------------

test('store.writeJsonWithBackup：.bak 写入失败不阻断主文件提交返回，且 memory-files 保持 stateRaw 同步', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pr2-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'state.json')
  // 用同名目录占据 state.json.bak，迫使 .bak 写入抛 EISDIR/ENOTDIR
  mkdirSync(`${file}.bak`, { recursive: true })
  const errors = []
  assert.doesNotThrow(() => {
    writeJsonWithBackup(file, { version: 1, processed: { today: 1 } }, {
      validate: (v) => Boolean(v && v.version === 1),
      onError: (e) => errors.push(e.message),
    })
  })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, processed: { today: 1 } })
  assert.equal(errors.length, 1, '应通过 onError 记录 .bak 失败告警而不抛错')

  // openMemoryFiles 在 .bak 目录阻塞下连续两次 save 均成功，不触发 stateRaw 失步死锁
  const log = quietLog()
  const store = openMemoryFiles(dir, { log })
  t.after(() => store.close())
  const s1 = store.load()
  s1.processed.today = 2
  assert.doesNotThrow(() => store.save(s1))
  const s2 = store.load()
  s2.processed.today = 3
  assert.doesNotThrow(() => store.save(s2))
  assert.equal(store.load().processed.today, 3)
})

test('memory-files.save：外部合法改动 state.json 时自动重载并合并增量，且 warn 限频；损坏仍抛错', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pr2-cas-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = quietLog()
  const store = openMemoryFiles(dir, { log })
  t.after(() => store.close())

  const s0 = store.load()
  s0.items.push({ id: 'm1', text: '测试事实', scope: 'private:10001', at: 1000, hits: 2, hitDays: 1, lastHit: 1000 })
  s0.runs = { '04:00': '2026-11-26' }
  s0.processed = { '2026-11-26': 10 }
  store.save(s0)

  // 模拟外部进程合法更新 state.json：hits.m1 增到 5，新增 runs['16:00'] 与 processed['2026-11-25']
  const statePath = join(dir, 'state.json')
  const disk = JSON.parse(readFileSync(statePath, 'utf8'))
  disk.hits.m1 = { hits: 5, hitDays: 2, lastHit: 2000 }
  disk.hits.m2 = { hits: 1, hitDays: 1, lastHit: 2000 }
  disk.runs['16:00'] = '2026-11-26'
  disk.processed['2026-11-25'] = 99
  writeFileSync(statePath, JSON.stringify(disk, null, 2))

  // 当前进程基于旧快照只加了 +1 hit 并改写 processed['2026-11-26'] = 25
  const s1 = store.load()
  s1.items[0].hits = 3
  s1.items[0].lastHit = 3000
  s1.processed['2026-11-26'] = 25
  assert.doesNotThrow(() => store.save(s1))

  const after = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(after.hits.m1.hits, 6, 'hits 应按增量累加（5 + 1 = 6）')
  assert.equal(after.hits.m1.lastHit, 3000, 'lastHit 取最新值')
  assert.equal(after.hits.m2.hits, 1, '外部新增的 hits.m2 应保留')
  assert.equal(after.runs['16:00'], '2026-11-26', '外部新增的 runs 应保留')
  assert.equal(after.processed['2026-11-25'], 99, '外部新增的 processed 应保留')
  assert.equal(after.processed['2026-11-26'], 25, '当前写入对目标字段的修改应优先覆盖')
  assert.equal(log.warns.length, 1, '应输出一条限频 warn 日志')

  // 立即再次外部修改并保存：warn 应被限频，不再刷屏
  const disk2 = JSON.parse(readFileSync(statePath, 'utf8'))
  disk2.runs['20:00'] = '2026-11-26'
  writeFileSync(statePath, JSON.stringify(disk2, null, 2))
  assert.doesNotThrow(() => store.save(store.load()))
  assert.equal(log.warns.length, 1, '限频窗口内不重复刷 warn')

  // 若磁盘 state.json 损坏：仍必须抛错阻止写入
  writeFileSync(statePath, '{corrupt json')
  assert.throws(() => store.save(store.load()), /外部被修改|重载/)
})

// ---------------- 2. P0: inMemoryRetry 切断无限重跑风暴 & batchState.start 不永久熔断 ----------------

test('memory-learning.tick：save() 持续失败时进程内退避依然生效，彻底切断无限重跑风暴', async () => {
  let llmCalls = 0
  let saveAttempts = 0
  const today = new Date()
  const yest = new Date(today.getTime() - 86_400_000)
  const yestKey = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, '0')}-${String(yest.getDate()).padStart(2, '0')}`
  const lines = Array.from({ length: 6 }, (_, i) => ({ chatId: 'private:10002', who: '测试用户', text: `具体聊天内容第 ${i} 条` }))

  const learning = createMemoryLearning({
    dsh: {
      get: () => null,
      llm: {
        async *stream() {
          llmCalls++
          yield { type: 'text-delta', text: '[]' }
        },
      },
    },
    getConfig: () => ({ ownerQQ: '10001', model: { provider: 'p', model: 'm' }, memory: { enabled: true, dailyConsolidate: true, consolidateTimes: ['00:00'] } }),
    hub: { chatLogDays: () => [yestKey], chatLogOf: () => lines },
    log: quietLog(),
    isActive: () => true,
    createGenerationSignal: () => ({ signal: new AbortController().signal, isValid: () => true, cleanup: () => {} }),
    generationOf: () => ({ signal: { signal: new AbortController().signal, isValid: () => true }, cleanup: () => {} }),
    load: () => ({ items: [], processed: {}, processedSources: {}, extractionBatches: {}, runs: {}, lastConsolidate: {} }),
    save: () => {
      saveAttempts++
      throw new Error('记忆运行状态已在外部被修改，请先重载档案')
    },
    health: () => ({ ok: true }),
    relatedTo: () => [],
    add: () => ({ ok: true }),
    addMany: () => ({ ok: true, added: 0, updated: 0, skipped: 0 }),
    revise: () => true,
    supersede: () => ({ ok: true }),
    invalidate: () => true,
    invalidateMany: () => 0,
    scopeFromChatId: (c) => c,
    listFor: () => [],
    profileOf: () => null,
    setDerivedProfile: () => true,
    profileKeyOf: (qq, sc) => `${qq}@${sc}`,
    insightsOf: () => [],
    setDerivedInsights: () => {},
    styleOf: () => [],
    setDerivedStyle: () => {},
    personKey: () => '',
  })

  await learning.api.tick()
  const savesAfterFirst = saveAttempts
  assert.ok(savesAfterFirst >= 1)
  assert.equal(llmCalls, 0, 'batchState.start 失败时不应调模型')

  // 紧接着连续再跑 5 次 tick：全部被 inMemoryRetry 冷却期拦截，0 次额外 save/LLM
  for (let i = 0; i < 5; i++) await learning.api.tick()
  assert.equal(saveAttempts, savesAfterFirst, '冷却期内不得继续重试')
  assert.equal(llmCalls, 0)

  // 验证 batchState.start 失败没有触发永久 batchRecoveryError
  const r = await learning.api.consolidate({ includeToday: true })
  assert.equal(r.ok, false)
  assert.doesNotMatch(r.message || '', /自动整理已暂停/, 'batchState.start 失败不应置入永久恢复熔断')
})

// ---------------- 3. P0: consolidate 全败且存储错误时短路跳过 buildProfile ----------------

test('memory-extractor.consolidate：全部聊天提炼失败且存在存储错误时短路跳过 buildProfile 循环', async () => {
  let profileCalls = 0
  const today = new Date()
  const yest = new Date(today.getTime() - 86_400_000)
  const yestKey = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, '0')}-${String(yest.getDate()).padStart(2, '0')}`
  const lines = Array.from({ length: 6 }, (_, i) => ({ chatId: 'private:10002', who: '小明', text: `有价值的事实 ${i}` }))
  const items = [
    { id: '1', about: '10002', scope: 'private:10002', text: '事实1', at: 1 },
    { id: '2', about: '10002', scope: 'private:10002', text: '事实2', at: 2 },
    { id: '3', about: '10002', scope: 'private:10002', text: '事实3', at: 3 },
  ]

  const extractor = createMemoryExtractor({
    dsh: { get: () => null, llm: { async *stream() { yield { type: 'text-delta', text: '[]' } } } },
    getConfig: () => ({ ownerQQ: '10001', model: { provider: 'p', model: 'm' }, memory: { enabled: true } }),
    relatedTo: () => [],
    commit: () => true,
    isActive: () => true,
    addMany: () => ({ ok: true, added: 0 }),
    reflect: async () => {},
    batchState: {
      get: () => null,
      start: () => { throw new Error('记忆运行状态已在外部被修改，请先重载档案') },
      fail: () => {},
      done: () => {},
    },
    scopeOf: (c) => c,
    recoveryError: () => '',
    log: quietLog(),
    consolidation: {
      health: () => ({ ok: true }),
      load: () => ({ items, profiles: {}, processed: {}, processedSources: {}, lastConsolidate: {} }),
      save: () => { throw new Error('不应该走到末尾 save') },
      chatLogDays: () => [yestKey],
      chatLogSnapshot: () => ({ records: lines, hash: 'a'.repeat(64) }),
      buildProfile: async () => { profileCalls++; return true },
      profileKeyOf: (qq, sc) => `${qq}@${sc}`,
      createGenerationSignal: () => ({ signal: new AbortController().signal, isValid: () => true, cleanup: () => {} }),
    },
  })

  const res = await extractor.consolidate({ includeToday: true })
  assert.equal(res.ok, false)
  assert.equal(profileCalls, 0, '存储错误导致全败时必须短路跳过 buildProfile，防止空烧 LLM')
  assert.match(res.message, /跳过人物档案重建/)
})

// ---------------- 4. P1: 中文人设 ID 隔离、四处 personaVisible 过滤、删卡安全 ----------------

test('人设双轨：中文人设 ID 不再塌缩成 dafeiyu，且 recentEventsFor/hintBody/relatedTo/topicScore 全链路隔离', (t) => {
  withTempDataDir(t, 'pr2-persona-')
  assert.equal(normalizePersonaId('清冷剑修'), '清冷剑修')
  assert.equal(normalizePersonaId('元气猫娘_1'), '元气猫娘_1')
  const subA = withPersonaId({ kind: 'insight', text: '剑修视角' }, '清冷剑修')
  const subB = withPersonaId({ kind: 'insight', text: '猫娘视角' }, '元气猫娘_1')
  assert.equal(subA.personaId, '清冷剑修')
  assert.equal(subB.personaId, '元气猫娘_1')
  assert.equal(isEntryVisibleToPersona(subA, '元气猫娘_1'), false)
  assert.equal(isEntryVisibleToPersona(subA, '清冷剑修'), true)

  const cfg = {
    ownerQQ: '10001',
    persona: { current: '清冷剑修', privates: { '10001': '清冷剑修' }, groups: { '20001': '清冷剑修' } },
    memory: { enabled: true, recallCount: 6, hintCount: 6, hintMaxChars: 600 },
  }
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => cfg,
    hub: { chatLogDays: () => [], chatLogOf: () => [] },
    log: quietLog(),
    personaText: () => '',
  })
  t.after(() => store.dispose())

  store.add({ text: '剑修觉得青莲茶最清雅', about: '10001', scope: 'private:10001', kind: 'insight', personaId: '清冷剑修', importance: 0.9 })
  store.add({ text: '剑修今日练剑三百回', scope: 'private:10001', source: 'event', kind: 'insight', personaId: '清冷剑修', importance: 0.8 })
  store.add({ text: '猫娘最爱小鱼干喵呜', about: '10001', scope: 'private:10001', kind: 'insight', personaId: '元气猫娘_1', importance: 0.95 })
  store.add({ text: '猫娘今天追了激光笔', scope: 'private:10001', source: 'event', kind: 'insight', personaId: '元气猫娘_1', importance: 0.9 })

  const chat = { kind: 'private', userId: '10001', chatId: 'private:10001' }

  // 1) recentEventsFor 过滤
  const evts = store.recentEventsFor(['private:10001'], 24, 10)
  assert.equal(evts.length, 1)
  assert.match(evts[0].text, /剑修今日练剑/)

  // 2) hintBody 泛问兜底过滤
  const hint = store.recallHint(chat, '随便聊聊完全不搭界的词xyz')
  assert.match(hint, /剑修/)
  assert.doesNotMatch(hint, /猫娘/)

  // 3) relatedTo 过滤
  const rel = store.relatedTo('private:10001', '用户(10001): 小鱼干喵呜 青莲茶')
  assert.ok(rel.every((m) => !m.text.includes('猫娘')), 'relatedTo 不得泄露其他人设的主观记忆')
  assert.ok(rel.some((m) => m.text.includes('青莲茶')))

  // 4) topicScore 过滤
  assert.equal(store.topicScore('猫娘最爱小鱼干喵呜', chat), 0, 'topicScore 对其他人设的主观记忆应返回 0')
  assert.ok(store.topicScore('剑修觉得青莲茶最清雅', chat) > 0, 'topicScore 对当前人设的主观记忆应正常打分')
})

test('routes-persona：/persona/delete 禁止删除任意层级正在使用的人设；/persona/save 按 p.id 重置会话', async (t) => {
  withTempDataDir(t, 'pr2-routes-persona-')
  savePersona('cardA', { name: '卡A', tags: [], body: '正文A' })
  savePersona('cardB', { name: '卡B', tags: [], body: '正文B' })
  savePersona('cardC', { name: '卡C', tags: [], body: '正文C' })
  savePersona('cardD', { name: '卡D', tags: [], body: '正文D' })
  savePersona('cardE', { name: '卡E', tags: [], body: '正文E' })
  savePersona('unusedCard', { name: '闲置', tags: [], body: '正文闲置' })

  const cfg = {
    persona: {
      current: 'cardA',
      privateDefault: 'cardB',
      groupDefault: 'cardC',
      privates: { '10001': 'cardD' },
      groups: { '20001': 'cardE' },
    },
  }
  const routes = new Map()
  const resetChats = []
  registerPersonaRoutes({
    route: (path, fn) => routes.set(path, fn),
    readBody: async (req) => req.body,
    query: (req) => req.query || {},
    ctx: {},
    getConfig: () => cfg,
    setConfig: () => {},
    hub: {
      sessions: () => ({ 'private:10001': { personaId: 'cardD' } }),
      resetChat: (chatId) => { resetChats.push(chatId); return true },
    },
    log: quietLog(),
  })

  const del = routes.get('/persona/delete')
  for (const used of ['cardA', 'cardB', 'cardC', 'cardD', 'cardE']) {
    const r = await del({ body: { id: used } })
    assert.equal(r.ok, false, `正在使用的 ${used} 不应允许删除`)
  }
  const delUnused = await del({ body: { id: 'unusedCard' } })
  assert.equal(delUnused.ok, true, '未被任何字段使用的人设卡应可正常删除')

  // /persona/save 传入含非 safeId 字符的 id（如 "cardD!!!"），p.id 为 "cardD"，应命中并重置会话
  const save = routes.get('/persona/save')
  const sr = await save({ body: { id: 'cardD!!!', name: '卡D新', tags: [], body: '新正文D' } })
  assert.equal(sr.ok, true)
  assert.equal(sr.persona.id, 'cardD')
  assert.deepEqual(resetChats, ['private:10001'], '应按 safeId 后的 p.id 重置使用该人设的会话')
})

// ---------------- 5. P1: 淘汰保护 pinned & 墓碑先汰 ----------------

test('evictScopeItems：绝不自动淘汰 pinned，优先淘汰已失效墓碑', () => {
  const items = [
    { id: 'pin1', scope: 'private:10001', pinned: 1, importance: 0.01, source: 'auto', at: 1 },
    { id: 'tomb1', scope: 'private:10001', invalidAt: 5000, importance: 0.99, source: 'panel', at: 9999 },
    { id: 'live1', scope: 'private:10001', importance: 0.2, source: 'auto', at: 10 },
    { id: 'live2', scope: 'private:10001', importance: 0.8, source: 'tool', at: 20 },
  ]
  const evicted = []
  const removed = evictScopeItems(items, 'private:10001', 2, Date.now(), evicted)
  assert.equal(removed, 2)
  const remainingIds = items.map((m) => m.id)
  assert.ok(remainingIds.includes('pin1'), 'pinned 条目绝不可被自动淘汰')
  assert.ok(remainingIds.includes('live2'), '高重要度有效条目应保留')
  assert.ok(!remainingIds.includes('tomb1'), '高重要度墓碑也应优先被淘汰')
  assert.ok(!remainingIds.includes('live1'), '低重要度有效条目随后淘汰')
  assert.equal(evicted.length, 2)
})

// ---------------- 6. P1: indexFor 防缓存投毒、tokCache 失效、reload 清空 pendingHitUpdates、reportMiss 单次保存 ----------------

test('indexFor：区分 chatLike 与 scopeOverrideFn 放行结果，杜绝 relatedTo 与 recall 缓存投毒', (t) => {
  withTempDataDir(t, 'pr2-indexfor-')
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => ({ ownerQQ: '10001', memory: { enabled: true, recallCount: 6 } }),
    hub: { chatLogDays: () => [], chatLogOf: () => [] },
    log: quietLog(),
  })
  t.after(() => store.dispose())

  store.add({ text: '主人的私密暗号是蓝鲸鱼', scope: 'private:10001', importance: 0.8 })
  store.add({ text: '群里大家约好周末爬山', scope: 'group:20001', importance: 0.8 })

  let allowCross = true
  store.registerScopeOverride((sc, chat) => allowCross && sc === 'private:10001' && chat?.groupId === '20001')

  const groupChat = { kind: 'group', groupId: '20001', chatId: 'group:20001' }
  const idxStr = store.indexFor('group:20001')
  assert.equal(idxStr.docs.some((d) => d.it.text.includes('蓝鲸鱼')), false, '字符串 scope 索引不得含私聊记忆')

  const idxChat = store.indexFor(groupChat)
  assert.equal(idxChat.docs.some((d) => d.it.text.includes('蓝鲸鱼')), true, 'chat 对象开启 override 时应能看到放行域')

  const idxStrAgain = store.indexFor('group:20001')
  assert.equal(idxStrAgain.docs.some((d) => d.it.text.includes('蓝鲸鱼')), false, 'chat 索引不得反向投毒字符串 scope 索引')

  allowCross = false
  const idxChatOff = store.indexFor(groupChat)
  assert.equal(idxChatOff.docs.some((d) => d.it.text.includes('蓝鲸鱼')), false, '关闭 override 后缓存键变化，立即失效')
})

test('tokCache & reload & reportMiss：修改正文后去重不走陈旧切词；reload 清空 pendingHitUpdates；reportMiss 单次落盘', (t) => {
  withTempDataDir(t, 'pr2-tok-miss-')
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => ({ ownerQQ: '10001', memory: { enabled: true, recallCount: 6 } }),
    hub: { chatLogDays: () => [], chatLogOf: () => [] },
    log: quietLog(),
  })
  t.after(() => store.dispose())

  const a = store.add({ text: '小明养了一只橘猫叫大橘', scope: 'private:10001', importance: 0.8 })
  const b = store.add({ text: '小明每天早上喝冰美式咖啡', scope: 'private:10001', importance: 0.8 })
  store.add({ text: '完全无关的新事实一二三四', scope: 'private:10001' })
  store.update(a.id, { text: '小明周末喜欢打羽毛球比赛' })
  const dupRes = store.add({ text: '小明周末喜欢打羽毛球比赛哟', scope: 'private:10001' })
  assert.equal(dupRes.updated, a.id, 'update 正文后 tokCache 应失效，新条目应正确去重合并')

  const chat = { kind: 'private', userId: '10001', chatId: 'private:10001' }
  const hits = store.recall('小明 羽毛球 冰美式', { chat, where: 'private:10001' })
  assert.ok(hits.length >= 2)
  store.reload()
  store.add({ text: '第三条独立事实验证命中清零', scope: 'private:10001' })
  const afterReload = store.listFor(['private:10001']).find((x) => x.id === b.id)
  assert.equal(afterReload.hits, 0, 'reload() 应同步清空 pendingHitUpdates')

  store.recall('小明 羽毛球 冰美式', { chat, where: 'private:10001' })
  const touched = store.reportMiss('private:10001', '你记错了，不是这样的')
  assert.ok(touched >= 2, 'reportMiss 应一次性纠错全部命中条目')
  const updatedA = store.listFor(['private:10001']).find((x) => x.id === a.id)
  const updatedB = store.listFor(['private:10001']).find((x) => x.id === b.id)
  assert.ok(updatedA.importance < 0.8 && updatedB.importance < 0.8, '两条命中条目均应降权')
})

// ---------------- 7. P1: 向量维数变更重建句柄、embedQuery 信号与防截断 emoji、多 scope 单次召回、精排全汰不兜底 ----------------

test('memory-vector：改 vectorDim 自动重建句柄；embedQuery 透传 signal 且安全截断 emoji 代理对', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pr2-vec-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let dim = 64
  const seenInputs = []
  let receivedSignal = null
  const fetchImpl = async (_url, opt) => {
    receivedSignal = opt.signal
    const body = JSON.parse(opt.body)
    seenInputs.push(...body.input)
    return {
      ok: true,
      json: async () => ({
        data: body.input.map(() => ({ embedding: Array(dim).fill(1 / Math.sqrt(dim)) })),
      }),
    }
  }
  const ch = createVectorChannel({
    memoryDir: dir,
    getConfig: () => ({ memory: { embeddings: { enabled: true, url: 'https://emb.local', model: 'm', dim, maxChars: 60 } } }),
    log: quietLog(),
    fetchImpl,
  })
  t.after(() => ch.dispose())

  const emojiQuery = 'a'.repeat(59) + '😀' + 'b'
  const qv = await ch.embedQuery(emojiQuery, { timeoutMs: 2000 })
  assert.equal(qv.length, 64)
  assert.ok(receivedSignal instanceof AbortSignal, 'embedQuery 应透传 AbortSignal 到 fetch')
  assert.equal(seenInputs[0], 'a'.repeat(59) + '😀', 'Array.from 截断不应拆碎 emoji 代理对')

  ch.queueScope('private:10001', [{ id: 'v1', text: '测试向量一' }])
  await ch.flush()
  assert.equal(ch.status().dim, 64)
  dim = 128
  ch.queueScope('private:10001', [{ id: 'v1', text: '测试向量一改' }])
  await ch.flush()
  assert.equal(ch.status().dim, 128)
  const hits = await ch.searchScopes('测试', ['private:10001'], { topK: 5 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'v1')
})

test('recallFused & recallHintFused：多 scope 合并单次嵌入；短句拼 context；精排全汰时不触发 hintBody 兜底', async (t) => {
  withTempDataDir(t, 'pr2-fused-')
  const embedCalls = []
  const origFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = origFetch })

  let rerankCalled = 0
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('/rerank')) {
      rerankCalled++
      const body = JSON.parse(opt.body)
      return {
        ok: true,
        json: async () => ({
          results: body.documents.map((_, index) => ({ index, relevance_score: 0.001 })),
        }),
      }
    }
    return origFetch(url, opt)
  }

  const vectorFetchImpl = async (_url, opt) => {
    const body = JSON.parse(opt.body)
    embedCalls.push(body.input)
    return {
      ok: true,
      json: async () => ({
        data: body.input.map(() => ({ embedding: Array(64).fill(1 / 8) })),
      }),
    }
  }

  const cfg = {
    ownerQQ: '10001',
    memory: {
      enabled: true,
      recallCount: 4,
      hintCount: 4,
      hintMaxChars: 600,
      embeddings: { enabled: true, url: 'https://emb.local', model: 'm', dim: 64, batch: 8 },
    },
    ext: {
      memory: {
        rerankEnabled: true,
        rerankApiKey: 'test-key-fake',
        rerankUrl: 'https://rerank.local/rerank',
        rerankMinScore: 0.05,
      },
    },
  }
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => cfg,
    hub: { chatLogDays: () => [], chatLogOf: () => [] },
    log: quietLog(),
    vectorFlushDebounceMs: 5,
    vectorFetchImpl,
  })
  t.after(() => store.dispose())

  store.add({ text: '主人喜欢喝手冲咖啡', scope: 'private:10001', importance: 0.8 })
  store.add({ text: '全局公告：周末维护服务器', scope: 'global', importance: 0.8 })
  await new Promise((r) => setTimeout(r, 40))
  embedCalls.length = 0

  const chat = { kind: 'private', userId: '10001', chatId: 'private:10001' }
  const hint = await store.recallHintFused(chat, '嗯嗯好呀', '刚刚在聊手冲咖啡和服务器')
  assert.equal(embedCalls.length, 1, 'private+global 两个 scope 应合并为单次 embedQuery 调用')
  assert.match(embedCalls[0][0], /手冲咖啡/, '短句应拼上 context 送向量检索')
  assert.equal(rerankCalled, 1, '应执行精排')
  assert.equal(hint, '', '精排把候选全汰后不应触发 hintBody 兜底反塞无关记忆')
})

// ---------------- 8. P1: 梦境经验按 label 覆盖更新、跳过 group:*、批量 invalidateMany、比较器严格三态弱序 ----------------

test('梦境巩固：同 label 覆盖更新不重复追加；跳过 group:* 派生洞察；invalidateMany 批量生效；比较器满足三态弱序', async (t) => {
  withTempDataDir(t, 'pr2-dream-')
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => ({ ownerQQ: '10001', memory: { enabled: true } }),
    hub: { chatLogDays: () => [], chatLogOf: () => [] },
    log: quietLog(),
  })
  t.after(() => store.dispose())

  store.add({ text: '主人周末喜欢看科幻电影', topic: '电影', scope: 'private:10001' })
  store.add({ text: '主人平时常看经典悬疑电影', topic: '电影', scope: 'private:10001' })
  store.add({ text: '群里大家聊起露营装备推荐', topic: '露营', scope: 'group:20001' })
  store.add({ text: '群友讨论周末露营帐篷选型', topic: '露营', scope: 'group:20001' })

  await store.dreamConsolidate()
  assert.equal(store.insights().some((b) => b.key === 'group:20001'), false, '梦境应跳过 group:* 无效派生洞察写入')

  store.add({ text: '主人也收藏了不少动画电影原声', topic: '电影', scope: 'private:10001' })
  await store.dreamConsolidate()
  const bucket = store.insights().find((b) => b.key === 'qq:10001') /* pii-scan:ignore */
  const movieExps = (bucket?.list || []).filter((x) => x.text.startsWith('关于「电影」的共性归纳'))
  assert.equal(movieExps.length, 1, '同 label 共性归纳应覆盖更新而非反复追加')
  assert.match(movieExps[0].text, /3 条/)

  const f1 = store.add({ text: '批量过时测试甲一二三', scope: 'private:10001' })
  const f2 = store.add({ text: '批量过时测试乙四五六', scope: 'private:10001' })
  const fPin = store.add({ text: '批量过时钉住测试丙七八九', scope: 'private:10001', pinned: true })
  const applied = store.invalidateMany([
    { oldId: f1.id, newId: 'rep' },
    { oldId: f2.id, newId: 'rep' },
    { oldId: fPin.id, newId: 'rep' },
  ])
  assert.equal(applied, 2, 'invalidateMany 应批量立 2 条墓碑并保护 pinned')
  const liveIds = store.listFor(['private:10001']).map((x) => x.id)
  assert.ok(!liveIds.includes(f1.id) && !liveIds.includes(f2.id) && liveIds.includes(fPin.id))

  const pureRes = dreamConsolidatePure([
    { id: 'same', text: '主人喜欢喝热茶', scope: 'private:10001', topic: '饮品', importance: 0.5, at: 100 },
    { id: 'same', text: '主人不喜欢喝热茶', scope: 'private:10001', topic: '饮品', importance: 0.5, at: 100 },
  ], { now: () => 200 })
  assert.equal(pureRes.ok, true)
})

// ---------------- 9. P1: llm.js 超时 signal 传播、显式模型视觉检查、describeWithHelper 超时保护 ----------------

test('llm.js：askModel 传入级联超时 signal、显式 provider/model 查 modelVision、describeWithHelper 带超时 signal', async () => {
  clearVisionCache()
  const parentAc = new AbortController()
  let streamSignal = null
  const visionQueries = []

  const dsh = {
    get: () => null,
    attachments: { admitPromptContent: async (c) => c },
    llm: {
      async resolveModelInfo(provider, model) {
        visionQueries.push(`${provider}/${model}`)
        return { inputModalities: model === 'blind-explicit' ? ['text'] : ['text', 'image'] }
      },
      async *stream(params) {
        streamSignal = params.signal
        yield { type: 'text-delta', text: 'ok' }
      },
    },
  }

  const res = await askModel(dsh, {
    cfg: { model: { provider: 'defaultP', model: 'defaultM', vision: 'on' } },
    text: 'hello',
    signal: parentAc.signal,
  })
  assert.equal(res, 'ok')
  assert.ok(streamSignal instanceof AbortSignal)
  assert.notEqual(streamSignal, parentAc.signal, '应传 withAbortTimeout 级联后的 signal，而非直接传 o.signal')

  let helperSignal = null
  const dsh2 = {
    get: () => null,
    attachments: { admitPromptContent: async (c) => c },
    llm: {
      async resolveModelInfo(provider, model) {
        visionQueries.push(`${provider}/${model}`)
        return { inputModalities: model === 'blind-explicit' ? ['text'] : ['text', 'image'] }
      },
      async *stream(params) {
        if (params.model === 'helper-m') helperSignal = params.signal
        yield { type: 'text-delta', text: params.model === 'helper-m' ? '一只橘猫' : '收到描述' }
      },
    },
  }
  const out2 = await askModel(dsh2, {
    cfg: {
      model: { provider: 'defaultP', model: 'defaultM', vision: 'on' },
      visionHelper: { enabled: true, provider: 'hp', model: 'helper-m' },
    },
    provider: 'expP',
    model: 'blind-explicit',
    text: '看图',
    images: [{ data: 'AA==', mediaType: 'image/png' }],
  })
  assert.equal(out2, '收到描述')
  assert.ok(visionQueries.includes('expP/blind-explicit'), '显式指定模型时应检查该显式模型的 modelVision')
  assert.ok(helperSignal instanceof AbortSignal, 'describeWithHelper 应经 withAbortTimeout 传入 AbortSignal')

  let directHelperSignal = null
  const desc = await describeWithHelper({
    get: () => null,
    attachments: { admitPromptContent: async (c) => c },
    llm: {
      async *stream(params) {
        directHelperSignal = params.signal
        yield { type: 'text-delta', text: '蓝色天空' }
      },
    },
  }, {
    images: [{ data: 'AA==', mediaType: 'image/png' }],
    cfg: { visionHelper: { enabled: true, provider: 'hp', model: 'hm' } },
    hint: '看图',
  })
  assert.match(desc, /蓝色天空/)
  assert.ok(directHelperSignal instanceof AbortSignal)
})

// ---------------- 10. P1: config.js douyinDm 一次性迁移 & speakUp 默认值统一 ----------------

test('config.js：douyinDm 仅旧版本迁移一次，用户修改后可持久化保留；speakUp 默认值与 normalize 兜底一致', () => {
  const migrated = normalize({ profilePerms: { douyinDm: 'all' } })
  assert.equal(migrated.profilePerms.douyinDm, 'owner')
  assert.equal(migrated.profilePermsVersion, PROFILE_PERMS_VERSION)

  const editedOff = normalize({ ...migrated, profilePerms: { ...migrated.profilePerms, douyinDm: 'off' } })
  assert.equal(editedOff.profilePerms.douyinDm, 'off', '新版本配置修改 douyinDm 为 off 后不应被覆写')
  const panelAll = mergeFromPanel(migrated, { profilePerms: { douyinDm: 'all' } })
  assert.equal(panelAll.profilePerms.douyinDm, 'all', '面板保存修改 douyinDm 为 all 后应保留')

  const fallback = normalize({
    speakUp: {
      idleMinutes: 'bad',
      minIntervalMinutes: 'bad',
      maxIntervalMinutes: 'bad',
      maxPerDay: 'bad',
    },
  }).speakUp
  assert.equal(fallback.idleMinutes, DEFAULTS.speakUp.idleMinutes)
  assert.equal(fallback.minIntervalMinutes, DEFAULTS.speakUp.minIntervalMinutes)
  assert.equal(fallback.maxIntervalMinutes, DEFAULTS.speakUp.maxIntervalMinutes)
  assert.equal(fallback.maxPerDay, DEFAULTS.speakUp.maxPerDay)
})
