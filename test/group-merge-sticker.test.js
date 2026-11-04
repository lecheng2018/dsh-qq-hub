// 回归：群聊「超过 3 条合并」不能把表情/图片变成字面文本。
//
// 2026-11-04 事故：1.3.9 为了让「话不说完」的内容不丢，把超过 3 条的 item 一律拼成字符串：
//   rest.map((i) => (i.kind === 'text' ? i.value : `[${i.kind}]`)).join(' ')
// 结果 sticker 被拼成 "[sticker]" 发进群里 —— 群友看到的就是「…白米饭 [sticker]」这几个字，
// 而不是一张表情图。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let hub
let fake

before(async () => {
  const { createFakeDsh } = await import('./helpers/fake-dsh.js')
  const dataDir = mkdtempSync(join(tmpdir(), 'merge-sticker-'))
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    ownerQQ: '10000001', botQQ: '20000002', dataDir,
    snowluma: { autoStart: false, autoAttach: false, dir: join(dataDir, 'ns') },
    voice: { engine: 'none', autoChance: 0 },
    stickers: { autoChance: 0, faces: true },
    group: { interjectChance: 0, quota: { enabled: false } },
  }))
  process.env.DSH_QQ_HUB_DATA_DIR = dataDir
  fake = createFakeDsh({ brain: () => 'x' })
  const host = await import('../src/host.js')
  const api = host.apply(fake.ctx)
  await api.ready
  await new Promise((r) => setTimeout(r, 800))
  hub = api.hub
})

const deliver = (text) => hub.deliver('group:999', text, { simulate: true })

test('群聊超过 3 条：表情保持 sticker 类型，不会变成 [sticker] 文本', async () => {
  const items = await deliver(['第一句', '第二句', '第三句', '第四句', '<sticker:吃瓜>'].join('\n'))
  const stickers = items.filter((i) => i.kind === 'sticker')
  assert.equal(stickers.length, 1, '表情要作为 sticker item 保留：' + JSON.stringify(items))
  assert.equal(stickers[0].value, '吃瓜')
  // 关键：任何文本里都不能出现 "[sticker]" 这种占位符
  for (const t of items.filter((i) => i.kind === 'text')) {
    assert.equal(/\[sticker\]/i.test(t.value), false, '文本里出现了 [sticker] 占位符：' + JSON.stringify(t.value))
  }
})

test('群聊超过 3 条：合并后总数不超过 3', async () => {
  const items = await deliver(['一', '二', '三', '四', '五', '六'].join('\n'))
  assert.ok(items.length <= 3, '合并后应该 ≤3 条，实际 ' + items.length)
})

test('群聊超过 3 条：文本内容一条都不能丢', async () => {
  const texts = ['甲句', '乙句', '丙句', '丁句', '戊句']
  const items = await deliver(texts.join('\n'))
  const all = items.filter((i) => i.kind === 'text').map((i) => i.value).join(' ')
  for (const t of texts) assert.ok(all.includes(t), '丢了内容「' + t + '」：' + all)
})

test('群聊 3 条以内原样通过，不触发合并', async () => {
  const items = await deliver(['一', '二', '<sticker:偷笑>'].join('\n'))
  assert.equal(items.length, 3)
  assert.ok(items.some((i) => i.kind === 'sticker' && i.value === '偷笑'))
})

test('纯文本超 3 条也能合并（不因为只有文本就失效）', async () => {
  const items = await deliver(['a', 'b', 'c', 'd', 'e'].join('\n'))
  assert.ok(items.length <= 3)
  assert.ok(items.every((i) => i.kind === 'text'))
})

test('多个表情：最多保留 2 条非文本，不超总数上限', async () => {
  const items = await deliver(['一', '二', '三', '<sticker:A>', '<sticker:B>', '<sticker:C>'].join('\n'))
  assert.ok(items.length <= 3, '实际 ' + items.length)
  assert.ok(items.filter((i) => i.kind === 'sticker').length <= 2)
})

// fake 环境有定时器/连接，不主动收尾进程不会退出（会把整个测试文件拖到超时）
after(async () => {
  try { fake?.dispose?.() } catch (error) {}
  setTimeout(() => process.exit(0), 200).unref?.()
})
