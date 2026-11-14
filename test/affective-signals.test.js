// US-015 · 关系信号挖掘（affective-signals）回归。
//
// 这一层决定「她跟谁有多熟」的**输入**，所以四条铁律必须有测试盯着：
//   ① 六种信号各能真的认出来（真实中文样例，不是英文占位符）；
//   ② 宁可漏判不可误判：日常碎话、客套、打闹不许被记成吵架/谈心/越界；
//   ③ 同样输入必产出同样结果（纯函数，连跑三次全等）；
//   ④ 每条信号带 note，且 note 里能看见触发它的原话（可解释 / 面板可追溯）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mineSignals,
  SIGNAL_KINDS,
  MIN_CONFIDENCE,
  MAX_NOTE_CHARS,
} from '../src/chat/affective-signals.js'
import { SIGNAL_WEIGHTS } from '../src/chat/affective-graph.js'

const CHAT = 'private:10001'

/** 一轮对话 → 信号（测试内统一入口，避免每个用例重复拼参数）。 */
const mine = (userText, botText = '', extra = {}) => mineSignals({ chatKey: CHAT, userText, botText, ...extra })

/** 某种信号是否出现。 */
const hasKind = (signals, kind) => signals.some((s) => s.kind === kind)

/**
 * 深夜时间戳（把"深夜长聊"这条规则变成可复现的输入，而不是读机器本地时间）。
 *
 * 必须用**本地时间**构造：mineSignals 的深夜判定走 `new Date(now).getHours()`，
 * 语义是「用户手机上的几点」（与 group-policy 的 quietHours 同口径）。
 * 曾经写成绝对时刻 `new Date('...T02:30:00+08:00')`：在 Asia/Shanghai 恰好是 2 点所以本地全绿，
 * 但 CI 跑在 UTC，同一时刻 getHours()=18，深夜分支不触发 → 置信度 0.7 → 断言 >=0.8 失败。
 * `new Date(y, m, d, h, mi)` 按本地时区解释，任何时区都得到 getHours()===2。
 */
const DEEP_NIGHT = new Date(2026, 0, 1, 2, 30).getTime()

// ---------------------------------------------------------------------------
// 词表契约
// ---------------------------------------------------------------------------

test('信号词表与图谱 SIGNAL_WEIGHTS 完全对齐（不多不少）', () => {
  assert.deepEqual([...SIGNAL_KINDS].sort(), Object.keys(SIGNAL_WEIGHTS).sort())
  for (const kind of SIGNAL_KINDS) {
    assert.equal(typeof MIN_CONFIDENCE[kind], 'number', `${kind} 必须有置信度下限`)
    assert.ok(MIN_CONFIDENCE[kind] > 0 && MIN_CONFIDENCE[kind] <= 1)
  }
  // 负面信号的门槛必须更严（"宁可漏判不可误判"在此可断言）
  assert.ok(MIN_CONFIDENCE['conflict'] > MIN_CONFIDENCE['shared-joke'])
  assert.ok(MIN_CONFIDENCE['boundary-violation'] > MIN_CONFIDENCE['conflict'])
})

test('无命中返回 []（不是 undefined），空输入也返回 []', () => {
  assert.deepEqual(mine(''), [])
  assert.deepEqual(mineSignals({}), [])
  assert.deepEqual(mineSignals(), [])
  assert.deepEqual(mine('今天天气不错，吃饭了吗'), [])
})

// ---------------------------------------------------------------------------
// ① shared-joke
// ---------------------------------------------------------------------------

test('shared-joke：双方"哈哈哈哈"对答 → 命中，note 引用原话', () => {
  const hits = mine('哈哈哈哈笑死我了，你也太逗了', '哈哈哈哈，被你发现了')
  assert.ok(hasKind(hits, 'shared-joke'))
  const hit = hits.find((s) => s.kind === 'shared-joke')
  assert.ok(hit.confidence >= MIN_CONFIDENCE['shared-joke'])
  assert.match(hit.note, /哈{2,}|笑死|逗/)
})

test('shared-joke：接梗元话语 + 一起笑 → 命中', () => {
  const hits = mine('哈哈哈这个梗我们上次也玩过', '哈哈哈哈复读机上线')
  assert.ok(hasKind(hits, 'shared-joke'))
  assert.match(hits.find((s) => s.kind === 'shared-joke').note, /梗/)
})

