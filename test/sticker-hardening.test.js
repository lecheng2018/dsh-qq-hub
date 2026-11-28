// 表情包加固回归：并发写入、容量上限、确定性匹配、pending、按群策略、图包。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createStickerStore
let buildStickerPack
let readStickerPack
let isStickerCandidate
let isStickerSegment
let normalize

before(async () => {
  ;({ createStickerStore } = await import('../src/features/stickers.js'))
  ;({ buildStickerPack, readStickerPack } = await import('../src/features/sticker-pack.js'))
  ;({ isStickerCandidate, isStickerSegment } = await import('../src/chat/inbound.js'))
  ;({ normalize } = await import('../src/core/config.js'))
})

const log = { info() {}, warn() {}, debug() {} }
const dir = () => mkdtempSync(join(tmpdir(), 'qqhub-sticker-hardening-'))

function png(salt, width = 200, height = 200) {
  const b = Buffer.alloc(160)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[7] = 0x0a
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20)
  b[40] = salt
  return b
}

function storeFor(overrides = {}, extra = {}) {
  process.env.DSH_QQ_HUB_DATA_DIR = dir()
  const cfg = { dryRun: true, stickers: { enabled: true, collect: true, caption: false, ...overrides }, ...extra }
  return {
    cfg,
    store: createStickerStore({
      dsh: {},
      getConfig: () => cfg,
      onebot: { call: async () => ({}) },
      log,
    }),
  }
}

test('并发收表情：两条同时收，索引里一条都不能丢', async () => {
  process.env.DSH_QQ_HUB_DATA_DIR = dir()
  const cfg = { dryRun: false, stickers: { enabled: true, collect: true, caption: false } }
  const store = createStickerStore({
    dsh: {},
    getConfig: () => cfg,
    onebot: {
      call: async (action) => {
        if (action === 'add_custom_face') await new Promise((r) => setTimeout(r, 40))
        return { emoji_id: action === 'add_custom_face' ? 'e1' : '' }
      },
    },
    log,
  })
  const a = { type: 'image', data: { url: 'base64://' + png(1).toString('base64'), sub_type: 1 } }
  const b = { type: 'image', data: { url: 'base64://' + png(2).toString('base64'), sub_type: 1 } }
  const [ra, rb] = await Promise.all([store.collect(a, 'group:1'), store.collect(b, 'group:1')])
  assert.equal(ra.ok, true)
  assert.equal(rb.ok, true)
  assert.equal(store.library().items.length, 2, '并发写入不能互相覆盖')
})

test('容量上限：自动收藏会淘汰偷来的；手动/导入不被悄悄清掉，满了就明确拒绝', async () => {
  const { store } = storeFor({ maxLibrary: 2 })
  for (let i = 1; i <= 3; i++) {
    const r = await store.collect({ type: 'image', data: { url: 'base64://' + png(i).toString('base64'), sub_type: 1 } }, 'group:1')
    assert.equal(r.ok, true)
  }
  assert.equal(store.library().items.length, 2, '超过上限要淘汰')

  const m1 = await store.addFromBuffer(png(11), { name: '手动一', from: 'manual', toQQ: false })
  const m2 = await store.addFromBuffer(png(12), { name: '手动二', from: 'manual', toQQ: false })
  assert.equal(m1.ok, true)
  assert.equal(m2.ok, true)
  assert.equal(store.library().items.length, 2)
  assert.equal(store.library().items.every((i) => i.from === 'manual'), true, '自动收藏应被手动表情挤掉')

  const m3 = await store.addFromBuffer(png(13), { name: '手动三', from: 'manual', toQQ: false })
  assert.equal(m3.ok, false)
  assert.match(m3.reason, /表情库满了/)
  const c = await store.collect({ type: 'image', data: { url: 'base64://' + png(14).toString('base64'), sub_type: 1 } }, 'group:1')
  assert.equal(c.ok, false)
  assert.match(c.reason, /表情库满了/)
})

