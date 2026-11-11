import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const body = src.slice(src.indexOf('function Mood('), src.indexOf('/** 人物小档案'))

function render({ health = null, reloading = false, post = async () => ({ ok: true, message: '已重新载入' }) } = {}) {
  const states = [[], {}, '', [], { text: '', aboutName: '', importance: 0.6 }, false, health, reloading, {}]
  const updates = [], toasts = [], requests = []
  let slot = 0
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((x) => x != null && x !== false) })
  const names = ['Card', 'Btn', 'Row', 'Select', 'Empty', 'ProfilesCard', 'InsightCard', 'DistillPanel', 'SlangBook', 'StyleEditor', 'OwnerMigrate', 'MemoryRow', 'RecallLog', 'MemoryImport', 'ModOff']
  const factory = new Function('h', 'useState', 'useEffect', 'useField', 'modOn', 'get', 'post', 'setPath', 'timeAgo', ...names, `${body}; return Mood`)
  const Mood = factory(h, (initial) => {
    const i = slot++
    return [i < states.length ? states[i] : initial, (value) => updates.push({ slot: i, value })]
  }, () => {}, () => ({ sw: () => null, range: () => null }), (_, name) => name === 'memory',
  async (path) => { requests.push(path); return path === '/insights' ? { items: [], styles: {} } : { items: [], stats: {}, health: { ok: true } } },
  post, () => {}, () => '', ...names)
  const draft = { memory: {} }
  const tree = Mood({ st: { config: draft }, draft, setDraft() {}, toast: (...args) => toasts.push(args) })
  const all = (node) => typeof node === 'object' && node !== null ? [node, ...node.children.flatMap(all)] : []
  return { nodes: all(tree), updates, toasts, requests }
}

test('记忆页在档案旁显示具体故障和恢复指引', () => {
  const { nodes } = render({ health: { ok: false, stateError: '进度状态损坏', brokenScopes: [{ file: '/memory/private/1/memory.md', error: '条目未闭合' }] } })
  const alert = nodes.find((node) => node.props.role === 'alert')
  assert.ok(alert)
  const text = JSON.stringify(alert)
  assert.match(text, /进度状态损坏/)
  assert.match(text, /private\/1\/memory.md/)
  assert.match(text, /条目未闭合/)
  assert.match(text, /重新载入/)
})

test('重新载入调用 POST 并刷新档案与派生列表，处理进行中及失败反馈', async () => {
  for (const failed of [false, true]) {
    const calls = []
    const env = render({ post: async (...args) => { calls.push(args); if (failed) throw new Error('连接中断'); return { ok: true, message: '已重新载入' } } })
    const button = env.nodes.find((node) => node.type === 'Btn' && node.children.includes('重新载入档案'))
    assert.ok(button)
    await button.props.onClick()
    assert.deepEqual(calls, [['/memory/reload', {}]])
    assert.deepEqual(env.updates.filter((x) => x.slot === 7).map((x) => x.value), [true, false])
    assert.ok(env.toasts.some((args) => args[0] === (failed ? '连接中断' : '已重新载入')))
    if (!failed) {
      assert.ok(env.requests.some((path) => path.startsWith('/memories?')))
      assert.ok(env.requests.includes('/insights'))
    }
  }
  const busy = render({ reloading: true }).nodes.find((node) => node.type === 'Btn' && node.props.disabled && node.children.includes('正在载入…'))
  assert.ok(busy)
})