test('shared-joke：引用最近上下文里的旧梗 + 笑 → 命中且 note 指向那句梗', () => {
  const hits = mine('「小鱼干」哈哈哈哈你又来了', '哈哈那条鱼还在', {
    recentContext: '对方：我外号叫小鱼干\n我：小鱼干你好',
  })
  assert.ok(hasKind(hits, 'shared-joke'))
  assert.match(hits.find((s) => s.kind === 'shared-joke').note, /小鱼干/)
})

test('shared-joke 反例：只有对方笑、她没接 → 不算一起玩过梗', () => {
  // 单方笑可能是礼貌/自嘲，构不成"共享"
  assert.equal(hasKind(mine('哈哈哈哈', '好的，我记下了'), 'shared-joke'), false)
})

test('shared-joke 反例：正经通知 / 日常寒暄里出现"好笑"字样也不命中', () => {
  assert.equal(hasKind(mine('明天九点开会，别迟到', '好的，我会提醒你'), 'shared-joke'), false)
  assert.equal(hasKind(mine('这个报告不太好笑', '我看看'), 'shared-joke'), false)
})

// ---------------------------------------------------------------------------
// ② deep-talk
// ---------------------------------------------------------------------------

test('deep-talk：情绪自陈（焦虑/失眠）→ 命中，note 引用原话', () => {
  const hits = mine('最近好焦虑，晚上总是睡不着，一想到工作就心慌', '我在呢，慢慢说')
  assert.ok(hasKind(hits, 'deep-talk'))
  assert.match(hits.find((s) => s.kind === 'deep-talk').note, /焦虑|睡不着/)
})

test('deep-talk：深夜 + 心事 → 命中（0–5 点的长聊形态）', () => {
  const hits = mineSignals({ chatKey: CHAT, userText: '有点烦，睡不着', botText: '那我陪你聊会儿', now: DEEP_NIGHT })
  const hit = hits.find((s) => s.kind === 'deep-talk')
  assert.ok(hit, '深夜心事应命中 deep-talk')
  assert.ok(hit.confidence >= 0.8, `深夜应给出更高置信度（实际 ${hit.confidence}）`)
})

test('deep-talk：强自陈（"我只跟你说"）→ 命中，不需要长消息', () => {
  const hits = mine('这事我只跟你说，别外传', '嗯，我记着')
  assert.ok(hasKind(hits, 'deep-talk'))
  assert.match(hits.find((s) => s.kind === 'deep-talk').note, /只跟你说|别外传/)
})

test('deep-talk 反例：日常家常（我妈让我早点睡）不许被当成掏心窝', () => {
  assert.equal(hasKind(mine('我妈让我早点睡，先下了', '好，晚安'), 'deep-talk'), false)
})

test('deep-talk 反例：只有"压力大"这种弱词、没有内心活动也不长 → 不命中', () => {
  assert.equal(hasKind(mine('今天压力好大', '辛苦啦'), 'deep-talk'), false)
})

// ---------------------------------------------------------------------------
// ③ mutual-help
// ---------------------------------------------------------------------------

test('mutual-help：求助 + 她给了可执行建议 → 命中', () => {
  const hits = mine('这个报错我搞不定，帮我看看怎么办', '你可以先把日志开起来，再试试重启服务')
  assert.ok(hasKind(hits, 'mutual-help'))
  assert.match(hits.find((s) => s.kind === 'mutual-help').note, /帮我|怎么办/)
})

test('mutual-help：道谢 + 她确实帮上了（给了方法） → 命中', () => {
  const hits = mine('谢谢，我试试你说的那个方法', '不客气，先把缓存清掉再看')
  assert.ok(hasKind(hits, 'mutual-help'))
})

test('mutual-help：道谢 + 问题解决（闭环） → 命中，置信度更高', () => {
  const hits = mine('多谢！按你说的弄好了，解决了', '太好了')
  const hit = hits.find((s) => s.kind === 'mutual-help')
  assert.ok(hit)
  assert.ok(hit.confidence >= 0.8, `闭环道谢应更有把握（实际 ${hit.confidence}）`)
})

test('mutual-help 反例：纯客套道谢（她没帮任何忙）不算互相帮忙', () => {
  assert.equal(hasKind(mine('谢谢', '不客气'), 'mutual-help'), false)
  assert.equal(hasKind(mine('谢谢你陪我聊', '嗯嗯'), 'mutual-help'), false)
})

test('mutual-help 反例：她给了建议但对方没求助也没道谢 → 不命中（单方面输出不算互助）', () => {
  assert.equal(hasKind(mine('今天上班好累', '你可以早点睡，试试泡个脚'), 'mutual-help'), false)
})

// ---------------------------------------------------------------------------
// ④ conflict（负面，保守）
// ---------------------------------------------------------------------------

