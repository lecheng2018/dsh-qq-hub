// Batch 3 · T3.8：记忆一致性（越多 = 越少丢 / 越少串）
//
// 改前四个具体缺陷：
//   ① scopeOfChat(system/未知) 返回 'global' —— 内部回合能读到所有人的记忆，clearScope 也会误清全局；
//   ② invalidate('global') 只删 `scope:global` 键，各会话已缓存的 chat 索引继续召回旧内容；
//   ③ 向量 flush 失败后每 flushDebounceMs 就打一次 embedding，且失败回填会把「失败期间已删空
//      作用域」的旧 ID 复活进 dirty（死向量重新落盘）；
//   ④ normalizeFact 只认 pinned === true，1 / '1' 的「已固定」条目会被当普通条目整理覆盖。
// 这里全部用真实导出函数验证。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryIndexCache } from '../src/features/memory-index-cache.js'
import { createVectorChannel } from '../src/features/memory-vector.js'
import { normalizeFact, consolidate } from '../src/features/memory-dream.js'
import { openMemoryFiles, scopeToFilePath } from '../src/features/memory-files.js'
import { createMemoryLearning } from '../src/features/memory-learning.js'

const noopLog = { info() {}, warn() {}, error() {}, debug() {} }

test('T3.8 索引缓存：system/未知会话 fail-closed（不再落到 global）', () => {
  const cache = createMemoryIndexCache({ getConfig: () => ({}), load: () => ({ items: [], profiles: {}, insights: {}, style: {} }) })
  assert.equal(cache.scopeOfChat({ kind: 'system' }), 'private:unknown')
  assert.equal(cache.scopeOfChat(null), 'private:unknown')
  assert.equal(cache.scopeOfChat({ kind: 'unknown' }), 'private:unknown')
  assert.equal(cache.scopeOfChat({ kind: 'private', userId: '10001' }), 'private:10001')
  assert.equal(cache.scopeOfChat({ kind: 'group', groupId: '777' }), 'group:777')
  // 可见性：内部会话连 global 都不给；未知会话也不给
  assert.equal(cache.scopeVisible('global', { kind: 'system' }), false)
  assert.equal(cache.scopeVisible('global', { kind: 'private', userId: '10001' }), true)
  assert.equal(cache.scopeVisible('global', null), false)
})

test('T3.8 索引缓存：invalidate("global") 必须让所有会话的缓存一起失效', () => {
  let state = {
    items: [{ id: 'm1', scope: 'global', text: '全局条目', at: Date.now() }],
    profiles: {}, style: {}, insights: {}, rev: 1,
  }
  const cache = createMemoryIndexCache({ getConfig: () => ({}), load: () => state, getRev: () => state.rev })
  const chat = { kind: 'private', userId: '10001' }
  const idsOf = (idx) => idx.docs.map((d) => d.it.id)
  const first = cache.indexFor(chat)
  assert.deepEqual(idsOf(first), ['m1'], '第一次建索引应包含 global 条目')
  // 全局条目被换掉（模拟面板编辑/清理），只失效 global。rev 同时递增 —— 这是真实落盘路径。
  state = {
    items: [{ id: 'm2', scope: 'global', text: '新的全局条目', at: Date.now() }],
    profiles: {}, style: {}, insights: {}, rev: 2,
  }
  cache.invalidate('global')
  const second = cache.indexFor(chat)
  assert.deepEqual(idsOf(second), ['m2'], 'global 变更后会话索引必须重建')
  assert.equal(idsOf(second).includes('m1'), false, '旧条目不许继续留在缓存里')
})

