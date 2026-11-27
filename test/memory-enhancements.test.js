// 记忆补强与 token-guardian 移除回归测试：
// 1. 向量 + RRF 真双通道叠加、minCos 噪点过滤、rerankTopN 候选池与低分截断、向量命中记账；
// 2. 分聊天人设隔离（personaIdFor）；
// 3. 人物小档案纯新增 append-stale 降级可读，破坏性变更保持失效；
// 4. 梦境巩固传递真实 at / pinned（新事实胜出，不再按随机 UUID 字典序）；
// 5. biliLike 仅作用于涉 B 站条目，不误伤同作用域其他条目；
// 6. extractionBatches 过期 done 批次自动清理；
// 7. token-guardian 已彻底从 BUILTINS 移除。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMemoryStore } from '../src/features/memory.js'
import { BUILTINS } from '../src/modules/index.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function withTempData(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mem-enh-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'migration.json'), JSON.stringify({ status: 'success' }))
  writeFileSync(join(dir, 'memory', 'state.json'), JSON.stringify({ version: 1, hits: {}, processed: {}, processedSources: {}, extractionBatches: {}, runs: {}, lastConsolidate: {}, insightNames: {} }))
  const prev = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('token-guardian 已彻底移除：BUILTINS 与模块目录均不存在', () => {
  assert.equal(BUILTINS.some((m) => m.id === 'token-guardian'), false)
  assert.equal(existsSync(join(ROOT, 'src/modules/token-guardian')), false)
})

test('recallFused：RRF 真双通道叠加 + minCos 过滤低分噪声 + 向量命中记账 recallLog/hits', async (t) => {
  withTempData(t)
  // 向量构造：
  //   query -> [1, 0, 0, ...]
  //   mDual (双通道命中：含「咖啡」且 cos=0.9) -> [0.9, 0.43589, 0...]
  //   mBm25 (仅 BM25 命中：含「咖啡」但 cos=0.1 < 0.35 被滤) -> [0.1, 0.99499, 0...]
  //   mVec  (仅向量命中：不含「咖啡」但 cos=0.95) -> [0.95, 0.31225, 0...]
  //   mNoise (低相关噪声：不含「咖啡」且 cos=0.2 < 0.35 应被 minCos 滤掉) -> [0.2, 0.9798, 0...]
  const vecOf = (text) => {
    const v = new Array(64).fill(0)
    if (text.includes('双通道咖啡')) { v[0] = 0.9; v[1] = Math.sqrt(1 - 0.81) }
    else if (text.includes('纯字面咖啡')) { v[0] = 0.1; v[1] = Math.sqrt(1 - 0.01) }
    else if (text.includes('拿铁拉花')) { v[0] = 0.95; v[1] = Math.sqrt(1 - 0.95 * 0.95) }
    else if (text.includes('无关拖拉机')) { v[0] = 0.2; v[1] = Math.sqrt(1 - 0.04) }
    else { v[0] = 1 } // query
    return v
  }
  const fakeFetch = async (url, opts) => {
    const body = JSON.parse(opts.body)
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    return { ok: true, json: async () => ({ data: inputs.map((text) => ({ embedding: vecOf(String(text)) })) }) }
  }
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => ({
      ownerQQ: '10001',
      memory: { enabled: true, recallCount: 6 },
      ext: {
        memory: {
          vectorEnabled: true, vectorUrl: 'https://mock/embeddings', vectorApiKey: 'k', vectorModel: 'm', vectorDim: 64,
        },
      },
    }),
    log: { info() {}, warn() {} },
    vectorFetchImpl: fakeFetch,
  })
  t.after(() => store.dispose())

  const chat = { kind: 'private', userId: '10002', chatId: 'private:10002' }
  const idBm25 = store.add({ text: '纯字面咖啡咖啡咖啡最爱', about: '10003', scope: 'private:10002', importance: 0.7 }).id
  const idDual = store.add({ text: '双通道咖啡香醇', about: '10003', scope: 'private:10002', importance: 0.6 }).id
  const idVec = store.add({ text: '拿铁拉花教程', about: '10003', scope: 'private:10002', importance: 0.6 }).id
  const idNoise = store.add({ text: '无关拖拉机修理', about: '10003', scope: 'private:10002', importance: 0.6 }).id
  await store.vectorBackfill(store.list(''))

  const hits = await store.recallFused('喝咖啡', { chat, limit: 4, where: 'private:10002' })
  const ids = hits.map((h) => h.it.id)
  assert.equal(ids[0], idDual, '双通道共同命中应经 RRF 叠加排在首位')
  assert.ok(ids.includes(idBm25), 'BM25 命中保留')
  assert.ok(ids.includes(idVec), '高相似纯向量命中保留')
  assert.ok(!ids.includes(idNoise), 'cos < 0.35 的低相关向量噪声应被 minCos 过滤')

  // 向量命中同样记入 recallLog，且触发 hits 更新
  const lastLog = store.recalls()[0]
  assert.ok(lastLog.hits.some((h) => h.id === idVec), '纯向量命中必须写入 recallLog 以便负反馈和面板观察')
})

