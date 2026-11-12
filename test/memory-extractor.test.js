import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryExtractor } from '../src/features/memory-extractor.js'

function dshWithText(text) {
  return {
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: typeof text === 'function' ? text() : text }
      },
    },
  }
}

function fixture(output, commits = []) {
  return {
    commits,
    extractor: createMemoryExtractor({
      dsh: dshWithText(output),
      getConfig: () => ({ ownerQQ: '10001', botQQ: '20002', ownerName: '主人', model: { provider: 'test', model: 'm' } }),
      relatedTo: () => [],
      commit: (item, context) => { commits.push({ item, context }); return true },
      isActive: () => true,
    }),
  }
}

test('extractor 解析模型事实并通过提交边界返回计数，不直接写档案', async () => {
  const f = fixture('[{"op":"add","text":"小明不吃香菜，点外卖先确认","about":"小明","about_qq":"12345","importance":0.6}]')
  const added = await f.extractor.extractFacts('private:10002', '小明(12345)：我不吃香菜')
  assert.equal(added, 1)
  assert.equal(f.commits.length, 1)
  assert.equal(f.commits[0].item.text, '小明不吃香菜，点外卖先确认')
  assert.equal(f.commits[0].context.about, '12345')
  assert.equal(f.commits[0].context.chatId, 'private:10002')
})

test('extractor 拒绝无效 JSON，模型结果不产生提交副作用', async () => {
  const f = fixture('不是 JSON')
  await assert.rejects(f.extractor.extractFacts('private:10002', '内容'), /有效的记忆 JSON/)
  assert.equal(f.commits.length, 0)
})

test('提交中途失败时报告已提交条数，供批次标记待核对', async () => {
  const commits = []
  const extractor = createMemoryExtractor({
    dsh: dshWithText('[{"text":"第一条事实","about":"甲"},{"text":"第二条事实","about":"乙"}]'),
    getConfig: () => ({ ownerQQ: '10001', botQQ: '20002', model: { provider: 'test', model: 'm' } }),
    relatedTo: () => [],
    commit: (item) => {
      commits.push(item.text)
      if (commits.length === 2) throw new Error('档案写入失败')
      return true
    },
    isActive: () => true,
  })
  await assert.rejects(extractor.extractFacts('private:10002', '内容'), (error) => {
    assert.equal(error.message, '档案写入失败')
    assert.equal(error.factsCommitted, 1)
    return true
  })
})


test('extractLines 在独立状态适配器上跳过成功块并重试失败块', async () => {
  const lines = Array.from({ length: 81 }, (_, index) => ({
    chatId: 'private:10002', who: '小张', text: `第 ${index} 条需要长期保存的具体事实`,
  }))
  const states = new Map()
  const prompts = []
  let failSecond = true
  let reflected = 0
  const batchState = {
    get: (id) => states.get(id),
    start: (batch, scope) => states.set(batch.id, { fingerprint: batch.fingerprint, scope, status: 'running' }),
    fail: (batch, scope, error) => states.set(batch.id, { fingerprint: batch.fingerprint, scope, status: error.factsCommitted ? 'pending' : 'failed' }),
    done: (batch, scope, added) => states.set(batch.id, { fingerprint: batch.fingerprint, scope, status: 'done', added }),
  }
  const extractor = createMemoryExtractor({
    dsh: { llm: { async *stream(params) {
      if (params.system.includes('整理长期记忆')) {
        prompts.push(params.messages[0].content[0].text)
        if (failSecond && params.messages[0].content[0].text.includes('第 80 条')) throw new Error('第二块失败')
      }
      yield { type: 'text-delta', text: '[]' }
    } } },
    getConfig: () => ({ ownerQQ: '10001', botQQ: '20002', model: { provider: 'test', model: 'm' } }),
    relatedTo: () => [],
    commit: () => false,
    isActive: () => true,
    reflect: async () => { reflected++; return 0 },
    batchState,
    scopeOf: (chatId) => chatId,
    recoveryError: () => '',
    log: { info() {}, warn() {} },
  })
  const first = await extractor.extractLines('private:10002', lines)
  assert.equal(first.ok, false)
  assert.equal([...states.values()].filter((state) => state.status === 'done').length, 1)
  assert.equal([...states.values()].filter((state) => state.status === 'failed').length, 1)
  failSecond = false
  const second = await extractor.extractLines('private:10002', lines)
  assert.equal(second.ok, true)
  assert.equal(prompts.filter((text) => text.includes('第 0 条')).length, 1)
  assert.equal(prompts.filter((text) => text.includes('第 80 条')).length, 2)
  assert.equal(reflected, 1)
})
