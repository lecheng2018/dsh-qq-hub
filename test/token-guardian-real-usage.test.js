// 回归：压缩判定用真实 usage，不用字符估算。
//
// 2026-11-04 实测：token-guardian 估算 89k，而 DSH 上报的真实上下文是 443k（历史最大 799k），
// 差 5~9 倍。按字符估算判定等于永不压缩 —— 这是「压缩不工作」最根本的一层。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUsage, createTelemetry } from '../src/core/telemetry.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

test('上下文大小 = input + cacheRead + cacheWrite（这次请求发进去多少）', () => {
  const u = normalizeUsage({ uncachedInputTokens: 1200, outputTokens: 300, cacheReadTokens: 440000, cacheWriteTokens: 0 })
  assert.equal(u.input + u.cacheRead + u.cacheWrite, 441200, '上下文是入向三项之和，不含 output')
})

test('telemetry.contextOf 能报出某个聊天的真实上下文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-real-'))
  const t = createTelemetry({ dir: () => dir })
  assert.equal(t.contextOf('group:1'), null, '没记录时为 null')
  t.record({ chatId: 'group:1', model: 'm', usage: { uncachedInputTokens: 1000, outputTokens: 50, cacheReadTokens: 3000, cacheWriteTokens: 0 } })
  const c = t.contextOf('group:1')
  assert.ok(c, '记录后要能查到')
  assert.equal(c.tokens, 4000, '1000 + 3000')
  assert.equal(t.allContexts().length, 1)
})

test('contextOf 是「最近一次」而不是累加', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-real2-'))
  const t = createTelemetry({ dir: () => dir })
  t.record({ chatId: 'group:1', usage: { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 } })
  t.record({ chatId: 'group:1', usage: { uncachedInputTokens: 100, cacheReadTokens: 2900, cacheWriteTokens: 0 } })
  assert.equal(t.contextOf('group:1').tokens, 3000, '第二次覆盖第一次，不累加')
})

test('token-guardian 判定优先读 telemetry 的真实值', () => {
  const src = readFileSync(join(ROOT, 'src/modules/token-guardian/index.js'), 'utf8')
  assert.match(src, /telemetry\?\.contextOf/, 'tickOnce 要读真实用量')
  assert.match(src, /measured = true/, '要标记用的是真实值')
  assert.match(src, /estimated:/, 'status 要告诉面板这条是估算还是实测')
})

test('status 路由按本行 chatId 查真实用量（不再引用未定义的 key）', () => {
  const src = readFileSync(join(ROOT, 'src/modules/token-guardian/index.js'), 'utf8')
  // 2026-11-04 事故：status 的 map 里写了 `contextOf?.(key)`，key 是 activity 回调里的
  // 局部变量，路由作用域里没有 —— ReferenceError 被 catch 静默吞掉，
  // 面板永远 estimated:true，真实 usage 从未显示过。
  const statusBlock = src.split("api.route('/token-guardian/status'")[1] || ''
  assert.ok(statusBlock.includes('contextOf?.(chatId)'), 'status 里要用循环变量的 chatId')
  assert.ok(!/\bcontextOf\?\.\(key\)/.test(statusBlock), 'status 里不能再出现未定义的 key')
})
