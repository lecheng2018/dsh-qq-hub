// 抖音：认号 / 主页链接、推荐页判定、假驱动刷一轮、日上限、试运行、主人私信（只认 sec_uid）、#4 相关回归。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let util, duty, cdp, normalize, profilePermDefault, DOUYIN_PERM_KEYS, permOf

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-douyin-'))
  util = await import('../src/douyin/util.js')
  duty = await import('../src/douyin/duty.js')
  cdp = await import('../src/douyin/cdp.js')
  ;({ normalize } = await import('../src/core/config.js'))
  ;({ profilePermDefault, DOUYIN_PERM_KEYS, permOf } = await import('../src/chat/access.js'))
})

test('工具：认抖音号 / 主页链接 / 短链 / 视频链接', () => {
  assert.deepEqual(util.parseUserInput('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs'), { secUid: 'MS4wLjABAAAAabcdefghijklmnopqrs' })
  assert.deepEqual(util.parseUserInput('https://v.douyin.com/AbCdEf/'), { short: 'https://v.douyin.com/AbCdEf/' })
  assert.deepEqual(util.parseUserInput('@my.douyin_01'), { uniqueId: 'my.douyin_01' })
  assert.equal(util.parseUserInput(''), null)
  assert.deepEqual(util.findAwemeId('看这个 https://www.douyin.com/video/7123456789012345678'), { awemeId: '7123456789012345678' })
  assert.deepEqual(util.findAwemeId('https://v.douyin.com/xyz123/'), { short: 'https://v.douyin.com/xyz123/' })
  assert.ok(util.isRecommendUrl('https://www.douyin.com/?recommend=1'))
  assert.equal(util.isRecommendUrl('https://www.douyin.com/?tab=home'), false)
  assert.ok(util.sameAvatar('https://cdn/x/abc~tplv-xxx.jpeg', 'https://other/abc~c5_300x300.jpeg'))
  assert.equal(util.sameAvatar('https://cdn/a.jpg', 'https://cdn/b.jpg'), false)
  assert.ok(util.looksLikeVerify('请完成安全验证'))
  assert.ok(util.looksLimited('操作过于频繁，请稍后再试'))
})

test('配置：抖音总开关默认关；8 项权限默认仅主人；面板改不了 secUid', () => {
  const c = normalize({})
  assert.equal(c.douyin.enabled, false)
  assert.equal(c.douyin.caps.like, 30)
  assert.equal(c.douyin.caps.comment, 3)
  assert.equal(c.douyin.perRun, 5)
  for (const k of DOUYIN_PERM_KEYS) {
    assert.equal(profilePermDefault(k), 'owner')
    assert.equal(c.profilePerms[k], 'owner')
    assert.equal(permOf(c, k), 'owner')
  }
})

test('配置：mergeFromPanel 保留核对过的 secUid', async () => {
  const { mergeFromPanel } = await import('../src/core/config.js')
  const cur = normalize({ douyin: { owner: { input: 'aaa', secUid: 'SEC1', nickname: '主人', avatar: 'http://a', confirmedInput: 'aaa' } } })
  const next = mergeFromPanel(cur, { douyin: { owner: { input: 'bbb', secUid: 'HACK', nickname: '假的', avatar: 'x', confirmedInput: 'HACK' } } })
  assert.equal(next.douyin.owner.input, 'bbb') // 输入可以改
  assert.equal(next.douyin.owner.secUid, 'SEC1')
  assert.equal(next.douyin.owner.nickname, '主人')
  assert.equal(next.douyin.owner.confirmedInput, 'aaa') // 输入变了但 confirmed 仍是旧的 → ownerConfirmed 为假
  assert.equal(util.ownerConfirmed(next), false)
})

const feed = [
  { awemeId: '1001', author: '阿猫', authorSecUid: 'sec_cat', desc: '猫砂盆测评', likes: 1000, comments: 10, tags: ['猫'] },
  { awemeId: '1002', author: '阿狗', authorSecUid: 'sec_dog', desc: '狗狗跑步', likes: 2000, comments: 20, tags: ['狗'] },
  { awemeId: '1003', author: '阿鸟', authorSecUid: 'sec_bird', desc: '鹦鹉说话', likes: 500, comments: 5, tags: [] },
]

