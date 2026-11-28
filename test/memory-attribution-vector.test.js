// 回归（记忆归因与向量修复）：
// ① 向量 flush 纯摘除也落盘（旧版 pruned 恒 0 → 死向量残留磁盘、重启复活）
// ② bus.add 透传 hearsay 归因与槽位字段（旧版剥掉 speaker/status/entity/topic/title）
// ③ supersede 传递/继承来源归因（旧版把听来的事实洗成直接事实）
// ④ 去重合并传递归因（旧版传闻并入 direct 无标注）
// ⑤ recallHint 读对配置路径（旧版 cfg.memory 恒 undefined，面板 hintCount 失效）
// ⑥ 梦境归纳追加合并而非整桶覆盖反思经验、不污染人名
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createMemoryStore } = await import('../src/features/memory.js')
const { createMemoryBus } = await import('../src/features/memory-bus.js')
const { createVectorChannel, createScopeVectorFile } = await import('../src/features/memory-vector.js')
const { scopeToVecFilePath } = await import('../src/features/memory-files.js')

function makeStore(cfgOver = {}) {
  const d = mkdtempSync(join(tmpdir(), 'memattr-'))
  process.env.DSH_QQ_HUB_DATA_DIR = d
  const cfg = { ownerQQ: '10001', memory: { enabled: true, recallCount: 4 }, ...cfgOver }
  const store = createMemoryStore({
    dsh: {}, getConfig: () => cfg,
    hub: { chatLogOf: () => [], chatLogDays: () => [] },
    log: { info() {}, warn() {}, debug() {} }, personaText: () => '',
  })
  return { store, cfg, dir: d }
}

// ---- ① 向量纯摘除落盘 ----
function fakeFetch(url, opt) {
  const body = JSON.parse(opt.body)
  return Promise.resolve({
    ok: true,
    json: async () => ({
      data: body.input.map((t) => {
        const v = Array(64).fill(0)
        if (String(t).includes('猫')) v[0] = 1
        else if (String(t).includes('狗')) v[1] = 1
        else { v[0] = 0.5; v[1] = 0.5 }
        return { embedding: v }
      }),
    }),
  })
}
const itemsOf = (list) => list.map((x) => ({ tags: [], aboutName: '', entity: '', topic: '', ...x }))

test('向量通道：纯摘除的 flush 也落盘，死向量不残留磁盘', async () => {
  const memDir = mkdtempSync(join(tmpdir(), 'memvec-prune-'))
  const getConfig = () => ({ memory: { embeddings: { enabled: true, url: 'https://x', model: 'm', dim: 64, batch: 8 } } })
  const ch = createVectorChannel({ memoryDir: memDir, getConfig, log: { warn() {} }, fetchImpl: fakeFetch })
  ch.queueScope('private:10001', itemsOf([{ id: 'm1', text: '主人喜欢养猫' }, { id: 'm2', text: '邻居家的狗很吵' }]))
  await ch.flush()
  const vecPath = join(memDir, scopeToVecFilePath('private:10001'))
  const readDisk = () => createScopeVectorFile(vecPath, 64, { log: { warn() {} } }).load()
  assert.equal(readDisk().size, 2, '初始两条落盘')
  // 纯摘除：m2 消失，无新增/变更
  ch.queueScope('private:10001', itemsOf([{ id: 'm1', text: '主人喜欢养猫' }]))
  await ch.flush()
  const disk = readDisk()
  assert.equal(disk.size, 1, '纯摘除也要落盘（旧版 pruned 恒 0 永不 save，m2 残留磁盘）')
  assert.ok(disk.has('m1') && !disk.has('m2'))
  ch.dispose()
})

// ---- ② bus.add 透传归因 ----
test('bus.add：透传 speaker/status/entity/topic/title，不再剥掉 hearsay 归因', () => {
  const captured = []
  const bus = createMemoryBus({ store: { add: (o) => { captured.push(o); return { ok: true, id: 'x' } } } })
  bus.add({ text: '听小红说小明养了猫', chatId: 'private:10001', speaker: '小红', status: 'hearsay', entity: '猫', topic: '宠物', title: '养猫' })
  assert.equal(captured[0].speaker, '小红')
  assert.equal(captured[0].status, 'hearsay')
  assert.equal(captured[0].entity, '猫')
  assert.equal(captured[0].topic, '宠物')
  assert.equal(captured[0].title, '养猫')
})

// ---- ③ supersede 归因 ----
test('supersede：显式 status 传递到新事实', () => {
  const { store } = makeStore()
  const a = store.add({ text: '小明说他喜欢喝可乐', about: '10002', scope: 'private:10001', speaker: '小明', status: 'hearsay' })
  const s = store.supersede({ oldId: a.id, text: '小明说他已经戒掉可乐了', about: '10002', scope: 'private:10001', status: 'guess' })
  assert.ok(s.ok)
  const newItem = store.listFor(['private:10001']).find((x) => x.id === s.id)
  assert.equal(newItem.status, 'guess', 'supersede 应传递 status（旧版丢弃）')
})

