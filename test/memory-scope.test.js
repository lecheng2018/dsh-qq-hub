import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// memory.js 用 dataDir() 决定落盘位置，先指到一个临时目录再动态 import
const dir = mkdtempSync(join(tmpdir(), 'ab-scope-'))
mkdirSync(join(dir, 'aurabot'), { recursive: true })
process.env.AURABOT_DATA_DIR = dir
process.env.DSH_PLUGIN_DATA = dir

const { createMemoryStore } = await import('../src/features/memory.js')

const cfg = {
  botQQ: '10001', ownerQQ: '10001', ownerName: '主人',
  memory: { enabled: true, recallCount: 8, dailyHour: 23, keepDays: 30, autoExtract: true },
}
const noop = () => {}
const store = createMemoryStore({
  dsh: { get: () => null },
  getConfig: () => cfg,
  hub: { ask: noop },
  log: { info: noop, warn: noop, debug: noop, error: noop },
})

const PRIVATE = { chatId: 'private:20002', kind: 'private', userId: '20002' }
const GROUP   = { chatId: 'group:30003',  kind: 'group',   groupId: '30003' }
const OTHER   = { chatId: 'private:40004', kind: 'private', userId: '40004' }

test('scopeOfChat：私聊/群/系统各自的作用域', () => {
  assert.equal(store.scopeOfChat(PRIVATE), 'private:20002')
  assert.equal(store.scopeOfChat(GROUP), 'group:30003')
  assert.equal(store.scopeOfChat({ kind: 'system' }), 'global')
  assert.equal(store.scopeOfChat(null), 'global')
})

test('scopeVisible：私聊记忆在群里不可见，在别的私聊也不可见', () => {
  assert.equal(store.scopeVisible('private:20002', PRIVATE), true)
  assert.equal(store.scopeVisible('private:20002', GROUP), false, '私聊记忆不该在群里可见')
  assert.equal(store.scopeVisible('private:20002', OTHER), false, '私聊记忆不该在别人私聊可见')
  assert.equal(store.scopeVisible('global', GROUP), true, 'global 哪里都可见')
  // 这一条以前断言 true（「老数据没 scope 当 global」），正是跨群泄漏的主因：
  // 无 scope 的老数据如果一律放行，任何陌生群都能查到历史上所有私聊记忆。
  assert.equal(store.scopeVisible(undefined, GROUP), false, '老数据没 scope：不当 global 放行，宁可少给')
  assert.equal(store.scopeVisible('', PRIVATE), false, '空 scope 同样不跨聊天可见')
  assert.equal(store.scopeVisible('   ', GROUP), false, '空白 scope 也算没有作用域')
})

test('端到端：私聊记住猫名，群里检索不到、私聊能检索到', () => {
  store.add({ text: '主人的猫叫粥粥', about: '20002', aboutName: '主人', importance: 0.9,
              source: 'tool', chatId: PRIVATE.chatId, scope: store.scopeOfChat(PRIVATE) })

  // 私聊：能想起来
  const inPrivate = store.recall('猫叫什么', { about: '20002', chat: PRIVATE })
  assert.ok(inPrivate.some((h) => h.it.text.includes('粥粥')), '私聊应该能想起粥粥')

  // 群聊：必须检索不到（这是记忆隔离的核心）
  const inGroup = store.recall('猫叫什么', { chat: GROUP })
  assert.ok(!inGroup.some((h) => h.it.text.includes('粥粥')), '群里不该检索到私聊的记忆')

  // 别的私聊：也检索不到
  const inOther = store.recall('猫叫什么', { chat: OTHER })
  assert.ok(!inOther.some((h) => h.it.text.includes('粥粥')), '别人的私聊不该检索到')
})

test('recallHint 也走作用域（模型拿不到群里被过滤的内容）', () => {
  const hintPrivate = store.recallHint(PRIVATE, '猫叫什么', '')
  const hintGroup = store.recallHint(GROUP, '猫叫什么', '')
  assert.ok(hintPrivate.includes('粥粥'), '私聊提示词里应该有粥粥')
  assert.ok(!hintGroup.includes('粥粥'), '群聊提示词里绝不能出现粥粥')
})

