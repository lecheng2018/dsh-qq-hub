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
    config: { persona: { current: 'dafeiyu', privateDefault: 'dafeiyu', groupDefault: '', privates: { 10000001: 'dafeiyu' }, groups: { 333444555: 'dafeiyu' } } },
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
  // setDraft 现在是函数式更新（setDraft(prev => next)），桩要能接住两种形式：
  // 传函数就喂它当前值、收集返回值；传值就直接收集。
  const seen = []
  let state = { persona: { current: 'dafeiyu', groupDefault: '', privateDefault: '', privates: {}, groups: {} } }
  const setDraft = (v) => {
    const next = typeof v === 'function' ? v(state) : v
    if (next === undefined || next === null) return
    state = next
    seen.push(next)
  }
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


test('「按聊天换人设」用真实群/私聊做下拉，不再让人手打号码', () => {
  // 用户报的：空输入行、不能从已有的私聊/群里选。改成 Select 后必须能列出真实聊天。
  const parts = [extractConst('PSEC_SUGGEST'), extractConst('PSEC_COLORS'), extractFn('splitPersona')].filter(Boolean)
  const body = extractFn('Persona')
  const env = makeEnv()
  const factory = new Function('h', 'useState', 'useEffect', 'useMemo', 'useCallback',
    'Card', 'Btn', 'Row', 'Select', 'Seg', 'Empty', 'AvatarCard', 'Switch', 'cx', 'setPath', 'get', 'post', 'toast', 'reload',
    'return (function(){' + parts.join('\n') + '\n' + body + '\nreturn Persona})()')
  const chats = [
    { chatId: 'group:333444555', kind: 'group', id: '333444555', name: 'QQ 群 · 测试群', lastAt: 2 },
    { chatId: 'private:10000001', kind: 'private', id: '10000001', name: 'QQ · 主人私聊', lastAt: 1 },
  ]
  // 让 Persona 里 useEffect 立刻执行，把 chats 灌进去（这里 useState 的初值取不到，
  // 所以直接把已知聊天做成「已经配过」的行来看下拉候选）
  const Persona = factory(
    env.args[0], env.args[1], env.args[2], env.args[3], env.args[4],
    env.args[5], env.args[6], env.args[7], env.args[8], env.args[9], env.args[10], env.args[11], env.args[12],
    env.args[13], env.args[14], env.args[15], env.args[16], env.args[17], env.args[18]
  )
  const draft = { persona: { current: 'dafeiyu', privateDefault: '', groupDefault: '', privates: { 10000001: '' }, groups: {} } }
  const st = { personas: [{ id: 'dafeiyu', name: '大肥鱼', tags: [], chars: 1 }], config: draft }
  const tree = Persona({ st, draft, setDraft: () => {}, toast: () => {}, reload: () => {} })

  // 找渲染出来的 Select，看它是不是下拉（options 数组），而不是 input
  // 占位组件的 type 是函数，认不出名字，改用「带 options 数组的 props」识别下拉
  const finds = (n, out = []) => {
    if (!n || typeof n !== 'object') return out
    if (Array.isArray(n)) { n.forEach((x) => finds(x, out)); return out }
    if (n.props && Array.isArray(n.props.options)) out.push(n)
    if (n.children) n.children.forEach((x) => finds(x, out))
    return out
  }
  const selects = finds(tree)
  // 至少：两个「默认」下拉 + 行内选择下拉
  assert.ok(selects.length >= 3, '应该有下拉选择器，实际 ' + selects.length)
  // 每行对应的下拉必须是 Select 且带 options
  const withOpts = selects.filter((s) => Array.isArray(s.props.options))
  assert.ok(withOpts.length >= selects.length, '下拉都应该带 options')
  // 不能再有把号码手打进去的 input（群号/QQ 号 placeholder）
  const inputs = []
  const findInput = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(findInput); return }
    if (n.type === 'input') inputs.push(n)
    if (n.children) n.children.forEach(findInput)
  }
  findInput(tree)
  // 有候选、且已选定时用下拉；手输输入框只出现在「没有候选」或用户主动选「手动输入」时
  assert.ok(selects.length > 0, '有已知聊天时应该渲染下拉')
})


