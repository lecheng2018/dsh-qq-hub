// 面板数字框「删不掉」的结构性回归（2026-11-24）。
//
// 报障：群里「怎么说话（分条）」那张卡里的「群里一条最长 / 私聊一条最长 / 一轮最多几条」
// 删不光 —— 删到最后一位，数字自己跳回去。别处也有（回合超时、静默时段、贴吧浏览间隔…）。
//
// 根因有两层，缺一层都还会复发：
//   ① 前端逐键归一：旧 f.num 在 onChange 里就 sanitize，`Number('')` 是 0 → 立刻被 min
//      夹到下限；显式给了 fallback 的框则被默认值直接顶回去。中间态（'1.'、'-'）也会被改写。
//   ② 后端把空串当数字：config.js 的 num() 里 `Number('')` 是 0 且 isFinite 为真，
//      于是「清空」存下来变成一个被钳到下限的值，而不是「恢复默认」。
//
// 修法：输入过程只进暂存（NumInput），失焦/回车才提交；清空写 ''；num() 把 '' 当未填回默认。
// 这里把这两层行为都钉住。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseNumText, commitNumText } from '../client/src/core/utils.js'
import { normalize } from '../src/core/config.js'
import { resolveModuleSettings } from '../src/core/modules.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(ROOT, 'client/client.js'), 'utf8')
/** 去掉注释再断言：修这些 bug 时注释里会引用「旧写法」，不能把说明文字当成代码。 */
const stripComments = (src) => src
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '') // JSX 注释 {/* … */}
  .replace(/\/\*[\s\S]*?\*\//g, '')                // 块注释
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n') // 行注释

const numSrc = readFileSync(join(ROOT, 'client/src/ui/primitives.js'), 'utf8')

// ---------------- ① 解析层：空就是空 ----------------

test('空 / 空白 / 非数字都解析成空串（不再变成 0）', () => {
  assert.equal(parseNumText(''), '')
  assert.equal(parseNumText('   '), '')
  assert.equal(parseNumText('abc'), '')
  assert.equal(parseNumText('.'), '')
  assert.equal(parseNumText('-'), '')
})

test('正常数字照常解析，整数框取整、超界夹住', () => {
  assert.equal(parseNumText('12'), 12)
  assert.equal(parseNumText('3.7'), 3, '整数语义：3.7 → 3（以前的坑是先滤非数字变 37）')
  assert.equal(parseNumText('999', { min: 10, max: 500, clamp: true }), 500)
  assert.equal(parseNumText('1', { min: 10, max: 500, clamp: true }), 10)
})

test('输入过程不夹取：敲到一半的小数字不被 min 提前改掉', () => {
  // 「群里一条最长」min=10，但用户从 40 改成 15 时要先经过 1 和 4
  assert.equal(parseNumText('1', { min: 10, max: 500 }), 1, '未声明 clamp 时保留原值')
})

// ---------------- ② 配置层：清空 = 恢复默认 ----------------

test('清空的数字配置回落默认值，而不是被钳到下限', () => {
  const cfg = normalize({ reply: { groupMaxChars: '', privateMaxChars: '', maxBubbles: '' } })
  assert.equal(cfg.reply.groupMaxChars, 40, '群里一条最长清空后应是默认 40（不是下限 10）')
  assert.equal(cfg.reply.privateMaxChars, 120)
  assert.equal(cfg.reply.maxBubbles, 6)
})

test('清空仍回落默认：回合超时 / 文件大小 / 静默小时', () => {
  assert.equal(normalize({ turnTimeoutMs: '' }).turnTimeoutMs, 600000, '回合超时清空 = 默认 10 分钟')
  assert.equal(normalize({ files: { maxMB: '' } }).files.maxMB, 50)
  assert.equal(normalize({ browser: { idleMinutes: '' } }).browser.idleMinutes, 10)
})

test('数字 0 是合法取值，不会被「空值回默认」误伤', () => {
  // 这条是关键的反向约束：很多开关型字段用 0 表示关掉，绝不能因为「空 → 默认」把 0 也回默认
  assert.equal(normalize({ browser: { idleMinutes: 0 } }).browser.idleMinutes, 0)
  assert.equal(normalize({ diary: { timesPerDay: 0 } }).diary.timesPerDay, 0)
  assert.equal(normalize({ group: { maxPerHour: 0 } }).group.maxPerHour, 0)
})

test('模块设置清空后回落 defaults（空串当未填，0 照常生效）', () => {
  const def = { defaults: { dailyBudget: 50000, ownerSharePercent: 60 } }
  // 面板清空「每日总预算」写的是 ''：模块读到默认值，而不是 Number('') = 0（预算直接哑掉）
  assert.equal(resolveModuleSettings(def, { dailyBudget: '' }).dailyBudget, 50000)
  assert.equal(resolveModuleSettings(def, { ownerSharePercent: null }).ownerSharePercent, 60)
  // 反向约束：0 是有意义的取值，不能被当成「没填」
  assert.equal(resolveModuleSettings(def, { ownerSharePercent: 0 }).ownerSharePercent, 0)
})

// ---------------- ③ 组件层：输入过程不归一 ----------------

test('数字框的 onChange 只进暂存，不在输入途中写配置', () => {
  // NumInput 的 onChange 只 setTyped，commit（失焦/回车）才调 onChange 出去
  const body = numSrc.slice(numSrc.indexOf('function NumInput('), numSrc.indexOf('// 绑定到草稿配置的控件'))
  assert.match(body, /onChange=\{\(e\) => setTyped\(e\.target\.value\)\}/,
    'onChange 里不该直接写回配置（那会逐键归一）')
  assert.ok(/onBlur=\{commit\}/.test(body), '失焦要提交')
  assert.ok(/if \(e\.key === 'Enter'\)/.test(body), '回车要提交')
  assert.ok(/value=\{shown\}/.test(body), '显示值要在渲染期派生（不靠 effect 回写，少一帧旧值）')
})

test('提交换算：清空写空串、0 保留、超界夹取、scale 换单位', () => {
  // 这条直接驱动 NumInput 用的那个纯函数，覆盖面板里每个数字框的真实提交语义
  const box = (raw, opts) => commitNumText(raw, opts)
  // 清空 = 恢复默认
  assert.deepEqual(box('', { min: 10, max: 500, allowEmpty: true }), { value: '', text: '' },
    '「群里一条最长」删光后写空串（后端回落默认 40），框里也保持空')
  // 0 是合法取值
  assert.deepEqual(box('0', { min: 0, max: 240, allowEmpty: true }), { value: 0, text: '0' })
  // 超界夹取、整数语义
  assert.deepEqual(box('999', { min: 10, max: 500, allowEmpty: true }), { value: 500, text: '500' })
  assert.deepEqual(box('3.7', { min: 1, max: 10, allowEmpty: true }), { value: 3, text: '3' })
  // 显示分钟、存毫秒（回合超时）
  assert.deepEqual(box('15', { min: 1, max: 120, allowEmpty: true, scale: 60000 }), { value: 900000, text: '15' })
  // 必填项（静默时段这类）清空落回下限，而不是留空
  assert.deepEqual(box('', { min: 0, max: 23, allowEmpty: false }), { value: 0, text: '0' })
})

// ---------------- ④ 别处的同类控件也一起修了 ----------------

test('模块数字框不再按 key 名特批（所有模块都能留空）', () => {
  const modules = readFileSync(join(ROOT, 'client/src/views/modules.js'), 'utf8')
  assert.doesNotMatch(stripComments(modules), /s\.key === 'maxPerDay'/, '不该再只放行 maxPerDay')
  assert.match(modules, /if \(s\.type === 'number'\) return f\.num\(p, \{ min: s\.min, max: s\.max, step: s\.step, fallback: \(m\.defaults \|\| \{\}\)\[s\.key\] \}\)/,
    '模块数字框统一走 f.num（自带可留空）')
})

test('multiparser 的群号名单改成 ListInput（逗号/空格不再被逐键吃掉）', () => {
  const src = readFileSync(join(ROOT, 'client/src/views/platforms/multiparser.js'), 'utf8')
  assert.ok(/<ListInput[\s\S]{0,400}?disabledGroups/.test(src), '群号名单要用 ListInput')
  assert.doesNotMatch(src, /disabledGroups.*?\.split\(\/\[\\s,，;；\]\+\/\)/, '不该再逐键 split+filter')
})

test('记忆页的整理时间照实显示（清空后不再假装还是 04:00）', () => {
  const src = readFileSync(join(ROOT, 'client/src/views/mood.js'), 'utf8')
  assert.doesNotMatch(stripComments(src), /value=\{times\[0\] \|\| '04:00'\}/, '框里不该塞一个没写进草稿的默认值')
  assert.ok(/value=\{times\[0\] \|\| ''\}/.test(src))
})

test('贴吧浏览间隔清空后不被夹回下限', () => {
  const panel = readFileSync(join(ROOT, 'extensions/tieba-reader/panel.js'), 'utf8')
  assert.doesNotMatch(panel, /Math\.round\(Number\(e\.target\.value\) \|\| min\)/, '失焦不该用 `|| min` 把空值夹回下限')
  const host = readFileSync(join(ROOT, 'extensions/tieba-reader/index.mjs'), 'utf8')
  assert.match(host, /if \(v === '' \|\| v === null \|\| v === undefined\) return fallback/,
    'bounded() 要把空值当未填回落默认')
})

test('打包产物里带上了新组件（忘了 build:client 会红）', () => {
  assert.ok(bundle.includes('parseNumText'), 'client.js 里没有 parseNumText：请运行 npm run build:client')
  assert.ok(bundle.includes('function NumInput('), 'client.js 里没有 NumInput：请运行 npm run build:client')
  assert.ok(bundle.includes('parseNumText'), 'client.js 里没有 parseNumText：请运行 npm run build:client')
})