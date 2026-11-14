// US-012 接线验收：素材熔炉真的被构造、沉淀、匹配、落盘。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCrucible, CRUCIBLE_SOURCES, CRUCIBLE_MAX_ENTRIES } from '../src/purpose/engine/crucible.js'
import { createPurpose } from '../src/purpose/module.js'

const NOW = 1_700_000_000_000

test('createCrucible 提供 entries/ingest/prune/match 四个操作', () => {
  const c = createCrucible([])
  for (const k of ['entries', 'ingest', 'prune', 'match']) {
    assert.equal(typeof c[k], 'function', `缺 ${k}`)
  }
})

test('ingest 沉淀素材，同指纹只续期不重复', () => {
  const c = createCrucible([])
  const r1 = c.ingest([{ source: 'group', title: '群友聊到露营', fingerprint: 'fp-1', capturedAt: NOW }], { now: NOW })
  assert.equal(r1.added.length, 1, '首次应新增')
  const r2 = c.ingest([{ source: 'group', title: '群友聊到露营', fingerprint: 'fp-1', capturedAt: NOW + 1000 }], { now: NOW + 1000 })
  assert.equal(r2.added.length, 0, '同指纹不该重复新增')
  assert.equal(r2.refreshed.length, 1, '应续期')
  assert.equal(c.entries().length, 1, '池子里仍只有一条')
})

test('match 按兴趣打分取 top-N，无命中返回空数组（不随机兜底）', () => {
  const c = createCrucible([])
  c.ingest([
    { source: 'group', title: '大家聊露营装备聊得很起劲', fingerprint: 'fp-camp', capturedAt: NOW },
    { source: 'group', title: '有人在说股票行情', fingerprint: 'fp-stock', capturedAt: NOW },
  ], { now: NOW })
  const hits = c.match('private:1000', ['露营'], { now: NOW, limit: 5 })
  assert.ok(Array.isArray(hits), '应返回数组')
  if (hits.length) assert.ok(String(hits[0].title).includes('露营'), '命中项应与兴趣相关')

  const none = c.match('private:1000', ['量子力学'], { now: NOW, limit: 5 })
  assert.deepEqual(none, [], '无命中必须返回空数组，不做随机兜底')
})

test('prune 让过期素材发酵离场', () => {
  const c = createCrucible([])
  c.ingest([{ source: 'group', title: '很久以前的一条线索', fingerprint: 'fp-old', capturedAt: NOW }], { now: NOW })
  assert.equal(c.entries().length, 1)
  // 30 天后再 prune（CRUCIBLE_MAX_TTL_MS = 30 天）
  c.prune({ now: NOW + 40 * 86_400_000 })
  assert.equal(c.entries().length, 0, '过期应被淘汰')
})

test('entries 返回副本：改它不污染内部池', () => {
  const c = createCrucible([])
  c.ingest([{ source: 'group', title: '测试条目', fingerprint: 'fp-x', capturedAt: NOW }], { now: NOW })
  const e = c.entries()
  e[0].title = '被改了'
  e[0].tags.push('注入')
  assert.equal(c.entries()[0].title, '测试条目', '内部池不得被污染')
})

test('ingest 返回的 pool 也是副本（不能借它污染内部池）', () => {
  const c = createCrucible([])
  const r = c.ingest([{ source: 'group', title: '条目A', fingerprint: 'fp-a', capturedAt: NOW }], { now: NOW })
  r.pool[0].title = '被改了'
  assert.equal(c.entries()[0].title, '条目A', '交出去的 pool 必须是副本')
})

test('容量上限生效，不无限增长', () => {
  const c = createCrucible([])
  const many = Array.from({ length: CRUCIBLE_MAX_ENTRIES + 20 }, (_, i) => ({
    source: 'group', title: `条目${i}`, fingerprint: `fp-${i}`, capturedAt: NOW + i,
  }))
  c.ingest(many, { now: NOW })
  assert.ok(c.entries().length <= CRUCIBLE_MAX_ENTRIES, `不应超过 ${CRUCIBLE_MAX_ENTRIES}，实际 ${c.entries().length}`)
})

test('CRUCIBLE_SOURCES 可枚举（模块接线依赖它做 source 归类）', () => {
  assert.deepEqual([...CRUCIBLE_SOURCES].sort(), ['bili', 'group', 'rss'])
})

test('初始池可由构造器注入（重启恢复路径）', () => {
  const c = createCrucible([{ source: 'group', title: '恢复的条目', fingerprint: 'fp-r', capturedAt: NOW, tags: [] }])
  assert.equal(c.entries().length, 1, '应从既有池恢复')
})

test('降级兴趣匹配：通过 topic 关键词成功命中潜伏素材', () => {
  const c = createCrucible([{ source: 'group', title: '露营装备选购心得', summary: '推荐几款实用的帐篷和睡袋', fingerprint: 'fp-camp', capturedAt: NOW, tags: ['露营'] }])
  // 当未配置兴趣时，从聊天提取出的 topic（如「露营」）能准确命中标题/摘要，而不是长句整句脱靶
  const topicTerms = ['露营', '周末']
  const hits = c.match('private:10001', topicTerms, { now: NOW, limit: 5 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].fingerprint, 'fp-camp')
})

