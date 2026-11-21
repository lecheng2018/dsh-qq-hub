// 面板「清空本分区」的二次确认必须按 kind 隔离（Q09 面板侧回归）。
// 同一 scope 下记忆行和人物档案行会并排出现；确认态若只以 scope 为键，
// 点了记忆行的「清空本分区」，档案行也会跟着变成「确认清空」——
// 用户点它就把另一种 kind 清掉了。
//
// 这里用假 React 把真实 panel.js 跑一遍（真机是 new Function 加载的，同样的执行方式）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/modules/memory-privacy/panel.js', import.meta.url), 'utf8')
const SCOPE = 'private:10000001'

const STATS = {
  ok: true,
  overrides: {},
  // 记忆与档案两个分区都有同一个 scope
  main: { total: 2, scopes: [{ scope: SCOPE, n: 2 }] },
  profiles: { total: 1, scopes: [{ scope: SCOPE, n: 1 }] },
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

/** 把 panel.js 跑起来：useState 用数组存，useEffect 在下一次渲染前补跑。 */
function mount(stats = STATS) {
  const calls = []
  const toasts = []
  // 顺序与组件里的 useState 一一对应：d / busy / viewing / viewItems / confirming / copied
  const state = [null, '', null, null, '', '']
  let slot = 0
  let effects = []
  // 假 h：真组件（ScopeRow / Panel）直接调用，ui 组件留成叶子节点，免得测试要认识 React。
  const leaf = (name) => { const f = () => {}; f.$$stub = name; return f }
  const h = (type, props, ...kids) => {
    const children = kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)
    if (typeof type === 'function' && !type.$$stub) return type({ ...(props || {}), children })
    return { type: typeof type === 'function' ? type.$$stub : type, props: props || {}, children }
  }
  const ui = { Card: leaf('Card'), Btn: leaf('Btn'), Empty: leaf('Empty') }
  const call = async (path, body) => {
    calls.push([path, body])
    if (path.startsWith('/memory-privacy/stats')) return stats
    if (path.startsWith('/memory-privacy/list')) return { ok: true, items: [] }
    return { ok: true, message: '已清空（' + (body?.scope || '') + '）' }
  }
  const React = {
    useState(initial) {
      const i = slot++
      return [i < state.length ? state[i] : initial, (value) => { state[i] = value }]
    },
    useEffect(fn) { effects.push(fn) },
  }
  // panel.js 的写法是「函数体里 return 组件」，所以 new Function 的返回值还要再调用一次
  const makePanel = new Function('React', 'h', 'ui', 'call', SRC)
  const Panel = makePanel(React, h, ui, call)
  const render = () => {
    slot = 0
    const tree = Panel({ toast: (...args) => toasts.push(args) })
    // 本次渲染注册的 effect 在渲染后补跑（React 的时机），下一次渲染就能读到新 state
    const pending = effects
    effects = []
    for (const fn of pending) fn()
    return tree
  }
  const nodes = (tree) => (typeof tree === 'object' && tree !== null ? [tree, ...tree.children.flatMap(nodes)] : [])
  const row = (kind) => nodes(render()).find((n) => n.props && n.props.key === kind + ':' + SCOPE)
  const buttons = (kind) => row(kind).children.filter((c) => c.type === 'Btn').map((c) => c.children[0])
  return { render, row, buttons, calls, toasts, nodes: () => nodes(render()) }
}

test('清空确认态按 kind 隔离：点了记忆行，档案行不该跟着变「确认清空」', async () => {
  const env = mount()
  env.render()
  await tick() // 等 load() 把 stats 填进 d

  assert.deepEqual(env.buttons('memory'), ['查看', '不隔离', '清空本分区'])
  assert.deepEqual(env.buttons('profiles'), ['查看', '不隔离', '清空本分区'])

  // 点记忆行的「清空本分区」
  const arm = env.row('memory').children.find((c) => c.type === 'Btn' && c.children[0] === '清空本分区')
  arm.props.onClick()
  assert.deepEqual(env.buttons('memory'), ['查看', '不隔离', '确认清空'])
  assert.deepEqual(env.buttons('profiles'), ['查看', '不隔离', '清空本分区'], '另一 kind 的行不能被一起点亮')

  // 确认后必须清的是记忆（kind=memory），不是档案
  const confirm = env.row('memory').children.find((c) => c.type === 'Btn' && c.children[0] === '确认清空')
  await confirm.props.onClick()
  const clear = env.calls.filter(([path]) => path === '/memory-privacy/clear-main').at(-1)
  assert.deepEqual(clear, ['/memory-privacy/clear-main', { scope: SCOPE, kind: 'memory' }])
})

test('清空确认态按 kind 隔离：点了档案行，记忆行不该跟着变「确认清空」', async () => {
  const env = mount()
  env.render()
  await tick()

  const arm = env.row('profiles').children.find((c) => c.type === 'Btn' && c.children[0] === '清空本分区')
  arm.props.onClick()
  assert.deepEqual(env.buttons('profiles'), ['查看', '不隔离', '确认清空'])
  assert.deepEqual(env.buttons('memory'), ['查看', '不隔离', '清空本分区'], '另一 kind 的行不能被一起点亮')

  const confirm = env.row('profiles').children.find((c) => c.type === 'Btn' && c.children[0] === '确认清空')
  await confirm.props.onClick()
  const clear = env.calls.filter(([path]) => path === '/memory-privacy/clear-main').at(-1)
  assert.deepEqual(clear, ['/memory-privacy/clear-main', { scope: SCOPE, kind: 'profiles' }])
})