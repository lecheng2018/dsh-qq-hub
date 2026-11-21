// 审计 Q04 / Q05 压测：在隔离进程里灌大量回合，量化的看内存与释放行为。
//
// 不是单元测试，是"拿真实实现跑一段时间"的测量脚本：
//   · Q05：灌 N 个回合，量 turns 表大小、heap 增长、以及「members 是否被剥离」；
//     同时用 turnCacheMax 模拟修复前的无上限行为做对照。
//   · Q04：反复超时，量「槽位是否真的被释放」「是否还有并发残留」。
//
// 用法：node scripts/bench-turn-lifecycle.mjs [回合数]

import { createTurnController } from '../src/chat/turn-controller.js'
import { createSystemTurns } from '../src/chat/system-turns.js'

const ROUNDS = Number(process.argv[2] || 4000)
const log = { info() {}, warn() {}, debug() {}, error() {} }

const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB'
const heap = () => {
  global.gc?.()
  return process.memoryUsage().heapUsed
}

/** 构造一条带媒体块的入站事件（贴近真实：文本 + 图片 + 引用）。 */
function inbound(i, chatKey) {
  return {
    eventId: `evt-${i}`,
    chatKey,
    text: `第 ${i} 条消息，`.repeat(20),
    segments: [
      { type: 'text', data: { text: `第 ${i} 条消息，`.repeat(20) } },
      { type: 'image', data: { url: 'https://example.com/a.png', file: 'a.png' } },
      { type: 'reply', data: { id: String(i) } },
    ],
    raw: { message: 'x'.repeat(500) },
    images: [{ url: 'https://example.com/a.png' }],
  }
}

async function runQ05({ rounds, turnCacheMax }) {
  const label = turnCacheMax === Infinity ? '修复前（无上限）' : `修复后（上限 ${turnCacheMax}）`
  const controller = createTurnController({
    log,
    ...(turnCacheMax === Infinity ? { turnCacheMax: Infinity } : { turnCacheMax }),
    merge: { waitMs: 0, maxMs: 1, groupWaitMs: 0, groupMaxMs: 1 },
    execute: async () => 'ok',
  })

  const before = heap()
  const ids = []
  let peak = before

  for (let i = 0; i < rounds; i++) {
    const r = controller.offer(inbound(i, `private:${100000 + (i % 500)}`))
    ids.push(r.turnId)
    // 等它落终态（合流窗口 0/1ms，很快就到）
    for (let k = 0; k < 200; k++) {
      const st = controller.getTurn(r.turnId)?.state
      if (st === 'succeeded' || st === 'failed' || st === 'cancelled') break
      await new Promise((res) => setImmediate(res))
    }
    if (i % 250 === 0) peak = Math.max(peak, heap())
  }

  // 等最后一个回合的落定 + 淘汰走完再统计（否则会数到「刚 set 进表、还没 prune」的那一条）
  await new Promise((res) => setTimeout(res, 50))
  const after = heap()
  let retained = 0
  for (const id of ids) if (controller.getTurn(id)) retained++

  await controller.dispose()
  return { label, before, after, peak, delta: after - before, retained, rounds }
}

async function runQ04({ rounds }) {
  // 每次都超时：验证槽位真的被释放、下一轮能立刻开
  const turns = createSystemTurns({
    createSession: async () => ({ sessionId: 'sys' }),
    resolveAgent: async () => ({ agent: { followup: async () => {} } }),
    onEvent: () => () => {},
    log,
  })
  const before = heap()
  let busyErrors = 0
  const t0 = Date.now()
  for (let i = 0; i < rounds; i++) {
    try { await turns.run('bench', '压测', `第 ${i} 轮`, { timeoutMs: 1 }) } catch (e) {
      if (/上一轮还没结束/.test(e.message)) busyErrors++
    }
  }
  const elapsed = Date.now() - t0
  let disposeOk = true
  try { await turns.dispose() } catch { disposeOk = false }
  const after = heap()
  return { before, after, delta: after - before, busyErrors, elapsed, rounds, disposeOk }
}

// ---------- 跑 ----------
console.log(`压测参数：${ROUNDS} 回合/组\n`)

const q05Before = await runQ05({ rounds: ROUNDS, turnCacheMax: Infinity })
const q05After = await runQ05({ rounds: ROUNDS, turnCacheMax: 200 })

const fmt = (r) => `${r.label.padEnd(22)} 保留 ${String(r.retained).padStart(6)} 条 | heap 增长 ${mb(r.delta).padStart(11)} | 峰值 ${mb(r.peak).padStart(11)}`

console.log('== Q05 终态回合保留 ==')
console.log('  ' + fmt(q05Before))
console.log('  ' + fmt(q05After))
const shrink = q05Before.delta > 0 ? ((1 - q05After.delta / q05Before.delta) * 100).toFixed(0) : 'n/a'
console.log(`  → 内存增长下降约 ${shrink}%，保留条目从 ${q05Before.retained} 降到 ${q05After.retained}\n`)

const q04 = await runQ04({ rounds: Math.min(ROUNDS, 2000) })
console.log('== Q04 超时释放 ==')
console.log(`  ${q04.rounds} 轮全部超时：报「上一轮还没结束」${q04.busyErrors} 次（应为 0）`)
console.log(`  总耗时 ${q04.elapsed} ms（均 ${(q04.elapsed / q04.rounds).toFixed(1)} ms/轮）`)
console.log(`  heap 增长 ${mb(q04.delta)}，dispose ${q04.disposeOk ? '正常返回' : '失败'}`)

// 断言式结论，让脚本可用于 CI
const fail = []
if (q04.busyErrors !== 0) fail.push(`Q04：仍有 ${q04.busyErrors} 次误报忙`)
if (q05After.retained > 200) fail.push(`Q05：终态保留 ${q05After.retained} 条，超过上限 200`)
if (!q04.disposeOk) fail.push('Q04：dispose 未正常返回')

console.log()
if (fail.length) { for (const f of fail) console.log('✖ ' + f); process.exitCode = 1 } else console.log('✔ 压测结论全部符合预期')