test('recallFused + rerank：送入完整 rerankTopN 候选池并在 rerank 后按 minScore 截断', async (t) => {
  withTempData(t)
  const prevFetch = globalThis.fetch
  let rerankDocCount = 0
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    const body = JSON.parse(opts.body)
    if (u.includes('/embeddings')) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      return { ok: true, json: async () => ({ data: inputs.map(() => ({ embedding: [1, ...Array(63).fill(0)] })) }) }
    }
    if (u.includes('/rerank')) {
      rerankDocCount = body.documents.length
      // 第 4 条（index 3）给最高分，其余给极低分 0.01（低于 minScore 0.05 应被过滤）
      return {
        ok: true,
        json: async () => ({
          results: body.documents.map((doc, idx) => ({
            index: idx,
            relevance_score: doc.includes('目标第四条') ? 0.92 : 0.01,
          })),
        }),
      }
    }
    throw new Error('unexpected url: ' + u)
  }
  t.after(() => { globalThis.fetch = prevFetch })

  const store = createMemoryStore({
    dsh: {},
    getConfig: () => ({
      ownerQQ: '10001',
      memory: { enabled: true, recallCount: 2 },
      ext: {
        memory: {
          vectorEnabled: true, vectorUrl: 'https://mock/embeddings', vectorApiKey: 'k', vectorModel: 'em', vectorDim: 64,
          rerankEnabled: true, rerankUrl: 'https://mock/rerank', rerankApiKey: 'rk', rerankModel: 'rm', rerankTopN: 10,
        },
      },
    }),
    log: { info() {}, warn() {} },
  })
  t.after(() => store.dispose())

  const chat = { kind: 'private', userId: '10002', chatId: 'private:10002' }
  store.add({ text: '周一清晨去公园慢跑五公里', about: '10003', scope: 'private:10002' })
  store.add({ text: '周二超市买了新鲜草莓蓝莓', about: '10003', scope: 'private:10002' })
  store.add({ text: '周三找师傅清洗客厅空调滤网', about: '10003', scope: 'private:10002' })
  store.add({ text: '目标第四条藏在后面计划学钢琴', about: '10003', scope: 'private:10002' })
  await store.vectorBackfill(store.list(''))

  // limit=2，但 rerankTopN=10：精排应看到全部 4 条（不是先截成 2 条），并筛出高分的目标第四条且踢掉 0.01 噪声
  const hits = await store.recallFused('随便问问', { chat, limit: 2 })
  assert.equal(rerankDocCount, 4, '精排前候选池不应被提前截断到 limit=2')
  assert.equal(hits.length, 1, '低于 minScore 的 0.01 噪声条目应被剔除')
  assert.match(hits[0].it.text, /目标第四条/)
})