test('群里记的事不会漏到私聊', () => {
  store.add({ text: '这个群周末要聚餐', about: '', importance: 0.7,
              source: 'tool', chatId: GROUP.chatId, scope: store.scopeOfChat(GROUP) })
  assert.ok(store.recall('聚餐', { chat: GROUP }).some((h) => h.it.text.includes('聚餐')), '群里能想起')
  assert.ok(!store.recall('聚餐', { chat: PRIVATE }).some((h) => h.it.text.includes('聚餐')), '私聊不该想起群里的')
})

test('global 记忆哪里都能用', () => {
  store.add({ text: '我叫大肥鱼', importance: 0.9, source: 'tool', scope: 'global' })
  assert.ok(store.recall('大肥鱼', { chat: GROUP }).length > 0, '群里能想起 global')
  assert.ok(store.recall('大肥鱼', { chat: PRIVATE }).length > 0, '私聊能想起 global')
})

// ---------- 回归：之前漏掉的泄漏路径（addEvent / contextFor / recentEvents） ----------
// 这一组对应真实事故：陌生群 333444555 问出「主人平时几点睡」「主人有什么喜好」。
// 以前的 recall() 会按 chat 过滤，但 addEvent 落库时没传 scope（写成 global），
// contextFor / recallHint 里的 recentEvents() 又不带 chat 过滤，于是从另一条路漏了出去。

test('addEvent 不再把经历写成 global：传了 chat 就落到那个聊天', () => {
  store.addEvent({ text: '在私聊里给主人发了张猫图', about: '20002', tags: ['画画'], importance: 0.5, chat: PRIVATE })
  const row = store.list().find((m) => m.text.includes('猫图'))
  assert.ok(row, '经历应该写进去了')
  assert.equal(row.scope, 'private:20002', '带 chat 的经历必须落到那个私聊，不能是 global')
})

test('私聊里的经历不会出现在陌生群的上下文里（contextFor）', () => {
  store.addEvent({ text: '给主人唱了《稻香》', about: '20002', tags: ['唱歌'], importance: 0.5, chat: PRIVATE })
  const inGroup = store.contextFor({ chatId: 'group:99999', kind: 'group', groupId: '99999' }, 's-leak-1')
  assert.ok(!inGroup.includes('稻香'), '陌生群的上下文里绝不能出现私聊的经历：' + inGroup)
  const inPrivate = store.contextFor(PRIVATE, 's-leak-2')
  assert.ok(inPrivate.includes('稻香'), '本人在私聊里应该想得起这件事：' + inPrivate)
})

test('私聊里的经历不会出现在陌生群的 recallHint 里', () => {
  const hint = store.recallHint({ chatId: 'group:99999', kind: 'group', groupId: '99999' }, '你最近做了什么', '')
  assert.ok(!hint.includes('稻香'), '陌生群提示词里不该有：' + hint)
})

test('recentEvents 带 chat 时按作用域过滤，不带时保持老行为', () => {
  const strangerRecent = store.recentEvents(24, 20, { chatId: 'group:99999', kind: 'group', groupId: '99999' })
  assert.ok(!strangerRecent.some((m) => m.text.includes('稻香')), '陌生群看不到私聊经历')
  const ownRecent = store.recentEvents(24, 20, PRIVATE)
  assert.ok(ownRecent.some((m) => m.text.includes('稻香')), '本人私聊能看得到')
  // 老调用（不传 chat）不过滤，保持向后兼容
  assert.ok(store.recentEvents(24, 20).some((m) => m.text.includes('稻香')), '不传 chat 时保持老行为')
})

test('经历默认落主人私聊，不是 global（B站/抖音这类兴趣画像不外泄）', () => {
  store.addEvent({ text: '在B站看了《猫猫合集》', tags: ['B站'], importance: 0.4 })
  const row = store.list().find((m) => m.text.includes('猫猫合集'))
  assert.ok(row, '经历应该写进去了')
  assert.equal(row.scope, `private:${cfg.ownerQQ}`, '没传 scope 的经历必须落主人私聊，不能是 global')
})

