// 抖音：认号 / 主页链接、推荐页判定、假驱动刷一轮、日上限、试运行不计次、写操作总闸、主人私信（只认 sec_uid）、#4 相关回归。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
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

test('配置：抖音总开关默认关；权限默认仅主人；写闸默认；改资料日上限；面板改不了 secUid', () => {
  const c = normalize({})
  assert.equal(c.douyin.enabled, false)
  assert.equal(c.douyin.caps.like, 30)
  assert.equal(c.douyin.caps.comment, 3)
  assert.equal(c.douyin.caps.sign, 2)
  assert.equal(c.douyin.caps.nickname, 2)
  assert.equal(c.douyin.caps.avatar, 1)
  assert.equal(c.douyin.perRun, 5)
  assert.equal(c.douyin.gate.maxWritesPerDay, 60)
  assert.equal(c.douyin.gate.minWriteGapSec, 20)
  assert.equal(c.douyin.gate.newAccountDays, 3)
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
  assert.equal(next.douyin.owner.input, 'bbb')
  assert.equal(next.douyin.owner.secUid, 'SEC1')
  assert.equal(next.douyin.owner.nickname, '主人')
  assert.equal(next.douyin.owner.confirmedInput, 'aaa')
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
  const drv = cdp.createFakeDriver({ feed: feed.map((x) => ({ ...x })), inbox: script.inbox || [], owner: script.owner || { secUid: 'owner_sec', nickname: '主人', avatar: 'https://x/a~tplv.jpg' }, commentReplies: script.commentReplies || [], ...script })
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
      dwellMin: 8, dwellMax: 40, // 真机用；假驱动跳过 sleep
      caps: { like: 30, comment: 1, replyComment: 6, follow: 5, dm: 5, shareOwner: 3, dmReply: 20 },
      gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 3 }, // 测里关掉间隔
      owner: { input: 'owner_id', secUid: 'owner_sec', nickname: '主人', avatar: 'https://x/a', confirmedInput: 'owner_id' },
      ...cfgOver,
    },
    profilePerms: Object.fromEntries(DOUYIN_PERM_KEYS.map((k) => [k, 'owner'])),
  })
  if (cfgOver.gate) base.douyin.gate = { ...base.douyin.gate, ...cfgOver.gate }
  if (cfgOver.caps) base.douyin.caps = { ...base.douyin.caps, ...cfgOver.caps }
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

test('刷一轮：看视频、按每天上限评论 / 点赞（关注不在刷流），记成她的经历', async () => {
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
  assert.equal(drv._state.followed.length, 0, '刷流不自动关注')
  assert.ok(events.some((e) => e.includes('在抖音看了') && e.includes('阿猫')))
  assert.equal(d.state().comment, 1)
  assert.equal(d.state().like, 2)
  const r2 = await d.run({ force: true })
  assert.equal(r2.ok, true)
  assert.equal(r2.watched, 1, '只剩第三条')
})

test('试运行：只记日志不真点，且不占真实日上限', async () => {
  const { d, drv } = fakes({ dryRun: true, decisions: [
    { i: 1, feeling: '好', like: true, comment: '评一下', follow: true, share: '给你看', remember: '' },
  ] })
  const r = await d.run({ force: true })
  assert.equal(r.ok, true)
  assert.equal(drv._state.liked.filter(Boolean).length, 0)
  assert.equal(drv._state.commented.length, 0)
  assert.equal(drv._state.followed.length, 0)
  assert.equal(drv._state.shared.length, 0)
  assert.equal(d.state().like, 0, '试运行不占 like 计数')
  assert.equal(d.state().comment, 0, '试运行不占 comment 计数')
  assert.equal(d.state().shareOwner, 0)
  assert.equal(d.state().writes, 0, '试运行不占写操作总闸')
})

test('分享给主人：要已核对 sec_uid；改了输入就不再认；openShareTo 必须选中才 ok', async () => {
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

  const sh = await drv.openShareTo('')
  assert.equal(sh.ok, false, '没 sec_uid 不能算分享成功')
})