test('T3.8 向量通道：连续失败退避 + 失败回填不复活已被删空的 ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-vec-'))
  let fail = true
  let calls = 0
  try {
    const channel = createVectorChannel({
      memoryDir: dir,
      getConfig: () => ({ memory: { embeddings: { enabled: true, url: 'http://127.0.0.1:1/v1', model: 'm', dim: 64, batch: 8 } } }),
      log: noopLog,
      flushDebounceMs: 0,
      // 真实 embed 请求一律失败（模拟网关 401/欠费）。flush 内部吞掉错误并记 streak，不向调用方抛。
      fetchImpl: async () => { calls += 1; if (fail) throw new Error('401 unauthorized'); return { ok: true, json: async () => ({ data: [{ embedding: Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0)) }] }) } },
    })
    channel.queueScope('private:10001', [{ id: 'm1', text: '待向量化' }])
    const embedded1 = await channel.flush()
    assert.equal(embedded1, 0, '失败时一条都没写进去')
    assert.equal(channel.failStreak(), 1, '失败次数要记下来（用于退避）')
    const delay1 = channel.nextFlushDelayMs()
    assert.ok(delay1 >= 1000, `连续失败后下一次调度必须退避，实际 ${delay1}ms`)
    assert.equal(channel.pendingIds().includes('m1'), true, '失败回填把待办留在队列里以便重试')
    const callsAfterFirst = calls

    // 失败期间作用域被删空：新快照 [] 必须让旧 pend 作废，不许复活
    channel.queueScope('private:10001', [])
    await channel.flush()
    assert.equal(channel.pendingIds().includes('m1'), false, '删空后的旧 ID 不许被失败回填复活')
    assert.equal(calls, callsAfterFirst, '删空后没有任何待办，不许再打 embedding')
    assert.equal(channel.failStreak(), 1, '没有可做的对账不算一次新失败')

    // 重新入队一个新条目再失败：退避必须比上一次更大
    channel.queueScope('private:10001', [{ id: 'm2', text: '新条目' }])
    await channel.flush()
    assert.equal(channel.failStreak(), 2)
    assert.ok(channel.nextFlushDelayMs() > delay1, '第二次失败退避更大')
    channel.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.ok(calls >= 2)
})

test('T3.8 梦境整理：pinned=1 的条目被识别为已固定，不会在整理里被合并掉', () => {
  const fact = normalizeFact({ id: 'f1', entity: '主人', topic: '偏好', scope: 'private:10001', text: '主人喜欢安静', pinned: 1 })
  assert.equal(fact.pinned, true, 'pinned: 1 必须归一化为已固定')
  assert.equal(normalizeFact({ id: 'f2', entity: '主人', topic: '偏好', scope: 'private:10001', text: 'x', pinned: 'true' }).pinned, true)
  assert.equal(normalizeFact({ id: 'f3', entity: '主人', topic: '偏好', scope: 'private:10001', text: 'x' }).pinned, false)

  // 同一 scope 但不同人设/轨道不许被合并成一簇
  const facts = [
    { id: 'a', scope: 'private:10001', personaId: 'default', track: 'fact', entity: '主人', topic: '猫', text: '主人养了一只猫', at: 1, weight: 1 },
    { id: 'b', scope: 'private:10001', personaId: 'group-seven', track: 'fact', entity: '主人', topic: '猫', text: '七群人设认为主人怕猫', at: 1, weight: 1 },
  ]
  const out = consolidate(facts, { maxItems: 50, windowDays: 3650, minWeight: 0 })
  const text = JSON.stringify(out)
  assert.match(text, /主人养了一只猫/)
  assert.match(text, /七群人设认为主人怕猫/, '不同人设的同主题事实不许被合成一条')
})

