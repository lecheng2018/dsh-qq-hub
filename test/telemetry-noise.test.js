// 回归：真实上下文不能被「小请求」冲掉（2026-11-04 实测）。
//
// 群聊上下文 406k，但标题生成/摘要这类后台小调用也走同一个 chatId，
// 它们只有 128 token，按「取最新一条」会把 406k 覆盖成 128，
// token-guardian 于是看到「上下文只有 128」而永远不压缩。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelemetry } from '../src/core/telemetry.js'

const row = (at, chatId, ctx, output = 10) => ({ v: 1, at, chatId, input: 0, cacheRead: ctx, cacheWrite: 0, output, total: ctx + output })

function seeded(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'tel-noise-'))
  writeFileSync(join(dir, 'telemetry.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return { dir, t: createTelemetry({ dir: () => dir }) }
}

test('回放：后面的小请求不能把大上下文冲掉', () => {
  const { t } = seeded([row(1000, 'group:A', 406016), row(2000, 'group:A', 128)])
  assert.equal(t.contextOf('group:A').tokens, 406016, '小值要跳过')
})

test('回放：正常增长照常更新（不是只留第一条）', () => {
  const { t } = seeded([row(1000, 'group:A', 300000), row(2000, 'group:A', 380000)])
  assert.equal(t.contextOf('group:A').tokens, 380000, '更大就更新')
})

test('record：小请求不覆盖已有大值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-noise2-'))
  const t = createTelemetry({ dir: () => dir })
  t.record({ chatId: 'group:A', usage: { uncachedInputTokens: 0, outputTokens: 5, cacheReadTokens: 406016, cacheWriteTokens: 0 } })
  t.record({ chatId: 'group:A', usage: { uncachedInputTokens: 0, outputTokens: 5, cacheReadTokens: 128, cacheWriteTokens: 0 } })
  assert.equal(t.contextOf('group:A').tokens, 406016, '128 不能覆盖 406016')
})

test('record：入向 0 token 不覆盖（provider 只报 output 的情况）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-noise3-'))
  const t = createTelemetry({ dir: () => dir })
  t.record({ chatId: 'group:A', usage: { uncachedInputTokens: 300000, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } })
  t.record({ chatId: 'group:A', usage: { uncachedInputTokens: 0, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 } })
  assert.equal(t.contextOf('group:A').tokens, 300000)
})

test('clear：压缩后清掉，让下次请求重新测', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-noise4-'))
  const t = createTelemetry({ dir: () => dir })
  t.record({ chatId: 'group:A', usage: { uncachedInputTokens: 0, outputTokens: 5, cacheReadTokens: 400000, cacheWriteTokens: 0 } })
  assert.ok(t.contextOf('group:A'))
  t.clear('group:A')
  assert.equal(t.contextOf('group:A'), null, '压缩后旧值要清掉，否则会反复压')
})

test('压缩成功后确实调了 clear', () => {
  const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const src = readFileSync(join(ROOT, 'src/modules/token-guardian/index.js'), 'utf8')
  assert.match(src, /telemetry\?\.clear\?\.\(chatId\)/)
})
