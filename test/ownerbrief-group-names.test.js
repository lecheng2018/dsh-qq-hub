// 审计 Q13 的行为锁：「权限 → 主人私聊：群聊摘要」的群名必须来自现存路由 /panel/chats。
// 旧代码请求的是随 title-filter 一起下线的 /groups/titles，失败还被 .catch(() => {}) 吞掉，
// 群名永远退回群号，功能坏了几个版本没人发现。
//
// 这里跑的是入库产物 client/client.js（用户实际加载的那份）：
// 产物没重建，行为测试就会红——顺带把「忘了 build」也挡住了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

/** 按括号/大括号配平，抽出顶层 function 定义（参数里有解构，不能直接找第一个 {）。 */
function extractFn (name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(SRC)
  assert.ok(m, `产物里找不到 function ${name}`)
  let paren = 1
  let p = m.index + m[0].length
  for (; p < SRC.length; p++) {
    if (SRC[p] === '(') paren++
    else if (SRC[p] === ')') { paren--; if (!paren) break }
  }
  const bodyStart = SRC.indexOf('{', p)
  let depth = 0
  for (let q = bodyStart; q < SRC.length; q++) {
    if (SRC[q] === '{') depth++
    else if (SRC[q] === '}') { depth--; if (!depth) return SRC.slice(m.index, q + 1) }
  }
  throw new Error(`function ${name} 没闭合`)
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

const GROUP_ID = '777'
const DRAFT = {
  allow: { groups: [GROUP_ID] },
  group: { ownerBrief: { enabled: true, lines: 12, groups: [] } },
}

/** 用假 h/React 把产物里的 OwnerBrief 跑起来，只关心它请求了谁、群名怎么取。 */
function mount (chats) {
  const requests = []
  const state = { info: null }
  let effects = []
  const h = (type, props, ...kids) => ({
    type: typeof type === 'function' ? type.name : type,
    props: props || {},
    children: kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false),
  })
  function Card () {}
  function Row () {}
  const useField = () => ({ sw: () => null, range: () => null })
  const cx = (...args) => args.filter(Boolean).join(' ')
  const setPath = (obj) => obj
  const get = async (path) => {
    requests.push(path)
    return { ok: true, chats }
  }
  const useState = (initial) => [state.info === undefined ? initial : state.info, (value) => { state.info = value }]
  const useEffect = (fn) => { effects.push(fn) }
  const factory = new Function('h', 'Card', 'Row', 'useField', 'cx', 'setPath', 'get', 'useState', 'useEffect',
    extractFn('OwnerBrief') + '; return OwnerBrief')
  const OwnerBrief = factory(h, Card, Row, useField, cx, setPath, get, useState, useEffect)
  const render = () => {
    const tree = OwnerBrief({ draft: DRAFT, setDraft: () => {} })
    for (const fn of effects.splice(0)) fn()
    return tree
  }
  const nodes = (tree) => (typeof tree === 'object' && tree !== null ? [tree, ...tree.children.flatMap(nodes)] : [])
  const chips = () => nodes(render()).filter((n) => n.type === 'button').map((n) => n.children.filter((c) => typeof c === 'string').join(''))
  return { render, chips, requests }
}

test('群聊摘要的群选择请求现存路由 /panel/chats，不再请求已下线的 /groups/titles', async () => {
  const env = mount([{ chatId: 'group:777', kind: 'group', id: GROUP_ID, name: 'QQ 群 · SyntheticGroup', rawName: 'SyntheticGroup', lastAt: 1 }])
  env.render()
  await tick()

  assert.deepEqual(env.requests, ['/panel/chats'])
  assert.ok(!env.requests.includes('/groups/titles'), '不能再请求已下线的 /groups/titles')
  assert.deepEqual(env.chips(), ['SyntheticGroup'], '群名应取 chats[] 的 id/rawName 映射')
})

test('群名查不到时退回「群」+群号，不再显示成别名', async () => {
  const env = mount([]) // 机器人没在这个群说过话 → 没有群名缓存
  env.render()
  await tick()

  assert.deepEqual(env.chips(), ['群'])
})

test('只按 kind=group 且 id 精确匹配取群名，私聊条目不会串进来', async () => {
  const env = mount([
    { chatId: 'private:10000001', kind: 'private', id: '10000001', name: 'QQ · 主人私聊', rawName: '主人私聊', lastAt: 3 },
    { chatId: 'group:778', kind: 'group', id: '778', name: 'QQ 群 · 别的群', rawName: '别的群', lastAt: 2 },
  ])
  env.render()
  await tick()

  assert.deepEqual(env.chips(), ['群'], '不同群/私聊的名字不能套到这个群号上')
})