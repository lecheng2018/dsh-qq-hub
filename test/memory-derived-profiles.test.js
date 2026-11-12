import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'

function fixture(t, stream) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-derived-profiles-'))
  const previous = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const store = createMemoryStore({
    dsh: { llm: { stream: stream || (async function* () { yield { type: 'text-delta', text: '小张的当前画像。' } }) } },
    getConfig: () => ({ ownerQQ: '10001', model: { provider: 'test', model: 'm' }, memory: { enabled: true, recallCount: 4 } }),
    log: { info() {}, warn() {} },
  })
  t.after(() => {
    store.dispose()
    if (previous === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, dir }
}

async function derivedProfile(store) {
  const ids = []
  for (const text of ['小张喜欢乌龙茶', '小张常去北郊骑车', '小张最近在学习摄影']) {
    ids.push(store.add({ text, about: '10002', aboutName: '小张', scope: 'private:10002' }).id)
  }
  assert.equal(await store.buildProfile('10002', 'private:10002'), true)
  return ids
}

test('事实变化使自动画像失效并停止注入，手动画像不受影响', async (t) => {
  const { store } = fixture(t)
  const ids = await derivedProfile(store)
  const generated = store.profileOf('10002', 'private:10002')
  assert.equal(generated.origin, 'derived')
  assert.deepEqual(generated.sourceFactIds, ids)
  assert.equal(typeof generated.sourceRev, 'number')

  assert.equal(store.update(ids[0], { text: '小张已经改喝黑咖啡' }).ok, true)
  const stale = store.profiles().find((p) => p.qq === '10002')
  assert.equal(stale.stale, true)
  assert.equal(store.profileOf('10002', 'private:10002'), null)
  assert.doesNotMatch(store.contextFor({ kind: 'private', userId: '10002', chatId: 'private:10002' }), /小张的当前画像/)

  store.setProfile('10002', '这是主人手工确认的小张档案', '小张', 'private:10002')
  assert.equal(store.update(ids[1], { text: '小张改去南郊骑车' }).ok, true)
  assert.equal(store.profileOf('10002', 'private:10002').text, '这是主人手工确认的小张档案')
  assert.equal(store.profileOf('10002', 'private:10002').origin, 'manual')
})

test('外部修改后 reload 使旧自动画像失效，重建带来源版本并恢复可见', async (t) => {
  const { store, dir } = fixture(t)
  await derivedProfile(store)
  const file = join(dir, 'memory/private/10002/memory.md')
  writeFileSync(file, readFileSync(file, 'utf8').replace('小张最近在学习摄影', '小张最近已经改学烹饪'), 'utf8')
  assert.equal(store.reload().ok, true)
  assert.equal(store.profiles().find((p) => p.qq === '10002').stale, true)
  assert.equal(store.profileOf('10002', 'private:10002'), null)

  assert.equal(await store.buildProfile('10002', 'private:10002'), true)
  const rebuilt = store.profileOf('10002', 'private:10002')
  assert.equal(rebuilt.origin, 'derived')
  assert.equal(rebuilt.stale, undefined)
  assert.equal(rebuilt.sourceRev > 0, true)
  assert.match(store.contextFor({ kind: 'private', userId: '10002', chatId: 'private:10002' }), /小张的当前画像/)
})


test('新增、删除与事实替代都使同作用域自动画像失效', async (t) => {
  const { store } = fixture(t)
  const ids = await derivedProfile(store)
  assert.equal(store.remove(ids[0]).ok, true)
  assert.equal(store.profiles().find((p) => p.qq === '10002').stale, true)

  store.add({ text: '小张开始练习游泳', about: '10002', aboutName: '小张', scope: 'private:10002' })
  assert.equal(store.profiles().find((p) => p.qq === '10002').stale, true)
  assert.equal(await store.buildProfile('10002', 'private:10002'), true)
  assert.equal(store.profileOf('10002', 'private:10002').stale, undefined)

  const replaced = store.supersede({ oldId: ids[1], text: '小张已不再骑车', scope: 'private:10002' })
  assert.equal(replaced.ok, true)
  assert.equal(store.profiles().find((p) => p.qq === '10002').stale, true)
  assert.equal(store.profileOf('10002', 'private:10002'), null)
})


test('模型在途时来源版本变化，旧输入生成的画像不得写入', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { store } = fixture(t, async function* () {
    await gate
    yield { type: 'text-delta', text: '基于旧事实生成的画像。' }
  })
  const ids = []
  for (const text of ['小张喜欢乌龙茶', '小张常去北郊骑车', '小张最近在学习摄影']) {
    ids.push(store.add({ text, about: '10002', aboutName: '小张', scope: 'private:10002' }).id)
  }
  const pending = store.buildProfile('10002', 'private:10002')
  await new Promise((resolve) => setTimeout(resolve, 20))
  store.update(ids[0], { text: '小张已经改喝黑咖啡' })
  release()
  assert.equal(await pending, false)
  assert.equal(store.profiles().length, 0)
  assert.equal(store.profileOf('10002', 'private:10002'), null)
})