test('回主人私信：只认 confirmed sec_uid；列表没 sec_uid 就不开；超过 30 分钟不理', async () => {
  const now = Date.now()
  const { d, drv } = fakes({
    decisions: [],
    script: { inbox: [
      { secUid: 'owner_sec', nickname: '主人', text: '在干嘛', at: now },
      { secUid: 'other', nickname: '路人', text: '嗨', at: now },
    ] },
  })
  const r = await d.checkOwnerDms()
  assert.equal(r.replied, 1)
  assert.deepEqual(drv._state.dms, ['owner_sec'])
  assert.ok(drv._state.commented.includes('收到啦') || drv._state.commented.length >= 1)

  const { d: d2 } = fakes({
    decisions: [],
    script: { inbox: [{ secUid: '', nickname: '？', text: '嗨', at: now }] },
  })
  const r2 = await d2.checkOwnerDms()
  assert.equal(r2.ok, false)
  assert.match(r2.message, /认不出/)

  const { d: d3, drv: drv3 } = fakes({
    decisions: [],
    script: { inbox: [{ secUid: 'owner_sec', nickname: '主人', text: '很久以前', at: now - 40 * 60_000 }] },
  })
  const r3 = await d3.checkOwnerDms()
  assert.equal(r3.replied, 0, '超过 30 分钟的私信不理')
  assert.equal(drv3._state.dms.length, 0)
})

test('回主人私信：连续 3 条后若主人没新话就停', async () => {
  const now = Date.now()
  const inbox = [
    { secUid: 'owner_sec', nickname: '主人', text: '一', at: now },
    { secUid: 'owner_sec', nickname: '主人', text: '二', at: now },
    { secUid: 'owner_sec', nickname: '主人', text: '三', at: now },
    { secUid: 'owner_sec', nickname: '主人', text: '四', at: now },
  ]
  const { d } = fakes({ decisions: [], script: { inbox } })
  const r = await d.checkOwnerDms()
  assert.equal(r.replied, 3, '最多连回 3 条')
  assert.equal(d.state().dmReply, 3)
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
  const r = await d.run({ force: false })
  assert.equal(r.ok, true)
  const st = d.state()
  assert.ok(st.nextDueAt > Date.now(), '下次应在未来')
  const runsBefore = st.runs
  cfg.enabled = true
  cfg.douyin.enabled = true
  await d.tick()
  assert.equal(d.state().runs, runsBefore, '没到点不该再跑')
})

test('风控：验证码时暂停全部写操作并只通知主人一次', async () => {
  const { d, drv, sent } = fakes({ decisions: [
    { i: 1, feeling: '好', like: true, comment: '', follow: false, share: '', remember: '' },
  ] })
  const orig = drv.clickLike
  drv.clickLike = async () => { drv.markVerify('页面要验证'); throw new Error('请完成安全验证') }
  await d.run({ force: true })
  assert.ok(d.state().pauseReason)
  assert.ok(sent.some((x) => /验证|限制/.test(x.text)))
  // 再触发一次不应重复通知
  const n = sent.length
  drv.clickLike = orig
  await d.run({ force: true })
  assert.ok(d.state().pauseReason)
  assert.equal(sent.length, n, '验证码只通知一次')
})

test('权限 off：browse 关掉后自动刷拒绝', async () => {
  const { d, cfg } = fakes({ decisions: [] })
  cfg.profilePerms.douyinBrowse = 'off'
  const r = await d.run({ force: false })
  assert.equal(r.ok, false)
  assert.match(r.message, /权限|关掉/)
})

test('主动私信：每人每天最多 1 条；日上限仍生效', async () => {
  const { d, drv } = fakes({ decisions: [], cfgOver: { caps: { like: 0, comment: 0, replyComment: 0, follow: 0, dm: 5, shareOwner: 0, dmReply: 0 } } })
  const a = await d.dmTo('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs', '你好呀')
  assert.equal(a.ok, true, a.message)
  const b = await d.dmTo('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs', '第二句')
  assert.equal(b.ok, false)
  assert.match(b.message, /每人每天|已经给这个人/)
  assert.equal(drv._state.dms.length, 1)
})

test('关注工具：刷流不关注，douyin_follow 才关注', async () => {
  const { d, drv } = fakes({ decisions: [] })
  const r = await d.followUser('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs')
  assert.equal(r.ok, true, r.message)
  assert.equal(d.state().follow, 1)
  assert.ok(drv._state.followed.length >= 1 || drv._state.log.some((x) => x[0] === 'nav'))
})

test('回评论：走 listCommentReplies，不是只读 _state.commentReplies', async () => {
  const { d, drv } = fakes({
    decisions: [],
    script: { commentReplies: [{ id: 'r1', name: '路人甲', text: '哈哈哈', awemeId: '1001' }] },
  })
  // 确认假驱动暴露的是方法
  assert.equal(typeof drv.listCommentReplies, 'function')
  const r = await d.checkCommentReplies()
  assert.equal(r.replied, 1)
  assert.ok(drv._state.commented.includes('哈哈是呀'))
})