test('匹配确定性 + 重名保护 + 按 md5 定位', async () => {
  const { store } = storeFor()
  const a = await store.addFromBuffer(png(21), { name: '委屈巴巴', tags: ['委屈'], toQQ: false })
  const b = await store.addFromBuffer(png(22), { name: '委屈巴巴', tags: ['委屈'], toQQ: false })
  const first = store.match('委屈').md5
  for (let i = 0; i < 20; i++) assert.equal(store.match('委屈').md5, first, '同分不能随机跳')
  const resolved = store.resolve('委屈')
  assert.equal(resolved.item, null)
  assert.equal(resolved.ambiguous, true)
  assert.equal(resolved.candidates.length >= 2, true)
  assert.equal(store.resolve(a.item.md5.slice(0, 8)).item.md5, a.item.md5)
  assert.equal(store.resolve(b.item.md5.slice(0, 8)).item.md5, b.item.md5)

  const dup = await store.rename(b.item.md5, '委屈巴巴', undefined)
  assert.equal(dup.ok, false)
  assert.match(dup.reason, /同名/)
  assert.equal((await store.rename(b.item.md5, '可怜兮兮', undefined)).ok, true)
  const removed = await store.removeMany([a.item.md5, b.item.md5])
  assert.equal(removed.ok, true)
  assert.equal(removed.removed, 2)
  assert.equal(store.library().items.length, 0)
})

test('pending 表情不进自动配图池；有名字/标签的才参与', async () => {
  const { pickForReply } = await import('../src/features/stickers.js')
  assert.equal(pickForReply([{ md5: 'a', name: '', tags: [], pending: true }], '嗯'), null)
  const named = { md5: 'b', name: '得意叉腰', tags: ['开心'] }
  assert.equal(pickForReply([named], '嗯'), named)
  assert.equal(pickForReply([{ md5: 'c', name: '', tags: [], pending: true }, named], '嗯'), named)
})

test('网关摘要兜底：summary 是完整表情标签才认；明确 sub_type=0 的图片不认', () => {
  assert.equal(isStickerSegment({ type: 'image', data: { summary: '[动画表情]' } }), false)
  assert.equal(isStickerCandidate({ type: 'image', data: { summary: '[动画表情]' } }), true)
  assert.equal(isStickerCandidate({ type: 'image', data: { summary: '表情包' } }), true)
  assert.equal(isStickerCandidate({ type: 'image', data: { summary: '[贴纸]' } }), true)
  assert.equal(isStickerCandidate({ type: 'image', data: { summary: '[动画表情]', sub_type: 0 } }), false)
  assert.equal(isStickerCandidate({ type: 'image', data: { summary: '今天发个表情包' } }), false)
})

test('按群策略：覆盖只作用于对应群，冷却/每小时上限生效', async () => {
  const { store } = storeFor({
    autoChance: 0.5,
    overrides: { 123: { autoChance: 0, cooldownSec: 60, sendMaxPerHour: 1, enabled: true } },
  })
  assert.equal(store.policyFor('group:123').autoChance, 0)
  assert.equal(store.policyFor('group:456').autoChance, 0.5)

  const now = 1_700_000_000_000
  assert.equal(store.canAutoSend('group:123', now), true)
  await store.markUsed('missing', 'group:123', now)
  assert.equal(store.canAutoSend('group:123', now + 1000), false, '冷却中')
  assert.equal(store.canAutoSend('group:123', now + 61_000), false, '每小时上限仍是 1')
  assert.equal(store.canAutoSend('group:123', now + 3600_001), true, '冷却和额度都过期')
  assert.equal(store.canAutoSend('group:456', now + 1000), true, '覆盖不能影响别的群')
})

test('配置归一化：按群覆盖只收已知键，群号只留数字', () => {
  const c = normalize({
    stickers: {
      overrides: {
        '12a3': { autoChance: 2, cooldownSec: -1, sendMaxPerHour: 9999, collectMode: 'owner', junk: 'x' },
        bad: { enabled: true },
        '456': { enabled: false },
      },
    },
  })
  assert.deepEqual(Object.keys(c.stickers.overrides).sort(), ['123', '456'])
  assert.equal(c.stickers.overrides['123'].autoChance, 1)
  assert.equal(c.stickers.overrides['123'].cooldownSec, 0)
  assert.equal(c.stickers.overrides['123'].sendMaxPerHour, 500)
  assert.equal(c.stickers.overrides['123'].collectMode, 'owner')
  assert.equal('junk' in c.stickers.overrides['123'], false)
  assert.equal(c.stickers.overrides['456'].enabled, false)
})