function fakes({ decisions, cfgOver = {}, script = {}, dryRun = false } = {}) {
  const events = []
  const facts = []
  const sent = []
  const drv = cdp.createFakeDriver({ feed: feed.map((x) => ({ ...x })), inbox: script.inbox || [], owner: script.owner || { secUid: 'owner_sec', nickname: '主人', avatar: 'https://x/a~tplv.jpg' }, ...script })
  if (script.commentReplies) drv._state.commentReplies = script.commentReplies
  const hub = {
    runSystemTurn: async (_n, _t, prompt) => {
      if (prompt.includes('看完说说你的想法')) return JSON.stringify(decisions)
      if (prompt.includes('私信给你') || prompt.includes('发的私信')) return script.dmReplyText || '收到啦'
      if (prompt.includes('回你的评论')) return script.replyText || '哈哈是呀'
      return ''
    },
    sendText: async (chatId, text) => sent.push({ chatId, text }),
    logChat: () => {},
  }
  const memory = {
    list: () => [],
    recentEvents: () => [],
    addEvent: (e) => events.push(e.text),
    add: (m) => facts.push(m.text),
  }
  const base = normalize({
    enabled: true, dryRun, ownerQQ: '10000001', ownerName: '主人',
    douyin: {
      enabled: true, perRun: 2, maxWatchPerDay: 30, maxRunsPerDay: 3, intervalHours: 4,
      dwellMin: 1, dwellMax: 1,
      caps: { like: 30, comment: 1, replyComment: 6, follow: 5, dm: 5, shareOwner: 3, dmReply: 20 },
      owner: { input: 'owner_id', secUid: 'owner_sec', nickname: '主人', avatar: 'https://x/a', confirmedInput: 'owner_id' },
      ...cfgOver,
    },
    profilePerms: Object.fromEntries(DOUYIN_PERM_KEYS.map((k) => [k, 'owner'])),
  })
  // 每个测试独立状态文件，避免互相污染
  const dataFile = join(process.env.AURABOT_DATA_DIR, `douyin-${Math.random().toString(16).slice(2)}.json`)
  const d = duty.createDouyin({
    getConfig: () => base,
    hub, memory,
    log: { info() {}, warn() {}, debug() {} },
    driver: drv,
    dataFile,
  })
  return { d, drv, events, facts, sent, cfg: base, dataFile }
}

test('刷一轮：看视频、按每天上限评论 / 点赞 / 关注，记成她的经历', async () => {
  const { d, drv, events } = fakes({ decisions: [
    { i: 1, feeling: '猫砂好用', like: true, comment: '学到了', follow: true, share: '', remember: '有个猫砂测评' },
    { i: 2, feeling: '狗好快', like: true, comment: '跑得好快', follow: false, share: '', remember: '' },
  ] })
  const r = await d.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.watched, 2)
  assert.equal(drv._state.liked.filter(Boolean).length, 2)
  assert.equal(drv._state.commented.length, 1, '每天最多 1 条评论')
  assert.equal(drv._state.commented[0], '学到了')
  assert.equal(drv._state.followed.length, 1)
  assert.ok(events.some((e) => e.includes('在抖音看了') && e.includes('阿猫')))
  assert.equal(d.state().comment, 1)
  assert.equal(d.state().like, 2)
  // 看过的不会再看
  const r2 = await d.run({ force: true })
  assert.equal(r2.ok, true)
  assert.equal(r2.watched, 1, '只剩第三条')
})

test('试运行：只记日志不真点', async () => {
  const { d, drv } = fakes({ dryRun: true, decisions: [
    { i: 1, feeling: '好', like: true, comment: '评一下', follow: true, share: '给你看', remember: '' },
  ] })
  const r = await d.run({ force: true })
  assert.equal(r.ok, true)
  assert.equal(drv._state.liked.filter(Boolean).length, 0)
  assert.equal(drv._state.commented.length, 0)
  assert.equal(drv._state.followed.length, 0)
  assert.equal(drv._state.shared.length, 0)
  assert.ok(d.state().like >= 1, '试运行也计次数')
})

test('分享给主人：要已核对 sec_uid；改了输入就不再认', async () => {
  const { d, drv } = fakes({ decisions: [
    { i: 1, feeling: '好玩', like: false, comment: '', follow: false, share: '主人看这个猫', remember: '' },
  ] })
  await d.run({ force: true })
  assert.deepEqual(drv._state.shared, ['owner_sec'])

  const { d: d2, drv: drv2 } = fakes({
    decisions: [{ i: 1, feeling: '好玩', like: false, comment: '', follow: false, share: '主人看', remember: '' }],
    cfgOver: { owner: { input: 'changed', secUid: 'owner_sec', nickname: '主人', avatar: 'https://x/a', confirmedInput: 'owner_id' } },
  })
  await d2.run({ force: true })
  assert.equal(drv2._state.shared.length, 0, '输入和核对时不一致 → 不分享')
})

