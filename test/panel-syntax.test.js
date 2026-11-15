// 面板片段语法回归网：h() 风格的 panel.js 由客户端 new Function 直接执行，
// 语法错误要到面板加载时才炸（真机 2026-11-15：「Unexpected token ')'」）。
// 这里用 new Function 只编译不执行——React/ui/call 都是注入参数，编译期不需要真值。
//
// JSX 面板（含 <Tag> 写法的）走 esbuild 编译产物，错误在建包时暴露，不在本测试范围。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MODULES = join(import.meta.dirname, '..', 'src', 'modules')

test('h() 风格面板片段必须能被 new Function 编译（面板加载失败回归钉）', () => {
  const panels = readdirSync(MODULES).filter((d) => !d.startsWith('_') && !d.startsWith('.'))
  const checked = []
  for (const dir of panels) {
    const file = join(MODULES, dir, 'panel.js')
    let src = ''
    try { src = readFileSync(file, 'utf8') } catch { continue } // 没有面板的模块跳过
    // JSX 面板（<大写开头的标签）由 esbuild 在建包时编译，不在此测试范围
    if (/<[A-Z][A-Za-z]/.test(src)) continue
    assert.doesNotThrow(() => new Function('React', 'h', 'ui', 'call', src), `${dir}/panel.js 语法错误`)
    checked.push(dir)
  }
  assert.ok(checked.includes('token-billing'), 'token-billing 面板应被覆盖到')
  assert.ok(checked.length >= 2, `至少覆盖两个 h() 风格面板（实际 ${checked.length}）`)
})