test('图包：导出/导入往返保留名字和标签', async () => {
  const { store } = storeFor()
  await store.addFromBuffer(png(41), { name: '开心', tags: ['开心', '卖萌'], toQQ: false })
  await store.addFromBuffer(png(42), { name: '委屈', tags: ['委屈'], toQQ: false })
  const zip = await store.exportPack()
  assert.ok(zip.length > 100)
  const parsed = readStickerPack(zip)
  assert.equal(parsed.items.length, 2)
  assert.deepEqual(parsed.items.map((i) => i.name).sort(), ['委屈', '开心'])

  await store.removeMany(store.library().items.map((i) => i.md5))
  assert.equal(store.library().items.length, 0)
  const imported = await store.importPack(zip, { toQQ: false })
  assert.equal(imported.ok, true)
  assert.equal(imported.added, 2)
  assert.deepEqual(store.library().items.map((i) => i.name).sort(), ['委屈', '开心'])
})

test('图包：拒绝非法文件名和坏 CRC', () => {
  assert.throws(() => buildStickerPack([{ name: 'stickers/ok.txt', data: png(51) }]), /非法文件名/)
  assert.throws(() => buildStickerPack([{ name: 'other/ok.png', data: png(52) }]), /非法文件名/)
  const data = png(53)
  const zip = buildStickerPack([{ name: 'stickers/ok.png', data, item: { name: 'ok' } }])
  const bad = Buffer.from(zip)
  bad[30 + 'stickers/ok.png'.length] ^= 0xff
  assert.throws(() => readStickerPack(bad), /校验失败|解压失败|大小不符/)
  assert.throws(() => readStickerPack(Buffer.from('not a zip')), /不是 ZIP|目录|图包/)
})

test('缩略图：有 ffmpeg/sharp 就缩，没有就退回原图', async () => {
  const { store } = storeFor()
  const r = await store.addFromBuffer(png(61), { name: '缩略图', toQQ: false })
  const thumb = await store.thumbFor(r.item.md5)
  assert.ok(thumb && thumb.buf.length > 0)
  assert.match(thumb.mime, /^image\//)
})

test('缩略图路径穿越：md5 必须是 32 位 hex，任何路径串都不读盘', async () => {
  // 缺口（P0）：thumbFor 过去直接 `join(dir(), `thumb-${key}.jpg`)` + readFileSync，
  // key 未校验 —— 传 '/../secret' 就会读到数据目录外的任意 .jpg。
  // 这里在外层真放一张 secret.jpg，用真实调用证明「改前能读到、改后返回 null」。
  const outer = mkdtempSync(join(tmpdir(), 'qqhub-sticker-trav-'))
  const data = join(outer, 'data')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(outer, 'secret.jpg'), png(71))
  // 这个 env 会被 store 工厂在创建时读取；用完必须恢复，否则后续在该文件追加用例时互相污染
  const prevDataDir = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = data
  try {
    const cfg = { dryRun: true, stickers: { enabled: true, collect: true, caption: false } }
    const store = createStickerStore({ dsh: {}, getConfig: () => cfg, onebot: { call: async () => ({}) }, log })

    for (const bad of ['/../secret', '/../../secret', '../secret', 'abc/def', 'secret', '..', 'thumb', '/etc/passwd', '']) {
      assert.equal(await store.thumbFor(bad), null, `${JSON.stringify(bad)} 不得读到盘上文件`)
    }
    // 32 位但非法的（带 g / 太短 / 太长）同样拒绝
    for (const bad of ['g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) {
      assert.equal(await store.thumbFor(bad), null)
    }

    // 合法 md5 仍正常出图；大写规范化后同样命中（面板/工具传大写也不该坏）
    const ok = await store.addFromBuffer(png(72), { name: '正常缩略图', toQQ: false })
    assert.equal(ok.ok, true)
    const thumb = await store.thumbFor(ok.item.md5)
    assert.ok(thumb && thumb.buf.length > 0, '合法 md5 必须能出缩略图')
    const upper = await store.thumbFor(ok.item.md5.toUpperCase())
    assert.ok(upper && upper.buf.length > 0, '大写 md5 规范化后仍应命中')
  } finally {
    if (prevDataDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevDataDir
  }
})
