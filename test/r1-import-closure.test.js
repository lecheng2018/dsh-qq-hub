// R1 门禁（报告 §3/§6/§7.4）：静态导入闭包必须可解析 + host 入口必须能加载。
//
// 起因：refactor/m2-m6 提交缺失 src/chat/context-assembly.js，host.js→modular-core.js
// 静态导入在 flag 判断之前即炸（ERR_MODULE_NOT_FOUND），而纯模块测试全绿掩盖了它。
// 打包 dry-run 也不校验静态导入是否可解析。故必须单独立一道闸：
//   1) 遍历 src 全部 .js，抽取每个静态 `... from '<相对>'` / `import '<相对>'` 依赖，
//      断言目标文件真实存在；
//   2) 实际 import 入口 src/host.js 与新核心根（导出即成功，等价于 P0 现场复现的反面）。
//
// 这两条都不连真实 QQ/OneBot/DSH/生产——只证明「代码树自洽、可加载」。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

/** 递归收集 src 下全部 .js 文件（纯目录遍历，无副作用）。 */
function collectJs(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) collectJs(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

/** 用纯字符串扫描抽取一行里的相对模块说明符（不用正则 exec，避免歧义与误判）。 */
function relativeSpecsInCode(code) {
  const specs = []
  const lines = code.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    // 只认静态 import/export ... from '...' 与 import '...'；跳过注释与动态 import()
    if (line.startsWith('//') || line.startsWith('*')) continue
    const isImportLine = line.startsWith('import ') || line.startsWith('export ')
    if (!isImportLine) continue
    if (line.includes('import(')) continue // 动态导入不属静态闭包
    const q1 = line.indexOf("'")
    const q2 = line.indexOf("'", q1 + 1)
    if (q1 >= 0 && q2 > q1) specs.push(line.slice(q1 + 1, q2))
  }
  return specs.filter((s) => s.startsWith('./') || s.startsWith('../'))
}

/** 相对依赖是否可解析：.js / 目录 index.js / 原样。 */
function resolvable(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec)
  return existsSync(base) || existsSync(base + '.js') || existsSync(join(base, 'index.js'))
}

test('R1：src 全部静态相对导入都能解析到真实文件（防 context-assembly 式缺失）', () => {
  const files = collectJs(SRC, [])
  assert.ok(files.length > 50, `应覆盖整个 src（实际 ${files.length} 文件）`)
  const broken = []
  for (const f of files) {
    for (const spec of relativeSpecsInCode(readFileSync(f, 'utf8'))) {
      if (!resolvable(f, spec)) broken.push(`${f.replace(SRC, 'src')}  ->  ${spec}`)
    }
  }
  assert.deepEqual(broken, [], `以下静态导入无法解析：\n${broken.join('\n')}`)
})

test('R1：插件入口 src/host.js 可被实际 import（DSH 插件契约：name/inject/apply）', async () => {
  const mod = await import('../src/host.js')
  assert.equal(mod.name, 'qq-hub', '入口导出插件名')
  assert.equal(typeof mod.apply, 'function', '入口导出 apply(ctx) 装载函数')
})

test('R1：新核心组装根可被 import（flag-on 依赖链完整，正是 m2-m6 缺失的那条）', { skip: !existsSync(join(SRC, 'host', 'modular-core.js')) && '本分支未含模块化新核心（后续 PR 引入时自动生效）' }, async () => {
  const mod = await import('../src/host/modular-core.js')
  assert.equal(typeof mod.createModularCore, 'function')
})
