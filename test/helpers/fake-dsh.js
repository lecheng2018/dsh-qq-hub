// 测试用的假 DSH 宿主：只实现 Aurabot 用到的那几样服务。
// 「模型」是个脚本：按用户消息内容决定回什么、调不调工具，用来验证插件的整条链路。

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function createFakeDsh({ brain, admitImages = true } = {}) {
  const disposers = []
  const listeners = new Map()
  const routes = new Map()
  const variables = new Map()
  const agents = new Map()
  const workspaces = []
  const turns = [] // 记录每一轮：{ sessionId, preset, userText, images, reply, toolCalls }
  const modelSelections = [] // selectForNextRequest 调用记录（真机缺陷 8 断言面）
  const renames = [] // sessionController.rename 调用记录（真机缺陷 9：建会话命名/回填断言面）
  const titlesBySession = new Map() // sessionId → 当前标题（sessionTitle 服务面：跨"重启"回读去重）
  const logs = []

  const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args) }

  function makeAgent(sessionId, preset) {
    const tools = new Map()
    const contexts = new Map()
    // agent 作用域的提示词变量：同名变量遮蔽全局那份（对应 DSH 的 systemPrompt.variable 作用域语义）
    const agentVars = new Map()
    const events = []
    let turn = 0
    let chain = Promise.resolve()
    const session = {
      id: sessionId,
      append: (type, data) => events.push({ type, data }),
    }
    const agent = {
      id: sessionId,
      preset,
      session,
      tools,
      contexts,
      events,
      denied: new Set(),
      ctx: {
        tools: {
          register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) },
          restrict: ({ deny = [] }) => { for (const n of deny) agent.denied.add(n); return () => { for (const n of deny) agent.denied.delete(n) } },
        },
        systemPrompt: {
          context: (c) => { contexts.set(c.name, c); return () => contexts.delete(c.name) },
          variable: (name, fn) => { agentVars.set(name, fn); return () => agentVars.delete(name) },
        },
        // 真机缺陷 4：agent.ctx 也是 cordis ctx，模块上下文走 ctx.get('contexts')（不能直接 .contexts）
        get(name) {
          if (name === 'contexts') return { set: (k, v) => contexts.set(k, v), get: (k) => contexts.get(k), values: () => contexts.values() }
          if (name === 'tools') return this.tools
          if (name === 'systemPrompt') return this.systemPrompt
          return null
        },
      },
      steered: [],
      // 假的 steer：记下来，并当作下一步输入（这里简化成排在当前这一轮之后再跑一轮）
      steer(msg) {
        agent.steered.push(msg)
        return agent.followup(msg)
      },
      followup(msg) {
        chain = chain.then(async () => {
          turn++
          const myTurn = turn
          const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
          const images = msg.content.filter((c) => c.type === 'image')
          const ctxText = [...contexts.values()].map((c) => c.text()).filter(Boolean).join('\n')
          // 作用域变量优先（按聊天换人设就是靠遮蔽这一层实现的）
          const personaFn = agentVars.get('qq_hub_persona') || variables.get('qq_hub_persona')
          const persona = personaFn?.() || ''
          const calls = []
          const callTool = async (name, args) => {
            const t = tools.get(name)
            if (!t) { calls.push({ name, args, result: { ok: false, message: 'no such tool' } }); return null }
            const result = await t.execute(args, { agent })
            calls.push({ name, args, result })
            return result
          }
          const reply = await brain({ preset, text, images, ctxText, persona, callTool, toolNames: [...tools.keys()] })
          turns.push({ sessionId, preset, userText: text, images: images.length, reply, toolCalls: calls, ctxText, persona,
            msgId: msg?.id, msgRole: msg?.role, messageSource: msg?.source, contentTypes: msg?.content?.map((c) => c.type) })
          emit('session/event', session, { type: 'assistant/message', data: { turn: myTurn, message: { content: [{ type: 'text', text: reply }] } } })
          emit('session/event', session, { type: 'turn/end', data: { turn: myTurn, reason: { kind: 'completed' } } })
        })
        return chain
      },
    }
    return agent
  }

  const globalTools = new Map() // 全局工具（DSH 所有会话都能看到）
  const provided = new Map() // ctx.provide 登记的服务
  const ctx = {
    globalTools,
    tools: { register: (t) => { if (globalTools.has(t.name)) throw new Error('dup ' + t.name); globalTools.set(t.name, t); return () => globalTools.delete(t.name) } },
    provide(name, value) { provided.set(name, value); disposers.push(() => provided.delete(name)) },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name).delete(fn)
    },
    interval(fn, ms) {
      const t = setInterval(fn, ms)
      return () => clearInterval(t)
    },
    systemPrompt: { variable: (n, fn) => { variables.set(n, fn); return () => variables.delete(n) } },
    webServer: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) } },
    workspaceRegistry: {
      archivedSessionIds: [],
      archiveSession(id) { this.archivedSessionIds.push(id) },
      list: () => workspaces,
      async create(path, title) {
        const w = { id: randomUUID(), path, title, sessionIds: [] }
        workspaces.push(w)
        return w
      },
    },
    agents: { get: (id) => agents.get(id) },
    // sessionTitle 服务面（真机缺陷 9 去重回读）：ctrl.rename 落到 titlesBySession，这里 fold 回读
    sessionTitle: { get: (session) => (session?.id ? { title: titlesBySession.get(session.id) } : null) },
    attachments: {
      async admitPromptContent(content) {
        // 真机缺陷 2 测试开关：admitImages=false 模拟登记失败（EACCES/无附件目录），验证降级不毒化会话
        if (!admitImages) throw new Error('附件登记失败（模拟：无权限）')
        return content.map((c) => (c.type === 'image' ? { type: 'image', attachment: { attachmentId: randomUUID() }, mediaType: c.mediaType } : c))
      },
    },
    llm: {
      listProviders: () => ['fake'],
      async listModels() { return ['fake-1', 'm-pdef', 'm-gdef', 'm-owner', 'm-g777'].map((id) => ({ id, name: id })) },
      async *stream() {
        yield { type: 'text-delta', text: '可爱的小鲸鱼 #开心 #卖萌' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    services: {
      sessionController: {
        async create({ workspaceId, agentPreset }) {
          const id = randomUUID()
          agents.set(id, makeAgent(id, agentPreset))
          workspaces.find((w) => w.id === workspaceId)?.sessionIds.push(id)
          return { sessionId: id, agentPreset }
        },
        async rename({ sessionId, title } = {}) { renames.push({ sessionId, title }); titlesBySession.set(sessionId, title); return {} },
        // 真机缺陷 8 断言面：会话级模型选择只经 agents.selectForNextRequest（不改全局默认）。
        // 模拟真宿主语义：选择落到该会话（写入其 session events = 「本会话下一请求用这个」的可见效果），
        // chat-model/e2e 既有断言读 events 的口径不变；modelSelections 另记一份供直接断言。
        agents: {
          get: (id) => agents.get(id),
          selectForNextRequest(agent, sel) { modelSelections.push({ agentId: agent?.id, ...sel }); agent?.session?.append?.('model/selection', sel); return true },
        },
        async resolveAgent(id) {
          const a = agents.get(id)
          return a ? { agent: a } : { error: { code: 'session/not-found', message: 'not found' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) },
    },
    get(name) {
      return this.services[name] ?? provided.get(name) ?? this[name]
    },
  }

  async function call(path, body, headers = {}, opts = {}) {
    // 默认模拟面板当前标签页已持有联动密钥；安全测试可显式 admin:false 模拟未授权调用。
    headers = { host: '127.0.0.1', ...headers }
    let bridge = null
    try {
      bridge = JSON.parse(readFileSync(join(process.env.AURABOT_DATA_DIR || '', 'config.json'), 'utf8')).bridge
    } catch {}
    if (opts.admin !== false && bridge?.http && bridge?.token && !path.startsWith('/open/')
      && !headers.authorization && !headers['x-qq-hub-token']) headers['x-qq-hub-token'] = bridge.token
    // P1 §4.9：副作用路径已拒绝 GET/HEAD（405）。与真实面板客户端（client/client.js）对齐：
    // 带 body → POST，不带 body → GET（只读路径）。有副作用的接口调用必须显式传 body（至少 {}），
    // 否则会得到 405——那是防护本意，不是脚手架缺陷。opts.method 可强制指定（测防护用）。
    const method = String(opts.method || (body === undefined ? 'GET' : 'POST')).toUpperCase()
    const full = '/qq-hub/api' + path.split('?')[0]
    // 先精确匹配，再找最长的前缀路由（和 DSH 的网页服务一样）
    const r = routes.get(full) || [...routes.values()].filter((x) => x.kind === 'prefix' && (full === x.path || full.startsWith(x.path + '/'))).sort((a, b) => b.path.length - a.path.length)[0]
    if (!r) throw new Error('no route ' + path)
    let out = ''
    let status = 200
    const req = {
      url: '/qq-hub/api' + path,
      method,
      headers,
      async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body) },
    }
    const res = { set statusCode(v) { status = v }, setHeader() {}, end(s) { out = s } }
    await r.handler(req, res)
    return { status, raw: () => out, json: () => JSON.parse(out) }
  }

  return { ctx, routes, variables, agents, workspaces, turns, logs, modelSelections, renames, call, dispose: () => disposers.reverse().forEach((d) => { try { d() } catch (e) {} }) }
}
