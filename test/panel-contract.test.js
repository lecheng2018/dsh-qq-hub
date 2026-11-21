// 面板契约：前端用到的东西，后端和 UI 层必须真的有。
//
// 为什么要有这个测试：写「浏览器」页时我凭印象写了 `f.switch(...)`，
// 而 useField 只提供 `sw`，结果整页白屏；`get/post` 的路径如果后端没注册，
// 同样是运行时才炸。这类错都在浏览器里才看得见，静态检查能在提交前拦住。
//
// 对应 dsh-qq-hub-mods 的硬性要求：
//   API-04 面板动作的方法、路径和参数与后端注册一致
//   API-03 不编造宿主 HTTP 路由
// 以及 CONTRIBUTING §4「面板遵循现有 React / h / ui / call 桥接约定」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const find = (dir, ext) => {
  const out = []
  const walk = (d) => {
    let list = []
    try { list = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      const p = join(d, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) } else if (p.endsWith(ext)) out.push(p)
    }
  }
  walk(dir)
  return out
}

const viewFiles = () => [...find(join(ROOT, 'client/src/views'), '.js'), ...find(join(ROOT, 'client/src/shell'), '.js')]

// ---------- 1. useField 的方法名 ----------

test('面板视图只调用 useField 真正提供的方法', () => {
  const formSrc = readFileSync(join(ROOT, 'client/src/ui/form.js'), 'utf8')
  const body = formSrc.slice(formSrc.indexOf('return {'), formSrc.indexOf('\n  }\n}'))
  const helpers = new Set([...body.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((m) => m[1]))
  assert.ok(helpers.size > 0, '没能从 form.js 解析出 useField 的方法')

  const bad = []
  for (const file of viewFiles()) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\bf\.([a-zA-Z]+)\s*\(/g)) {
      if (!helpers.has(m[1])) {
        bad.push(`${file.replace(ROOT, '')} 用了 f.${m[1]}（useField 只有：${[...helpers].join(', ')}）`)
      }
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'))
})

// 商店模块（dsh-qq-hub-mods）自己 api.route 的路径前缀；主仓库静态看不到。
const MODULE_PREFIXES = [
  '/bili', '/douyin', '/heybox', '/multi-parser', '/qzone/social',
  '/deliveries', '/tophub', '/rss-reader', '/mijia',
]
// 别再把主仓库已删除的路由塞回白名单（审计 Q13）：'/groups/titles' 曾在这里，
// 把面板里那条死调用盖了整整几个版本，契约检查形同虚设。商店模块前缀才配豁免。

// ---------- 2. 前端路径 vs 后端注册 ----------

test('面板视图里 get/post 的路径，后端都真注册了', () => {
  // 后端所有 route('...') 的字面量（面板路由 + 模块路由）
  const backend = new Set()
  for (const file of [...find(join(ROOT, 'src/host'), '.js'), ...find(join(ROOT, 'src/modules'), '.js')]) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\broute\(\s*['"`]([^'"`]+)['"`]/g)) backend.add(m[1].split('?')[0])
  }
  assert.ok(backend.size > 10, `只解析到 ${backend.size} 条后端路由，可能解析规则失配`)

  const bad = []
  for (const file of viewFiles()) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\b(?:get|post)\(\s*['"`]([^'"`]+)['"`]/g)) {
      const path = m[1].split('?')[0]
      if (!path.startsWith('/')) continue
      // 路径里带模板变量（如 `/modules/${id}`）没法静态比，跳过
      if (/[$]/.test(m[1])) continue
      // 模块注册的路由在别的仓库（dsh-qq-hub-mods 的 modules/*/index.mjs 里 api.route(...)），
      // 主仓库里看不到；这些前缀按「模块自有」放行。
      if (MODULE_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p))) continue
      if (!backend.has(path)) bad.push(`${file.replace(ROOT, '')} 请求了 ${path}，后端没有这条 route()`)
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'))
})

// ---------- 3. 页面组件在标签页表里 ----------

test('每个标签页都能找到对应的页面组件', () => {
  const navSrc = readFileSync(join(ROOT, 'client/src/domain/nav.js'), 'utf8')
  const pageSrc = readFileSync(join(ROOT, 'client/src/shell/page.js'), 'utf8')
  // 只看 const TABS = [...] 这一段，别把 NAV_GROUPS（也有 id/label）算进来
  const tabsBlock = navSrc.slice(navSrc.indexOf('const TABS = ['), navSrc.indexOf(']', navSrc.indexOf('const TABS = [')))
  const ids = [...tabsBlock.matchAll(/\{ id: '([a-zA-Z]+)', label:/g)].map((m) => m[1])
  const mapBlock = pageSrc.slice(pageSrc.indexOf('const body = curTab.ext ? ExtPage : {'), pageSrc.indexOf('}[curTab.id]'))
  const mapped = new Set([...mapBlock.matchAll(/([a-zA-Z]+):\s*[A-Z][a-zA-Z]*/g)].map((m) => m[1]))
  const orphan = ids.filter((id) => !mapped.has(id))
  assert.deepEqual(orphan, [], `这些标签页没有对应的页面组件：${orphan.join(', ')}`)

  // 反向：映射里出现的名字得真 import 进来
  const imported = new Set([...pageSrc.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/views\//g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim())))
  const missing = [...mapped].filter((name) => {
    const comp = mapBlock.match(new RegExp(`${name}:\\s*([A-Z][a-zA-Z]*)`))?.[1]
    return comp && !imported.has(comp)
  })
  assert.deepEqual(missing, [], `这些页面组件没 import：${missing.join(', ')}`)
})