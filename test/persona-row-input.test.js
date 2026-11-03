// 「按聊天换人设」里手输号码的行为。
// 用户反馈过两个具体的坏现象，这里逐条守住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(`${REPO}/client/client.js`, 'utf8')

// 从面板源码里抠出 planPersonaRow 本体来跑（面板是浏览器脚本，不能直接 import）
function extractFn (name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`)
  const m = re.exec(src)
  if (!m) return null
  let depth = 1
  let i = m.index + m[0].length
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') { depth--; if (!depth) break }
  }
  const b = src.indexOf('{', i)
  let d = 0
  for (let p = b; p < src.length; p++) {
    if (src[p] === '{') d++
    else if (src[p] === '}') { d--; if (!d) return src.slice(m.index, p + 1) }
  }
  return null
}
const body = extractFn('planPersonaRow')
assert.ok(body, '找不到 planPersonaRow')
const planPersonaRow = new Function(body + '; return planPersonaRow')()

test('占位 key 不能把「03」洗出来 —— 用户看到的那行 03 就是这个', () => {
  // 以前是拿 key 去 replace(/\D/g,'')，'#newm5k03ab' 会变成 '03'
  // 现在只洗用户敲的内容，占位行在没输入时保持原样，不会被写成 03
  const map = { '#newm5k03ab': '' }
  const r = planPersonaRow({ map, id: '#newm5k03ab', raw: '' })
  assert.equal(r.action, 'clear', '空输入不能产生 03 这样的新 key')
  assert.equal(r.key, undefined, '不该造出任何数字 key')
})

test('敲号码：只取数字，落成该群号', () => {
  const map = { '#newabc': '' }
  const r = planPersonaRow({ map, id: '#newabc', raw: '61-56 93 464' })
  assert.deepEqual(r, { action: 'move', key: '222333444', value: '' })
})

test('选了一个群后，再选另一个不能把前面的顶掉', () => {
  // 第一行已经是 111，第二行（占位）再选 111 时应被拒，而不是覆盖第一行
  const map = { 111: 'dafeiyu', '#newabc': '' }
  const r = planPersonaRow({ map, id: '#newabc', raw: '111' })
  assert.equal(r.action, 'clear', '目标已被占用，不能顶掉')
})

test('不同号码正常各占一行', () => {
  const map = { 111: 'dafeiyu', '#newabc': '' }
  const r = planPersonaRow({ map, id: '#newabc', raw: '222' })
  assert.deepEqual(r, { action: 'move', key: '222', value: '' })
})

test('原地改写同一个号：算没变，保留人格设置', () => {
  const map = { 111: 'dafeiyu' }
  const r = planPersonaRow({ map, id: '111', raw: '111' })
  assert.equal(r.action, 'keep')
})

test('删光号码：原地退回占位，不整行消失', () => {
  const map = { 111: 'dafeiyu' }
  const r = planPersonaRow({ map, id: '111', raw: '' })
  assert.equal(r.action, 'clear')
})

test('已配的人格值要跟着搬走，不能丢', () => {
  const map = { '#newabc': 'some-persona' }
  const r = planPersonaRow({ map, id: '#newabc', raw: '999' })
  assert.equal(r.key, '999')
  assert.equal(r.value, 'some-persona', '人格不能被号码变更弄丢')
})
