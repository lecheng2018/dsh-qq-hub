import test from 'node:test'
import assert from 'node:assert/strict'
import { createQuotedMessages } from '../src/chat/quoted-messages.js'

const log = { debug() {} }

function fixture() {
  const calls = []
  const onebot = {
    async call(action, params) {
      calls.push([action, params])
      if (action === 'get_msg') {
        return {
          sender: { user_id: 42, nickname: '测试用户' },
          message: [
            { type: 'text', data: { text: '被引用的原话' } },
            { type: 'image', data: { file: 'bare.jpg', url: '' } },
          ],
        }
      }
      if (action === 'get_friend_msg_history' || action === 'get_group_msg_history') {
        return { messages: [{
          message_id: params.message_id || 7,
          sender: { user_id: 42, nickname: '测试用户' },
          message: [{ type: 'image', data: { file: 'usable.jpg', url: 'https://example.com/quoted.jpg' } }],
        }] }
      }
      throw new Error(`意外调用 ${action}`)
    },
  }
  return { calls, onebot }
}

test('引用读取统一补取历史图片，并暴露新旧核心需要的媒体视图', async () => {
  const { onebot } = fixture()
  const quotes = createQuotedMessages({
    onebot,
    log,
    getConfig: () => ({ botQQ: '20000002' }),
    isSentMessage: (id) => id === '7',
  })
  const quoted = await quotes.get('7', 'private:42')
  assert.equal(quoted.ok, true)
  assert.equal(quoted.uid, '42')
  assert.equal(quoted.isBot, true)
  assert.match(quoted.text, /被引用的原话/)
  assert.equal(quoted.images[0].data.url, 'https://example.com/quoted.jpg')
  assert.deepEqual(quoted.media, quoted.images)
  assert.equal(quoted.records, 0)
})

test('引用缓存按会话与消息 ID 隔离，同会话重复读取不重复请求', async () => {
  const { calls, onebot } = fixture()
  const quotes = createQuotedMessages({ onebot, log, getConfig: () => ({ botQQ: '20000002' }) })
  await quotes.get('7', 'private:42')
  await quotes.get('7', 'private:42')
  assert.equal(calls.length, 2)
  await quotes.get('7', 'group:99')
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map(([action]) => action), ['get_msg', 'get_friend_msg_history', 'get_msg', 'get_group_msg_history'])
})

test('引用读取失败返回可展示的失败结果，不抛出中断聊天', async () => {
  const quotes = createQuotedMessages({
    log,
    getConfig: () => ({}),
    onebot: { call: async () => { throw new Error('网关不可用') } },
  })
  assert.deepEqual(await quotes.get('bad', 'private:42'), {
    ok: false, who: '', uid: '', text: '', images: [], stickers: [], media: [], records: 0, isBot: false, at: 0,
  })
  assert.equal(await quotes.get('', 'private:42'), null)
})