test('群聊不注入任何经历（连 global 也不给谈资）', () => {
  store.addEvent({ text: '她在B站看了公开的《测试视频》', tags: ['B站'], importance: 0.4, scope: 'global' })
  const group = { chatId: 'group:99999', kind: 'group', groupId: '99999' }
  assert.deepEqual(store.recentEvents(24, 20, group), [], '群聊里 recentEvents 应恒为空')
  const ctx = store.contextFor(group, 's-norecent')
  assert.ok(!ctx.includes('测试视频'), '群聊上下文里不该出现任何经历：' + ctx)
  assert.ok(!ctx.includes('猫猫合集'), '群里更不能出现主人的兴趣：' + ctx)
})

test('主人私聊里仍然能看到自己的经历（global 和私聊的都给）', () => {
  // 注意：cfg.ownerQQ 是 10001，默认兜底落 private:10001，所以这里用主人私聊来看
  const OWNER = { chatId: `private:${cfg.ownerQQ}`, kind: 'private', userId: String(cfg.ownerQQ) }
  const recent = store.recentEvents(24, 20, OWNER)
  assert.ok(recent.some((m) => m.text.includes('猫猫合集')), '主人私聊能看到自己的经历')
  assert.ok(recent.some((m) => m.text.includes('测试视频')), '主人私聊也能看到 global 经历')
  // 别人的私聊看不到主人的经历
  const other = store.recentEvents(24, 20, OTHER)
  assert.ok(!other.some((m) => m.text.includes('猫猫合集')), '别人的私聊看不到主人的经历')
})

// ---------- /new：清当前聊天的记忆 ----------

test('clearScope 只清当前聊天，别的私聊和 global 不动', () => {
  const owner = { chatId: `private:${cfg.ownerQQ}`, kind: 'private', userId: String(cfg.ownerQQ) }
  const other = { chatId: 'private:40004', kind: 'private', userId: '40004' }

  store.add({ text: '主人的猫叫粥粥', about: String(cfg.ownerQQ), importance: 0.8, source: 'tool', chatId: owner.chatId, scope: store.scopeOfChat(owner) })
  store.add({ text: '别人的狗叫豆豆', about: '40004', importance: 0.8, source: 'tool', chatId: other.chatId, scope: store.scopeOfChat(other) })
  store.add({ text: '我叫大肥鱼', importance: 0.9, source: 'tool', scope: 'global' })

  const r = store.clearScope(owner)
  assert.ok(r.items >= 1, '应该清掉了主人的条目，实际清了 ' + r.items)

  assert.equal(store.recall('猫叫什么', { chat: owner }).length, 0, '主人的记忆清空了')
  assert.ok(store.recall('狗叫什么', { chat: other }).some((h) => h.it.text.includes('豆豆')), '别人的记忆不能跟着没')
  assert.ok(store.recall('大肥鱼', { chat: owner }).length > 0, 'global 记忆（她自己的设定）必须保留')
})

test('clearScope 连小组档案、相处经验、说话方式一起清（否则清了还在按旧印象说话）', () => {
  const owner = { chatId: `private:${cfg.ownerQQ}`, kind: 'private', userId: String(cfg.ownerQQ) }
  const key = `qq:${cfg.ownerQQ}`
  store.setProfile(String(cfg.ownerQQ), '他最近在戒辣', '', store.scopeOfChat(owner))
  store.setInsights(key, ['他喜欢被吐槽'])
  store.setStyle(key, ['爱用 hhh'])

  const r = store.clearScope(owner)
  assert.ok(r.profile >= 1, '小档案应该被清了')
  assert.ok(r.insights >= 1, '相处经验应该被清了')
  assert.ok(r.style >= 1, '说话方式应该被清了')
  assert.equal(store.insights().find((x) => x.key === key), undefined, '相处经验确实没了')
  assert.equal(store.styles()[key], undefined, '说话方式确实没了')
})

test('clearScope 对群聊只清那个群', () => {
  const g1 = { chatId: 'group:30003', kind: 'group', groupId: '30003' }
  const g2 = { chatId: 'group:50005', kind: 'group', groupId: '50005' }
  store.add({ text: '一群周末聚餐', importance: 0.7, source: 'tool', chatId: g1.chatId, scope: store.scopeOfChat(g1) })
  store.add({ text: '二群下周开黑', importance: 0.7, source: 'tool', chatId: g2.chatId, scope: store.scopeOfChat(g2) })

  store.clearScope(g1)
  assert.equal(store.recall('聚餐', { chat: g1 }).length, 0, '一群的记忆清掉了')
  assert.ok(store.recall('开黑', { chat: g2 }).some((h) => h.it.text.includes('开黑')), '二群的记忆不受影响')
})

