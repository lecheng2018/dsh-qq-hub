// 跨模块漏 import 检查（1.3.63b）：拆分文件时最容易犯、也最难发现的错——
// 某个模块用了兄弟模块导出的名字，却忘了 import。ESM 不会在加载时报错（裸标识符被当成全局，
// 只有真走到那行才抛 ReferenceError），所以表现为「偶发」「像环境问题」。
//
// 真实案例：1.3.49b 把 purpose/engine.js 拆成子模块，seeds.js 用了 QUESTION_RE / PLAN_RE
// 却没 import——只有「主人问了带问号的话 / 提到计划」这条路径会走到，于是表现为
// 「每隔一分钟报一次 QUESTION_RE is not defined」，还被误判成共享挂载的缓存问题。
//
// 做法：收集全 src 的导出名（取「只被一处导出」的名字，避免同名误判），找出「引用了它、
// 却既没 import 也没在本文件声明」，同时排除所有**绑定位置**（函数参数、解构、对象键、
// 简写属性、catch、for-of）以免把参数名当成漏 import。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

function walk (dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) } else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

const ID = '[A-Za-z_$][\\w$]*'

/** 收集一个文件导出的名字。 */
function exportsOf (code) {
  const names = new Set()
  for (const m of code.matchAll(new RegExp(`export\\s+(?:async\\s+)?(?:const|let|var|function|class)\\s+(${ID})`, 'g'))) names.add(m[1])
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name && new RegExp(`^${ID}$`).test(name)) names.add(name)
    }
  }
  return names
}

/** 这个文件里所有「有绑定」的名字：import 进来的 + 声明的 + 参数 + 解构 + 对象键 + catch/for。 */
function boundNames (code) {
  const names = new Set()
  const addAll = (s) => { for (const m of String(s).matchAll(new RegExp(ID, 'g'))) names.add(m[0]) }
  // import 子句
  for (const m of code.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = m[1]
    addAll(clause.match(/\{([\s\S]*)\}/)?.[1] || '')
    addAll(clause.replace(/\{[\s\S]*\}/, '').replace(/\bas\b/g, ' '))
  }
  // 声明
  for (const m of code.matchAll(new RegExp(`(?:const|let|var|function|class)\\s+(${ID})`, 'g'))) names.add(m[1])
  // 解构：const { a, b: c } = / const [a, b] =
  for (const m of code.matchAll(/(?:const|let|var)\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*=/g)) addAll(m[1])
  // 函数参数与箭头参数
  for (const m of code.matchAll(new RegExp(`function[^(]*\\(([^)]*)\\)`, 'g'))) addAll(m[1])
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) addAll(m[1])
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(${ID})\\s*=>`, 'g'))) names.add(m[1])
  // catch / for-of / for-in
  for (const m of code.matchAll(new RegExp(`catch\\s*\\(\\s*(${ID})`, 'g'))) names.add(m[1])
  for (const m of code.matchAll(new RegExp(`for\\s*\\(\\s*(?:const|let|var)?\\s*(${ID})`, 'g'))) names.add(m[1])
  // 对象字面量的键与简写属性：{ key: v, other }
  for (const m of code.matchAll(new RegExp(`(?:^|[{,\\s])(${ID})\\s*:`, 'gm'))) names.add(m[1])
  for (const m of code.matchAll(/\{([^{}]*)\}/g)) addAll(m[1])
  return names
}

/** 去掉注释、字符串、模板内容，减少噪声。 */
function stripNoise (code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/(?<![:\w])\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

test('没有任何文件「用了别的模块的导出却没 import」', () => {
  const files = walk(SRC)
  const owners = new Map()
  for (const f of files) {
    for (const n of exportsOf(readFileSync(f, 'utf8'))) {
      if (!owners.has(n)) owners.set(n, [])
      owners.get(n).push(relative(SRC, f))
    }
  }
  // 只查「全 src 只有一处导出」的名字：同名多处（各自实现的小工具）容易误判
  const unique = [...owners.entries()].filter(([, v]) => v.length === 1).map(([k]) => k)
  const problems = []
  for (const f of files) {
    const raw = readFileSync(f, 'utf8')
    const local = boundNames(raw)
    // 只看「使用」处：去掉 import/export-from 行
    const body = stripNoise(raw).replace(/^\s*(?:import|export)\s[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '')
    for (const name of unique) {
      if (local.has(name)) continue
      if (!new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(body)) continue
      problems.push(`${relative(SRC, f)} 用了 ${name}（由 ${owners.get(name)[0]} 导出）但没 import`)
    }
  }
  assert.deepEqual(problems, [], '漏 import：\n  ' + problems.join('\n  '))
})

test('回归：seeds.js 用到的那两个正则必须 import 进来', () => {
  const code = readFileSync(join(SRC, 'purpose/engine/seeds.js'), 'utf8')
  const imported = (code.match(/import \{([^}]+)\} from '\.\/drives\.js'/) || [])[1] || ''
  for (const name of ['QUESTION_RE', 'PLAN_RE']) {
    const used = new RegExp(`(?<![.\\w$])${name}(?![\\w$])`).test(code.replace(/^import.*$/gm, ''))
    if (used) assert.ok(imported.includes(name), `seeds.js 用了 ${name}，就必须从 drives.js import 它`)
  }
})
