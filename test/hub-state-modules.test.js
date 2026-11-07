// hub 状态所有权重构（1.3.57）：三个状态模块的独立测试。
// 以前这些规则内联在 chat/hub.js 的两千行里（20 秒节流、|| 回退、1 小时窗口、40 条上限、
// 4 分钟卡住保护、6 分钟 typing 上限），没法单独测。现在各归其位。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createInteractionState } from '../src/chat/interaction-state.js'
import { createGroupState, ENGAGE_MS } from '../src/chat/group-state.js'
import { createActivityState, BUSY_MAX_MS } from '../src/chat/activity-state.js'

// ---------------- 互动状态 ----------------
test('小黄脸去重池：按 chatId 隔离，记得上一次用了什么', () => {
  const s = createInteractionState()
  assert.equal(s.facesUsed('private:1').size, 0)
  s.rememberFaces('private:1', ['捂脸', 'OK'])
  assert.deepEqual([...s.facesUsed('private:1')], ['捂脸', 'OK'])
  assert.equal(s.facesUsed('private:2').size, 0, '别的聊天不受影响')
  s.rememberFaces('private:1', ['偷笑'])
  assert.deepEqual([...s.facesUsed('private:1')], ['偷笑'], '覆盖而不是累加')
})

test('戳回去的目标：群里优先最近戳她的人，没戳过就用最后说话的人；私聊直接戳对方', () => {
  const s = createInteractionState()
  assert.equal(s.pokeBackTarget('group:1'), '', '既没戳过也没说过话：没人可戳')
  s.rememberSpeaker('group:1', 'bao')
  assert.equal(s.pokeBackTarget('group:1'), 'bao', '回退到最后说话的人')
  s.rememberPoker('group:1', 'poker')
  assert.equal(s.pokeBackTarget('group:1'), 'poker', '戳过的人优先')
  assert.equal(s.pokeBackTarget('private:12345'), '12345', '私聊戳对方')
})

test('戳一戳节流：同一聊天 20 秒内只算一次，过了就重新放行', () => {
  const s = createInteractionState()
  const t0 = 1_000_000
  assert.equal(s.claimPoke('group:1', t0), true, '第一次放行')
  assert.equal(s.claimPoke('group:1', t0 + 19_999), false, '20 秒内挡掉')
  assert.equal(s.claimPoke('group:1', t0 + 20_000), true, '到点放行')
  assert.equal(s.claimPoke('group:2', t0 + 100), true, '别的群不受影响')
})

test('别处代发的补话队列：取出即清空，最多留 5 条', () => {
  const s = createInteractionState()
  assert.deepEqual(s.takeAside('group:1'), [], '空队列')
  for (let i = 0; i < 7; i++) s.queueAside('group:1', '第' + i + '句')
  const got = s.takeAside('group:1')
  assert.equal(got.length, 5, '只留最近 5 条')
  assert.equal(got.at(-1).text, '第6句')
  assert.deepEqual(s.takeAside('group:1'), [], '取出后清空，不会重复补')
})

// ---------------- 群聊状态 ----------------
test('消息缓冲：40 条上限，超出丢最旧的', () => {
  const g = createGroupState()
  for (let i = 0; i < 45; i++) g.appendMessage('123', { text: 'm' + i })
  const buf = g.buffer('123')
  assert.equal(buf.length, 40)
  assert.equal(buf[0].text, 'm5', '最旧的 5 条被丢掉')
  assert.equal(buf.at(-1).text, 'm44')
})

test('消息缓冲：调用方可以就地改条目（语音转写补字依赖这个）', () => {
  const g = createGroupState()
  const entry = g.appendMessage('123', { text: '', uid: 'u1' })
  assert.equal(g.lastFrom('123', 'u1'), entry, '按 uid 找得到')
  g.lastFrom('123', 'u1').text = '补上的转写'
  assert.equal(g.buffer('123')[0].text, '补上的转写', '改的是同一个对象')
  assert.equal(g.lastFrom('123', 'u2'), null, '别人没有')
})