test('分聊天人设隔离：私聊默认人设与群聊默认人设的经验/风格/档案各自落款互不串味', async (t) => {
  withTempData(t)
  const store = createMemoryStore({
    dsh: { llm: { stream: async function* () { yield { type: 'text-delta', text: '妹妹视角的小档案。' } } } },
    getConfig: () => ({
      ownerQQ: '10001',
      model: { provider: 'p', model: 'm' },
      persona: {
        current: 'persona-group-card',
        groupDefault: 'persona-group-card',
        privateDefault: 'persona-private-sister',
      },
      memory: { enabled: true, recallCount: 6 },
    }),
    reflectionContext: true,
    styleContext: true,
    log: { info() {}, warn() {} },
  })
  t.after(() => store.dispose())

  store.setDerivedInsights('qq:10001', [{ id: 'i1', text: '私聊温柔一点', at: Date.now() }], '主人', { sourceFingerprint: 'fp1' }) /* pii-scan:ignore */
  store.setDerivedStyle('qq:10001', ['私聊常用呀'], { sourceFingerprint: 'fp1' }) /* pii-scan:ignore */

  // 写入落款应为私聊人设 persona-private-sister，而不是全局 current persona-group-card
  const savedIns = store.insights().find((x) => x.key === 'qq:10001')?.list?.[0] /* pii-scan:ignore */
  assert.equal(savedIns?.personaId, 'persona-private-sister')
  assert.equal(store.styleSourceOf('qq:10001')?.personaId, 'persona-private-sister') /* pii-scan:ignore */

  const privCtx = store.contextFor({ kind: 'private', userId: '10001', chatId: 'private:10001' })
  assert.match(privCtx, /私聊温柔一点/)
  assert.match(privCtx, /私聊常用呀/)

  // 人物小档案按作用域解析人设落款
  for (const text of ['主人喜欢猫', '主人住杭州', '主人爱喝茶']) {
    store.add({ text, about: '10001', aboutName: '主人', scope: 'private:10001' })
  }
  assert.equal(await store.buildProfile('10001', 'private:10001'), true)
  const prof = store.profileOf('10001', 'private:10001')
  assert.equal(prof?.personaId, 'persona-private-sister')
})

test('人物小档案：纯新增 append-stale 保持降级可读，破坏性删改立刻失效停止注入', async (t) => {
  withTempData(t)
  const store = createMemoryStore({
    dsh: { llm: { stream: async function* () { yield { type: 'text-delta', text: '小李喜欢打羽毛球。' } } } },
    getConfig: () => ({ ownerQQ: '10001', model: { provider: 'p', model: 'm' }, memory: { enabled: true, recallCount: 4 } }),
    log: { info() {}, warn() {} },
  })
  t.after(() => store.dispose())

  const ids = []
  for (const text of ['小李喜欢打羽毛球', '小李在上海工作', '小李不吃香菜']) {
    ids.push(store.add({ text, about: '10002', aboutName: '小李', scope: 'private:10002' }).id)
  }
  assert.equal(await store.buildProfile('10002', 'private:10002'), true)

  // 纯新增一条记忆：档案标 stale+staleReason:'append'，待整理刷新，但期间仍可读不失明
  store.add({ text: '小李买了一把新球拍', about: '10002', aboutName: '小李', scope: 'private:10002' })
  const rawAfterAdd = store.profiles().find((p) => p.qq === '10002')
  assert.equal(rawAfterAdd.stale, true)
  assert.equal(rawAfterAdd.staleReason, 'append')
  assert.equal(store.profileOf('10002', 'private:10002')?.text, '小李喜欢打羽毛球。')

  // 破坏性删除一条旧事实：立刻升级为破坏性 stale，profileOf 返回 null
  store.remove(ids[0])
  const rawAfterDel = store.profiles().find((p) => p.qq === '10002')
  assert.equal(rawAfterDel.stale, true)
  assert.equal(rawAfterDel.staleReason, undefined)
  assert.equal(store.profileOf('10002', 'private:10002'), null)
})

