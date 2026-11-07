// 回归：长句硬拆不能切断标签、不能以逗号结尾（2026-11-04 线上两个真实 bug）。
//
// bug 1: "<face:捂脸>" 被拆成 "<face:" + "捂脸>" —— 用户收到两条残缺消息
// bug 2: 拆出来的上一条以「，」结尾 —— 读起来像半句话，没有活人感
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply } from '../src/chat/reply.js'

const textsOf = (s) => parseReply(s).items.filter((i) => i.kind === 'text').map((i) => i.value)

test('硬拆不能切断 <face:…> 标签（线上 bug）', () => {
  const out = textsOf('那我就闷锅里煮着，什么时候开盖什么时候算我熟 <face:捂脸>')
  const joined = out.join('')
  assert.ok(joined.includes('<face:捂脸>'), '标签必须完整：' + JSON.stringify(out))
  assert.equal(out.some((t) => t.endsWith('<face:')), false, '不能出现半截标签')
  assert.equal(out.some((t) => t.startsWith('捂脸>')), false, '不能出现半截标签尾巴')
})

test('硬拆不会把 <sticker:…> 标签切坏（它会被正确提取成表情 item）', () => {
  const items = parseReply('你这话说得我有点想笑 <sticker:无语> 但是又觉得有道理').items
  const sticker = items.find((i) => i.kind === 'sticker')
  assert.ok(sticker, '表情标签应该被提取成 sticker item：' + JSON.stringify(items))
  assert.equal(sticker.value, '无语', '表情值不能残缺')
  // 文本里也不能残留半截标签
  for (const t of items.filter((i) => i.kind === 'text')) {
    assert.equal(/<sticker:|<face:|^\S+>/.test(t.value), false, '文本里有半截标签：' + JSON.stringify(t.value))
  }
})

test('短句原样通过，不该乱切', () => {
  assert.deepEqual(textsOf('草'), ['草'])
  assert.deepEqual(textsOf('不告诉你'), ['不告诉你'])
})

test('完整句子不切碎：45 字的一句话整条发（不按逗号劈）', () => {
  const raw = '今天我去了那个新开的商场，里面人特别多而且到处都在排队，还碰到大学同学了'
  const out = textsOf(raw)
  assert.deepEqual(out, [raw], '完整的一句话不该被切成多段')
})

test('只有真长句（> 60 字）才切，且切开处不带逗号', () => {
  const raw = '这件事我先说清楚一下，第一是那个价格确实比上代贵了不少，第二是它的跑分虽然高但是我实际用起来感觉差别没那么大，第三是如果你只是日常用完全没必要换'
  const out = textsOf(raw)
  assert.ok(out.length >= 2, '这么长应该切')
  for (const t of out) {
    assert.equal(/[，,、：:；;]$/.test(t), false, '切开处不能以逗号结尾：' + JSON.stringify(t))
  }
})

test('群里一段回复超过 3 条时，多出来的并进第 3 条而不是丢掉', () => {
  // 这是 2026-11-04 线上事故的形状：她答「备用码」讲了四段，群里只出现第一段，
  // 用户看到的是「一个问题没回答完就停了」。截断在 hub.js 的 slice(0,3)。
  // 这里守的是 reply 层不把内容提前切成更多段，hub 层负责合并不丢弃。
  const raw = '备用码是 Google 给的一次性码，一共十个，手机丢了也能登录一个 路径在账号→安全性→两步验证→备用码，可以下载或打印 你现在验证器异常进不去设置页，先用短信那条路重置两步验证，再重新生成'
  const all = parseReply(raw).items.filter((i) => i.kind === 'text').map((i) => i.value).join('')
  // 无论切成几条，所有内容都必须在（不能有任何一段人间蒸发）
  for (const piece of ['备用码是', '一共十个', '手机丢了', '路径在账号', '可以下载或打印', '验证器异常', '短信那条路', '重新生成']) {
    assert.ok(all.includes(piece), `内容「${piece}」被丢了：` + JSON.stringify(all))
  }
})

test('时间/比例里的冒号不是切点：09:22 不会被切成「到14」+「22 …」', () => {
  // 2026-11-05 线上：额度汇报里「到14:22 已经烧掉55%」被她发成两条，
  // 前一条停在「…到14」、冒号还没了，看着像被截断。
  const raw = '查了 你猜对了一半 【M Plan 现在状态】 5小时窗口 今天09:22开的 到14:22 已经烧掉55% 剩45% 周窗口到下周三09:22 只烧了6% 剩94%'
  const out = textsOf(raw)
  const joined = out.join('')
  assert.ok(joined.includes('到14:22'), '时间被切开了：' + JSON.stringify(out))
  assert.ok(joined.includes('09:22'), '时间被切开了：' + JSON.stringify(out))
  for (const t of out) {
    assert.equal(/\d$/.test(t) && /[：:]/.test(raw), false, '不要以单个数字结尾（半截时间）：' + JSON.stringify(t))
  }
})

test('冒号不再被当成切开处的收尾标点', () => {
  const raw = '按M3.1-Flash刊例折算 输入1 输出4 缓存读0.1 每百万 总共才3块6 所以烧的不是新token 是缓存读那3065万 按量算一分钱 换成M Plan额度就变成三千多块的额度单位'
  const out = textsOf(raw)
  for (const t of out) {
    assert.equal(/[，,、：:；;]$/.test(t), false, '切开处不能带标点：' + JSON.stringify(t))
  }
})
