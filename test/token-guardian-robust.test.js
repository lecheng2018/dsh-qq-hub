import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// state.json / summary.json 被写脏（null、字符串、数组）时，预算守门员不能崩。
// 真实报错：Cannot read properties of null (reading 'chars')
// 来源：tickOnce 里 estimate(st.chars) —— Object.entries(state) 给出 null 时直接抛。

function makeApi(routes, warns = []) {
  const noop = () => {}
  return {
    settings: () => ({ enabled: true, threshold: 300000, idleSeconds: 20, cooldownMinutes: 120, summaryMaxChars: 1200 }),
    config: () => ({ memory: { enabled: true } }),
    log: { info: noop, warn: (...a) => warns.push(a.join(' ')), debug: noop, error: noop },
    route: (p, fn) => { routes[p] = fn },
    on: noop, context: noop, rule: noop, tool: noop, every: noop, emit: noop, onDispose: noop,
    defineTool: (x) => x,
    core: { hub: {}, http: {} },
  }
}

let seq = 0
async function boot(dir) {
  process.env.AURABOT_DATA_DIR = dir
  // 加 query 打散 import 缓存，让每个用例读到自己的目录
  const mod = (await import(`../src/modules/token-guardian/index.js?case=${seq++}`)).default
  const routes = {}
  const warns = []
  const out = mod.setup(makeApi(routes, warns))
  return { mod, routes, out, warns }
}

test('state.json 里有 null 时，/status 不崩且脏条目被过滤', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-null-'))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    'private:20002': { chars: 5000, lastAt: 1, turns: 3 },
    'group:30003': null,
    null: null,
  }))
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ 'private:20002': null }))

  const { routes, out } = await boot(dir)
  const r = await routes['/token-guardian/status']()
  assert.equal(r.ok, true, '/status 应该正常返回')
  assert.deepEqual(r.items.map((x) => x.chatId), ['private:20002'], '只留正经对象条目')
  assert.equal(r.items[0].chars, 5000)
  assert.deepEqual(Object.keys(out.state()), ['private:20002'], '脏 key 在加载时就被清掉')
})

test('state.json 整体是数组/字符串/null 时退化成空，不崩', async () => {
  for (const bad of ['[]', '"坏"', 'null', '123']) {
    const dir = mkdtempSync(join(tmpdir(), 'tg-bad-'))
    writeFileSync(join(dir, 'state.json'), bad)
    const { routes, out } = await boot(dir)
    const r = await routes['/token-guardian/status']()
    assert.equal(r.ok, true, `state=${bad} 时 /status 仍要 ok`)
    assert.deepEqual(r.items, [], `state=${bad} 时应该当空处理`)
    assert.deepEqual(out.state(), {}, `state=${bad} 时 state() 应为空对象`)
  }
})

test('summary.json 脏了也不影响上下文注入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-sum-'))
  writeFileSync(join(dir, 'state.json'), '{}')
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ 'private:1': null, 'private:2': { text: '旧摘要', at: Date.now() } }))
  const { out } = await boot(dir)
  const s = out.summaries()
  assert.ok(!('private:1' in s), 'null 摘要要被清掉')
  assert.equal(s['private:2'].text, '旧摘要', '正常摘要要留着')
})
