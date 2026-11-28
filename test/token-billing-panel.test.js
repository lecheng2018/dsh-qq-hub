// T1.5 回归：token-billing 面板「重置今天用量」。
//
// P0 现场：组件签名里没有 toast，L37/L38 裸调 toast(...) 必抛 ReferenceError；
// 且重置完成后没有 setConfirming(false)，确认按钮永远卡在界面上。
// 这里按 client/src/views/modules.js 的方式用 new Function 真正编译并执行 panel.js，
// 真的点按钮、真的跑 promise 链。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/modules/token-billing/panel.js', import.meta.url), 'utf8')

const STATS = {
  ok: true,
  dateKey: '2026-01-01',
  totalLimit: 1000,
  totalUsed: 100,
  totalRemaining: 900,
  allocations: {},
  usage: {},
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

function mount({ resetReply = { ok: true }, withToast = true } = {}) {
  // 与 panel.js 的 useState 顺序一一对应：d / busy / confirming
  const state = [STATS, false, false]
  let slot = 0
  const React = {
    useState(initial) {
      const i = slot++
      const value = i < state.length ? state[i] : initial
      const set = (next) => { state[i] = typeof next === 'function' ? next(state[i]) : next }
      return [value, set]
    },
    useEffect() {},
  }
  // 面板里的 h(ui.X) 组件留成叶子节点，好从树上找按钮
  const h = (type, props, ...kids) => ({
    type,
    props: props || {},
    children: kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false),
  })
  const ui = { Card: 'Card', Btn: 'Btn', Empty: 'Empty' }
  const calls = []
  const call = async (path, body) => {
    calls.push([path, body])
    if (path === '/token-usage') return STATS
    return resetReply
  }
  const Panel = new Function('React', 'h', 'ui', 'call', SRC)(React, h, ui, call)
  const toasts = []
  const render = () => {
    slot = 0
    const props = withToast ? { toast: (...a) => toasts.push(a) } : {}
    return Panel(props)
  }
  const nodes = (tree) => (typeof tree === 'object' && tree !== null ? [tree, ...tree.children.flatMap(nodes)] : [])
  const buttons = (tree) => nodes(tree).filter((n) => n.type === 'Btn')
  const button = (tree, text) => buttons(tree).find((b) => b.children[0] === text)
  return { render, buttons, button, toasts, calls, state }
}

test('T1.5 重置：toast 被调用且确认态复位（不再裸调未定义 toast、不再卡在确认态）', async () => {
  const env = mount({ withToast: true })
  let tree = env.render()

  // 点「重置今天用量」进入确认态
  env.button(tree, '重置今天用量').props.onClick()
  tree = env.render()
  assert.ok(env.button(tree, '确认清零今天用量'), '第一次点击应进入确认态')

  // 点「确认清零今天用量」
  env.button(tree, '确认清零今天用量').props.onClick()
  await tick()
  await tick()

  assert.deepEqual(env.toasts, [['今天的用量已清零', 'ok']], 'toast 必须被调用且带 kind=ok')
  assert.equal(env.state[2], false, '重置成功后必须 setConfirming(false)')

  tree = env.render()
  assert.ok(env.button(tree, '重置今天用量'), '确认态应已复位，回到「重置今天用量」')
  assert.equal(env.button(tree, '确认清零今天用量'), undefined)
  assert.ok(env.calls.some(([p]) => p === '/token-usage/reset'), '确实打了重置接口')
})

test('T1.5 重置被拒：用 err 提示并同样复位确认态', async () => {
  const env = mount({ resetReply: { ok: false, message: '今天还没用量' } })
  let tree = env.render()
  env.button(tree, '重置今天用量').props.onClick()
  tree = env.render()
  env.button(tree, '确认清零今天用量').props.onClick()
  await tick()
  await tick()

  assert.deepEqual(env.toasts, [['今天还没用量', 'err']])
  assert.equal(env.state[2], false, '被拒也不能卡在确认态')
  assert.ok(env.button(env.render(), '重置今天用量'))
})

test('T1.5 宿主没传 props.toast 时也不崩（默认空实现）', async () => {
  const env = mount({ withToast: false })
  let tree = env.render()
  env.button(tree, '重置今天用量').props.onClick()
  tree = env.render()
  assert.doesNotThrow(() => env.button(tree, '确认清零今天用量').props.onClick())
  await tick()
  await tick()
  assert.equal(env.state[2], false, '无 toast 也要正常复位确认态')
})
