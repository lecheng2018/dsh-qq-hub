// 模型列表去重 / 合并。两条线上真实问题：
//   1. fan 与 fan-vision 是同一批模型的两种声明（后者 vision=true），
//      以前会画成两套，用户看到「重复的供应商」，而且每行都标「能看图」。
//   2. 同一 provider 下 hy3 / hy3-x 显示名都叫 Hy3，是真的不同模型，要能分开。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const { dedupeModelList } = await import(`file:///${REPO}/src/core/models.js`)

// 线上 /models 的真实形状（节选）
const fanModels = [
  { id: 'hy3', name: 'Hy3' },
  { id: 'hy3-x', name: 'Hy3' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
]
const fanVisionModels = fanModels.map((m) => ({ ...m }))

test('fan 与 fan-vision 是同一批模型：合并成一条，不再重复', () => {
  const out = dedupeModelList([
    { provider: 'fan', models: fanModels },
    { provider: 'fan-vision', models: fanVisionModels },
  ])
  assert.deepEqual(out.map((x) => x.model), ['hy3', 'hy3-x', 'glm-5.3-flash'],
    '每个模型只应出现一次，而不是 fan 一套、fan-vision 再一套')
})

test('合并后取能看图的那个 provider 作为首选', () => {
  const out = dedupeModelList([
    { provider: 'fan', models: [{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', vision: false }] },
    { provider: 'fan-vision', models: [{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', vision: true }] },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].vision, true, '任一 provider 说能看图就算能看图')
  assert.equal(out[0].preferred.provider, 'fan-vision', '优先用能看图的 provider')
  assert.deepEqual(out[0].providers, ['fan', 'fan-vision'], '两个来源都记下来')
})

test('只有基础版（没有 vision 版）时，vision 保持 false，首选仍是它自己', () => {
  const out = dedupeModelList([{ provider: 'fan', models: [{ id: 'hy3', name: 'Hy3' }] }])
  assert.equal(out[0].vision, false)
  assert.equal(out[0].preferred.provider, 'fan')
})

test('真·同名不同模型（hy3 / hy3-x）都要保留', () => {
  const out = dedupeModelList([{ provider: 'fan', models: [{ id: 'hy3', name: 'Hy3' }, { id: 'hy3-x', name: 'Hy3' }] }])
  assert.equal(out.length, 2, '这是两个不同模型，不能并掉')
  assert.deepEqual(out.map((x) => x.model), ['hy3', 'hy3-x'])
})

test('不同 provider 的完全不同的模型，不会互相覆盖', () => {
  const out = dedupeModelList([
    { provider: 'fan', models: [{ id: 'a-model' }] },
    { provider: 'other', models: [{ id: 'b-model' }] },
  ])
  assert.deepEqual(out.map((x) => x.model).sort(), ['a-model', 'b-model'])
})

test('同一 provider 重复报同一模型：只留一条', () => {
  const out = dedupeModelList([
    { provider: 'fan', models: [{ id: 'hy3' }, { id: 'hy3' }] },
    { provider: 'fan', models: [{ id: 'hy3' }] },
  ])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].providers, ['fan'])
})

test('vision 字段的其他写法也认', () => {
  const out = dedupeModelList([
    { provider: 'p', models: [{ id: 'm', supportsVision: true }] },
    { provider: 'q', models: [{ id: 'n', capabilities: ['vision', 'tools'] }] },
  ])
  assert.equal(out.find((x) => x.model === 'm').vision, true)
  assert.equal(out.find((x) => x.model === 'n').vision, true)
})

test('空值、坏数据不崩', () => {
  assert.deepEqual(dedupeModelList(null), [])
  assert.deepEqual(dedupeModelList([]), [])
  assert.deepEqual(dedupeModelList([{ provider: '', models: [{ id: 'x' }] }]), [])
  assert.deepEqual(dedupeModelList([{ provider: 'p', models: [null, undefined, {}] }]), [])
})

test('保留原始对象，方便上层取 name', () => {
  const out = dedupeModelList([{ provider: 'p', models: [{ id: 'm', name: '好看的模型' }] }])
  assert.equal(out[0].raw.name, '好看的模型')
})