test('conflict：明确骂战 → 命中，note 引用脏话原话', () => {
  const hits = mine('你有病吧，滚开', '那我先不说了')
  const hit = hits.find((s) => s.kind === 'conflict')
  assert.ok(hit)
  assert.match(hit.note, /有病|滚/)
  assert.ok(hit.confidence >= MIN_CONFIDENCE['conflict'])
})

test('conflict：两条不同对立标记（弱证据凑够） → 命中', () => {
  const hits = mine('你根本不懂，别说了', '好')
  assert.ok(hasKind(hits, 'conflict'))
})

test('conflict：拉黑式对立 → 命中', () => {
  const hits = mine('烦死了，再这样我拉黑你', '我知道了')
  assert.ok(hasKind(hits, 'conflict'))
})

test('conflict 反例：打闹带玩笑标记（"你有病吧开玩笑的"）→ 不误伤', () => {
  const hits = mine('哈哈哈哈你有病吧，开玩笑的', '哈哈吓我一跳')
  assert.equal(hasKind(hits, 'conflict'), false, '玩笑语境下的冲突词不算吵架')
})

test('conflict 反例：单条弱证据（"你错了"）→ 不扣分', () => {
  const hits = mine('我觉得你错了，这个方案应该反过来', '你说得对，我再想想')
  assert.equal(hasKind(hits, 'conflict'), false, '正常分歧不是吵架')
})

test('conflict 反例：吐槽第三方 / 转述别人的争吵 → 不误伤', () => {
  assert.equal(hasKind(mine('今天同事跟我吵架了，好烦', '辛苦了'), 'conflict'), false)
  assert.equal(hasKind(mine('网上那些人说话真难听', '别理他们'), 'conflict'), false)
})

test('conflict 反例：歧义词（"无语"单独出现）不许扣分', () => {
  assert.equal(hasKind(mine('这个 bug 真无语', '我看看'), 'conflict'), false)
})

// ---------------------------------------------------------------------------
// ⑤ boundary-violation（负面，最保守）
// ---------------------------------------------------------------------------

test('boundary-violation：她已明确划界 + 对方硬顶 → 命中', () => {
  const hits = mine('我就要继续说', '说了不想聊这个，别问了')
  const hit = hits.find((s) => s.kind === 'boundary-violation')
  assert.ok(hit)
  assert.match(hit.note, /我就要/)
  assert.ok(hit.confidence >= MIN_CONFIDENCE['boundary-violation'])
})

test('boundary-violation：划界在上一轮（recentContext）+ 这一轮命令式越界 → 命中', () => {
  const hits = mine('你必须告诉我，不许拒绝', '……', {
    recentContext: '对方：那个问题\n我：这个不聊，换个话题吧',
  })
  assert.ok(hasKind(hits, 'boundary-violation'))
})

test('boundary-violation：她说不舒服 + 对方继续逼问 → 命中', () => {
  const hits = mine('凭什么不行，继续说', '你这样我有点不舒服')
  assert.ok(hasKind(hits, 'boundary-violation'))
})

test('boundary-violation 反例：她划界了但对方立刻退让 → 不误伤', () => {
  assert.equal(hasKind(mine('好的，那我不问了，对不起', '没事'), 'boundary-violation'), false)
})

test('boundary-violation 反例：没有划界证据时，任何"硬顶"都不算越界（必要条件）', () => {
  // 没有拒绝证据 = 无法证明越界，宁可漏判
  assert.equal(hasKind(mine('我就要继续说', '嗯，你说'), 'boundary-violation'), false)
  assert.equal(hasKind(mine('你管不着', '哈哈好吧'), 'boundary-violation'), false)
})

test('boundary-violation 反例：日常商量里的"凭什么"不许当成越界', () => {
  const hits = mine('凭什么这个方案要我改', '我看看排期')
  assert.equal(hasKind(hits, 'boundary-violation'), false)
})

// ---------------------------------------------------------------------------
// ⑥ explicit-confirmed
// ---------------------------------------------------------------------------

test('explicit-confirmed："你真好" → 命中', () => {
  const hits = mine('你真好，谢谢你陪我', '嘿嘿')
  const hit = hits.find((s) => s.kind === 'explicit-confirmed')
  assert.ok(hit)
  assert.match(hit.note, /你真好/)
})

test('explicit-confirmed："我信任你" → 命中', () => {
  assert.ok(hasKind(mine('我信任你，这件事就交给你了', '放心吧'), 'explicit-confirmed'))
})

