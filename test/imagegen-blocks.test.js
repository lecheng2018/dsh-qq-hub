// 生图工具结果：能看图的模型拿原图（image 块），纯文本模型只拿文字
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { drawResultBlocks, imageToolBlock, drawToolMessage } = await import('../src/features/imagegen.js')
const { shrinkImage } = await import('../src/core/img.js')
const { defineTool } = await import('../src/tools/tools.js')

test('drawResultBlocks：有图时文字 + image 块，没图时只有文字', () => {
  // 正常走的是 DSH 附件块（imageToolBlock() 登记过），要原样透传
  const attachment = { type: 'image', attachment: { attachmentId: 'att-1' }, mediaType: 'image/png' }
  const withImg = drawResultBlocks({}, { ok: true, message: '画好发出去了', image: attachment })
  assert.equal(withImg.length, 2)
  assert.deepEqual(withImg[0], { type: 'text', text: '画好发出去了' })
  assert.deepEqual(withImg[1], attachment, '附件块原样进工具结果')

  const noImg = drawResultBlocks({}, { ok: true, message: '画好发出去了' })
  assert.deepEqual(noImg, [{ type: 'text', text: '画好发出去了' }], '纯文本模型只有文字，不能出现 image 块')

  // 形状不对（既没 attachment 也没 data）别硬塞 image 块
  assert.deepEqual(drawResultBlocks({}, { ok: true, message: 'x', image: { mediaType: 'image/png' } }), [{ type: 'text', text: 'x' }])

  const bad = drawResultBlocks({}, { ok: false, message: '生图服务没配' })
  assert.deepEqual(bad, [{ type: 'text', text: '✗ 生图服务没配' }])
})

test('drawToolMessage：看不了图时如实说，且不带路径', () => {
  assert.equal(drawToolMessage({ visual: true }), '画好发出去了')
  const blind = drawToolMessage({ visual: false })
  assert.match(blind, /看不了图/)
  assert.doesNotMatch(blind, /存在\s*[A-Za-z]:[\\\\/]|\.png|读它/, '不能给文件路径')
})

test('imageToolBlock：小图登记成附件块；没附件服务 / 登记失败 → null', async () => {
  const buf = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const admit = (block) => ({ admitPromptContent: async ([b]) => [{ ...block, mediaType: b.mediaType }] })

  assert.deepEqual(
    await imageToolBlock({ attachments: admit({ type: 'image', attachment: { attachmentId: 'att-9' } }) }, buf),
    { type: 'image', attachment: { attachmentId: 'att-9' }, mediaType: 'image/png' },
  )
  assert.equal(await imageToolBlock({}, buf), null, '没有附件服务 → 不带图')
  assert.equal(await imageToolBlock({ attachments: { admitPromptContent: async () => { throw new Error('nope') } } }, buf), null, '登记失败 → 不带图')
  assert.equal(await imageToolBlock(null, buf), null, '没有 dsh → 不带图')
})

test('shrinkImage：没有 ffmpeg 时安静返回 null', async () => {
  const buf = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  assert.equal(await shrinkImage(buf, 512, 'definitely-not-a-real-ffmpeg', { timeoutMs: 800 }), null)
})

test('defineTool：自定义 render 生效，默认 render 不变', () => {
  const custom = defineTool({
    name: 't1',
    description: 'd',
    execute: async () => ({ ok: true }),
    render: () => [{ type: 'image', data: 'AA', mediaType: 'image/png' }],
  })
  assert.deepEqual(custom.output.render({}, { ok: true }), [{ type: 'image', data: 'AA', mediaType: 'image/png' }])

  const plain = defineTool({ name: 't2', description: 'd', execute: async () => ({ ok: true }) })
  assert.deepEqual(plain.output.render({}, { ok: true, message: '好了' }), [{ type: 'text', text: '好了' }])
  assert.deepEqual(plain.output.render({}, { ok: false, message: '坏了' }), [{ type: 'text', text: '✗ 坏了' }])
})