test('supersede：未传 status 时继承旧事实归因', () => {
  const { store } = makeStore()
  const a = store.add({ text: '听别人说小明养了猫', about: '10002', scope: 'private:10001', speaker: '路人', status: 'hearsay' })
  const s = store.supersede({ oldId: a.id, text: '小明其实养的是狗', about: '10002', scope: 'private:10001' })
  const newItem = store.listFor(['private:10001']).find((x) => x.id === s.id)
  assert.equal(newItem.status, 'hearsay', '应继承旧事实的 hearsay')
  assert.equal(newItem.speaker, '路人', '应继承 speaker')
})

// ---- ④ 去重合并归因 ----
test('去重合并：传闻并入非 direct 条目时传递归因，但不反向降级已确认的 direct 记忆', () => {
  const { store } = makeStore()
  // 非 direct（guess）被 hearsay 合并时，传递归因与 speaker
  store.add({ text: '小明喜欢喝可乐', about: '10002', scope: 'private:10001', status: 'guess' })
  const r = store.add({ text: '小明喜欢喝可乐', about: '10002', scope: 'private:10001', speaker: '小红', status: 'hearsay' })
  assert.ok(r.updated, '相似条目应合并')
  const merged = store.listFor(['private:10001']).find((x) => x.id === r.updated)
  assert.equal(merged.status, 'hearsay', '非 direct 条目合并应带上 hearsay 标注')
  assert.equal(merged.speaker, '小红')

  // 已确认的 direct 记忆不应被 guess / hearsay 反向降级
  store.add({ text: '小红喜欢喝奶茶', about: '10003', scope: 'private:10001' }) // direct
  const r2 = store.add({ text: '小红喜欢喝奶茶', about: '10003', scope: 'private:10001', speaker: '路人', status: 'hearsay' })
  assert.ok(r2.updated)
  const mergedDirect = store.listFor(['private:10001']).find((x) => x.id === r2.updated)
  assert.equal(mergedDirect.status, undefined, '已确认的 direct 记忆不得被 hearsay 反向降级')
})

// ---- ⑤ recallHint 配置路径 ----
test('recallHint：面板 hintCount 生效（旧版读 cfg.memory 恒默认）', () => {
  const { store, cfg } = makeStore()
  for (const t of ['猫喜欢睡觉', '猫爱吃鱼', '猫经常爬树', '猫讨厌洗澡']) {
    store.add({ text: t, scope: 'private:10001', importance: 0.6 })
  }
  const chat = { kind: 'private', userId: '10001', chatId: 'private:10001' }
  cfg.memory.hintCount = 1
  const h1 = store.recallHint(chat, '猫')
  cfg.memory.hintCount = 8
  const h8 = store.recallHint(chat, '猫')
  assert.ok(h1 && h8, '应有召回提示')
  assert.notEqual(h1, h8, 'hintCount 应生效（旧版两者都默认 8，输出相同）')
  assert.ok(h1.length < h8.length, 'hintCount=1 的提示应更短')
})

// ---- ⑥ 梦境归纳追加合并 ----
test('梦境归纳：追加合并保留反思经验，不污染人名', () => {
  const { store } = makeStore()
  store.setInsights('qq:10002', [{ id: 'r1', text: '小明相处经验：喜欢被夸', at: Date.now() }], '小明') /* pii-scan:ignore */
  store.setDerivedInsights('qq:10002', [{ id: 'd1', text: '梦境归纳：小明爱喝可乐', at: Date.now() }], '', { sourceFingerprint: 'dream', merge: true }) /* pii-scan:ignore */
  const bucket = store.insights().find((b) => b.key === 'qq:10002') /* pii-scan:ignore */
  assert.equal(bucket.name, '小明', '梦境不应把人名改成「梦境归纳」')
  const texts = bucket.list.map((x) => x.text)
  assert.ok(texts.includes('小明相处经验：喜欢被夸'), '反思经验应保留（旧版整桶覆盖）')
  assert.ok(texts.includes('梦境归纳：小明爱喝可乐'), '梦境经验应追加')
})

test('梦境归纳：重复正文去重，不无限追加', () => {
  const { store } = makeStore()
  store.setInsights('qq:10002', [{ id: 'r1', text: '小明爱喝可乐', at: Date.now() }], '小明') /* pii-scan:ignore */
  store.setDerivedInsights('qq:10002', [{ id: 'd1', text: '小明爱喝可乐', at: Date.now() }], '', { merge: true }) /* pii-scan:ignore */
  const bucket = store.insights().find((b) => b.key === 'qq:10002') /* pii-scan:ignore */
  assert.equal(bucket.list.filter((x) => x.text === '小明爱喝可乐').length, 1, '同正文只留一条')
})