test('explicit-confirmed："你是我朋友 / 把你当朋友" → 命中', () => {
  assert.ok(hasKind(mine('你是我最好的朋友', '嘿嘿'), 'explicit-confirmed'))
  assert.ok(hasKind(mine('我一直把你当朋友', '我也是'), 'explicit-confirmed'))
})

test('explicit-confirmed 反例："你真好笑 / 你真好骗" 是调侃，不是认可关系', () => {
  assert.equal(hasKind(mine('你真好笑', '哈哈'), 'explicit-confirmed'), false)
  assert.equal(hasKind(mine('你真好骗', '才没有'), 'explicit-confirmed'), false)
})

test('explicit-confirmed 反例：转述别人的关系 / 玩笑式表白都不算', () => {
  assert.equal(hasKind(mine('她说你真好', '嘿嘿'), 'explicit-confirmed'), false)
  assert.equal(hasKind(mine('我信任你才怪，开玩笑的', '哈哈'), 'explicit-confirmed'), false)
})

// ---------------------------------------------------------------------------
// 负向压制：吵架那一轮不产出正向信号
// ---------------------------------------------------------------------------

test('负面信号在场时，同一轮不产出任何正向信号（吵架里的"谢谢"不抵消损伤）', () => {
  const hits = mine('你有病吧，谢谢你的"好意"', '……')
  assert.ok(hasKind(hits, 'conflict'))
  for (const kind of ['shared-joke', 'deep-talk', 'mutual-help', 'explicit-confirmed']) {
    assert.equal(hasKind(hits, kind), false, `${kind} 不该在冲突轮出现`)
  }
})

// ---------------------------------------------------------------------------
// 确定性与边界
// ---------------------------------------------------------------------------

test('同输入确定性：连跑三次结果全等（纯函数，无随机）', () => {
  const inputs = [
    { chatKey: CHAT, userText: '哈哈哈哈笑死我了', botText: '哈哈哈哈哈' },
    { chatKey: CHAT, userText: '最近好焦虑，睡不着', botText: '我在呢' },
    { chatKey: CHAT, userText: '你有病吧', botText: '' },
    { chatKey: CHAT, userText: '我就要继续说', botText: '别问了，我不想聊' },
    { chatKey: CHAT, userText: '谢谢，弄好了', botText: '先把日志开起来试试' },
  ]
  for (const input of inputs) {
    const a = JSON.stringify(mineSignals(input))
    const b = JSON.stringify(mineSignals(input))
    const c = JSON.stringify(mineSignals(input))
    assert.equal(a, b, `第二次结果应与第一次相同：${input.userText}`)
    assert.equal(b, c, `第三次结果应与第二次相同：${input.userText}`)
  }
})

test('非法 chatKey 一律返回 []（fail-closed，不猜作用域）', () => {
  for (const bad of ['', 'nope', 'private:', 'private:0', 'private:007', 42, {}, null]) {
    assert.deepEqual(
      mineSignals({ chatKey: bad, userText: '哈哈哈哈', botText: '哈哈哈哈' }),
      [],
      `${JSON.stringify(bad)} 应 fail-closed`,
    )
  }
  // 不传 chatKey 时不猜域，正常挖掘（调用方负责绑域）
  assert.ok(hasKind(mineSignals({ userText: '哈哈哈哈', botText: '哈哈哈哈' }), 'shared-joke'))
})

test('非字符串输入不猜（对象/数字/数组不产生信号，也不抛）', () => {
  for (const bad of [42, {}, [], true, null, undefined]) {
    assert.deepEqual(mineSignals({ chatKey: CHAT, userText: bad, botText: bad }), [])
  }
})

test('note 有长度上限，且永远是非空字符串（面板可追溯）', () => {
  const long = '最近好焦虑，'.repeat(60)
  const hits = mine(long, '我在')
  for (const hit of hits) {
    assert.equal(typeof hit.note, 'string')
    assert.ok(hit.note.length > 0, `${hit.kind} 的 note 不能为空`)
    assert.ok(Array.from(hit.note).length <= MAX_NOTE_CHARS + 2, `note 应截断到 ${MAX_NOTE_CHARS} 上下`)
  }
})

test('每个信号对象形状固定为 {kind, note, confidence}', () => {
  const hits = mine('哈哈哈哈笑死我了', '哈哈哈哈哈')
  for (const hit of hits) {
    assert.deepEqual(Object.keys(hit).sort(), ['confidence', 'kind', 'note'])
    assert.ok(SIGNAL_KINDS.includes(hit.kind))
    assert.ok(hit.confidence > 0 && hit.confidence <= 1)
  }
})