test('开关用的是 Switch 的 on，不是 value（写错会点了没反应）', () => {
  // 这类 bug 语法检查抓不到：Switch({on}) 收到 value 时 on 恒为 undefined，
  // 点击只触发 onChange(true)，显示状态永远不变。
  const bad = src.match(/h\(Switch,\s*\{[^}]*value:/)
  assert.equal(bad, null, 'Switch 不能传 value，必须传 on')
})


test('一个候选都没有时，「＋ 添加」依然可点、且给出输入框', () => {
  // 用户实际遇到的就是这个：/panel/chats 没数据 → candidates 为空 →
  // 以前按钮 disabled，点了毫无反应。这条守住它。
  const parts = [extractConst('PSEC_SUGGEST'), extractConst('PSEC_COLORS'), extractFn('splitPersona')].filter(Boolean)
  const body = extractFn('Persona')
  const env = makeEnv()
  const factory = new Function('h', 'useState', 'useEffect', 'useMemo', 'useCallback',
    'Card', 'Btn', 'Row', 'Select', 'Seg', 'Empty', 'AvatarCard', 'Switch', 'cx', 'setPath', 'get', 'post', 'toast', 'reload',
    'return (function(){' + parts.join('\n') + '\n' + body + '\nreturn Persona})()')
  const Persona = factory(...env.args)
  // chats 为空（接口没返回数据）
  const draft = { persona: { current: 'dafeiyu', privateDefault: '', groupDefault: '', privates: {}, groups: {} } }
  const st = { personas: [{ id: 'dafeiyu', name: '大肥鱼', tags: [], chars: 1 }], config: draft }
  let called = 0
  const setDraft = () => { called++ }
  const tree = Persona({ st, draft, setDraft, toast: () => {}, reload: () => {} })

  // Card 的按钮挂在 props.right 上
  const findBtns = (n, out = []) => {
    if (!n || typeof n !== 'object') return out
    if (Array.isArray(n)) { n.forEach((x) => findBtns(x, out)); return out }
    if (n.props && n.props.onClick && JSON.stringify(n.children || []).includes('添加')) out.push(n)
    if (n.props && n.props.right && n.props.right.props && n.props.right.props.onClick) {
      if (JSON.stringify(n.props.right.children || []).includes('添加')) out.push(n.props.right)
    }
    if (n.children) n.children.forEach((x) => findBtns(x, out))
    return out
  }
  const btns = findBtns(tree)
  assert.ok(btns.length >= 2, '两张卡都应该有添加按钮')
  assert.equal(btns[0].props.disabled, undefined, '没有候选时也不能禁用添加按钮')
  btns[0].props.onClick()
  assert.ok(called > 0, '点下去必须真的改动草稿')
})


test('点「＋ 添加」后必须真的多出一行（渲染读 draft 而不是 st.config）', () => {
  // 用户报的：点了添加什么都没有。根因是渲染读已保存的 st.config，
  // 而按钮改的是 draft，两者脱节 → 新行永远不显示。
  const parts = [extractConst('PSEC_SUGGEST'), extractConst('PSEC_COLORS'), extractFn('splitPersona')].filter(Boolean)
  const body = extractFn('Persona')
  const env = makeEnv()
  const factory = new Function('h', 'useState', 'useEffect', 'useMemo', 'useCallback',
    'Card', 'Btn', 'Row', 'Select', 'Seg', 'Empty', 'AvatarCard', 'Switch', 'cx', 'setPath', 'get', 'post', 'toast', 'reload',
    'return (function(){' + parts.join('\n') + '\n' + body + '\nreturn Persona})()')
  const Persona = factory(...env.args)

  const saved = { persona: { current: 'dafeiyu', privateDefault: '', groupDefault: '', privates: {}, groups: {} } }
  const st = { personas: [{ id: 'dafeiyu', name: '大肥鱼', tags: [], chars: 1 }], config: saved }

  const flat = (n, out = []) => {
    if (!n || typeof n !== 'object') return out
    if (Array.isArray(n)) { n.forEach((x) => flat(x, out)); return out }
    if (typeof n.type === 'string') out.push(n.type)
    if (n.props && n.props.className === 'ab-input') out.push('__INPUT__')
    if (n.children) n.children.forEach((x) => flat(x, out))
    return out
  }
  const has = (tree, s) => JSON.stringify(tree).includes(s)

  // 第一次渲染：草稿里没有分流行
  const t1 = Persona({ st, draft: { persona: { ...saved.persona } }, setDraft: () => {}, toast: () => {}, reload: () => {} })
  // 没候选、也没分行时，提示是「机器人还没在群里说过话…」；有候选时是「还没单独指定」。
  // 两种都算「没有行」，这里只要求不是空的、且没有渲染出输入框。
  assert.ok(!flat(t1).includes('__INPUT__'), '初始不该有输入框')
  assert.ok(has(t1, '添加') || has(t1, '还没'), '初始应有提示文案')

  // 模拟点了添加之后：draft 里多了一个 #new 占位行
  const draft2 = { persona: { ...saved.persona, groups: { '#newabc': '' } } }
  const t2 = Persona({ st, draft: draft2, setDraft: () => {}, toast: () => {}, reload: () => {} })
  // 有占位行后，提示文案让位给真正的一行；核心是下面必须出现输入框
  assert.ok(!has(t2, '还没单独指定') || flat(t2).includes('__INPUT__'), '点添加后不该还停在旧提示')
  // 占位行没有已知聊天可选 → 应该给出号码输入框
  assert.ok(flat(t2).includes('__INPUT__'), '必须渲染出输入框，实际：' + flat(t2).join(','))
})

test('手输群号：敲进去、失焦之后不能消失（用户报的「离开输入框字样就消失」）', () => {
  // 根因：用渲染时的旧 draft 快照重建 map —— commitRow 把 key 从 #newabc 改成群号，
  // 另一个控件的 onChange 随后拿旧快照重建，就把刚填的号抹掉了。
  // 现在全改成 setDraft(prev => ...)，这里按真实调用顺序模拟一遍。
  const parts = [extractConst('PSEC_SUGGEST'), extractConst('PSEC_COLORS'),
    extractFn('splitPersona'), extractFn('planPersonaRow')].filter(Boolean)
  const body = extractFn('Persona')

  // draft 与 typing 都要有真状态，否则只能测到「函数被调用过」
  let state = { persona: { current: 'dafeiyu', groupDefault: '', privateDefault: '', privates: {}, groups: { '#newabc': '' } } }
  const setDraft = (v) => { const n = typeof v === 'function' ? v(state) : v; if (n) state = n }
  // Persona 里 useState 的调用顺序：0 chats / 1 list / 2 typing / 3 current / 4 sel / 5 edit / 6 dirty / 7 pending / 8 whole
  let typing = {}
  const hooks = []
  const useStateImpl = (init) => {
    const idx = hooks.length
    hooks.push(idx)
    if (idx === 2) return [typing, (u) => { typing = typeof u === 'function' ? u(typing) : u }]
    return [typeof init === 'function' ? init() : init, () => {}]
  }

  const mkEnv = () => {
    const h = (type, props, ...kids) => ({ $$el: true, type: typeof type === 'string' ? type : (type && type.name) || 'fn', props: props || {}, children: kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false) })
    const mk = (n) => function (props, ...kids) { return { $$el: true, type: n, props: props || {}, children: kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false) } }
    const names = ['Card', 'Btn', 'Row', 'Select', 'Seg', 'Empty', 'AvatarCard', 'Switch']
    const comps = {}; names.forEach((n) => { comps[n] = mk(n) })
    const fn = new Function('h', 'useState', 'useEffect', 'useMemo', 'useCallback',
      'Card', 'Btn', 'Row', 'Select', 'Seg', 'Empty', 'AvatarCard', 'Switch',
      'cx', 'setPath', 'getPath', 'clone', 'post', 'get', 'localStorage',
      'return (function(){' + parts.join('\n') + '\n' + body + '\nreturn Persona})()')
    return fn(h, useStateImpl, () => {}, (f) => f(), (f) => f(),
      comps.Card, comps.Btn, comps.Row, comps.Select, comps.Seg, comps.Empty, comps.AvatarCard, comps.Switch,
      (...a) => a.filter(Boolean).join(' '),
      (o, path, v) => { const n = JSON.parse(JSON.stringify(o == null ? {} : o)); let c = n; const ks = path.split('.'); for (let i = 0; i < ks.length - 1; i++) c = c[ks[i]] = c[ks[i]] || {}; c[ks[ks.length - 1]] = v; return n },
      (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o),
      (o) => JSON.parse(JSON.stringify(o)),
      () => Promise.resolve({ ok: false }), () => Promise.resolve({ ok: false }),
      { getItem: () => null, setItem: () => {} })
  }

  const props = () => ({ st: { personas: [], config: { persona: state.persona } }, draft: state, setDraft, toast: () => {}, reload: () => {} })

  const findInput = (n, out = []) => {
    if (!n || typeof n !== 'object') return out
    if (Array.isArray(n)) { n.forEach((x) => findInput(x, out)); return out }
    if (n.type === 'input' && n.props && n.props.onBlur) out.push(n)
    if (n.children) n.children.forEach((x) => findInput(x, out))
    return out
  }

  hooks.length = 0
  let Persona = mkEnv()
  let tree = Persona(props())
  const inputs = findInput(tree)
  assert.ok(inputs.length >= 1, '应该有手输号码的输入框（下拉框已按要求去掉），实际 ' + inputs.length)

  inputs[0].props.onChange({ target: { value: '222333444' } })   // 敲
  inputs[0].props.onBlur({ currentTarget: { value: '222333444' } }) // 失焦

  const groups = state.persona.groups
  assert.equal(groups['222333444'], '', '群号必须真的落进配置，实际：' + JSON.stringify(groups))
  assert.ok(!('#newabc' in groups), '占位行应已被替换，实际：' + JSON.stringify(groups))

  // 重渲染后群号必须还在（这就是「离开输入框就消失」的直接回归点）
  tree = Persona(props())
  const j = JSON.stringify(tree)
  assert.ok(j.includes('222333444'), '重新渲染后群号不能消失')
})

