// 面板窄屏横向溢出的回归钉。
// 报障现场（真机 2026-11-21）：手机上进「系统 → 扩展页」，整页可以左右拖动。
// 根因不是某个卡片写死宽度，而是 `.ab-grid` 的单列轨道用了裸 `1fr`——`1fr` 的最小值是
// min-content，而扩展页紧凑行的描述是 `white-space: nowrap` + 省略号（为了只露一行），
// 那串 nowrap 文本的最小内容宽 ~1264px，于是整条轨道被顶到 1344px，卡片全部跟着变宽。
// 修法：单列轨道写成 `minmax(0, 1fr)`（网格的最小值可以被压到 0），和 11-15 修 `.ab-g2`
// 的 `minmax(min(Npx, 100%), 1fr)` 是同一类问题。这里把规则钉住，别再写回裸 1fr。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(ROOT, 'client/src/styles/theme.css'), 'utf8')
const bundle = readFileSync(join(ROOT, 'client/client.js'), 'utf8')

/** 取出某条规则块（同一条声明可能出现在多个媒体查询里，全部返回）。 */
const ruleBodies = (src, selector) => {
  const out = []
  const pattern = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')
  for (const hit of src.matchAll(pattern)) out.push(hit[1])
  return out
}

/** 轨道里除了 minmax()/min() 包起来的 1fr，还有没有裸 1fr（裸的那个才是最小值 min-content 的坑）。 */
const hasBareFr = (track) => /(^|[,\s])1fr/.test(track.replace(/minmax\([^)]*\)/g, 'minmax()').replace(/min\([^)]*\)/g, 'min()'))

test('.ab-grid 的单列轨道必须可收缩（minmax(0, 1fr)），不能是裸 1fr', () => {
  const bodies = ruleBodies(css, '.ab-grid')
  assert.ok(bodies.length, 'theme.css 里找不到 .ab-grid 规则')
  for (const body of bodies) {
    const track = /grid-template-columns:\s*([^;]+)/.exec(body)
    if (!track) continue
    assert.match(track[1], /minmax\(\s*0\s*,/, '.ab-grid 的轨道没写 minmax(0, 1fr)：nowrap 内容会把整页撑宽')
    assert.ok(!hasBareFr(track[1]), '.ab-grid 的轨道里还有裸 1fr')
  }
  assert.ok(bodies.some((b) => /minmax\(\s*0\s*,\s*1fr\s*\)/.test(b)), '默认（不带修饰类）的 .ab-grid 必须自己就写 minmax(0, 1fr)')
})

test('窄屏媒体查询里也不能退化成裸 1fr', () => {
  // 只查窄屏段：宽屏段的 auto-fit 轨道已经用 min(Npx, 100%) 兜过底。
  // 文件里有多个 max-width: 720px 段（导航一段、响应式一段），全都要查。
  const narrowBlocks = [...css.matchAll(/@media \(max-width: 720px\)\s*\{/g)]
    .map((m) => {
      // 从 `{` 开始按花括号配对切出整段，避免嵌套规则被截断
      let i = m.index + m[0].length - 1, depth = 0, start = i
      for (; i < css.length; i++) {
        if (css[i] === '{') depth++
        else if (css[i] === '}' && --depth === 0) break
      }
      return css.slice(start, i + 1)
    })
  assert.ok(narrowBlocks.length, 'theme.css 里找不到窄屏媒体查询')
  for (const body of narrowBlocks) for (const sel of ['.ab-g2', '.ab-g4', '.ab-persona']) {
    for (const hit of ruleBodies(body, sel)) {
      const track = /grid-template-columns:\s*([^;]+)/.exec(hit)
      if (!track) continue
      assert.ok(!hasBareFr(track[1]), `窄屏下的 ${sel} 用了裸 1fr，窄屏会横向溢出`)
    }
  }
})

test('构建产物里的样式和源文件一致（改 CSS 没重新构建时，线上仍是旧样式）', () => {
  assert.ok(bundle.includes('grid-template-columns: minmax(0, 1fr)'), 'client/client.js 里没有新的 .ab-grid 轨道：请运行 npm run build:client')
  assert.ok(!bundle.includes('.ab-grid { display: grid; gap: 12px }'), 'client/client.js 里还留着旧的裸 1fr 轨道')
})