test('回主人私信：只认 confirmed sec_uid；列表没 sec_uid 就不开', async () => {
  const { d, drv } = fakes({
    decisions: [],
    script: { inbox: [{ secUid: 'owner_sec', nickname: '主人', text: '在干嘛' }, { secUid: 'other', nickname: '路人', text: '嗨' }] },
  })
  const r = await d.checkOwnerDms()
  assert.equal(r.replied, 1)
  assert.deepEqual(drv._state.dms, ['owner_sec'])
  assert.ok(drv._state.commented.includes('收到啦') || drv._state.commented.length >= 1)

  const { d: d2 } = fakes({
    decisions: [],
    script: { inbox: [{ secUid: '', nickname: '？', text: '嗨' }] },
  })
  const r2 = await d2.checkOwnerDms()
  assert.equal(r2.ok, false)
  assert.match(r2.message, /认不出/)
})

test('#4 卡在精选：ensureRecommend 失败则本轮不刷', async () => {
  const { d } = fakes({ decisions: [], script: { stuckOnFeatured: true } })
  const r = await d.run({ force: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /推荐页|精选/)
  assert.equal(d.state().lastSkipReason.includes('推荐') || d.state().lastSkipReason.includes('精选'), true)
})

test('#4 计数立刻落盘：每个视频看完 watched 就 +1', async () => {
  const { d, dataFile } = fakes({ decisions: [
    { i: 1, feeling: '1', like: false, comment: '', follow: false, share: '', remember: '' },
    { i: 2, feeling: '2', like: false, comment: '', follow: false, share: '', remember: '' },
  ] })
  await d.run({ force: true })
  const { readFileSync } = await import('node:fs')
  const saved = JSON.parse(readFileSync(dataFile, 'utf8'))
  assert.equal(saved.watched, 2)
  assert.ok(saved.seen.includes('1001') && saved.seen.includes('1002'))
  assert.ok(saved.history.some((h) => h.kind === 'watch'))
})

test('#4 定时：nextDueAt 落盘；未到点 tick 不跑', async () => {
  const { d, cfg } = fakes({ decisions: [
    { i: 1, feeling: '好', like: false, comment: '', follow: false, share: '', remember: '' },
  ] })
  // 非 force 才会写 nextDueAt
  const r = await d.run({ force: false })
  assert.equal(r.ok, true)
  const st = d.state()
  assert.ok(st.nextDueAt > Date.now(), '下次应在未来')
  const runsBefore = st.runs
  // 把全局 enabled 打开、在醒着时间
  cfg.enabled = true
  cfg.douyin.enabled = true
  await d.tick()
  assert.equal(d.state().runs, runsBefore, '没到点不该再跑')
})

test('风控：验证码时暂停并通知主人', async () => {
  const { d, drv, sent } = fakes({ decisions: [
    { i: 1, feeling: '好', like: true, comment: '', follow: false, share: '', remember: '' },
  ] })
  // 点赞时触发验证
  const orig = drv.clickLike
  drv.clickLike = async () => { drv.markVerify('页面要验证'); throw new Error('请完成安全验证') }
  await d.run({ force: true })
  assert.ok(d.state().pauseReason)
  assert.ok(sent.some((x) => /验证|限制/.test(x.text)))
  drv.clickLike = orig
})

test('权限 off：browse 关掉后自动刷拒绝', async () => {
  const { d, cfg } = fakes({ decisions: [] })
  cfg.profilePerms.douyinBrowse = 'off'
  const r = await d.run({ force: false })
  assert.equal(r.ok, false)
  assert.match(r.message, /权限|关掉/)
})

test('主动私信工具：日上限', async () => {
  const { d, drv } = fakes({ decisions: [], cfgOver: { caps: { like: 0, comment: 0, replyComment: 0, follow: 0, dm: 1, shareOwner: 0, dmReply: 0 } } })
  const a = await d.dmTo('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs', '你好呀')
  assert.equal(a.ok, true, a.message)
  const b = await d.dmTo('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs', '第二句')
  assert.equal(b.ok, false)
  assert.match(b.message, /用完/)
  assert.equal(drv._state.dms.length, 1)
})

test('feed 整理：广告 / 直播丢掉', () => {
  assert.equal(util.normalizeAweme({ aweme_id: '1', is_ads: true }), null)
  assert.equal(util.normalizeAweme({ aweme_id: '2', cell_room: {} }), null)
  const v = util.normalizeAweme({ aweme_id: '3', desc: 'hi', author: { nickname: 'x', sec_uid: 's' }, statistics: { digg_count: 9 } })
  assert.equal(v.awemeId, '3')
  assert.equal(v.likes, 9)
  assert.deepEqual(util.awemesFromResponse({ aweme_list: [{ aweme_id: '3', desc: 'hi', author: {}, statistics: {} }] }).map((x) => x.awemeId), ['3'])
})
