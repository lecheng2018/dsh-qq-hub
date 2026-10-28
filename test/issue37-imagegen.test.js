// #37：生图工具返回真实图片附件，发送失败或附件不可用时如实说明。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import imagegen from '../src/modules/imagegen/index.js'

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

function setup({ send = { message_id: 1 }, admit = true, memoryThrows = false, caption = false } = {}) {
  let builder
  const events = []
  const inputs = []
  const config = { imageGen: { ownerOnly: true, stylePrompt: '', size: '1024x1024' }, memory: { enabled: caption }, model: { vision: 'on' } }
  const api = {
    core: {
      hub: { turnSendersAllOwner: () => true, sendSegments: async (_chat, segments) => { inputs.push(segments); return send } },
      local: { active: () => true, call: async () => png },
    },
    config: () => config,
    lazy: () => ({ addEvent: (event) => { if (memoryThrows) throw new Error('磁盘不可写'); events.push(event) } }),
    log: { info() {}, warn() {} },
    ask: async ({ images }) => { assert.equal(images[0].data, png.toString('base64')); return '蓝色鲸鱼在海里游泳' },
    dsh: { attachments: admit ? { admitPromptContent: async (content) => {
      assert.equal(content[0].data, png.toString('base64'))
      assert.equal(content[0].mediaType, 'image/png')
      return [{ type: 'image', attachment: { attachmentId: 'image-1', name: 'drawing', mediaType: 'image/png' } }]
    } } : null },
    tool: (fn) => { builder = fn },
  }
  imagegen.setup(api)
  const tool = builder({ chat: { kind: 'private', chatId: 'private:1', userId: '1' }, sessionId: 's' })
  return { tool, events, inputs }
}

test('本地生图把同一张图发给 QQ 并登记进 DSH 工具结果，事件记住提示词', async () => {
  const { tool, events, inputs } = setup()
  const value = await tool.execute({ prompt: '一只蓝色的鲸鱼' })
  const content = tool.output.render({}, value)
  assert.equal(inputs[0][0].data.file, 'base64://' + png.toString('base64'))
  assert.deepEqual(content[1], { type: 'image', attachment: { attachmentId: 'image-1', name: 'drawing', mediaType: 'image/png' } })
  assert.match(events[0].text, /一只蓝色的鲸鱼/)
  assert.match(events[0].text, /不一定与实际画面一致/)
})

test('开启记忆且模型支持视觉时，根据实际图片异步记下画面', async () => {
  const { tool, events } = setup({ caption: true })
  const value = await tool.execute({ prompt: '画一只鲸鱼' })
  assert.equal(value.ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(events.some((event) => event.text.includes('实际画面：蓝色鲸鱼在海里游泳')))
})

test('发送失败不谎称成功、不写经历；附件或记忆不可用不触发重复发图', async () => {
  let s = setup({ send: null })
  let value = await s.tool.execute({ prompt: '测试' })
  assert.equal(value.ok, false)
  assert.match(value.message, /没有发到 QQ/)
  assert.equal(s.events.length, 0)
  assert.equal(s.tool.output.render({}, value).length, 1)
  s = setup({ admit: false, memoryThrows: true })
  value = await s.tool.execute({ prompt: '测试' })
  assert.equal(value.ok, true)
  assert.match(value.message, /没能交给你看/)
  assert.equal(s.inputs.length, 1)
  assert.equal(s.tool.output.render({}, value).length, 1)
})