test('梦境巩固：传递真实 at 与 pinned，同重要度冲突按时间新者胜出且不伤 pinned', async (t) => {
  withTempData(t)
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => ({ ownerQQ: '10001', memory: { enabled: true, recallCount: 4 } }),
    log: { info() {}, warn() {} },
  })
  t.after(() => store.dispose())

  // 两条同重要度、极性相反的事实：先加旧的，延迟确保 at 更晚再加新的
  const oldAdd = store.add({ text: '小明喜欢吃辣', about: '10002', aboutName: '小明', scope: 'private:10002', importance: 0.6 })
  await new Promise((r) => setTimeout(r, 15))
  const newAdd = store.add({ text: '小明不喜欢吃辣', about: '10002', aboutName: '小明', scope: 'private:10002', importance: 0.6 })

  const res = await store.dreamConsolidate()
  assert.equal(res.ok, true)
  const live = store.listFor(['private:10002'])
  assert.ok(live.some((m) => m.id === newAdd.id), '较新的事实必须胜出')
  assert.ok(!live.some((m) => m.id === oldAdd.id), '较旧的冲突事实应被立墓碑')

  // pinned（落盘后为数字 1）：即便更旧，也不能被梦境证伪
  const pinnedAdd = store.add({ text: '小红喜欢喝咖啡', about: '10003', aboutName: '小红', scope: 'private:10003', importance: 0.6, pinned: true })
  await new Promise((r) => setTimeout(r, 15))
  store.add({ text: '小红不喜欢喝咖啡', about: '10003', aboutName: '小红', scope: 'private:10003', importance: 0.6 })
  await store.dreamConsolidate()
  const livePinned = store.listFor(['private:10003'])
  assert.ok(livePinned.some((m) => m.id === pinnedAdd.id), 'pinned=1 的事实不得被梦境立墓碑')
})

test('biliLike 去重收紧只针对涉 B 站条目，不再误伤同作用域普通记忆', async (t) => {
  withTempData(t)
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => ({ ownerQQ: '10001', memory: { enabled: true, recallCount: 4 } }),
    log: { info() {}, warn() {} },
  })
  t.after(() => store.dispose())

  // 先放一条带 B站 标签的记忆
  store.add({ text: 'B站教程讲Docker部署要点', tags: ['B站'], scope: 'private:10001' })
  // 再放两条相似度在 [0.5, 0.6) 之间的普通非 B 站记忆（不应被压成一条）
  const r1 = store.add({ text: '周末去西湖边散步喝龙井茶', scope: 'private:10001' })
  const r2 = store.add({ text: '周末去西湖边散步拍照看日落', scope: 'private:10001' })
  assert.ok(r1.id && r2.id && r1.id !== r2.id, '同作用域存在 B站 记忆不应误把普通记忆去重阈值降到 0.5')
})

test('recallFused + rerank：单向量候选也受 minScore 过滤，并支持配置 rerankMinScore（如负 logits）', async (t) => {
  withTempData(t)
  const prevFetch = globalThis.fetch
  let nextScore = 0.01
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    const body = JSON.parse(opts.body)
    if (u.includes('/embeddings')) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      return { ok: true, json: async () => ({ data: inputs.map(() => ({ embedding: [1, ...Array(63).fill(0)] })) }) }
    }
    if (u.includes('/rerank')) {
      return { ok: true, json: async () => ({ results: [{ index: 0, relevance_score: nextScore }] }) }
    }
    throw new Error('unexpected url: ' + u)
  }
  t.after(() => { globalThis.fetch = prevFetch })

  let minScoreCfg
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => ({
      ownerQQ: '10001',
      memory: { enabled: true, recallCount: 4 },
      ext: {
        memory: {
          vectorEnabled: true, vectorUrl: 'https://mock/embeddings', vectorApiKey: 'k', vectorModel: 'em', vectorDim: 64,
          rerankEnabled: true, rerankUrl: 'https://mock/rerank', rerankApiKey: 'rk', rerankModel: 'rm', rerankTopN: 10,
          rerankMinScore: minScoreCfg,
        },
      },
    }),
    log: { info() {}, warn() {} },
  })
  t.after(() => store.dispose())

  const chat = { kind: 'private', userId: '10002', chatId: 'private:10002' }
  store.add({ text: '唯一一条擦线向量记忆', about: '10003', scope: 'private:10002' })
  await store.vectorBackfill(store.list(''))

  // 默认阈值 0.05：仅 1 条向量候选且 rerankScore=0.01 时也应被剔除，recallLog 命中为空且不计 hits
  const dropped = await store.recallFused('完全无关问句', { chat, limit: 4 })
  assert.equal(dropped.length, 0)
  assert.equal(store.recalls()[0].hits.length, 0)

  // 配成负 logits 阈值 -5：score=-1.2 允许通过
  minScoreCfg = -5
  nextScore = -1.2
  const kept = await store.recallFused('完全无关问句', { chat, limit: 4 })
  assert.equal(kept.length, 1)
})

