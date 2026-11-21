import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const panelUrl = existsSync(new URL('panel.js', import.meta.url))
  ? new URL('panel.js', import.meta.url)
  : new URL('../panel.js', import.meta.url)
const panelSrc = readFileSync(panelUrl, 'utf8')

test('distill panel: 移动端自适应 CSS 规则健全，无裸 1fr 且防止横向溢出', () => {
  // 1. 根容器约束
  assert.match(panelSrc, /\.distill-panel-root\s*\{[^}]*min-width:\s*0/, '根容器必须设置 min-width: 0')
  assert.match(panelSrc, /\.distill-panel-root\s*\{[^}]*max-width:\s*100%/, '根容器必须设置 max-width: 100%')

  // 2. 状态徽章必须支持自然折行，不能用裸 inline-flex 单行硬撑
  assert.match(panelSrc, /\.distill-status-badge\s*\{[^}]*word-break:\s*break-word/, '状态条必须支持 word-break: break-word 折行')

  // 3. 窄屏媒体查询里禁止裸 1fr，必须使用 minmax(0, 1fr) 允许轨道收缩
  const mediaBlock = /@media \(max-width: 720px\)\s*\{([\s\S]*?)\n\}/.exec(panelSrc)
  assert.ok(mediaBlock, '必须包含 @media (max-width: 720px) 响应式断点')
  const mediaCss = mediaBlock[1]

  const gridCols = [...mediaCss.matchAll(/grid-template-columns:\s*([^;]+)/g)].map(m => m[1])
  assert.ok(gridCols.length >= 2, '移动端网格应包含 stats、actions、tab 等排版')
  for (const track of gridCols) {
    const hasBareFr = /(^|[,\s])1fr/.test(track.replace(/minmax\([^)]*\)/g, 'minmax()'))
    assert.ok(!hasBareFr, `移动端媒体查询中发现了裸 1fr (${track})，这会导致移动端被内容撑开横向溢出`)
    assert.match(track, /minmax\(\s*0\s*,/, `移动端网格必须写成 minmax(0, 1fr): ${track}`)
  }

  // 4. 3个操作按钮中的第3个在双列网格中跨两列
  assert.match(mediaCss, /\.distill-meta-actions\s+\.ab-btn:last-child\s*\{[^}]*grid-column:\s*span 2/, '第3个按钮必须跨两列占满整行')
})

test('distill panel: 能够正常实例化并输出符合移动端规范的虚拟 DOM 结构', () => {
  let stateIndex = 0
  const stateValues = [false, [{ groupId: '10001', groupName: '测试群', isLiveActive: true, activeCount: 5 }], '10001']
  const React = {
    useState: (init) => {
      const idx = stateIndex++
      const val = idx < stateValues.length ? stateValues[idx] : (typeof init === 'function' ? init() : init)
      return [val, () => {}]
    },
    useEffect: () => {},
  }
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false)
  })
  const ui = {
    Card: 'Card',
    Btn: 'Btn',
    Empty: 'Empty',
    Select: 'Select',
    Row: 'Row',
  }
  const call = async () => ({ ok: true, list: [{ groupId: '10001', groupName: '测试群', isLiveActive: true, activeCount: 5 }] })

  const PanelComp = new Function('React', 'h', 'ui', 'call', panelSrc)(React, h, ui, call)
  assert.equal(typeof PanelComp, 'function', 'panel.js 必须返回组件函数')

  const tree = PanelComp({ toast: () => {} })
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'distill-panel-root')

  // 检查状态条使用 distill-status-badge 类，而非硬编码 inline-flex
  const json = JSON.stringify(tree)
  assert.ok(json.includes('distill-status-badge active'), '必须渲染移动端折行状态徽章')
  assert.ok(!json.includes('display":"inline-flex'), '不得再使用内联 inline-flex 作为群状态指示条')
})
