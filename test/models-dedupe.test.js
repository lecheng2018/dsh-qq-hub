// 模型列表去重：DSH 会把同一个 provider 报两遍、同一个模型返回多条，
// 面板下拉里就出现两个一模一样的「Hy3 / fan-vision」。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const { dedupeModelList } = await import(`file:///${REPO}/src/core/models.js`)

test('同一个 provider 报两遍：模型不重复', () => {
  const out = dedupeModelList([
    { provider: 'fan-vision', models: [{ id: 'Hy3' }, { id: 'Hy3' }, { id: 'Hy4 preview' }] },
    { provider: 'fan-vision', models: [{ id: 'Hy3' }, { id: 'Hy4 preview' }] },
  ])
  assert.deepEqual(out.map((x) => x.provider + '/' + x.model), [
    'fan-vision/Hy3',
    'fan-vision/Hy4 preview',
  ])
})

test('同一 provider 第二次带出新模型：不能整段跳过', () => {
  const out = dedupeModelList([
    { provider: 'fan-vision', models: [{ id: 'Hy3' }] },
    { provider: 'fan-vision', models: [{ id: 'Hy3' }, { id: 'Hy5' }] },
  ])
  assert.deepEqual(out.map((x) => x.model), ['Hy3', 'Hy5'], '新模型要保留')
})

test('不同 provider 下的同名模型：都要保留', () => {
  const out = dedupeModelList([
    { provider: 'fan', models: [{ id: 'glm-5.3-flash' }] },
    { provider: 'mini', models: [{ id: 'glm-5.3-flash' }] },
  ])
  assert.equal(out.length, 2, 'provider 不同就不算重复')
})

test('model 字段写法（不是 id）也能去重', () => {
  const out = dedupeModelList([
    { provider: 'p', models: [{ model: 'm1' }, { model: 'm1' }] },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].model, 'm1')
})

test('空值、坏数据不崩', () => {
  assert.deepEqual(dedupeModelList(null), [])
  assert.deepEqual(dedupeModelList([]), [])
  assert.deepEqual(dedupeModelList([{ provider: '', models: [{ id: 'x' }] }]), [], '没 provider 的丢掉')
  assert.deepEqual(dedupeModelList([{ provider: 'p', models: [null, undefined, {}] }]), [], '没 model 的丢掉')
})

test('保留原始对象，方便上层取 name 等字段', () => {
  const out = dedupeModelList([{ provider: 'p', models: [{ id: 'm', name: '好看的模型' }] }])
  assert.equal(out[0].raw.name, '好看的模型')
})