test('T3.8 梦境整理：轨道（selfView/perspective）与人设不同的同主题事实不许互相合并', () => {
  // normalizeFact 必须保留轨道字段 —— 丢了就和普通事实同键了
  const kept = normalizeFact({ id: 'k', text: '主人喜欢猫', personaId: 'group-seven', selfView: 1, perspective: 'self' })
  assert.equal(kept.personaId, 'group-seven')
  assert.equal(kept.selfView, true)
  assert.equal(kept.perspective, 'self')
  assert.equal(normalizeFact({ id: 'k2', text: '主人喜欢猫' }).selfView, false)

  // 正文几乎逐字相同（旧 groupKey 必然合一），只有轨道/人设不同
  const base = { scope: 'private:10001', entity: '主人', topic: '猫', text: '主人喜欢猫', at: 1000 }
  const facts = [
    { ...base, id: 't1', kind: 'fact', selfView: false, perspective: 'other' },
    { ...base, id: 't2', kind: 'fact', selfView: true, perspective: 'self' },
    { ...base, id: 't3', kind: 'fact', personaId: 'default' },
    { ...base, id: 't4', kind: 'fact', personaId: 'group-seven' },
  ]
  const out = consolidate(facts, { maxItems: 50, windowDays: 3650, minWeight: 0 })
  const ids = (out.facts || []).map((f) => f.id).sort()
  assert.deepEqual(ids, ['t1', 't2', 't3', 't4'], `不同轨道/人设的同主题事实不许合并：${JSON.stringify(ids)}`)
  assert.equal(out.merges.length, 0)
  assert.equal(out.supersede.length, 0)

  // 对照组：同轨道、同人设、同文本仍要合并（没有把去重能力一起关掉）
  const dup = consolidate([
    { ...base, id: 'd1', kind: 'fact', personaId: 'default' },
    { ...base, id: 'd2', kind: 'fact', personaId: 'default' },
  ], { maxItems: 50, windowDays: 3650, minWeight: 0 })
  assert.equal((dup.facts || []).length, 1, '同轨道的重复条目仍然要合并')
  assert.equal(dup.merges.length, 1)
})