test('接线验证：未配置 interests 时，通过 materials 的 m.topic 降级成功匹配熔炉素材', () => {
  const now = Date.now()
  const c = createCrucible([
    { source: 'group', title: '露营装备选购心得与避坑', summary: '推荐几款实用的帐篷和睡袋', fingerprint: 'fp-camp', capturedAt: now, tags: ['露营'] },
    { source: 'group', title: '无人机高空拍摄技巧', summary: '飞行动作与构图', fingerprint: 'fp-drone', capturedAt: now, tags: ['无人机'] },
  ])
  const cfg = {
    enabled: true,
    ownerQQ: '10001',
    speakUp: { enabled: false },
    // ext.purpose.interests 未设置，触发降级到 materials.items 的 topic
    ext: { purpose: { enabled: true } },
  }
  const hub = {
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => [],
    chatLogOf: () => [],
  }
  const p = createPurpose({
    getConfig: () => cfg,
    hub,
    crucible: c,
    memory: () => ({
      recall: () => [
        {
          id: 'mem-1',
          importance: 0.8,
          at: now,
          it: {
            id: 'mem-1',
            text: '主人周末打算去郊外露营',
            topic: '露营',
          },
        },
      ],
    }),
  })
  const prev = p.preview()
  const crucibleMaterials = prev.materials.filter((m) => m.kind === 'crucible')
  assert.equal(crucibleMaterials.length, 1, '降级使用 m.topic 应该命中 1 条素材')
  assert.equal(crucibleMaterials[0].fingerprint, 'fp-camp')
  assert.ok(crucibleMaterials[0].text.includes('露营'), '命中的素材应包含露营')
})

test('接线验证：配置了 ext.purpose.interests 时，优先按配置的兴趣词匹配熔炉素材', () => {
  const now = Date.now()
  const c = createCrucible([
    { source: 'group', title: '露营装备选购心得与避坑', summary: '推荐几款实用的帐篷和睡袋', fingerprint: 'fp-camp', capturedAt: now, tags: ['露营'] },
    { source: 'group', title: '无人机高空拍摄技巧', summary: '飞行动作与构图', fingerprint: 'fp-drone', capturedAt: now, tags: ['无人机'] },
  ])
  const cfg = {
    enabled: true,
    ownerQQ: '10001',
    speakUp: { enabled: false },
    ext: { purpose: { enabled: true, interests: ['无人机'] } },
  }
  const hub = {
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => [],
    chatLogOf: () => [],
  }
  const p = createPurpose({
    getConfig: () => cfg,
    hub,
    crucible: c,
    memory: () => ({
      recall: () => [
        {
          id: 'mem-1',
          importance: 0.8,
          at: now,
          it: {
            id: 'mem-1',
            text: '主人周末打算去郊外露营',
            topic: '露营',
          },
        },
      ],
    }),
  })
  const prev = p.preview()
  const crucibleMaterials = prev.materials.filter((m) => m.kind === 'crucible')
  assert.equal(crucibleMaterials.length, 1)
  assert.equal(crucibleMaterials[0].fingerprint, 'fp-drone', '应优先使用配置的兴趣词命中无人机')
})

test('接线验证：关停（enabled: false）时 tick 不会触发 crucibleCycle 采集', async () => {
  const cfg = {
    enabled: false,
    ownerQQ: '10001',
    ext: { purpose: { enabled: false } },
  }
  const hub = {
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => [],
    chatLogOf: () => [],
  }
  const c = createCrucible([])
  const p = createPurpose({
    getConfig: () => cfg,
    hub,
    crucible: c,
    log: { warn() {} },
  })
  await p.tick()
  assert.equal(c.entries().length, 0, '关停时不应采集入池')
})

test('接线验证：素材来源映射基于 m.source，非 CRUCIBLE_SOURCES 降级为 group', async () => {
  const now = Date.now()
  const c = createCrucible([])
  const cfg = {
    enabled: true,
    ownerQQ: '10001',
    ext: { purpose: { enabled: true, minMaterials: 0 } },
  }
  const hub = {
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => [],
    chatLogOf: () => [],
  }
  const p = createPurpose({
    getConfig: () => cfg,
    hub,
    crucible: c,
    memory: () => ({
      recall: () => [
        {
          id: 'mem-1',
          importance: 0.8,
          at: now,
          it: {
            id: 'mem-1',
            text: '来自记忆的素材内容测试',
            topic: '记忆',
            source: 'memory', // 非 CRUCIBLE_SOURCES (rss/bili/group)
          },
        },
      ],
    }),
  })
  await p.tick()
  const entries = c.entries()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].source, 'group', 'memory 来源应降级为 group')
})

test('接线验证：crucibleCycle 脏检查生效，无数据变动时不刷盘', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'crucible-dirty-'))
  const origDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = tempDir
  try {
    const poolFile = join(tempDir, 'purpose', 'crucible-pool.json')
    const now = Date.now()
    const cfg = {
      enabled: true,
      ownerQQ: '10001',
      ext: { purpose: { enabled: true, minMaterials: 0 } },
    }
    const hub = {
      lastOwnerChatAt: 0,
      lastBotToOwner: { at: 0, text: '' },
      chatLogDays: () => [],
      chatLogOf: () => [],
    }
    const p = createPurpose({
      getConfig: () => cfg,
      hub,
      memory: () => ({
        recall: () => [
          {
            id: 'mem-1',
            importance: 0.8,
            at: now,
            it: { id: 'mem-1', text: '稳定测试记忆内容', topic: '测试' },
          },
        ],
      }),
    })
    // 第一次 tick：有新素材写入，应触发刷盘
    await p.tick()
    assert.ok(existsSync(poolFile), '首次应刷盘生成 crucible-pool.json')
    const firstStat = statSync(poolFile)
    const firstMtime = firstStat.mtimeMs

    // 等待 20ms 确保如果再次写入 mtime 会变
    await new Promise((resolve) => setTimeout(resolve, 30))

    // 第二次 tick：素材未改变，dirty 为 false，不应刷盘
    await p.tick()
    const secondStat = statSync(poolFile)
    assert.equal(secondStat.mtimeMs, firstMtime, '素材无变动时不应重复写盘')
  } finally {
    process.env.AURABOT_DATA_DIR = origDir
  }
})