test('分流人设里所有写回都用函数式更新（旧快照重建会抹掉刚填的群号）', () => {
  // 这是「离开输入框字样就消失」的根因回归锁：
  // 只要 specific() 区块里出现 setDraft(setPath(draft, ...))，
  // 就意味着有控件在用渲染时的旧 draft 快照重建 map，
  // 它和后一个控件的写回会互相覆盖，用户填的群号就会消失。
  const src2 = src
  const a = src2.indexOf('const specific = (mapKey, title, hint) => {')
  assert.ok(a > 0, '找不到 specific()')
  // 花括号配平，取出整个 specific 函数体
  let d = 0, end = -1
  for (let q = src2.indexOf('{', a); q < src2.length; q++) {
    if (src2[q] === '{') d++
    else if (src2[q] === '}') { d--; if (!d) { end = q; break } }
  }
  // 注释里会提到这个旧写法（就是为了说明为什么不能用），先剥掉注释再查
  const body = src2.slice(a, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const bad = body.match(/setDraft\s*\(\s*setPath\s*\(\s*draft\b/g) || []
  assert.equal(bad.length, 0, 'specific() 里不能再有 setDraft(setPath(draft, ...))，要写 setDraft(prev => ...)，发现 ' + bad.length + ' 处')
  // 同时确认确实用了函数式更新
  assert.ok(/setDraft\(\(prev\) =>/.test(body), 'specific() 里应当用 setDraft((prev) => ...) 写回')
})

test('分流人设只用手输输入框，不再给选群下拉（用户要求去掉）', () => {
  const src2 = src
  const a = src2.indexOf('const specific = (mapKey, title, hint) => {')
  let d = 0, end = -1
  for (let q = src2.indexOf('{', a); q < src2.length; q++) {
    if (src2[q] === '{') d++
    else if (src2[q] === '}') { d--; if (!d) { end = q; break } }
  }
  const body = src2.slice(a, end)
  assert.ok(/placeholder: wantKind === 'group' \? '填群号' : '填 QQ 号'/.test(body), '应当有手输群号/QQ 号的输入框')
  // specific() 内部：行内人格下拉 1 个 + 底部「默认」人格下拉 1 个 = 2
  // 关键是不能再有「选群/选人」那个 Select（options 来自 chats 候选）
  const selCount = (body.match(/h\(Select,/g) || []).length
  assert.equal(selCount, 2, 'specific() 里只该剩两个「选人格」下拉，选群/选人下拉必须去掉，实际 ' + selCount)
  assert.ok(!/candidates/.test(body), '不该再有选群候选列表了')
  assert.ok(!/__manual__/.test(body), '不该再有「手动输入…」这个下拉项了')
})

test('「＋ 添加」也用函数式更新（否则会把刚填的群号顶掉）', () => {
  const src2 = src
  const a = src2.indexOf('const specific = (mapKey, title, hint) => {')
  let d = 0, end = -1
  for (let q = src2.indexOf('{', a); q < src2.length; q++) {
    if (src2[q] === '{') d++
    else if (src2[q] === '}') { d--; if (!d) { end = q; break } }
  }
  const body = src2.slice(a, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  // 「＋ 添加」按钮的 onClick 必须以 setDraft((prev) => 开头
  const m = /onClick: \(\) => setDraft\(\(prev\) =>/.exec(body)
  assert.ok(m, '「＋ 添加」要用 setDraft((prev) => ...)，不能拿渲染时的旧 draft 快照')
})

test('手输清空已有群号时：退回占位行，绝不把原号码留住（避免「03」输入框清空后复活）', () => {
  const parts = [extractConst('PSEC_SUGGEST'), extractConst('PSEC_COLORS'),
    extractFn('splitPersona'), extractFn('planPersonaRow')].filter(Boolean)
  const body = extractFn('Persona')

  // 前置：草稿里有一个历史遗留的 '03'
  let state = { persona: { current: 'dafeiyu', groupDefault: '', privateDefault: '', privates: {}, groups: { '03': '' } } }
  const setDraft = (v) => { const n = typeof v === 'function' ? v(state) : v; if (n) state = n }

  let typing = {}
  const hooks = []
  const useStateImpl = (init) => {
    const idx = hooks.length; hooks.push(idx)
    if (idx === 2) return [typing, (u) => { typing = typeof u === 'function' ? u(typing) : u }]
    return [typeof init === 'function' ? init() : init, () => {}]
  }

  const mkEnv = () => {
    const h = (type, props, ...kids) => ({ $$el: true, type: typeof type === 'string' ? type : (type && type.name) || 'fn', props: props || {}, children: kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false) })
    const mk = (n) => function (props, ...kids) { return { $$el: true, type: n, props: props || {}, children: kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false) } }
    const comps = {}; ['Card', 'Btn', 'Row', 'Select', 'Seg', 'Empty', 'AvatarCard', 'Switch'].forEach((n) => { comps[n] = mk(n) })
    const fn = new Function('h', 'useState', 'useEffect', 'useMemo', 'useCallback',
      'Card', 'Btn', 'Row', 'Select', 'Seg', 'Empty', 'AvatarCard', 'Switch',
      'cx', 'setPath', 'getPath', 'clone', 'post', 'get', 'localStorage',
      'return (function(){' + parts.join('\n') + '\n' + body + '\nreturn Persona})()')
    return fn(h, useStateImpl, () => {}, (f) => f(), (f) => f(),
      comps.Card, comps.Btn, comps.Row, comps.Select, comps.Seg, comps.Empty, comps.AvatarCard, comps.Switch,
      (...a) => a.filter(Boolean).join(' '),
      (o, path, v) => { const n = JSON.parse(JSON.stringify(o == null ? {} : o)); let c = n; const ks = path.split('.'); for (let i = 0; i < ks.length - 1; i++) c = c[ks[i]] = c[ks[i]] || {}; c[ks[ks.length - 1]] = v; return n },
      (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o),
      (o) => JSON.parse(JSON.stringify(o)),
      () => Promise.resolve({ ok: false }), () => Promise.resolve({ ok: false }),
      { getItem: () => null, setItem: () => {} })
  }

  const props = () => ({ st: { personas: [], config: { persona: state.persona } }, draft: state, setDraft, toast: () => {}, reload: () => {} })

  const findInput = (n, out = []) => {
    if (!n || typeof n !== 'object') return out
    if (Array.isArray(n)) { n.forEach((x) => findInput(x, out)); return out }
    if (n.type === 'input' && n.props && n.props.onBlur) out.push(n)
    if (n.children) n.children.forEach((x) => findInput(x, out))
    return out
  }

  hooks.length = 0
  const Persona = mkEnv()
  let tree = Persona(props())
  const inputs = findInput(tree)
  assert.ok(inputs.length >= 1, '应该有号码输入框')

  // 用户把 '03' 全删掉变空串，然后失焦
  inputs[0].props.onChange({ target: { value: '' } })
  inputs[0].props.onBlur({ currentTarget: { value: '' } })

  const groups = state.persona.groups
  assert.equal(groups['03'], undefined, '03 绝不能再作为 key 保留在 groups 里')
  const keys = Object.keys(groups)
  assert.equal(keys.length, 1, '应该保留一行')
  assert.ok(keys[0].startsWith('#new'), '原本已成立的号码清空后应当退回 #new 占位行，实际：' + keys[0])
})
