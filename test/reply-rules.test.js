// 分条规则（2026-11-05）：以前按字数一刀切，长回复被切在句子中间、时间被拆成「到14」+「22」。
// 现在改成「她自己断的句优先，字数只兜底」，并且群聊/私聊上限分开、面板可调。
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReply, replyRules } from '../src/chat/reply.js'

const texts = (raw, rules) => parseReply(raw, rules).items.filter((i) => i.kind === 'text').map((i) => i.value)

test('replyRules：群聊与私聊取不同的单条上限，非法值夹住', () => {
  assert.equal(replyRules({}, true).maxChars, 40, '群聊默认 40')
  assert.equal(replyRules({}, false).maxChars, 120, '私聊默认 120')
  assert.equal(replyRules({ reply: { groupMaxChars: 9999 } }, true).maxChars, 500, '群聊上限夹到 500')
  assert.equal(replyRules({ reply: { privateMaxChars: 1 } }, false).maxChars, 20, '私聊下限夹到 20')
  assert.equal(replyRules({ reply: {} }, true).trustModelBubbles, true, '默认按她自己断句')
  assert.equal(replyRules({ reply: { trustModelBubbles: false } }, true).trustModelBubbles, false)
  assert.equal(replyRules({ reply: {} }, true).keepReports, true, '默认清单整段发')
})

test('按她自己的断句发：她换几行就是几条，不再按字数切碎', () => {
  const raw = '对了 那个我还没说完\n今天挺忙的\n晚上再说吧'
  const out = texts(raw, replyRules({}, true))
  assert.deepEqual(out, ['对了 那个我还没说完', '今天挺忙的', '晚上再说吧'])
})

test('||| 是她自己划的条：内容原样成条', () => {
  const raw = '第一句话在这里|||第二句话也在这一条里，比三十个字长一点也没关系，不用再切'
  const out = texts(raw, replyRules({}, true))
  assert.deepEqual(out, ['第一句话在这里', '第二句话也在这一条里，比三十个字长一点也没关系，不用再切'])
})

test('关掉「按她自己的断句」就回到老办法：按字数切成短条', () => {
  const raw = '我看了半天也没想明白。可能是缓存没清干净，也可能是模型本身的问题。回头我再试试别的办法看看能不能绕过去。顺便把日志也清理一下，省得越堆越多。'
  const off = texts(raw, { maxChars: 30, trustModelBubbles: false, keepReports: true })
  assert.ok(off.length >= 2, '老办法应该切开：' + JSON.stringify(off))
  const on = texts(raw, { maxChars: 40, trustModelBubbles: true, keepReports: true })
  assert.equal(on.length, 1, '新办法：一条连贯的话不硬切')
})

test('清单/汇报整段发（多小标题、编号列表、代码块）', () => {
  const report = '【问题在哪】\n缓存没清干净\n【结论】\n不用升配\n【建议】\n1. 长会话勤开新的\n2. 换按量计费\n3. 少读大文件'
  const out = texts(report, replyRules({}, true))
  assert.equal(out.length, 1, '汇报不该被拆散：' + JSON.stringify(out))
  assert.ok(out[0].includes('【结论】') && out[0].includes('3. 少读大文件'), '内容要完整')
  const code = '看这段：\n```\nnpm run build\n```\n跑完就好'
  assert.equal(texts(code, replyRules({}, true)).length, 1, '代码块整段发')
})

test('关掉「清单整段发」后，同样的汇报会按上限拆', () => {
  const report = '【问题在哪】\n缓存没清干净\n【结论】\n不用升配\n【建议】\n1. 长会话勤开新的\n2. 换按量计费\n3. 少读大文件'
  const out = texts(report, { maxChars: 20, trustModelBubbles: true, keepReports: false })
  assert.ok(out.length >= 2, '关掉后应该拆：' + JSON.stringify(out))
})

test('时间里的冒号永远不是切点（两种情况都守住）', () => {
  const raw = '查了 你猜对了一半 【M Plan 现在状态】 5小时窗口 今天09:22开的 到14:22 已经烧掉55% 剩45% 周窗口到下周三09:22 只烧了6% 剩94%'
  for (const rules of [replyRules({}, true), { maxChars: 30, trustModelBubbles: false }]) {
    const joined = texts(raw, rules).join('')
    assert.ok(joined.includes('到14:22'), '时间不能断开：' + JSON.stringify(texts(raw, rules)))
    assert.ok(joined.includes('09:22'), '时间不能断开')
  }
})