test('T3.8 记忆学习：提炼批次状态与整理进度真的走 mutate（CAS 自愈），不再用裸 save() 覆盖并发写入', async () => {
  let state = {
    version: 1,
    items: [],
    profiles: {},
    insights: {},
    styles: {},
    styleSources: {},
    processed: {},
    processedSources: {},
    runs: {},
    lastConsolidate: {},
    extractionBatches: {
      b1: { fingerprint: 'f', scope: 'private:10001', status: 'pending', added: 0, at: 1 },
    },
  }
  let mutations = 0
  let directSaves = 0
  const learning = createMemoryLearning({
    dsh: { get: () => null, llm: { async *stream() { yield { type: 'text-delta', text: '[]' } } } },
    getConfig: () => ({ ownerQQ: '10001', model: { provider: 'p', model: 'm' }, memory: { enabled: true } }),
    hub: {},
    log: noopLog,
    isActive: () => true,
    createGenerationSignal: () => ({ signal: new AbortController().signal, isValid: () => true, cleanup: () => {} }),
    generationOf: () => ({ signal: { signal: new AbortController().signal, isValid: () => true }, cleanup: () => {} }),
    load: () => structuredClone(state),
    save: () => { directSaves += 1 },
    mutate: (fn) => { mutations += 1; const next = structuredClone(state); fn(next); state = next; return true },
    health: () => ({ ok: true }),
    relatedTo: () => [],
    add: () => ({ ok: true }),
    addMany: () => ({ ok: true, added: 0, updated: 0, skipped: 0 }),
    revise: () => true,
    supersede: () => ({ ok: true }),
    invalidate: () => true,
    invalidateMany: () => 0,
    scopeFromChatId: (c) => String(c || ''),
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

  const resolved = learning.api.resolveExtractionBatch('b1', 'done')
  assert.equal(resolved.ok, true)
  assert.equal(mutations, 1, '批次状态落盘必须走 mutate')
  assert.equal(directSaves, 0, '不许再绕过 persist 直接 save()')
  assert.equal(state.extractionBatches.b1.status, 'done')
  assert.equal(state.extractionBatches.b1.recovery, 'manual-confirmed', '改动的确是这次事务写进去的')

  // 读侧（extractionBatches）看到的是落盘后的新状态
  assert.equal(learning.api.extractionBatches().b1.status, 'done')
})

test('T3.8 档案落盘：state.json 在提交作用域之前被外部改动 → 直接抛错，一个 memory.md 都不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-cas-order-'))
  try {
    const statePath = join(dir, 'state.json')
    let bumped = false
    const log = {
      info() {}, debug() {}, error() {},
      // 第一次「外部变更合并」的 warn 正好是「第二个进程又改了一次 state.json」的时机：
      // 用这个真实钩子制造「CAS 校验点落在提交作用域之后」时才会踩到的交错。
      warn: () => {
        if (bumped) return
        bumped = true
        const disk = JSON.parse(readFileSync(statePath, 'utf8'))
        disk.runs = { ...(disk.runs || {}), '17:00': '2026-11-27' }
        writeFileSync(statePath, JSON.stringify(disk, null, 2))
      },
    }
    const store = openMemoryFiles(dir, { log })
    const s0 = store.load()
    s0.items.push({ id: 'm1', text: '私聊里的一条事实', scope: 'private:10001', at: 1000 })
    s0.items.push({ id: 'm2', text: '群里的一条事实', scope: 'group:777', at: 1000 })
    store.save(s0)
    const p1 = join(dir, scopeToFilePath('private:10001'))
    const p2 = join(dir, scopeToFilePath('group:777'))
    const before1 = readFileSync(p1, 'utf8')
    const before2 = readFileSync(p2, 'utf8')

    // 外部第一次合法改动：触发 save() 里的合并 warn，warn 里再做第二次改动
    const disk = JSON.parse(readFileSync(statePath, 'utf8'))
    disk.runs = { ...(disk.runs || {}), '16:00': '2026-11-27' }
    writeFileSync(statePath, JSON.stringify(disk, null, 2))

    const s1 = store.load()
    s1.items.push({ id: 'm3', text: '两个作用域都要落盘的新事实', scope: 'private:10001', at: 2000 })
    s1.items.push({ id: 'm4', text: '两个作用域都要落盘的新事实', scope: 'group:777', at: 2000 })
    assert.throws(() => store.save(s1), /已在外部被修改|重载/)
    assert.equal(readFileSync(p1, 'utf8'), before1, 'CAS 校验失败时私聊档案不许被改一半')
    assert.equal(readFileSync(p2, 'utf8'), before2, 'CAS 校验失败时群档案也不许被改一半')
    assert.ok(!store.load().items.some((m) => m.id === 'm3'), '内存快照也不许提前吞下这次写入')
    store.close?.()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T3.8 档案落盘：不同人设的同一 QQ 档案不再共用 prof_<qq> ID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3-files-'))
  try {
    const files = openMemoryFiles(dir, { log: noopLog })
    // 真实落盘：save() 会把 profiles 写进各自 scope 的 memory.md，ID 就在条目元数据里。
    files.save({
      version: 1,
      items: [],
      insights: {},
      style: {},
      processed: {},
      profiles: {
        '10002': { qq: '10002', scope: 'private:10002', text: '默认人设档案', name: '小张', personaId: 'default' },
        '10003': { qq: '10003', scope: 'private:10003', text: '七群人设档案', name: '小张', personaId: 'group-seven' },
      },
    })
    const docs = []
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name)
        if (e.isDirectory()) walk(f)
        else if (e.name.endsWith('.md')) docs.push(readFileSync(f, 'utf8'))
      }
    }
    walk(dir)
    const profIds = docs.flatMap((raw) => [...raw.matchAll(/"id":"(prof_[^"]+)"/g)].map((m) => m[1]))
    assert.equal(profIds.length, 2, `两个档案都该落盘：${profIds.join(',')}`)
    assert.equal(new Set(profIds).size, profIds.length, `档案 ID 不许撞车：${profIds.join(',')}`)
    assert.ok(profIds.some((id) => id.includes('group-seven')), '人设分桶要体现在 ID 上')
    assert.ok(profIds.includes('prof_default_10002'), '默认人设档案 ID 保留 QQ 号便于排查')
    files.close?.()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