// ---------- 越权读取：索引本身按作用域构建 ----------
// 这一组对应真实事故的直接推力：陌生群提到主人私聊里出现过的词，
// 她的「话题相关度」被抬高，于是主动开口，开口内容来自私聊记忆。

test('topicScore 只在当前聊天可见的记忆里算（陌生群拿不到主人私聊的话题）', () => {
  store.add({ text: '主人在折腾 NAS 自建影音库和 Docker 部署', about: String(cfg.ownerQQ), importance: 0.9,
              source: 'tool', chatId: PRIVATE.chatId, scope: store.scopeOfChat(PRIVATE) })
  const stranger = { chatId: 'group:333444555', kind: 'group', groupId: '333444555' }
  assert.equal(store.topicScore('你们有玩 NAS 的吗', stranger), 0, '陌生群不该因为主人私聊的记忆而「感兴趣」')
  assert.equal(store.topicScore('Docker 怎么部署', stranger), 0, '同上，Docker 也不行')
  assert.ok(store.topicScore('NAS', PRIVATE) > 0, '主人私聊里应该算得出相关度')
})

test('topicScore 不传 chat 时 fail-closed 返回 0', () => {
  assert.equal(store.topicScore('NAS'), 0, '不知道在哪个聊天，就当不相关')
  assert.equal(store.topicScore('NAS', null), 0, '显式 null 同样为 0')
})

test('索引按作用域隔离：别的私聊的记忆搜不出来', () => {
  const other = { chatId: 'private:40004', kind: 'private', userId: '40004' }
  assert.equal(store.topicScore('NAS', other), 0, '别人的私聊也不该命中主人的记忆')
})

test('contextFor 群聊不拼 global 小档案（不把主人画像搬进陌生群）', () => {
  store.setProfile(String(cfg.ownerQQ), '他做跨境电商，熬夜，爱看猫狗', '', 'global')
  const group = { chatId: 'group:333444555', kind: 'group', groupId: '333444555' }
  const ctx = store.contextFor(group, 's-prof')
  assert.ok(!ctx.includes('跨境电商') && !ctx.includes('熬夜'), '群聊上下文里不该出现 global 档案：' + ctx)
})

test('relatedTo 不把别处的记忆当成已知事实喂给归纳模型', () => {
  const stranger = { chatId: 'group:333444555', kind: 'group', groupId: '333444555' }
  const rel = store.relatedTo(stranger.chatId, '大家在聊 NAS 和 Docker 怎么玩')
  assert.ok(!rel.some((m) => String(m.text).includes('NAS')), '提炼陌生群聊天时不该看到主人私聊的记忆')
})

// ---------- 老数据迁移后的行为 ----------
// 对应 scripts/fix-memory-scope.mjs：线上曾有一批 chatId 全空、无 scope 的老记忆。
// 新代码对「无 scope」一律不可见，所以迁移必须给它们落一个明确作用域，
// 否则这批记忆会静默消失（不报错，就是没了）。

test('迁移后：来源不明的老记忆落在主人私聊，群里看不到', () => {
  const stranger = { chatId: 'group:888888888', kind: 'group', groupId: '888888888' }
  // 迁移脚本把无来源条目兜底到 private:<主人QQ>（这里是 cfg.ownerQQ = 10001）
  const owner = { chatId: 'private:' + cfg.ownerQQ, kind: 'private', userId: String(cfg.ownerQQ) }
  store.add({ text: '迁移兜底的主人私事样例', about: String(cfg.ownerQQ), importance: 0.9,
              source: 'auto', chatId: '', scope: `private:${cfg.ownerQQ}` })
  assert.ok(store.recall('兜底', { chat: owner }).length > 0, '迁移后主人私聊还认得这条')
  assert.equal(store.recall('兜底', { chat: stranger }).length, 0, '陌生群拿不到')
  assert.ok(!store.contextFor(stranger, 'sx2').includes('兜底'), '陌生群上下文里也没有')
})

