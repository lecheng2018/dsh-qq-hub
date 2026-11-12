import test from 'node:test'
import assert from 'node:assert/strict'
import { createInboundImages } from '../src/chat/inbound-images.js'
import { createInboundVision } from '../src/chat/inbound-vision.js'

const log = { debug() {}, warn() {} }
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
const imageBlock = { type: 'image', url: `base64://${png.toString('base64')}` }

function fixture(description = '图里是一只蓝色小鲸鱼') {
  const calls = []
  const dsh = {
    get(name) {
      if (name === 'attachments') return { admitPromptContent: async (content) => content }
      if (name === 'llm') return {
        async *stream(params) {
          calls.push(params)
          yield { type: 'text-delta', text: description }
        },
      }
      return null
    },
  }
  const inboundImages = createInboundImages({ dsh, log })
  return { calls, dsh, vision: createInboundVision({ dsh, log, inboundImages }) }
}

const config = (helper = true) => ({
  model: { vision: 'off' },
  visionHelper: { enabled: helper, provider: helper ? 'helper' : '', model: helper ? 'vision' : '', maxImages: 4, maxChars: 600 },
})

test('主模型不能看图时，modular 同样获得辅助模型转述而不是裸图片块', async () => {
  const { calls, vision } = fixture()
  const result = await vision.admit([{ type: 'text', text: '这是什么' }, imageBlock], {
    nickname: '主人', hint: '这是什么', cfg: config(),
  })
  assert.equal(result.some((block) => block.type === 'image'), false)
  assert.match(result.at(-1).text, /另一个模型看过之后转述/)
  assert.match(result.at(-1).text, /蓝色小鲸鱼/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'helper')
})

test('未配置辅助模型时明确说明看不到，视觉开启时保留附件登记路径', async () => {
  const { calls, vision } = fixture()
  const blind = await vision.admit([imageBlock], { nickname: '主人', hint: '', cfg: config(false) })
  assert.equal(blind.some((block) => block.type === 'image'), false)
  assert.match(blind.at(-1).text, /主人 发了 1 张图片，你现在的模型看不了图/)
  assert.equal(calls.length, 0)

  const seeing = await vision.admit([imageBlock], {
    nickname: '主人', hint: '', cfg: { ...config(), model: { vision: 'on' } },
  })
  assert.equal(seeing[0].type, 'image')
  assert.equal(calls.length, 0)
})
