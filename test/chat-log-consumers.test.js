import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatLog, createChatLogApi } from '../src/chat/chat-log.js'
import { createDistillEngine } from '../src/modules/distill/index.js'
import { createSlangEngine } from '../src/modules/slang/index.js'
import { createMemoryStore } from '../src/features/memory.js'
import { withAbortTimeout } from '../src/core/llm.js'

const L1 = '{"language_features":["短句"],"topic_features":["游戏"]}'
const SLANG = '[{"word":"石化流","meaning":"一种打法"}]'
const log = { info() {}, warn() {}, debug() {} }
const day = '2026-11-10'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'chatlog-consumers-'))
  const previous = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  let time = new Date(2026, 10, 10, 12).getTime()
  const service = createChatLog({ now: () => time, log })
  const chatLog = createChatLogApi(service)
  let distillState = {}
  let slangState = {}
  const config = () => ({ ownerQQ: '10001', enabled: true, model: { provider: 'test', model: 'm' }, memory: { enabled: true, slang: true, distill: true } })
  const engines = []
  const distill = (askModelImpl, load = () => structuredClone(distillState)) => {
    const engine = createDistillEngine({
      config, targetsOf: () => [{ gid: '777', uid: '555' }], chatLog,
      loadState: load, saveState: (s) => { distillState = structuredClone(s) },
      askModelImpl, log, now: () => time,
    })
    engines.push(engine)
    return engine
  }
  const slang = (askModelImpl) => {
    const engine = createSlangEngine({
      config, chatLog, loadState: () => structuredClone(slangState),
      saveState: (s) => { slangState = structuredClone(s) }, askModelImpl, log, now: () => time,
    })
    engines.push(engine)
    return engine
  }
  const append = (count, offset = 0) => {
    for (let i = offset; i < offset + count; i++) service.append('group:777', '群友', `石化流配装这次很有趣，具体原话编号 ${i}`, '555')
  }
  t.after(() => {
    for (const engine of engines) engine.dispose?.()
    service.dispose()
    if (previous === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, service, chatLog, config, append, distill, slang,
    distillState: () => distillState, slangState: () => slangState,
    setTime: (value) => { time = value },
  }
}

test('distill checkpoints successful windows and resumes after a failure/restart without replay', async (t) => {
  const f = fixture(t)
  f.append(42)
  const prompts = []
  const first = f.distill(async (_, opts) => {
    prompts.push(opts.text)
    if (prompts.length === 2) throw new Error('provider down')
    return L1
  })
  assert.equal(await first.runL1('777', '555', {}), false)
  assert.equal(f.distillState()['777#555'].sources[day].count, 14)
  const resumed = []
  const second = f.distill(async (_, opts) => { resumed.push(opts.text); return L1 })
  assert.equal(await second.runL1('777', '555', {}), true)
  assert.equal(resumed.length, 2)
  assert.match(resumed[0], /原话编号 14/)
  assert.doesNotMatch(resumed[0].split('群聊上下文')[0], /原话编号 0\n/)
  assert.equal(f.distillState()['777#555'].sources[day].count, 42)
  assert.equal(await second.runL1('777', '555', {}), true)
  assert.equal(resumed.length, 2, '同一来源不再计费')
})

test('distill rejects replaced/shortened consumed sources and preserves its cursor', async (t) => {
  const f = fixture(t)
  f.append(14)
  let calls = 0
  const engine = f.distill(async () => { calls++; return L1 })
  assert.equal(await engine.runL1('777', '555', {}), true)
  const before = structuredClone(f.distillState())
  const rows = f.service.readDay(day)
  rows[0].text = '被外部同长度替换'
  const file = join(f.dir, 'chatlog', `${day}.jsonl`)
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  assert.equal(await engine.runL1('777', '555', {}), false)
  assert.equal(calls, 1)
  assert.deepEqual(f.distillState(), before)
  writeFileSync(file, rows.slice(0, 13).map((r) => JSON.stringify(r)).join('\n') + '\n')
  assert.equal(await engine.runL1('777', '555', {}), false)
  assert.deepEqual(f.distillState(), before)
})

test('slang owns source progress, accepts appended rows and refuses replaced prefixes', async (t) => {
  const f = fixture(t)
  f.append(12)
  let calls = 0
  const engine = f.slang(async () => { calls++; return SLANG })
  await engine.learnDay(day)
  assert.equal(f.slangState().sources[day]['777'].count, 12)
  f.append(12, 12)
  await engine.learnDay(day)
  assert.equal(calls, 2, '旧 learned[day] 不能吞掉追加流水')
  assert.equal(f.slangState().sources[day]['777'].count, 24)
  const before = structuredClone(f.slangState())
  const rows = f.service.readDay(day)
  rows[0].text = '替换已处理来源'
  writeFileSync(join(f.dir, 'chatlog', `${day}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const result = await engine.learnDay(day)
  assert.equal(result.results[0].ok, false)
  assert.match(result.results[0].error, /替换/)
  assert.deepEqual(f.slangState(), before)
})

test('slang catches up retained older days instead of retrying only yesterday', async (t) => {
  const f = fixture(t)
  f.append(12)
  f.setTime(new Date(2026, 10, 11, 12).getTime())
  f.append(12)
  f.setTime(new Date(2026, 10, 12, 12).getTime())
  const engine = f.slang(async () => SLANG)
  await engine.tick()
  assert.equal(f.slangState().sources['2026-11-10']['777'].count, 12)
  assert.equal(f.slangState().sources['2026-11-11']['777'].count, 12)
})

test('shared logs remain readable by other consumers after memory consolidation or disposal', async (t) => {
  const f = fixture(t)
  f.append(14)
  const memory = createMemoryStore({
    dsh: { get: () => null, llm: { async *stream() { yield { type: 'text-delta', text: '[]' } } } },
    getConfig: f.config, chatLog: f.chatLog, log,
  })
  assert.equal((await memory.consolidate()).ok, true)
  memory.dispose()
  const failed = f.distill(async () => { throw new Error('down') })
  assert.equal(await failed.runL1('777', '555', {}), false)
  const slang = f.slang(async () => SLANG)
  assert.equal((await slang.learnDay(day)).results[0].ok, true)
  assert.equal(f.slangState().sources[day]['777'].count, 14)
  assert.equal(f.distillState()['777#555']?.sources?.[day], undefined)
  assert.equal(f.chatLog.readDay(day).length, 14)
})

for (const type of ['distill', 'slang']) {
  test(`${type} disposal aborts in-flight work and refuses late writes`, async (t) => {
    const f = fixture(t)
    f.append(14)
    let signal
    let release
    let started
    const ready = new Promise((resolve) => { started = resolve })
    const engine = f[type](async (_, opts) => {
      signal = opts.signal
      started()
      return new Promise((resolve) => { release = resolve })
    })
    const pending = type === 'distill' ? engine.runL1('777', '555', {}) : engine.learnDay(day)
    await ready
    engine.dispose()
    await pending
    assert.equal(signal.aborted, true)
    const before = structuredClone(type === 'distill' ? f.distillState() : f.slangState())
    release(type === 'distill' ? L1 : SLANG)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(type === 'distill' ? f.distillState() : f.slangState(), before)
    assert.equal(f.chatLog.readDay(day).length, 14)
  })
}

test('model timeout wrapper also cancels immediately on parent disposal', async () => {
  const controller = new AbortController()
  let seen
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const pending = withAbortTimeout(async (signal) => {
    seen = signal
    started()
    return await new Promise(() => {})
  }, 120000, '测试', controller.signal)
  await ready
  controller.abort(new Error('consumer disposed'))
  await assert.rejects(pending, /consumer disposed/)
  assert.equal(seen.aborted, true)
})

const L2 = '{"scene_templates":{"casual_chat":{"tone":"玩梗"}}}'
const L3 = '{"persona_segment":{"speech_rules":"短句回应"}}'

test('failed L2 stays pending, retries before consuming further L1 and does not replay successful raw windows', async (t) => {
  const f = fixture(t)
  f.append(84)
  let failL2 = true
  let l1Calls = 0
  let l2Calls = 0
  const engine = f.distill(async (_, opts) => {
    if (opts.system.includes('场景聚合引擎')) {
      l2Calls++
      if (failL2) throw new Error('L2 down')
      return L2
    }
    l1Calls++
    return L1
  })
  assert.equal(await engine.runL1('777', '555', {}), false)
  assert.equal(l1Calls, 5)
  assert.equal(f.distillState()['777#555'].sources[day].count, 70)
  assert.equal(f.distillState()['777#555'].batchesSinceL2, 5)
  failL2 = false
  assert.equal(await engine.runL1('777', '555', {}), true)
  assert.equal(l2Calls, 2)
  assert.equal(l1Calls, 6)
  assert.equal(f.distillState()['777#555'].batchesSinceL2, 1)
})

test('daily L3 failures can retry on the same day; only successful targets are marked complete', async (t) => {
  const f = fixture(t)
  let calls = 0
  const engine = f.distill(async () => { calls++; if (calls === 1) throw new Error('L3 down'); return L3 }, () => ({ '777#555': { l2: JSON.parse(L2) } }))
  assert.equal(await engine.dailyTick(), 0)
  assert.equal(f.distillState()['777#555']?.lastL3Day, undefined)
  assert.equal(await engine.dailyTick(), 1)
  assert.ok(f.distillState()['777#555'].lastL3Day)
  assert.equal(await engine.dailyTick(), 0)
  assert.equal(calls, 2)
})

test('a source replaced during the model call cannot be committed by either learning consumer', async (t) => {
  const f = fixture(t)
  f.append(14)
  for (const type of ['distill', 'slang']) {
    const engine = f[type](async () => {
      const rows = f.service.readDay(day)
      rows[0].text += ' 外改'
      writeFileSync(join(f.dir, 'chatlog', `${day}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
      return type === 'distill' ? L1 : SLANG
    })
    const result = type === 'distill' ? await engine.runL1('777', '555', {}) : await engine.learnDay(day)
    assert.equal(type === 'distill' ? result : result.results[0].ok, false)
    assert.equal(type === 'distill' ? f.distillState()['777#555']?.sources?.[day] : f.slangState().sources?.[day], undefined)
  }
})

test('malformed shared logs never advance learning progress', async (t) => {
  const f = fixture(t)
  f.append(14)
  writeFileSync(join(f.dir, 'chatlog', `${day}.jsonl`), '{bad json}\n')
  let calls = 0
  const distill = f.distill(async () => { calls++; return L1 })
  const slang = f.slang(async () => { calls++; return SLANG })
  assert.equal(await distill.runL1('777', '555', {}), false)
  assert.equal((await slang.learnDay(day)).ok, false)
  assert.equal(calls, 0)
  assert.deepEqual(f.distillState(), {})
  assert.deepEqual(f.slangState(), {})
})
