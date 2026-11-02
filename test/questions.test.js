import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatQuestionCard,
  formatBatchQuestions,
  parseUserAnswer,
  createQuestionRegistry
} from '../src/chat/questions.js'

test('formatQuestionCard: 单选与多选题呈现', () => {
  const qSingle = {
    id: 'q1',
    question: '是否确认重启网卡？',
    options: [
      { label: '立即重启', description: '断网约5秒' },
      { label: '稍后重启' }
    ]
  }
  const card1 = formatQuestionCard(qSingle)
  assert.match(card1, /【单选题】 是否确认重启网卡？/)
  assert.match(card1, /A\. 立即重启 \(断网约5秒\)/)
  assert.match(card1, /B\. 稍后重启/)

  const qMulti = {
    id: 'q2',
    question: '请选择清理范围',
    detail: '注意：清理后不可恢复',
    multiSelect: true,
    options: [
      { label: '构建缓存' },
      { label: '旧日志' },
      { label: '缩略图' }
    ]
  }
  const card2 = formatQuestionCard(qMulti, { index: 1, total: 2 })
  assert.match(card2, /（第 1\/2 问）/)
  assert.match(card2, /【多选题】/)
  assert.match(card2, /注意：清理后不可恢复/)
  assert.match(card2, /A\. 构建缓存/)
  assert.match(card2, /B\. 旧日志/)
  assert.match(card2, /C\. 缩略图/)
})

test('parseUserAnswer: 字母选项匹配 (单选/多选/大小写/连写)', () => {
  const qSingle = {
    id: 'q1',
    multiSelect: false,
    options: [{ label: '苹果' }, { label: '香蕉' }, { label: '橙子' }]
  }

  // 大小写字母
  assert.deepEqual(parseUserAnswer('A', qSingle), { selected: ['苹果'] })
  assert.deepEqual(parseUserAnswer('b', qSingle), { selected: ['香蕉'] })
  assert.deepEqual(parseUserAnswer('选c', qSingle), { selected: ['橙子'] })
  assert.deepEqual(parseUserAnswer('我选 B', qSingle), { selected: ['香蕉'] })

  // 多选
  const qMulti = {
    id: 'q2',
    multiSelect: true,
    options: [{ label: '构建缓存' }, { label: '旧日志' }, { label: '缩略图' }]
  }
  assert.deepEqual(parseUserAnswer('A, C', qMulti), { selected: ['构建缓存', '缩略图'] })
  assert.deepEqual(parseUserAnswer('a+b', qMulti), { selected: ['构建缓存', '旧日志'] })
  assert.deepEqual(parseUserAnswer('ac', qMulti), { selected: ['构建缓存', '缩略图'] })
  assert.deepEqual(parseUserAnswer('ABC', qMulti), { selected: ['构建缓存', '旧日志', '缩略图'] })
})

test('parseUserAnswer: 数字编号与文本标签匹配', () => {
  const q = {
    id: 'q1',
    options: [{ label: '重启容器' }, { label: '停止服务' }]
  }

  // 数字序号
  assert.deepEqual(parseUserAnswer('1', q), { selected: ['重启容器'] })
  assert.deepEqual(parseUserAnswer('选 2', q), { selected: ['停止服务'] })

  // 文本标签直接匹配
  assert.deepEqual(parseUserAnswer('重启容器', q), { selected: ['重启容器'] })
  assert.deepEqual(parseUserAnswer('停止', q), { selected: ['停止服务'] })
})

test('parseUserAnswer: 自定义输入作为 custom 回答', () => {
  const q = {
    id: 'q1',
    options: [{ label: '确认' }, { label: '取消' }]
  }
  // 未命中任何预设选项，作为 custom 文本
  assert.deepEqual(parseUserAnswer('我想明天早上8点再处理', q), {
    selected: [],
    custom: '我想明天早上8点再处理'
  })
})

test('createQuestionRegistry: 异步提问与回复状态流转', async () => {
  const sent = []
  const registry = createQuestionRegistry({
    deliver: async (chatId, text) => {
      sent.push({ chatId, text })
    },
    timeoutMs: 1000
  })

  const chatId = 'private:12345678'
  const askPromise = registry.ask(chatId, {
    questions: [
      {
        id: 'q_test',
        question: '要删除哪些文件？',
        multiSelect: true,
        options: [{ label: 'tmp' }, { label: 'log' }, { label: 'bak' }]
      }
    ]
  })

  assert.equal(registry.has(chatId), true)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /要删除哪些文件？/)

  // 模拟用户回复 "A, B"
  const handled = registry.handleReply(chatId, 'A, B')
  assert.equal(handled, true)
  assert.equal(registry.has(chatId), false)

  const result = await askPromise
  assert.deepEqual(result, {
    answers: [
      {
        id: 'q_test',
        selected: ['tmp', 'log']
      }
    ]
  })
})

test('createQuestionRegistry: 超时自动回填空答案', async () => {
  const sent = []
  const registry = createQuestionRegistry({
    deliver: async (chatId, text) => {
      sent.push({ chatId, text })
    },
    timeoutMs: 50 // 50毫秒快速超时
  })

  const chatId = 'group:999999'
  const askPromise = registry.ask(chatId, {
    questions: [
      { id: 'q_timeout', question: '请回答？', options: [{ label: '是' }, { label: '否' }] }
    ]
  })

  const result = await askPromise
  assert.deepEqual(result, {
    answers: [{ id: 'q_timeout', selected: [] }]
  })
  assert.equal(registry.has(chatId), false)
  assert.match(sent[1].text, /提问已超时/)
})
