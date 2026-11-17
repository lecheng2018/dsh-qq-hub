// 针对压缩容错自愈与无会话清场的行为回归测试（2026-11-17）：
// 1. content_filter、撤回等主流审核拦截特征能被 100% 识别，触发自愈而非死循环
// 2. 无活跃 DSH 会话时，不报错 no-reset，直接判定就绪并落盘摘要、重置计数
// 3. 支持查看摘要详情接口与手动重置异常用量计数接口
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let seq = 0

async function boot({ ask, cfgOver = {}, sessions = null } = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'tg-resilience-'))
  const mod = (await import(`../src/modules/token-guardian/index.js?resilience=${seq++}`)).default
  const routes = {}
  const handlers = {}
  const chatId = 'group:995845542'
  const logLines = Array.from({ length: 180 }, (_, i) => ({
    chatId,
    who: i % 2 === 0 ? 'bot' : '群友',
    text: `第 ${i} 句话说了一堆事情，用来把流水撑到线上真实体量（两三千字以上）。`,
  }))
  const api = {
    dataDir: (...parts) => join(process.env.AURABOT_DATA_DIR, ...parts),
    settings: () => ({
      enabled: true, threshold: 100, idleSeconds: 0, cooldownMinutes: 120,
      summaryMaxChars: 1200, askTimeoutSeconds: 5, ...cfgOver,
    }),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    route: (path, fn) => { routes[path] = fn },
    on: (name, fn) => { (handlers[name] ||= []).push(fn) },
    context() {}, rule() {}, tool() {}, emit() {}, onDispose() {},
    defineTool: (v) => v,
    ask,
    core: {
      http: {
        body: async (req) => req?.body || {},
      },
      chatLog: { listDays: () => ['2026-11-17'], readDay: () => logLines, append() {} },
      hub: {
        sessions: () => (sessions !== null ? sessions : { [chatId]: { sessionId: 'sess-active' } }),
        resetChat: (id) => (sessions !== null ? Boolean(sessions[id]?.sessionId) : true),
        groupName: async () => '测试群',
      },
    },
  }
  return { out: mod.setup(api), routes, handlers, chatId }
}

test('内容审核拦截：content_filter、撤回等主流报错必须被识别为审核拦截并触发自愈重试', async () => {
  let callCount = 0
  const { out, chatId } = await boot({
    ask: async () => {
      callCount++
      if (callCount === 1) {
        throw new Error('模型报错：Provider finish_reason: content_filter')
      }
      return '{"topics":["讨论技术"],"background":[],"progress":[],"pending":[],"agreements":[]}'
    },
  })

  // 第一次被拦截，应削减流水并重试成功
  const res = await out.compact(chatId, { chatId })
  assert.equal(res.ok, true, '自愈重试后应压缩成功')
  assert.equal(callCount, 2, '应该在缩减流水后触发第 2 次重试')
})

test('无活跃会话时，不阻断压缩（修复 140 万字符无界暴涨 Bug）', async () => {
  // 模拟空会话映射（Bot 尚未在此群开场或会话已重置）
  const { out, routes, chatId } = await boot({
    ask: async () => '{"topics":["群友日常闲聊"],"background":[],"progress":[],"pending":[],"agreements":[]}',
    sessions: {}, // 没有 sessionId
  })

  // 模拟之前累积了 140 万字符
  const st = out.state()[chatId] || {}
  st.chars = 1420000
  out.state()[chatId] = st

  const res = await out.compact(chatId, { chatId })
  assert.equal(res.ok, true, '无活跃会话时应直接判定就绪并完成压缩')
  assert.equal(res.reason, undefined)

  // 字符计数必须被重置为摘要长度，不能继续暴涨
  const updatedSt = out.state()[chatId]
  assert.ok(updatedSt.chars < 2000, `字符数应被重置为摘要长度，实际: ${updatedSt.chars}`)
})

test('后端路由：/token-guardian/summary 与 /token-guardian/reset-usage 功能正常', async () => {
  const { out, routes, chatId } = await boot({
    ask: async () => '{"topics":["买光猫"],"background":[],"progress":[],"pending":["答应发链接"],"agreements":[]}',
  })

  // 先压缩生成一份摘要
  await out.compact(chatId, { chatId })

  // 1. 查询摘要接口
  const summaryRoute = routes['/token-guardian/summary']
  assert.ok(typeof summaryRoute === 'function')
  const sumRes = await summaryRoute({ query: { chatId } })
  assert.equal(sumRes.ok, true)
  assert.ok(sumRes.summary.text.includes('买光猫'))
  assert.equal(sumRes.summary.structured.pending[0], '答应发链接')

  // 2. 模拟用量暴涨后重置接口
  const st = out.state()[chatId]
  st.chars = 999999
  st.failures = 5
  st.lastError = '一些严重错误'

  const resetRoute = routes['/token-guardian/reset-usage']
  assert.ok(typeof resetRoute === 'function')
  const resetRes = await resetRoute({ query: { chatId } })
  assert.equal(resetRes.ok, true)

  const fixedSt = out.state()[chatId]
  assert.ok(fixedSt.chars < 2000, '字符数应已重置')
  assert.equal(fixedSt.failures, 0, '失败计数应清零')
  assert.equal(fixedSt.lastError, '', '错误信息应清除')
})
