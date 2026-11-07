// 回归：资讯池面板「添加订阅后没有保存按钮」（2026-11-04 主人截图报的）。
//
// 两个 bug 叠在一起：
//   1. ExtPanel 只传 settings/draftSettings/setSettings，**没传 draft/setDraft** ——
//      panel.js 用的 props.draft / props.setDraft 全是 undefined，
//      点「添加」试拉成功但写不进草稿，列表永远空。
//   2. TAB_KEYS 里没有 rss —— 就算写进了草稿也不会标记 dirty，
//      底部「保存设置」栏永远不出现，于是「没有保存按钮」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client/client.js'), 'utf8')
const PANEL = readFileSync(join(ROOT, 'src/modules/rss/panel.js'), 'utf8')

test('ExtPanel 要给模块 panel 传 draft / setDraft', () => {
  assert.match(CLIENT, /function ExtPanel\(\{[^}]*draft, setDraft[^}]*\}\)/, 'ExtPanel 签名要收 draft/setDraft')
  assert.match(CLIENT, /h\(Comp, \{[^}]*draft, setDraft[^}]*\}\)/, '渲染要转发给模块组件')
  assert.match(CLIENT, /h\(ExtPanel, \{[^}]*draft, setDraft[^}]*\}\)/, '调用处要传进去')
})

test('TAB_KEYS 里有 rss，改了才会出现底部保存栏', () => {
  assert.match(CLIENT, /rss: \['rss'\]/, 'TAB_KEYS 缺 rss 的话 tabDirty 恒为 false')
})

test('资讯池 panel 走 draft / setDraft（不是 settings），且保存后进 config.rss', () => {
  assert.match(PANEL, /props\.draft\?\.rss/, '要读草稿里的 rss')
  assert.match(PANEL, /props\.setDraft/, '要写草稿')
  // 模块读的是 api.config().rss，面板写 draft.rss —— 必须是同一份，不能写到 ext.rss
  assert.equal(/props\.setSettings/.test(PANEL), false, '不能写 ext.rss（模块读的是 config.rss）')
  const INDEX = readFileSync(join(ROOT, 'src/modules/rss/index.js'), 'utf8')
  assert.match(INDEX, /api\.config\(\)\.rss/, '模块要读 config.rss')
})

test('添加订阅用函数式 setDraft（旧快照会把刚加的那行冲掉）', () => {
  assert.match(PANEL, /props\.setDraft\(\(prev\)/, 'setDraft 必须收函数式更新')
})
