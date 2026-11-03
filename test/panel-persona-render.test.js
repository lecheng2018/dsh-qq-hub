// 面板「人设」页必须能真实渲染出来，不能有未定义变量。
// 这类 bug（Can't find variable: title）语法检查抓不到，只有真跑一遍才行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'client/client.js'), 'utf8')

/** 按大括号配平，抽出顶层 function 定义。 */
function extractFn (name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(')
  const m = re.exec(src)
  if (!m) return null
  let depth = 1
  let pos = m.index + m[0].length
  for (let p = pos; p < src.length; p++) {
    if (src[p] === '(') depth++
    else if (src[p] === ')') { depth--; if (!depth) { pos = p; break } }
  }
  const b = src.indexOf('{', pos)
  let d = 0
  for (let p = b; p < src.length; p++) {
    if (src[p] === '{') d++
    else if (src[p] === '}') { d--; if (!d) return src.slice(m.index, p + 1) }
  }
  return null
}

/** 抽省一行式 const（数组/字符串字面量）。 */
function extractConst (name) {
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*')
  const m = re.exec(src)
  if (!m) return null
  const start = m.index + m[0].length
  let depth = 0
  let inStr = null
  for (let p = start; p < src.length; p++) {
    const c = src[p]
    if (inStr) { if (c === '\\') { p++; continue } if (c === inStr) inStr = null; continue }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue }
    if (c === '[' || c === '{' || c === '(') depth++
    else if (c === ']' || c === '}' || c === ')') { depth--; if (!depth) return src.slice(m.index, src.indexOf('\n', p)) }
    else if (depth === 0 && (c === '\n' || c === ';')) return src.slice(m.index, p)
  }
  return null
}

/** 建一个够用的假渲染环境：h 真的调用子组件，组件用占位符代替。 */
function makeEnv () {
  const h = (type, props, ...kids) => {
    const children = kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)
    return { $$el: true, type: typeof type === 'string' ? type : (type && type.name) || 'fn', props: props || {}, children }
  }
  // 占位组件要保留 props（onClick）和 children（按钮文字），否则测试点不到按钮
  const mk = (n) => function (props, ...kids) {
    return { $$el: true, type: n, props: props || {}, children: kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false) }
  }
  return {
    h,
    args: [
      h,
      (init) => [init, () => {}], // useState
      () => {}, // useEffect
      (f) => f(), // useMemo
      (f) => f(), // useCallback
      mk('Card'), mk('Btn'), mk('Row'), mk('Select'), mk('Seg'), mk('Empty'), mk('AvatarCard'), mk('Switch'),
      (...a) => a.filter(Boolean).join(' '), // cx
      (o, k, v) => { const c = { ...o }; c[k] = v; return c }, // setPath
      async () => ({ ok: false }), async () => ({ ok: false }), // get / post
      () => {}, () => {}, // toast / reload
    ],
  }
}

function renderPersona () {
  const parts = [extractConst('PSEC_SUGGEST'), extractConst('PSEC_COLORS'), extractFn('splitPersona')].filter(Boolean)
  const body = extractFn('Persona')
  assert.ok(body, 'client.js 里应该有 Persona 组件')
  const env = makeEnv()
  const factory = new Function('h', 'useState', 'useEffect', 'useMemo', 'useCallback',
    'Card', 'Btn', 'Row', 'Select', 'Seg', 'Empty', 'AvatarCard', 'Switch', 'cx', 'setPath', 'get', 'post', 'toast', 'reload',
    'return (function(){' + parts.join('\n') + '\n' + body + '\nreturn Persona})()')
  const Persona = factory(...env.args)
  const st = {
    personas: [{ id: 'dafeiyu', name: '大肥鱼', tags: ['A'], chars: 100 }, { id: 'x', name: 'X', tags: [], chars: 10 }],
    config: { persona: { current: 'dafeiyu', privateDefault: '', groupDefault: '', privates: {}, groups: {} } },
  }
  const draft = { persona: { current: 'dafeiyu', privateDefault: '', groupDefault: '', privates: {}, groups: {} } }
  return Persona({ st, draft, setDraft: () => {}, toast: () => {}, reload: () => {} })
}

test('人设页能渲染出来，不抛「变量未定义」', () => {
  const tree = renderPersona()
  assert.ok(tree && tree.$$el, '应该返回一个元素')
  assert.equal(tree.type, 'div')
  assert.ok(tree.children.length >= 3, '至少有：人格列表 + 编辑区 + 按聊天换人设')
})

test('按聊天换人设的两张卡片都在（群 / 私聊）', () => {
  const tree = renderPersona()
  // 把整棵树拍平成字符串，找卡片标题
  const flat = (n) => {
    if (!n || typeof n !== 'object') return []
    if (Array.isArray(n)) return n.flatMap(flat)
    const self = n.props && n.props.title ? [String(n.props.title)] : []
    return self.concat(n.children ? n.children.flatMap(flat) : [])
  }
  const titles = flat(tree)
  assert.ok(titles.includes('按群换人设'), '应该有「按群换人设」卡片')
  assert.ok(titles.includes('按人换人设（私聊）'), '应该有「按人换人设（私聊）」卡片')
})

