// Batch 3 · T3.11：回复渲染与主动行为
//
// 全部真实调用导出函数，断言实际输出；不做「读源码正则匹配」的假测试。

import test from 'node:test'
import assert from 'node:assert/strict'

import { stripMarkdown } from '../src/chat/reply-markdown.js'
import { parseReply, capBubbles } from '../src/chat/reply-segment.js'
import { expandMentions } from '../src/chat/mentions.js'
import { extractAndStripInnerMonologue } from '../src/chat/reply-sanitize.js'
import { isAwakeAt } from '../src/core/day-window.js'

const at = (h, m = 0) => new Date(2026, 0, 1, h, m).getTime()

test('T3.11 代码块内容不被 Markdown 规则改写（下划线/星号/井号/分隔线原样保留）', () => {
  const text = [
    '看这段：',
    '```python',
    'def __init__(self):',
    '    a = b * c * d',
    '# note',
    '---',
    '```',
    '还有 `x_y_z` 和 `a * b * c`',
  ].join('\n')
  const out = stripMarkdown(text)
  assert.match(out, /def __init__\(self\):/, '__init__ 的下划线不能被当成加粗吃掉')
  assert.match(out, /a = b \* c \* d/, '代码里的乘号不能被当成斜体吃掉')
  assert.match(out, /# note/, '代码里的 # 不能被当成标题删掉')
  assert.match(out, /---/, '代码里的 --- 不能被换成分隔线')
  assert.match(out, /x_y_z/, '行内代码同样原样保留')
  assert.match(out, /a \* b \* c/, '行内代码里的星号原样保留')
})

test('T3.11 代码块里的 ||| 不是气泡分隔符', () => {
  const r = parseReply('第一段```\na ||| b\n```第二段|||真的第二条')
  assert.equal(r.silent, false)
  assert.equal(r.items.length, 2, '只有代码外的那个 ||| 才切条')
  assert.match(r.items[0].value, /a \|\|\| b/, '代码里的分隔符必须原样留下')
  assert.equal(r.items[1].value, '真的第二条')
})

test('T3.11 capBubbles 合并文字时按原始下标放回，媒体顺序不错乱', () => {
  const items = [
    { kind: 'text', value: 'A' },
    { kind: 'text', value: 'B' },
    { kind: 'image', value: 'PIC' },
    { kind: 'text', value: 'C' },
  ]
  const out = capBubbles(items, 2)
  assert.deepEqual(out.map((i) => i.kind), ['text', 'image', 'text'])
  assert.equal(out[0].value, 'A\n\nB')
  assert.equal(out[1].value, 'PIC')
  assert.equal(out[2].value, 'C', '第 2 组文字必须留在图片之后，不能被顶到图片之前')
})

test('T3.11 isAwakeAt：跨午夜窗口 / 普通窗口 / 全天三种语义', () => {
  // 20:00 → 04:00 跨午夜
  assert.equal(isAwakeAt(at(22), 20, 4), true, '晚上 22 点应醒着')
  assert.equal(isAwakeAt(at(2), 20, 4), true, '凌晨 2 点仍应醒着')
  assert.equal(isAwakeAt(at(10), 20, 4), false, '上午 10 点应睡着')
  // 普通窗口 [9, 18)
  assert.equal(isAwakeAt(at(9), 9, 18), true, '左闭')
  assert.equal(isAwakeAt(at(18), 9, 18), false, '右开')
  // 全天
  assert.equal(isAwakeAt(at(3), 0, 24), true)
  assert.equal(isAwakeAt(at(15), 8, 8), true, 'from === to 视为全天')
})

test('T3.11 邮箱 / 版本号里的 @ 不当成提到人，数字前缀不误判 QQ', () => {
  // 用拼接避免邮箱字面量被隐私层改写，保证断言对象与输入一致。
  const mail = ['test', '123456.com'].join('@')
  const segs = [{ type: 'text', data: { text: `${mail} 和 @12345.6 以及 @小明 你好` } }]
  const missed = []
  const out = expandMentions(segs, [{ user_id: '10001', card: '小明' }], missed)
  const texts = out.filter((s) => s.type === 'text').map((s) => s.data.text).join('')
  assert.ok(texts.includes(mail), `邮箱应原样保留，实际：${texts}`)
  assert.match(texts, /@12345\.6/, '版本号原样保留')
  assert.equal(out.filter((s) => s.type === 'at').length, 1, '只有真正的小明被展开成 at 段')
  assert.equal(out.find((s) => s.type === 'at').data.qq, '10001')
  assert.ok(!missed.includes('123456.com'), '邮箱不该被记进未匹配名单')
})

test('T3.11 Promise<Array<number>> 泛型不被当成内层独白标签吃掉', () => {
  const r = extractAndStripInnerMonologue('Promise<Array<number>> 是泛型')
  assert.equal(r.text, 'Promise<Array<number>> 是泛型')
  assert.equal(r.inner.blocks, 0)
})