test('biliLike 去重兼容字符串格式 tags', async (t) => {
  withTempData(t)
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => ({ ownerQQ: '10001', memory: { enabled: true, recallCount: 4 } }),
    log: { info() {}, warn() {} },
  })
  t.after(() => store.dispose())

  const first = store.add({ text: '周末一起去看新番电影吧很开心', tags: 'B站,日常', scope: 'private:10001' })
  const second = store.add({ text: '周末一起去看新番电影吧还行', scope: 'private:10001' })
  assert.equal(second.updated, first.id, '字符串格式 tags 含 B站 时也应触发 0.5 去重合并')
})


test('recallFused + rerank：空白/布尔无效 rerankMinScore 回落默认阈值 0.05，0 值可正常生效', async (t) => {
  withTempData(t)
  const prevFetch = globalThis.fetch
  let score = 0.01
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    const body = JSON.parse(opts.body)
    if (u.includes('/embeddings')) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      return { ok: true, json: async () => ({ data: inputs.map(() => ({ embedding: [1, ...Array(63).fill(0)] })) }) }
    }
    if (u.includes('/rerank')) {
      return { ok: true, json: async () => ({ results: [{ index: 0, relevance_score: score }] }) }
    }
    throw new Error('unexpected url: ' + u)
  }
  t.after(() => { globalThis.fetch = prevFetch })

  let minScoreCfg = '   '
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => ({
      ownerQQ: '10001',
      memory: { enabled: true, recallCount: 4 },
      ext: {
        memory: {
          vectorEnabled: true, vectorUrl: 'https://mock/embeddings', vectorApiKey: 'k', vectorModel: 'em', vectorDim: 64,
          rerankEnabled: true, rerankUrl: 'https://mock/rerank', rerankApiKey: 'rk', rerankModel: 'rm', rerankTopN: 10,
          rerankMinScore: minScoreCfg,
        },
      },
    }),
    log: { info() {}, warn() {} },
  })
  t.after(() => store.dispose())

  const chat = { kind: 'private', userId: '10002', chatId: 'private:10002' }
  store.add({ text: '阈值回落验证条目', about: '10003', scope: 'private:10002' })
  await store.vectorBackfill(store.list(''))

  // 空白配置与空串参数都应回落到默认 0.05，过滤 0.01
  assert.equal((await store.recallFused('无关词', { chat, rerankMinScore: '' })).length, 0)
  minScoreCfg = true
  assert.equal((await store.recallFused('无关词', { chat })).length, 0)
  // minScore=0 时保留 0.01，过滤 -0.1
  minScoreCfg = 0
  assert.equal((await store.recallFused('无关词', { chat })).length, 1)
  score = -0.1
  assert.equal((await store.recallFused('无关词', { chat })).length, 0)
})

test('biliLike 去重与 tags 归一化：支持长串、顿号分隔、非字符串容错且重载后持久保留', async (t) => {
  const dir = withTempData(t)
  const cfg = () => ({ ownerQQ: '10001', memory: { enabled: true, recallCount: 4 } })
  const store1 = createMemoryStore({ dsh: {}, getConfig: cfg, log: { info() {}, warn() {} } })

  // 超 5 字字符串与顿号：归一化为数组后保留 B站 标签且不截断丢字
  const a = store1.add({ text: '晚上在家一起看电影纪录片真好看', tags: '美食,日常,B站', scope: 'private:10001' })
  const aDup = store1.add({ text: '晚上在家一起看电影纪录片一般', scope: 'private:10001' })
  assert.equal(aDup.updated, a.id, '长字符串 tags 里的 B站 不应被 slice(0,5) 截断')

  const b = store1.add({ text: '周末去公园划船喝奶茶晒太阳聊天', tags: 'B站、随记', scope: 'private:10002' })
  const bDup = store1.add({ text: '周末去公园划船喝奶茶晒太阳吹风', scope: 'private:10002' })
  assert.equal(bDup.updated, b.id, '顿号分隔的 B站 标签也应触发 0.5 去重')

  // 非数组非字符串 tags 不抛 TypeError
  const c = store1.add({ text: '测试非标准标签字段容错能力', tags: 12345, scope: 'private:10003' })
  assert.equal(c.ok, true)
  store1.dispose()

  // 重载磁盘 Markdown 后标签仍完整保留
  const store2 = createMemoryStore({ dsh: {}, getConfig: cfg, log: { info() {}, warn() {} } })
  t.after(() => store2.dispose())
  const loaded = store2.listFor(['private:10001']).find((x) => x.id === a.id)
  assert.deepEqual(loaded.tags, ['美食', '日常', 'B站'])
  assert.equal(dir.length > 0, true)
})

