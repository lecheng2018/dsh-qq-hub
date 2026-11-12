import test from 'node:test'
import assert from 'node:assert/strict'
import { createInboundImages } from '../src/chat/inbound-images.js'

const log = { debug() {}, warn() {} }
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
const imageSegment = (data) => ({ type: 'image', data: { file: `base64://${data.toString('base64')}` } })

test('图片消息统一下载与类型校验，失败数量可用于诚实降级', async () => {
  const images = createInboundImages({ log })
  const result = await images.load({ chatId: 'private:42', stickers: [], images: [imageSegment(png), imageSegment(Buffer.from('not an image'))] })
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].mediaType, 'image/png')
  assert.equal(Buffer.from(result.images[0].data, 'base64').equals(png), true)
  assert.equal(result.failed, 1)
})

test('URL 图片块在 DSH 登记前转成 base64，文本块保持原样', async () => {
  let admitted
  const images = createInboundImages({
    log,
    dsh: {
      get: (name) => name === 'attachments' ? {
        admitPromptContent: async (content) => {
          admitted = content
          return content.map((block) => block.type === 'image' ? { ...block, attachmentId: 'att-1' } : block)
        },
      } : null,
    },
  })
  const text = { type: 'text', text: '看图' }
  const result = await images.admit([text, { type: 'image', url: `base64://${png.toString('base64')}` }])
  assert.equal(result[0], text)
  assert.equal(result[1].attachmentId, 'att-1')
  assert.equal(admitted[1].mediaType, 'image/png')
  assert.equal(Buffer.from(admitted[1].data, 'base64').equals(png), true)
})

test('附件服务不可用时不把裸图片块写进会话，保留文本和明确说明', async () => {
  const images = createInboundImages({ log, dsh: { get: () => null } })
  const result = await images.admit([{ type: 'text', text: '前文' }, { type: 'image', url: `base64://${png.toString('base64')}` }])
  assert.equal(result.length, 1)
  assert.equal(result[0].type, 'text')
  assert.match(result[0].text, /前文/)
  assert.match(result[0].text, /没能把它登记成附件/)
})
