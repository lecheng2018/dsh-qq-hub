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

test('主题令牌对齐宿主 DSH 变量，且保留内置模块 panel.js 所需别名与亮/暗模式对比度', () => {
  assert.match(css, /--ab-sea:\s*var\(--dsw-alias-state-business-primary/, '主色应跟随业务蓝 --dsw-alias-state-business-primary（不取黑白反色的 --dsw-alias-brand-primary）')
  assert.doesNotMatch(css, /--ab-sea:\s*var\(--dsw-alias-brand-primary/, '禁止把 --ab-sea 绑到深色模式为纯白的 --dsw-alias-brand-primary')
  assert.match(css, /--ab-panel-bg:\s*var\(--dsw-alias-hovercard-bg/, '--ab-panel-bg 应保持深底以匹配 memory-privacy 弹窗浅色文字')
  for (const alias of ['--ab-solid', '--ab-surface', '--ab-panel-bg', '--ab-accent', '--ab-muted-2']) {
    assert.ok(css.includes(`${alias}:`), `theme.css 应声明 ${alias} 以保证亮/暗模式及模块 panel.js 一致`)
  }
})

test('移动端布局与触控回归保护：容器查询、表格横滚、芯片样式、触控删除按钮与顶置 toast', () => {
  const navSrc = readFileSync(join(ROOT, 'client/src/shell/nav-bar.js'), 'utf8')
  assert.match(navSrc, /ab-chipbtn/, '移动端分组子导航应使用 .ab-chipbtn 样式类')
  assert.match(navSrc, /!isMobile/, '快捷查找弹层按桌面/移动端互斥挂载，避免双份 autoFocus 与重复 ARIA')
  assert.match(css, /@container ab \(max-width:/, '内容区应支持容器查询，防止 DSH 侧栏展开后中栏被挤扁')
  assert.match(css, /\.ab-table-wrap\s*\{[^}]*overflow-x:\s*auto/, '.ab-table-wrap 必须允许窄屏横向滚动')
  assert.match(css, /\.ab-stat\s*\{[^}]*position:\s*relative/, '.ab-stat 必须声明 position: relative')
  assert.match(css, /\.ab-kv\s*\{[^}]*minmax\(\s*0\s*,\s*1fr\s*\)/, '.ab-kv 值列必须可收缩（minmax(0, 1fr)）')
  assert.doesNotMatch(css, /@media \(max-width: 560px\)\s*\{[^}]*\.ab-kv\s*\{\s*grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/, '移动端 .ab-kv 应保持双列键值排布，不能折成单列产生右侧大片留白')
  assert.match(css, /\.ab-row\.ab-row-sw\s*\{[^}]*flex-direction:\s*row/, '移动端纯开关行 .ab-row.ab-row-sw 应保持左右同行排布')
  assert.match(css, /@media \(hover: none\)/, '触控设备下悬停隐藏的删除/排序按钮应保持可见')
  assert.match(css, /\.ab-toast\s*\{[^}]*top:\s*calc\(/, '.ab-toast 应顶置且不遮挡底部保存条与移动端底栏')
  assert.doesNotMatch(css, /\.ab-chips\s*\{[^}]*position:\s*sticky/, '移动端 .ab-chips 不应吸顶，向下滚动时应随页面滚走')
  assert.match(css, /\.ab-mkt-list\s*\{/, '扩展页市场条目样式 .ab-mkt-list 应存在于 theme.css')
  assert.match(css, /\.ab-mem-item\s+\.ab-btn\.ghost\s*\{[^}]*color:/, 'memory-privacy 深色弹窗里的幽灵按钮应显式设定浅色文字以保证亮色主题对比度')
})