test('配置里有分流人设时也能渲染（空 map / 有内容的 map 都不崩）', () => {
  const parts = [extractConst('PSEC_SUGGEST'), extractConst('PSEC_COLORS'), extractFn('splitPersona')].filter(Boolean)
  const body = extractFn('Persona')
  const env = makeEnv()
  const factory = new Function('h', 'useState', 'useEffect', 'useMemo', 'useCallback',
    'Card', 'Btn', 'Row', 'Select', 'Seg', 'Empty', 'AvatarCard', 'Switch', 'cx', 'setPath', 'get', 'post', 'toast', 'reload',
    'return (function(){' + parts.join('\n') + '\n' + body + '\nreturn Persona})()')
  const Persona = factory(...env.args)
  const st = {
    personas: [{ id: 'dafeiyu', name: '大肥鱼', tags: [], chars: 1 }],
    config: { persona: { current: 'dafeiyu', privateDefault: 'dafeiyu', groupDefault: '', privates: { 2471784685: 'dafeiyu' }, groups: { 1124211723: 'dafeiyu' } } },
  }
  const draft = st.config
  assert.doesNotThrow(() => Persona({ st, draft, setDraft: () => {}, toast: () => {}, reload: () => {} }))
})

test('点「＋ 添加」真的会更新草稿（这是用户报的「点了没反应」）', () => {
  const parts = [extractConst('PSEC_SUGGEST'), extractConst('PSEC_COLORS'), extractFn('splitPersona')].filter(Boolean)
  const body = extractFn('Persona')
  const env = makeEnv()
  const factory = new Function('h', 'useState', 'useEffect', 'useMemo', 'useCallback',
    'Card', 'Btn', 'Row', 'Select', 'Seg', 'Empty', 'AvatarCard', 'Switch', 'cx', 'setPath', 'get', 'post', 'toast', 'reload',
    'return (function(){' + parts.join('\n') + '\n' + body + '\nreturn Persona})()')

  // setDraft 要能记录调用，且 setPath 用真的实现（从 client.js 抽出来）
  const realSetPath = (obj, path, value) => {
    const clone = (o) => JSON.parse(JSON.stringify(o == null ? {} : o))
    const next = clone(obj)
    let cur = next
    const ks = path.split('.')
    for (let i = 0; i < ks.length - 1; i++) cur = cur[ks[i]] = cur[ks[i]] || {}
    cur[ks[ks.length - 1]] = value
    return next
  }
  const seen = []
  const setDraft = (v) => seen.push(v)
  const Persona = factory(
    env.args[0], env.args[1], env.args[2], env.args[3], env.args[4],
    env.args[5], env.args[6], env.args[7], env.args[8], env.args[9], env.args[10], env.args[11], env.args[12],
    env.args[13], realSetPath, env.args[15], env.args[16], env.args[17], env.args[18]
  )
  const draft = { persona: { current: 'dafeiyu', privateDefault: '', groupDefault: '', privates: {}, groups: {} } }
  const st = { personas: [{ id: 'dafeiyu', name: '大肥鱼', tags: [], chars: 1 }], config: draft }
  const tree = Persona({ st, draft, setDraft, toast: () => {}, reload: () => {} })

  // 找出所有「＋ 添加」按钮，点第一个
  // Card 是个组件，按钮挂在 props.right 上而不是 children 里
  const find = (n, out = []) => {
    if (!n || typeof n !== 'object') return out
    if (Array.isArray(n)) { n.forEach((x) => find(x, out)); return out }
    if (n.props && n.props.onClick && JSON.stringify(n.children || []).includes('添加')) out.push(n)
    if (n.props && n.props.right && n.props.right.props && n.props.right.props.onClick) {
      if (JSON.stringify(n.props.right.children || []).includes('添加')) out.push(n.props.right)
    }
    if (n.children) n.children.forEach((x) => find(x, out))
    return out
  }
  const addBtns = find(tree)
  assert.ok(addBtns.length >= 2, '应该有「按群」和「按人」两个添加按钮，实际 ' + addBtns.length)
  addBtns[0].props.onClick()
  assert.equal(seen.length, 1, '点添加必须调用 setDraft，否则界面不会有任何变化')
  const after = seen[0]
  assert.ok(after.persona, '要写回 persona')
  const keys = Object.keys(after.persona.groups || {})
  assert.equal(keys.length, 1, '应该新增一行，实际 keys=' + JSON.stringify(keys))
  assert.ok(keys[0].startsWith('#new'), '占位键要以 #new 开头，避免多行互相覆盖')
})

test('draft 还是 null 时点添加不崩（配置没加载完）', () => {
  const parts = [extractConst('PSEC_SUGGEST'), extractConst('PSEC_COLORS'), extractFn('splitPersona')].filter(Boolean)
  const body = extractFn('Persona')
  const env = makeEnv()
  const factory = new Function('h', 'useState', 'useEffect', 'useMemo', 'useCallback',
    'Card', 'Btn', 'Row', 'Select', 'Seg', 'Empty', 'AvatarCard', 'Switch', 'cx', 'setPath', 'get', 'post', 'toast', 'reload',
    'return (function(){' + parts.join('\n') + '\n' + body + '\nreturn Persona})()')
  const Persona = factory(...env.args)
  const st = { personas: [{ id: 'dafeiyu', name: '大肥鱼', tags: [], chars: 1 }], config: { persona: { current: 'dafeiyu' } } }
  const tree = Persona({ st, draft: null, setDraft: () => {}, toast: () => {}, reload: () => {} })
  const find = (n, out = []) => {
    if (!n || typeof n !== 'object') return out
    if (Array.isArray(n)) { n.forEach((x) => find(x, out)); return out }
    if (n.props && n.props.onClick && JSON.stringify(n.children || []).includes('添加')) out.push(n)
    if (n.props && n.props.right && n.props.right.props && n.props.right.props.onClick) {
      if (JSON.stringify(n.props.right.children || []).includes('添加')) out.push(n.props.right)
    }
    if (n.children) n.children.forEach((x) => find(x, out))
    return out
  }
  const btns = find(tree)
  assert.doesNotThrow(() => btns[0].props.onClick(), 'draft 为 null 时点添加也不能崩')
})
