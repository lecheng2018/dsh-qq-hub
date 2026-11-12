// 思考强度：不支持的模型不能传 reasoningEffort（否则 DSH 整轮报错），支持的要按能力收敛。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { askModel, modelReasoning, pickReasoningEffort, clearReasoningCache, modelWithOverride } = await import('../src/core/llm.js')

const CFG = { model: { provider: 'p', model: 'm' } }

/**
 * reasoning: undefined = 适配器报错（查不到）；null = 没有推理元数据；{efforts, default} = 支持
 */
function fakeDsh ({ reasoning, stream }) {
  const calls = []
  let lookups = 0
  const dsh = {
    get: (n) => (n === 'llm' ? dsh.llm : undefined),
    llm: {
      async resolveModelInfo (provider, model) {
        lookups++
        if (reasoning === undefined) throw new Error('adapter 不支持查询')
        return { provider, id: model, name: model, ...(reasoning === null ? {} : { reasoning }) }
      },
      async *stream (params) {
        calls.push(params)
        if (stream) return yield * stream(params, calls)
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  return { dsh, calls, lookups: () => lookups }
}

test('没有推理元数据的模型：不返回档位，也不传 reasoningEffort', async () => {
  clearReasoningCache()
  const { dsh, calls } = fakeDsh({ reasoning: null })
  assert.equal(await modelReasoning(dsh, 'p', 'm'), null)
  assert.equal(await pickReasoningEffort(dsh, 'p', 'm', 'low'), undefined)

  const text = await askModel(dsh, { cfg: CFG, text: '在吗' })
  assert.equal(text, 'ok')
  assert.equal('reasoningEffort' in calls[0], false, '非推理模型不能带 reasoningEffort')
})

test('查不到能力（适配器报错）也当作不支持', async () => {
  clearReasoningCache()
  const { dsh, calls } = fakeDsh({ reasoning: undefined })
  assert.equal(await modelReasoning(dsh, 'p', 'm'), null)
  await askModel(dsh, { cfg: CFG, text: '在吗' })
  assert.equal('reasoningEffort' in calls[0], false)
})

test('支持的模型：按能力取值，越界就退回模型默认', async () => {
  clearReasoningCache()
  const { dsh } = fakeDsh({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } })
  assert.deepEqual(await modelReasoning(dsh, 'p', 'm'), { efforts: ['low', 'high'], default: 'high' })
  assert.equal(await pickReasoningEffort(dsh, 'p', 'm', 'low'), 'low', '想要的档位支持就用')
  assert.equal(await pickReasoningEffort(dsh, 'p', 'm', 'max'), 'high', '不支持的档位退回模型默认')
  assert.equal(await pickReasoningEffort(dsh, 'p', 'm', ''), 'high', '没指定就用模型默认')
})

test('支持的模型：askModel 会把档位传下去', async () => {
  clearReasoningCache()
  const { dsh, calls } = fakeDsh({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } })
  await askModel(dsh, { cfg: CFG, text: '在吗', reasoningEffort: 'low' })
  assert.equal(calls[0].reasoningEffort, 'low')
})

test('万一还是被拒：去掉 reasoningEffort 自动重试一次', async () => {
  clearReasoningCache()
  let n = 0
  const { dsh, calls } = fakeDsh({
    reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' },
    stream: async function * (params) {
      if (params.reasoningEffort && n++ === 0) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'model does not support reasoning effort "high"' } } }
        return
      }
      yield { type: 'text-delta', text: '第二次好了' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const text = await askModel(dsh, { cfg: CFG, text: '在吗' })
  assert.equal(text, '第二次好了')
  assert.equal(calls.length, 2, '应该重试一次')
  assert.ok(calls[0].reasoningEffort, '第一次带了档位')
  assert.equal('reasoningEffort' in calls[1], false, '第二次不带档位')
  // 被拒过之后缓存记为不支持，下次直接不传
  assert.equal(await modelReasoning(dsh, 'p', 'm'), null)
})

test('能力结果有缓存，不会每次都去问适配器', async () => {
  clearReasoningCache()
  const { dsh, lookups } = fakeDsh({ reasoning: { efforts: [{ id: 'low' }] } })
  await modelReasoning(dsh, 'p', 'm')
  await modelReasoning(dsh, 'p', 'm')
  await pickReasoningEffort(dsh, 'p', 'm', 'low')
  assert.equal(lookups(), 1, '同一个模型只查一次')
})

test('宿主没有能力查询接口（老版本 DSH）：维持老行为，照传配置的档位', async () => {
  clearReasoningCache()
  const calls = []
  const dsh = {
    get: (n) => (n === 'llm' ? dsh.llm : undefined),
    llm: {
      // 故意不提供 resolveModelInfo
      async *stream (params) {
        calls.push(params)
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  assert.equal(await pickReasoningEffort(dsh, 'p', 'm', 'max'), 'max')
  await askModel(dsh, { cfg: CFG, text: '在吗', reasoningEffort: 'max' })
  assert.equal(calls[0].reasoningEffort, 'max', '查不了就别偷偷丢掉用户配置')
})

test('空正文自动重试：推理模型只思考不答题时，再要一次并加压提示', async () => {
  clearReasoningCache()
  const calls = []
  const dsh = {
    get: (n) => (n === 'llm' ? dsh.llm : undefined),
    llm: {
      async resolveModelInfo () { return { reasoning: { efforts: ['low', 'medium', 'high'], default: 'low' } } },
      async *stream (params) {
        calls.push(params)
        if (calls.length === 1) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
        yield { type: 'text-delta', text: '档案内容' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const out = await askModel(dsh, { cfg: CFG, text: '写点什么', reasoningEffort: 'low' })
  assert.equal(out, '档案内容')
  assert.equal(calls.length, 2, '空正文后重试了一次')
  assert.match(calls[1].messages[0].content[0].text, /直接写出结果本身/, '重试时带上加压提示')
})

test('空正文只重试一次：连续两轮都空就照实返回空', async () => {
  clearReasoningCache()
  const calls = []
  const dsh = {
    get: (n) => (n === 'llm' ? dsh.llm : undefined),
    llm: {
      async resolveModelInfo () { return {} },
      async *stream (params) { calls.push(params); yield { type: 'finish', reason: { kind: 'stop' } } },
    },
  }
  const out = await askModel(dsh, { cfg: CFG, text: '写点什么' })
  assert.equal(out, '')
  assert.equal(calls.length, 2, '只重试一次')
})

test('带图的请求不触发空正文重试（图片路径有自己的兜底）', async () => {
  clearReasoningCache()
  const calls = []
  const dsh = {
    get: (n) => (n === 'llm' ? dsh.llm : undefined),
    llm: {
      async resolveModelInfo () { return {} },
      async *stream (params) { calls.push(params); yield { type: 'finish', reason: { kind: 'stop' } } },
    },
  }
  const out = await askModel(dsh, { cfg: CFG, text: '看图', images: [{ data: Buffer.from('x').toString('base64'), mediaType: 'image/png' }] })
  assert.equal(out, '')
  assert.equal(calls.length, 1)
})

// 后台任务指定模型时的合并规则（1.3.66 事故）：
// 面板「跟随主模型」传的是 { provider: '', model: '' }，直接展开会把主模型覆盖成空，
// defaultModel() 因此取不到值、静默回落到宿主默认模型 —— 看起来像「选了什么都跟着主模型」。
test('modelWithOverride：指定模型两个字段都有才替换', () => {
  const main = { provider: 'fan', model: 'main-model', reasoningEffort: 'low' }
  const picked = modelWithOverride(main, { provider: 'mini', model: 'MiniMax-M3.1-Flash' })
  assert.equal(picked.provider, 'mini', '选了就用选的')
  assert.equal(picked.model, 'MiniMax-M3.1-Flash')
  assert.equal(picked.reasoningEffort, 'low', '其它设置沿用主模型')
  assert.equal(main.provider, 'fan', '不改原对象')
})

test('modelWithOverride：留空跟随主模型，绝不用空串覆盖', () => {
  const main = { provider: 'fan', model: 'main-model', reasoningEffort: 'low', vision: 'auto' }
  for (const empty of [{ provider: '', model: '' }, {}, null, undefined, { provider: 'fan', model: '' }]) {
    const out = modelWithOverride(main, empty)
    assert.equal(out.provider, 'fan', `${JSON.stringify(empty)} 时主模型 provider 必须保留`)
    assert.equal(out.model, 'main-model', '主模型 model 必须保留')
    assert.equal(out.vision, 'auto', '其它字段照旧')
  }
  // 只填一半也不能替换（半套模型名会让请求打空）
  const half = modelWithOverride(main, { provider: 'mini', model: '' })
  assert.equal(half.provider, 'fan', '只有 provider 时跟随主模型')
})

test('modelWithOverride 的产物能被 defaultModel 认出来（端到端：不会掉到宿主默认）', async () => {
  const main = { provider: 'fan', model: 'main-model' }
  const cfg = { model: modelWithOverride(main, { provider: '', model: '' }) }
  const calls = []
  const dsh = {
    get: (n) => (n === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'host', model: 'host-default' }) }
      : n === 'llm' ? dsh.llm : undefined),
    llm: {
      async resolveModelInfo () { return { reasoning: null } },
      async *stream (params) { calls.push(params) },
    },
  }
  await askModel(dsh, { cfg, text: 'x', maxTokens: 10 }).catch(() => {})
  assert.equal(calls[0].provider, 'fan', '留空时必须走主模型，不是宿主默认')
  assert.equal(calls[0].model, 'main-model')
})