test('无 scope 的老记忆不会出现在任何作用域索引里（迁移必须跑的原因）', async () => {
  // 用独立目录，避免污染本文件共享的记忆库
  const { mkdtempSync: mk, writeFileSync } = await import('node:fs')
  const alone = mk(join(tmpdir(), 'ab-noscope-'))
  writeFileSync(join(alone, 'memories.json'), JSON.stringify({
    items: [{ id: 'raw01', text: '没人认领的老记忆', importance: 0.9, source: 'auto', chatId: '', at: Date.now() }],
  }), 'utf8')
  const prev = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = alone
  const s3 = createMemoryStore({ dsh: { get: () => null }, getConfig: () => cfg,
    hub: { ask: noop, speakersOf: () => [] }, log: { info: noop, warn: noop, debug: noop, error: noop } })
  try {
    const own = { chatId: 'private:' + cfg.ownerQQ, kind: 'private', userId: String(cfg.ownerQQ) }
    assert.ok(!s3.indexFor(own).docs.some((x) => x.it.id === 'raw01'), '主人私聊的索引里也不该有它')
    assert.ok(!s3.indexFor('global').docs.some((x) => x.it.id === 'raw01'), 'global 索引里也不该有它')
  } finally {
    if (prev === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prev
  }
})

test('relatedTo 不会因聊天里出现某人 QQ 就捞出别的作用域的记忆', () => {
  // 真实场景：陌生群里有人提到主人的 QQ，提炼时不能把主人私聊的记忆当已知事实
  store.add({ text: '审计用隐私样例：猫叫粥粥', about: String(cfg.ownerQQ), importance: 0.9,
              source: 'tool', chatId: 'private:' + cfg.ownerQQ, scope: 'private:' + cfg.ownerQQ })
  const stranger = 'group:333444555'
  const rel = store.relatedTo(stranger, `(${cfg.ownerQQ}) 刚才说他在忙`)
  assert.ok(!rel.some((m) => String(m.text).includes('粥粥')), '陌生群不该捞到主人私聊的记忆：' + JSON.stringify(rel))
  // 主人私聊自己提炼时应该能看到
  const own = store.relatedTo('private:' + cfg.ownerQQ, `(${cfg.ownerQQ}) 我在忙`)
  assert.ok(own.some((m) => String(m.text).includes('粥粥')), '主人私聊自己提炼时应该看得到')
})

// ---------- P0-1：后台任务（heybox / pet / purpose）不许拿到别的私聊的记忆 ----------
// 后台任务没有 chat 概念，以前走 list('')/recall 无 chat = 全库索引，会把别的私聊的记忆拼进 prompt。
// 现在 recall 增加 scopes 参数：后台调用必须显式声明可见域，没声明一律不给（fail-closed）。
test('P0-1：recall 无 chat 无 scopes 时什么都不给（fail-closed）', () => {
  store.add({ text: '病人甲的小黑盒偏好是射击类', about: '30000003', importance: 0.8,
              source: 'tool', chatId: 'private:30000003', scope: 'private:30000003' })
  const leaked = store.recall('小黑盒 偏好', { limit: 6 })
  assert.equal(leaked.length, 0, '没声明可见域的后台调用不能拿到全库')
})

test('P0-1：scopes 显式声明 global+主人私聊 后，只拿到这两个域', () => {
  const got = store.recall('小黑盒 偏好', { limit: 6, scopes: ['global', 'private:10001'] })
  assert.ok(!got.some((h) => h.it.text.includes('射击类')), '别的私聊的记忆不许出现')
  store.add({ text: '主人喜欢射击类小游戏', about: '10001', importance: 0.8,
              source: 'tool', chatId: 'private:10001', scope: 'private:10001' })
  const ok = store.recall('射击类', { limit: 6, scopes: ['global', 'private:10001'] })
  assert.ok(ok.some((h) => h.it.text.includes('射击类')), '主人私聊域自己的记忆应该能拿到')
})

// ---------- P0-2：档案重写不许跨作用域 ----------
test('P0-2：buildProfile 不带 scope 直接拒绝（fail-closed）', async () => {
  await assert.rejects(
    () => store.buildProfile('10001', ''),
    /作用域/,
    '空 scope 必须拒绝，不能退化成全库写 global'
  )
})