test('说话/插话时间序列：只看 1 小时内的，过期自动清掉', () => {
  const g = createGroupState()
  const t0 = 10_000_000
  g.noteSpeak('123', t0)
  g.noteSpeak('123', t0 + 1000)
  assert.equal(g.speakTimes('123', t0 + 2000).length, 2)
  assert.equal(g.speakTimes('123', t0 + 3600_001).length, 1, '刚过 1 小时的边界：最后那条还在窗口内')
  assert.equal(g.speakTimes('123', t0 + 3600_000 + 2000).length, 0, '两条都过窗口后清空')
  g.noteInterject('123', t0)
  assert.equal(g.interjectTimes('123', t0 + 500).length, 1)
  assert.equal(g.interjectTimes('456', t0 + 500).length, 0, '别的群独立')
})

test('话题加入：3 分钟窗口，加入/退出/说过话自动加入', () => {
  const g = createGroupState()
  const t0 = 10_000_000
  assert.equal(g.engagedUntil('123'), 0, '默认没加入')
  g.joinTopic('123', t0)
  assert.equal(g.engagedUntil('123'), t0 + ENGAGE_MS)
  g.leaveTopic('123')
  assert.equal(g.engagedUntil('123'), 0, '退出了')
  g.noteSpokeInGroup('123', t0)
  assert.equal(g.engagedUntil('123'), t0 + ENGAGE_MS, '说过话自动加入话题')
})

test('群成员缓存：10 分钟内命中缓存，过期返回 null，失败可退回旧缓存', () => {
  const g = createGroupState()
  const t0 = 10_000_000
  assert.equal(g.cachedMembers('123', 600_000, t0), null, '没缓存')
  g.setMembers('123', [{ user_id: 1 }], t0)
  assert.deepEqual(g.cachedMembers('123', 600_000, t0 + 599_000), [{ user_id: 1 }])
  assert.equal(g.cachedMembers('123', 600_000, t0 + 601_000), null, '过期')
  assert.deepEqual(g.staleMembers('123'), [{ user_id: 1 }], '拉取失败退回旧缓存')
})

test('群名：names 是活动的 Map（外部模块按 .get() 用，兼容旧接口）', () => {
  const g = createGroupState()
  g.setName('123', '测试群')
  assert.equal(g.name('123'), '测试群')
  assert.equal(g.names.get('123'), '测试群', '外部 hub.groupNames.get() 照旧能取')
})

// ---------------- 活动状态 ----------------
test('busy：标记/释放，超过 4 分钟自动算「已回完」（卡住保护）', () => {
  const a = createActivityState()
  const t0 = 10_000_000
  assert.equal(a.isBusy('c1', t0), false)
  a.markBusy('c1', t0)
  assert.equal(a.isBusy('c1', t0 + 1000), true)
  assert.equal(a.isBusy('c1', t0 + BUSY_MAX_MS + 1), false, '卡死超时自动放开')
  a.markBusy('c1', t0)
  a.release('c1')
  assert.equal(a.isBusy('c1', t0 + 1000), false, '正常释放')
})

test('typing：只对私聊、开关关着不显示、重复调用不叠计时器、能停下', async () => {
  const pings = []
  const a = createActivityState()
  const cfg = { enabled: true, dryRun: false }
  a.startTyping('k1', { kind: 'group', groupId: '1' }, cfg, (u) => pings.push(u))
  assert.equal(pings.length, 0, '群聊不显示正在输入')
  a.startTyping('k2', { kind: 'private', userId: '9' }, { enabled: false, dryRun: false }, (u) => pings.push(u))
  assert.equal(pings.length, 0, '总开关关着不显示')
  a.startTyping('k3', { kind: 'private', userId: '9' }, cfg, (u) => pings.push(u))
  assert.equal(pings.length, 1, '私聊立即 ping 一次')
  a.startTyping('k3', { kind: 'private', userId: '9' }, cfg, (u) => pings.push(u))
  assert.equal(pings.length, 1, '重复调用不叠计时器')
  assert.equal(a.size().typing, 1)
  a.stopTyping('k3')
  assert.equal(a.size().typing, 0, '停下后计时器清掉')
})
