// 压缩摘要的端到端行为（2026-11-17 改成「五类结构化 → 渲染回一段话」）：
//   1. 模型按五类返回时，落库/注入的是**渲染后的一段话**，不是 JSON
//   2. 结构化结果另存一份留档（面板排障用），不进她的嘴边
//   3. 模型不按格式返回时回落纯文本，压缩照样成功（fail-soft，绝不清空记忆）
//   4. 挂起线索账本里的「还没了结的事」会被塞进压缩 prompt
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let seq = 0

async function boot({ ask, cfgOver = {}, threads = null } = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'tg-structured-'))
  const mod = (await import(`../src/modules/token-guardian/index.js?structured=${seq++}`)).default
  const routes = {}
  const handlers = {}
  const contexts = []
  const chatId = 'group:1'
  const logLines = Array.from({ length: 40 }, (_, i) => ({
    chatId,
    who: i % 3 === 0 ? 'bot' : (i % 3 === 1 ? '洛书' : '落叶'),
    text: `第 ${i} 句：光猫还没定型号，回头再说。`,
  }))
  const api = {
    dataDir: (...parts) => join(process.env.AURABOT_DATA_DIR, ...parts),
    settings: () => ({
      enabled: true, threshold: 1, idleSeconds: 0, cooldownMinutes: 120,
      summaryMaxChars: 1200, askTimeoutSeconds: 5, ...cfgOver,
    }),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    route: (path, fn) => { routes[path] = fn },
    on: (name, fn) => { (handlers[name] ||= []).push(fn) },
    context: (fn) => { contexts.push(fn) },
    rule() {}, tool() {}, emit() {}, onDispose() {},
    defineTool: (v) => v,
    ask,
    core: {
      http: {},
      chatLog: { listDays: () => ['2026-11-10'], readDay: () => logLines, append() {} },
      hub: { resetChat: () => true, isBusy: () => false },
      ...(threads ? { threads } : {}),
    },
  }
  return { out: mod.setup(api), routes, handlers, contexts, chatId }
}

const STRUCTURED_JSON = JSON.stringify({
  topics: ['他在挑光猫型号'],
  background: ['洛书说自己是电信的（事实）', '顺带开玩笑说要报销（玩笑）'],
  progress: ['型号定成 F7015MV3'],
  pending: ['他欠三条信息：运营商、兆数、光衰'],
  agreements: ['他要求私聊内容默认不外带（他提的）'],
})

test('模型按五类返回：落库与注入的都是渲染后的一段话，不是 JSON', async () => {
  const seen = []
  const { out, contexts, chatId } = await boot({
    ask: async (opts) => { seen.push(opts); return STRUCTURED_JSON },
  })
  const r = await out.compact(chatId, { chatId })
  assert.equal(r.ok, true)

  const saved = out.summaries()[chatId]
  assert.ok(saved, '摘要要落库')
  // 关键：注入的是人话，不是 JSON
  assert.doesNotMatch(saved.text, /[{}"[\]]/, `不该把 JSON 塞进上下文：${saved.text}`)
  assert.match(saved.text, /之前主要在聊他在挑光猫型号/)
  assert.match(saved.text, /还没了结的有他欠三条信息/)
  assert.match(saved.text, /你们之前说好/)
  assert.ok(saved.text.endsWith('。'))

  // 结构化另存一份留档
  assert.deepEqual(saved.structured.pending, ['他欠三条信息：运营商、兆数、光衰'])

  // 注入钩子返回的也是这段人话
  const injected = contexts.map((fn) => fn({ chat: { kind: 'group', chatId } })).filter(Boolean)
  assert.equal(injected.length, 1)
  assert.ok(injected[0].includes('还没了结的有'), '注入里要能看到未完事项')
  assert.doesNotMatch(injected[0], /\{"topics"/)
})

test('模型没按格式返回：回落纯文本，压缩仍然成功（不清空记忆）', async () => {
  const plain = '他们聊了光猫型号，最后定成 F7015MV3，还欠三条信息没给。'
  const { out, chatId } = await boot({ ask: async () => plain })
  const r = await out.compact(chatId, { chatId })
  assert.equal(r.ok, true, '解析失败不能让整次压缩失败')
  const saved = out.summaries()[chatId]
  assert.equal(saved.text, plain, '退回原文')
  assert.equal(saved.structured, undefined, '没有结构化结果就不硬塞')
})

test('模型返回被截断的 JSON：同样回落纯文本', async () => {
  const { out, chatId } = await boot({ ask: async () => '{"topics":["挑光猫"],"background":[' })
  const r = await out.compact(chatId, { chatId })
  assert.equal(r.ok, true)
  assert.ok(out.summaries()[chatId].text.includes('topics'), '半截 JSON 原样留着，至少不丢内容')
})

test('挂起线索账本里的未完事项会进压缩 prompt', async () => {
  const seen = []
  const threads = {
    list: (o) => {
      assert.equal(o.chatKey, 'group:1')
      assert.equal(o.status, 'unresolved')
      return [
        { id: 't1', type: 'promise', summary: '明天把链接发他', status: 'active' },
        { id: 't2', type: 'question_pending', summary: '光猫什么型号', status: 'active' },
      ]
    },
    stats: () => ({}),
  }
  const { out, chatId } = await boot({
    ask: async (opts) => { seen.push(opts); return STRUCTURED_JSON },
    threads,
  })
  await out.compact(chatId, { chatId })
  assert.match(seen[0].system, /并进 pending/)
  assert.match(seen[0].system, /答应了某事：明天把链接发他/)
  assert.match(seen[0].system, /问出去还没答：光猫什么型号/)
})

test('账本读不出来（抛错 / 没这接口）也不影响压缩', async () => {
  const boom = { list: () => { throw new Error('账本炸了') }, stats: () => ({}) }
  const { out, chatId } = await boot({ ask: async () => STRUCTURED_JSON, threads: boom })
  const r = await out.compact(chatId, { chatId })
  assert.equal(r.ok, true, '拿不到线索顶多少一条提示')

  const noLedger = await boot({ ask: async () => STRUCTURED_JSON })
  assert.equal((await noLedger.out.compact(noLedger.chatId, { chatId: noLedger.chatId })).ok, true)
})

test('压缩原文里说话人用真实群名片，她自己叫「你」', async () => {
  const seen = []
  const { out, chatId } = await boot({ ask: async (opts) => { seen.push(opts); return STRUCTURED_JSON } })
  await out.compact(chatId, { chatId })
  const body = seen[0].text
  assert.match(body, /你：第 0 句/, '她自己发的那几条要标「你」')
  assert.match(body, /洛书：/, '群友要用真实名片，不能一律「对方」')
  assert.match(body, /落叶：/)
  assert.doesNotMatch(body, /对方：/, '有名片时不再出现「对方」')
})
