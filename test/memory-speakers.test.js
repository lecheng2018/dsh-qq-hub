// 回归（P2-2 群聊说话人消解）：群里「他养了什么」能把正在说话的人的记忆带上。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ab-spk-'))
mkdirSync(join(dir, 'aurabot'), { recursive: true })
process.env.AURABOT_DATA_DIR = dir
process.env.DSH_PLUGIN_DATA = dir

const { createMemoryStore } = await import('../src/features/memory.js')

const cfg = { botQQ: '10001', ownerQQ: '10001', ownerName: '主人', memory: { enabled: true, recallCount: 4, autoExtract: false } }
const noop = () => {}
const hub = { ask: noop, speakersOf: (sid) => (sid === 'sess-A' ? ['30000001'] : sid === 'sess-B' ? ['30000002'] : []) }
let store
before(() => {
  store = createMemoryStore({ dsh: { get: () => null }, getConfig: () => cfg, hub, log: { info: noop, warn: noop, debug: noop, error: noop } })
})

const G = { chatId: 'group:30003', kind: 'group', groupId: '30003' }

test('说话人消解：A 在说话，问「他养了什么」召回 A 的记忆', () => {
  store.add({ text: '我养了一只柯基叫馒头', about: '30000001', importance: 0.7, source: 'tool', chatId: G.chatId, scope: 'group:30003' })
  store.add({ text: '我周末要去爬黄山', about: '30000002', importance: 0.7, source: 'tool', chatId: G.chatId, scope: 'group:30003' })
  const hint = store.recallHint(G, '他养的是什么宠物啊', '', { sessionId: 'sess-A' })
  assert.ok(hint.includes('柯基'), 'A 的宠物记忆要被召回，实际：' + hint.slice(0, 80))
})

test('说话人切换：B 在说话，同样的问题优先召回 B 的记忆', () => {
  const hint = store.recallHint(G, '他周末有什么安排吗', '', { sessionId: 'sess-B' })
  assert.ok(hint.includes('黄山'), 'B 的行程记忆要被召回，实际：' + hint.slice(0, 80))
})

test('contextFor 传 sessionId 时档案按说话人取（原有行为不回退）', () => {
  store.setProfile('30000001', '阿强爱钓鱼', '', 'group:30003')
  const ctx = store.contextFor(G, 'sess-A')
  assert.ok(ctx.includes('阿强爱钓鱼'), '说话人档案要进上下文')
})
