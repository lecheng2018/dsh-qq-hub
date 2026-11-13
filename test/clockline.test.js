// 时间锚（2026-11-05）：QQ 消息不带时间戳，模型分不出「刚说的」和「两小时前说的」。
// 这里守住三件事：间隔怎么写、时间行长什么样、多久以内的消息不标相对时间。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stamp, formatGap, nowLine, agoLabel } from '../src/chat/clockline.js'

const CORE = readFileSync(new URL('../src/host/modular-core.js', import.meta.url), 'utf8')

// 用一个固定时刻，免得测试跑在跨天/跨周时抖动（2026-11-05 是周四）
const AT = new Date(2026, 10, 5, 22, 3, 0).getTime()

test('间隔写成中文：分钟、小时、天', () => {
  assert.equal(formatGap(0), '刚刚')
  assert.equal(formatGap(30_000), '刚刚')
  assert.equal(formatGap(8 * 60_000), '8 分钟')
  assert.equal(formatGap(2 * 3600_000 + 7 * 60_000), '2 小时 7 分钟')
  assert.equal(formatGap(3 * 3600_000), '3 小时', '整小时不带「0 分钟」')
  assert.equal(formatGap(26 * 3600_000), '1 天 2 小时')
  assert.equal(formatGap(72 * 3600_000), '3 天')
  assert.equal(formatGap(-5000), '刚刚', '时钟回拨也不出负数')
})

test('时间行：只有现在 / 现在 + 距上一条消息多久', () => {
  assert.equal(stamp(AT), '11-05 22:03（周四）')
  assert.equal(nowLine(AT), '【现在】11-05 22:03（周四）', '第一次交给她时没有「距」')
  assert.equal(
    nowLine(AT, AT - (2 * 3600_000 + 7 * 60_000)),
    '【现在】11-05 22:03（周四）｜距上一条消息 2 小时 7 分钟',
  )
  assert.equal(
    nowLine(AT, AT - 20 * 60_000, { what: '上一段消息' }),
    '【现在】11-05 22:03（周四）｜距上一段消息 20 分钟',
  )
  assert.equal(nowLine(AT, AT + 60_000), '【现在】11-05 22:03（周四）', '上一次时间在将来就当没有')
})

test('每条消息的相对时间：一分钟以内不标，久了才标', () => {
  assert.equal(agoLabel(AT - 20_000, AT), '', '刚发的消息不标「刚刚」免得满屏噪音')
  assert.equal(agoLabel(AT - 8 * 60_000, AT), '（8 分钟前）')
  assert.equal(agoLabel(AT - 2 * 3600_000 - 7 * 60_000, AT), '（2 小时 7 分钟前）')
  assert.equal(agoLabel(0, AT), '')
  assert.equal(agoLabel(AT + 1000, AT), '', '时间在将来也不标')
})

test('接在当前发送链路上：私聊放消息最前，群聊每条消息带相对时间', () => {
  assert.match(CORE, /const previousTurnAt = turnAt\(turn\.chatKey\)/, '每轮先取上次回合时间')
  assert.match(CORE, /const timeHead = nowLine\(Date\.now\(\), previousTurnAt\)/, '私聊每轮算一次时间行')
  assert.match(CORE, /text: `\$\{source\}\\n\$\{timeHead\}\\n/, '时间行插在来源行下面')
  assert.match(CORE, /nowLine\(nowAt, previousTurnAt, \{ what: '上一段消息' \}\)/, '群聊那行在 groupPrompt 里')
  assert.match(CORE, /agoLabel\(x\.t, nowAt\)/, '群聊每条消息带相对时间')
})

test('上一次交给她是什么时候：写入当前会话映射，重启也算得出来', () => {
  assert.match(CORE, /registry\.markTurn\(chatKey\)/, '当前注册表负责持久化回合时间')
  assert.match(CORE, /entry\.lastTurnAt \|\| entry\.createdAt/, '会话列表读取持久化时间')
})
