import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createOutbox } from '../src/chat/outbox.js'
import { legacyEventToNormalized } from '../src/chat/adapters/legacy-inbound.js'
import { createTurnController } from '../src/chat/turn-controller.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const iterationsArg = process.argv.indexOf('--iterations')
const outputArg = process.argv.indexOf('--output')
const iterations = iterationsArg >= 0 ? Number(process.argv[iterationsArg + 1]) : 300
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10000) {
  throw new RangeError('--iterations must be an integer from 1 to 10000')
}

const sent = []
const deliveries = []
const outbox = createOutbox({
  async send(action, params) {
    const messageId = `mock-${sent.length + 1}`
    sent.push({ action, params, messageId })
    return { messageId }
  },
  enabled: () => true,
  dryRun: () => false,
})
const controller = createTurnController({
  merge: { waitMs: 0, maxMs: 0, groupWaitMs: 0, groupMaxMs: 0 },
  async execute(turn, { members }) {
    const inbound = members[0]
    const delivery = await outbox.request({
      chatKey: turn.chatKey,
      deliveryId: `benchmark-${inbound.eventId}`,
      segments: [{ type: 'text', data: { text: `reply:${inbound.eventId}` } }],
      sourceModuleId: 'benchmark',
    })
    deliveries.push(delivery)
    assert.equal(delivery.state, 'sent')
  },
})

const latencies = []
const pending = []
const keepAlive = setInterval(() => {}, 1000)
const rssBeforeBytes = process.memoryUsage().rss
const startedAt = performance.now()
try {
  for (let i = 0; i < iterations; i++) {
    const itemStartedAt = performance.now()
    const event = legacyEventToNormalized({
      post_type: 'message',
      message_type: 'private',
      user_id: String(10000000 + i),
      sender: { user_id: String(10000000 + i), nickname: `synthetic-${i}` },
      message_id: `benchmark-${i}`,
      time: 1763000000,
      message: [{ type: 'text', data: { text: `synthetic message ${i}` } }],
    }, { selfId: '20000002' })
    const offered = controller.offer(event)
    pending.push(controller.waitForTurn(offered.turnId).then((outcome) => {
      assert.equal(outcome?.state, 'succeeded', `turn ${i} did not succeed`)
      latencies.push(performance.now() - itemStartedAt)
    }))
  }
  await Promise.all(pending)
} finally {
  clearInterval(keepAlive)
  await controller.dispose()
  outbox.dispose()
}
const elapsedMs = performance.now() - startedAt
assert.equal(latencies.length, iterations, 'all input events must complete')
assert.equal(deliveries.length, iterations, 'each input must produce one delivery result')
assert.ok(deliveries.every((delivery) => delivery.state === 'sent'), 'all deliveries must be confirmed sent by the fake gateway')
assert.equal(new Set(deliveries.map((delivery) => delivery.deliveryId)).size, iterations, 'delivery IDs must be unique')
assert.equal(sent.length, iterations, 'each input must produce one fake outbound call')
assert.ok(sent.every((item) => item.action === 'send_private_msg'), 'all deliveries must use the private message path')
assert.equal(new Set(sent.map((item) => item.messageId)).size, iterations, 'fake gateway receipts must be unique')

const sorted = latencies.slice().sort((a, b) => a - b)
const percentile = (p) => Number(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)].toFixed(3))
let commit = null
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
} catch {}
const report = {
  benchmark: 'normalized-inbound-to-fake-outbox',
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  commit,
  iterations,
  elapsedMs: Number(elapsedMs.toFixed(3)),
  eventsPerSecond: Number((iterations / (elapsedMs / 1000)).toFixed(2)),
  latencyMs: { p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99) },
  rssBeforeBytes,
  rssAfterBytes: process.memoryUsage().rss,
  outboundCount: sent.length,
  deliveryCount: deliveries.length,
  errors: 0,
}
const json = `${JSON.stringify(report, null, 2)}\n`
if (outputArg >= 0) {
  const outputPath = resolve(root, process.argv[outputArg + 1] || '')
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, json)
}
process.stdout.write(json)
