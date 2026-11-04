// 回归：模型列表去重（DSH 里同一模型挂在 fan 和 fan-vision 两个 provider 下会重复显示）。
// 2026-11-04 主人反馈「可用模型后面加个 vision 就重复显示了」——
// 根因是 dedupeModelList 1.3.3 就写好了，却一直没接到 listModels 上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeModelList } from '../src/core/models.js'

const groups = () => [
  { provider: 'fan', models: [{ id: 'DeepSeek-V4.1-Flash' }, { id: 'GLM-5.3-Flash' }] },
  { provider: 'fan-vision', models: [{ id: 'DeepSeek-V4.1-Flash', vision: true }, { id: 'GLM-5.3-Flash', vision: true }] },
]

test('同一模型挂在普通/vision 两个 provider 下只出现一次', () => {
  const out = dedupeModelList(groups())
  assert.equal(out.length, 2, '两个模型两条，不是四条')
  assert.deepEqual(out.map((m) => m.model).sort(), ['DeepSeek-V4.1-Flash', 'GLM-5.3-Flash'])
})

test('能力取并集：任一 provider 能看图就算能看图', () => {
  const out = dedupeModelList(groups())
  for (const m of out) assert.equal(m.vision, true, m.model + ' 应该标记能看图')
})

test('首选 provider 保持第一次出现的那个（配置里存的名字要能匹配上）', () => {
  const out = dedupeModelList(groups())
  for (const m of out) assert.equal(m.provider, 'fan', '不能换成 fan-vision，否则配置里的 fan 匹配不上列表')
})

test('合并后记下所有来源 provider', () => {
  const out = dedupeModelList(groups())
  for (const m of out) assert.deepEqual(m.providers.sort(), ['fan', 'fan-vision'])
})

test('没有 vision 变体时原样保留', () => {
  const out = dedupeModelList([{ provider: 'huawei', models: [{ id: 'Qwen3-32B' }] }])
  assert.equal(out.length, 1)
  assert.equal(out[0].vision, false)
})

test('同一个模型出现在三个 provider 下也只留一条', () => {
  const out = dedupeModelList([
    { provider: 'glm', models: [{ id: 'glm-5.3-flash' }] },
    { provider: 'glm-vision', models: [{ id: 'glm-5.3-flash', vision: true }] },
    { provider: 'huawei', models: [{ id: 'glm-5.3-flash' }] },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].providers.length, 3)
})