// ---------------------------------------------------------------------------
// 性能相关回归（2026-11-27）：load 不再全库深拷贝、indexFor 不再物化整库、
// contextFor 一轮共用一份快照、addMany 批量写入语义与 add 一致。
// ---------------------------------------------------------------------------

test('load() 返回的对象改动不会污染内存快照（运行状态字段浅拷贝足够）', async (t) => {
  withTempData(t)
  const store = createMemoryStore({
    dsh: {}, getConfig: () => ({ ownerQQ: '10001', memory: { enabled: true, recallCount: 4 } }), log: { info() {}, warn() {} },
  })
  t.after(() => store.dispose())
  store.add({ text: '小林喜欢喝乌龙茶', about: '10002', aboutName: '小林', scope: 'private:10002' })
  store.setDerivedInsights('qq:10002', [{ id: 'a', text: '慢慢聊', at: Date.now() }], '小林', { sourceFingerprint: 'f' }) /* pii-scan:ignore */

  // 通过只读接口拿到内部状态后改它，不能让下一次读取看到脏数据
  const snap = store.insights().find((x) => x.key === 'qq:10002') /* pii-scan:ignore */
  snap.list.push({ id: 'evil', text: '这条不该出现在库里' })
  const again = store.insights().find((x) => x.key === 'qq:10002') /* pii-scan:ignore */
  assert.equal(again.list.some((i) => i.id === 'evil'), false, '改返回值不能污染库内数据')
})

test('addMany：批量写入与逐条 add 语义一致（同样的输入得到同样的库状态）', async (t) => {
  const batch = [
    { text: '小周喜欢爬山看日出', scope: 'private:10003', aboutName: '小周', importance: 0.6 },
    { text: '小周周末常去郊区爬山看日出', scope: 'private:10003', aboutName: '小周', importance: 0.6 },
    { text: '小周养了一只橘猫', scope: 'private:10003', aboutName: '小周', importance: 0.7 },
    { text: '小周最近开始学吉他', scope: 'private:10003', aboutName: '小周', importance: 0.5 },
    { text: '', scope: 'private:10003' }, // 空正文 → 跳过
    { text: '非法作用域应被拒', scope: 'not-a-scope' },
  ]
  const mk = () => {
    withTempData(t)
    return createMemoryStore({
      dsh: {}, getConfig: () => ({ ownerQQ: '10001', memory: { enabled: true, recallCount: 4 } }), log: { info() {}, warn() {} },
    })
  }
  // 逐条 add
  const one = mk()
  const oneResults = batch.map((e) => one.add({ ...e }))
  const oneLive = one.listFor(['private:10003']).map((m) => m.text).sort()
  const oneOk = oneResults.filter((r) => r.ok).length
  one.dispose()

  // 批量 addMany
  const many = mk()
  const r = many.addMany(batch.map((e) => ({ ...e })))
  const manyLive = many.listFor(['private:10003']).map((m) => m.text).sort()
  many.dispose()

  assert.deepEqual(manyLive, oneLive, '两种写法必须得到完全相同的库状态')
  assert.equal(r.added + r.updated, oneOk, '成功条数与逐条写法一致')
  assert.equal(r.skipped, 2, '空正文与非法作用域都应跳过')
  assert.ok(manyLive.every((text) => typeof text === 'string' && text.length > 0))
})

