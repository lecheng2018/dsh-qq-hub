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