test('写操作总闸：总次数上限；连续失败 3 次禁用该 op', async () => {
  const { d, drv } = fakes({
    decisions: [],
    cfgOver: { caps: { like: 30, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0 }, gate: { maxWritesPerDay: 2, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  // 用 likeVideo 两次占满总闸
  drv._state.feed = feed.map((x) => ({ ...x }))
  // like via run
  const { d: d2, drv: drv2 } = fakes({
    decisions: [
      { i: 1, feeling: 'a', like: true, comment: '', follow: false, share: '', remember: '' },
      { i: 2, feeling: 'b', like: true, comment: '', follow: false, share: '', remember: '' },
    ],
    cfgOver: { perRun: 2, caps: { like: 30, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0 }, gate: { maxWritesPerDay: 1, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  await d2.run({ force: true })
  assert.equal(d2.state().like, 1, '总闸 1 时第二条点赞不该成功')
  assert.equal(d2.state().writes, 1)

  // 连续失败禁用
  let fails = 0
  const { d: d3, drv: drv3 } = fakes({
    decisions: [{ i: 1, feeling: 'x', like: true, comment: '', follow: false, share: '', remember: '' }],
    cfgOver: { perRun: 1, gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  drv3.clickLike = async () => { fails++; throw new Error('点赞按钮丢了') }
  // 需要多轮触发 3 次失败：每轮 perRun=1，feed 重置不了 cursor——换 followUser
  const { d: d4, drv: drv4 } = fakes({ decisions: [], cfgOver: { gate: { minWriteGapSec: 0, newAccountDays: 0 } } })
  drv4.clickFollow = async () => { throw new Error('找不到关注按钮') }
  for (let i = 0; i < 3; i++) {
    const rr = await d4.followUser('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs')
    assert.equal(rr.ok, false)
  }
  const r4 = await d4.followUser('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs')
  assert.equal(r4.ok, false)
  assert.match(r4.message, /连续失败|停了/)
})

test('写操作间隔：minWriteGapSec 内第二次写被拒', async () => {
  let t = 1_700_000_000_000
  const events = []
  const sent = []
  const drv = cdp.createFakeDriver({ feed: feed.map((x) => ({ ...x })) })
  const base = normalize({
    enabled: true, dryRun: false, ownerQQ: '10000001', ownerName: '主人',
    douyin: {
      enabled: true, perRun: 1, maxWatchPerDay: 30, maxRunsPerDay: 3, intervalHours: 4,
      dwellMin: 8, dwellMax: 40,
      caps: { like: 30, comment: 0, replyComment: 0, follow: 5, dm: 0, shareOwner: 0, dmReply: 0 },
      gate: { maxWritesPerDay: 60, minWriteGapSec: 20, newAccountDays: 0 },
      owner: { input: 'owner_id', secUid: 'owner_sec', nickname: '主人', avatar: 'https://x/a', confirmedInput: 'owner_id' },
    },
    profilePerms: Object.fromEntries(DOUYIN_PERM_KEYS.map((k) => [k, 'owner'])),
  })
  const dataFile = join(process.env.AURABOT_DATA_DIR, `douyin-gap-${Math.random().toString(16).slice(2)}.json`)
  const d = duty.createDouyin({
    getConfig: () => base,
    hub: { runSystemTurn: async () => '', sendText: async (c, t) => sent.push({ c, t }), logChat() {} },
    memory: { list: () => [], recentEvents: () => [], addEvent: (e) => events.push(e.text), add() {} },
    log: { info() {}, warn() {}, debug() {} },
    driver: drv,
    dataFile,
    now: () => t,
  })
  const a = await d.followUser('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs')
  assert.equal(a.ok, true, a.message)
  t += 5_000 // 只过 5 秒
  const b = await d.followUser('https://www.douyin.com/user/MS4wLjABAAAAzzzzzzzzzzzzzzzzz')
  assert.equal(b.ok, false)
  assert.match(b.message, /再等|写太勤/)
  t += 20_000
  const c = await d.followUser('https://www.douyin.com/user/MS4wLjABAAAAzzzzzzzzzzzzzzzzz')
  assert.equal(c.ok, true, c.message)
})

test('feed 整理：广告 / 直播丢掉', () => {
  assert.equal(util.normalizeAweme({ aweme_id: '1', is_ads: true }), null)
  assert.equal(util.normalizeAweme({ aweme_id: '2', cell_room: {} }), null)
  const v = util.normalizeAweme({ aweme_id: '3', desc: 'hi', author: { nickname: 'x', sec_uid: 's' }, statistics: { digg_count: 9 } })
  assert.equal(v.awemeId, '3')
  assert.equal(v.likes, 9)
  assert.deepEqual(util.awemesFromResponse({ aweme_list: [{ aweme_id: '3', desc: 'hi', author: {}, statistics: {} }] }).map((x) => x.awemeId), ['3'])
})

test('过滤器：昵称 / 签名拒链接、手机、广告、超长', () => {
  assert.equal(util.filterNickname('肥鱼').ok, true)
  assert.equal(util.filterNickname('').ok, false)
  assert.equal(util.filterNickname('https://x.com').ok, false)
  assert.equal(util.filterNickname('加微信领券').ok, false)
  assert.equal(util.filterNickname('1'.repeat(21)).ok, false)
  assert.equal(util.filterSignature('今天心情好').ok, true)
  assert.equal(util.filterSignature('加v私聊').ok, false)
  assert.equal(util.filterSignature('a'.repeat(101)).ok, false)
})

test('头像来源：last / http / 白名单本地；域外本地拒', () => {
  const root = process.env.AURABOT_DATA_DIR
  const inside = join(root, 'pic.png')
  assert.equal(util.resolveAvatarSource('last', '').ok, false)
  assert.equal(util.resolveAvatarSource('last', 'https://cdn/a.jpg').url, 'https://cdn/a.jpg')
  assert.equal(util.resolveAvatarSource('https://cdn/b.png', '').url, 'https://cdn/b.png')
  assert.equal(util.resolveAvatarSource(inside, '', [root]).path, inside)
  assert.equal(util.resolveAvatarSource('/tmp/evil.png', '', [root]).ok, false)
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(util.sniffImageType(png), 'image/png')
})

test('改签名 / 昵称：过写闸、日上限、同日重复拒、试运行不计次', async () => {
  const { d, drv, events, cfg } = fakes({
    decisions: [],
    cfgOver: { caps: { like: 0, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0, sign: 2, nickname: 2, avatar: 1 }, gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  const a = await d.setSign('今天开心')
  assert.equal(a.ok, true, a.message)
  assert.equal(drv._state.signature, '今天开心')
  assert.ok(events.some((t) => t.includes('签名')))
  const dup = await d.setSign('今天开心')
  assert.equal(dup.ok, false)
  assert.match(dup.message, /已经改成/)
  const b = await d.setSign('换一句')
  assert.equal(b.ok, true, b.message)
  const c = await d.setSign('第三句')
  assert.equal(c.ok, false)
  assert.match(c.message, /用完|次数/)

  const n1 = await d.setNickname('小肥鱼')
  assert.equal(n1.ok, true, n1.message)
  assert.equal(drv._state.self.nickname, '小肥鱼')
  const n2 = await d.setNickname('小肥鱼')
  assert.equal(n2.ok, false)
  const n3 = await d.setNickname('大肥鱼')
  assert.equal(n3.ok, true, n3.message)
  const n4 = await d.setNickname('超肥鱼')
  assert.equal(n4.ok, false)

  // dryRun 不计次
  const { d: d2, drv: drv2 } = fakes({
    decisions: [], dryRun: true,
    cfgOver: { caps: { sign: 1, nickname: 1, avatar: 1, like: 0, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0 }, gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  const dry = await d2.setSign('试运行签名')
  assert.equal(dry.ok, true)
  assert.match(dry.message, /试运行/)
  assert.equal(drv2._state.signature, '')
  const st = d2.state()
  assert.equal(st.sign, 0)
})

test('换头像：MIME 嗅探、日上限 1、验证码 pauseAll', async () => {
  const root = process.env.AURABOT_DATA_DIR
  const pngPath = join(root, 'avatar-ok.png')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]))
  const { d, drv } = fakes({
    decisions: [],
    cfgOver: { caps: { avatar: 1, sign: 0, nickname: 0, like: 0, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0 }, gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  const a = await d.setAvatar(pngPath)
  assert.equal(a.ok, true, a.message)
  assert.equal(drv._state.avatarPath, pngPath)
  const b = await d.setAvatar(pngPath)
  assert.equal(b.ok, false)
  assert.match(b.message, /用完|次数/)

  const bad = join(root, 'not-img.bin')
  writeFileSync(bad, Buffer.from('hello'))
  const { d: d3 } = fakes({
    decisions: [],
    cfgOver: { caps: { avatar: 1, like: 0, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0 }, gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  const rBad = await d3.setAvatar(bad)
  assert.equal(rBad.ok, false)
  assert.match(rBad.message, /图片/)

  const { d: d4, drv: drv4, sent } = fakes({
    decisions: [],
    script: { profileFail: true, profileFailMessage: '请完成安全验证' },
    cfgOver: { caps: { avatar: 1, like: 0, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0 }, gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  const rV = await d4.setAvatar(pngPath)
  assert.equal(rV.ok, false)
  assert.ok(d4.state().pauseReason)
  assert.equal(sent.length, 1)
})