test('addMany：一次落盘，不会为每条都写一遍（整理 373 条不再刷屏淘汰日志）', async (t) => {
  withTempData(t)
  const infos = []
  const store = createMemoryStore({
    dsh: {}, getConfig: () => ({ ownerQQ: '10001', memory: { enabled: true, recallCount: 4 } }),
    log: { info: (m) => infos.push(String(m)), warn() {} },
  })
  t.after(() => store.dispose())

  // 塞满一个作用域配额（private 配额 300）：用互不重合的整词编码确保真正留存 300 条而不去重合并
  for (let i = 0; i < 300; i++) {
    store.add({ text: `seed_${i}_tok_${(i * 0x9e3779b1 >>> 0).toString(36)}`, scope: 'private:10009' })
  }
  assert.equal(store.listFor(['private:10009'], { limit: 400 }).length, 300, '预置应真正装满 300 条')
  infos.length = 0 // 清掉预置阶段的日志
  store.addMany(Array.from({ length: 60 }, (_, i) => ({
    text: `batch_${i}_tok_${((i + 1000) * 0x9e3779b1 >>> 0).toString(36)}`,
    scope: 'private:10009', importance: 0.6, source: 'auto',
  })))
  assert.equal(store.listFor(['private:10009'], { limit: 400 }).length, 300, '超出配额后应裁回 300 条')
  const evictLogs = infos.filter((l) => l.includes('淘汰'))
  assert.equal(evictLogs.length, 1, `淘汰日志应合并成一条，实际 ${evictLogs.length} 条：${JSON.stringify(evictLogs.slice(0, 3))}`)
})

test('load() 去掉深拷贝后：数组字段仍是副本，原地改返回值不能污染内存快照', async (t) => {
  withTempData(t)
  const store = createMemoryStore({
    dsh: {}, getConfig: () => ({ ownerQQ: '10001', memory: { enabled: true, recallCount: 4 } }), log: { info() {}, warn() {} },
  })
  t.after(() => store.dispose())
  store.add({ text: '带标签的记忆条目', scope: 'private:10001', tags: ['原标签'] })

  // 用户动手改返回值里的数组（面板/模块都可能这么干）→ 库里不能跟着变
  const first = store.listFor(['private:10001'])[0]
  assert.ok(Array.isArray(first.tags))
  first.tags.push('污染标签')

  const second = store.listFor(['private:10001'])[0]
  assert.deepEqual(second.tags, ['原标签'], 'tags 必须是副本，原地改不能回流到内存快照')
})

test('add() 去重合并同样更新索引；lastConsolidate().retry 改动不污染内部快照', async (t) => {
  const dir = withTempData(t)
  writeFileSync(join(dir, 'memory', 'state.json'), JSON.stringify({
    version: 1,
    hits: {},
    processed: {},
    processedSources: {},
    extractionBatches: {},
    runs: {},
    lastConsolidate: { at: 12345, retry: { count: 1, nextAt: 999 } },
    insightNames: {},
  }))
  const store = createMemoryStore({
    dsh: {}, getConfig: () => ({ ownerQQ: '10001', memory: { enabled: true, recallCount: 4 } }), log: { info() {}, warn() {} },
  })
  t.after(() => store.dispose())

  const r1 = store.add({ text: '小李在杭州西湖边工作平时很喜欢喝龙井茶', scope: 'private:10004' })
  assert.ok(r1.id)
  const chat = { kind: 'private', userId: '10004' }
  // 先建一次作用域索引缓存
  assert.equal(store.recall('杭州', { chat }).length, 1)
  // 命中去重并补充新词：索引缓存必须失效，新词可立即召回
  const r2 = store.add({ text: '小李在杭州西湖边工作平时很喜欢喝龙井茶和碧螺春', scope: 'private:10004' })
  assert.equal(r2.updated, r1.id)
  const hits = store.recall('碧螺春', { chat })
  assert.equal(hits.length, 1, '去重更新正文后新词必须可召回')

  // lastConsolidate.retry 也应做浅拷贝，外部改动不回流到快照
  const lc = store.lastConsolidate()
  lc.retry.count = 99
  assert.equal(store.lastConsolidate().retry.count, 1)
})
