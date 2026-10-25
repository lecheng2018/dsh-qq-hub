// B 站：签名、Cookie / 链接 / 分享卡片解析、刷一轮（评论、分享、记忆）、回复别人、看你发来的视频。用假的 B 站和假的模型测。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let api
let duty
let normalize

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-bili-'))
  api = await import('../src/bili/api.js')
  duty = await import('../src/bili/duty.js')
  ;({ normalize } = await import('../src/core/config.js'))
})

test('WBI 签名和文档里的例子一致', () => {
  const q = api.wbiSign({ foo: '114', bar: '514', zab: 1919810 }, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169 * 1000)
  assert.equal(q, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4')
})

test('解析：Cookie 只取有用的、认出视频号和短链、QQ 分享卡片', async () => {
  assert.deepEqual(api.parseCookie('SESSDATA=abc; bili_jct=x1; foo=bar; buvid3=b3'), { SESSDATA: 'abc', bili_jct: 'x1', buvid3: 'b3' })
  assert.deepEqual(api.findVideoId('看这个 https://www.bilibili.com/video/BV1GJ411x7h7/?p=1'), { bvid: 'BV1GJ411x7h7' })
  assert.deepEqual(api.findVideoId('av170001'), { aid: '170001' })
  assert.deepEqual(api.findVideoId('https://b23.tv/abc123 哈哈'), { short: 'https://b23.tv/abc123' })
  assert.equal(api.findVideoId('没有链接'), null)
  const { cardText } = await import('../src/chat/inbound.js')
  const card = JSON.stringify({ meta: { detail_1: { title: '哔哩哔哩', desc: '猫猫做饭', qqdocurl: 'https://b23.tv/xyz?share=1' } } })
  assert.equal(cardText(card), '[分享卡片（哔哩哔哩）：猫猫做饭 https://b23.tv/xyz]')
  assert.equal(cardText('不是 json'), '[卡片消息]')
})

test('过滤：播放量、发布时间、看过的', () => {
  const now = Date.now()
  const list = [
    { bvid: 'a', play: 100, pubdate: now },
    { bvid: 'b', play: 9000, pubdate: now - 100 * 86400_000 },
    { bvid: 'c', play: 9000, pubdate: now },
    { bvid: 'd', play: 9000, pubdate: now },
  ]
  assert.deepEqual(duty.filterVideos(list, { minViews: 5000, maxAgeDays: 60, seen: new Set(['d']), now }).map((v) => v.bvid), ['c'])
})

function fakes({ decisions, replyText = '是呀 我也觉得', cfgOver = {} } = {}) {
  const posted = []
  const sent = []
  const events = []
  const facts = []
  const fakeApi = {
    nav: async () => ({ isLogin: true, uname: '肥鱼小号' }),
    search: async (kw) => [{ bvid: 'BV1aaaaaaaaa', aid: 1, title: kw + ' 视频一', play: 20000, pubdate: Date.now() }, { bvid: 'BV1bbbbbbbbb', aid: 2, title: kw + ' 视频二', play: 30000, pubdate: Date.now() }],
    popular: async () => [],
    view: async ({ bvid }) => ({ bvid: bvid || 'BV1ccccccccc', aid: bvid === 'BV1bbbbbbbbb' ? 2 : 1, cid: 9, title: bvid === 'BV1bbbbbbbbb' ? '猫猫做饭' : '米饭大赛', author: 'UP主', play: 20000, desc: '简介' }),
    subtitle: async () => '大家好今天做饭',
    comments: async () => [{ name: '网友', text: '好香' }],
    postComment: async (aid, message, o) => { posted.push({ aid, message, ...(o || {}) }); return { rpid: 1 } },
    likeVideo: async () => {},
    replyFeed: async () => [{ id: 'f1', name: '路人甲', text: '你也爱吃米饭？', myText: '看饿了', oid: 1, root: 100, parent: 101, title: '米饭大赛', type: 1 }],
    resolveShort: async () => 'https://www.bilibili.com/video/BV1bbbbbbbbb',
  }
  const hub = {
    runSystemTurn: async (name, title, prompt) => {
      if (prompt.includes('挑 3 个')) return '["米饭","猫咪"]'
      if (prompt.includes('看完说说你的想法')) return JSON.stringify(decisions)
      if (prompt.includes('回复你')) return replyText
      return ''
    },
    sendText: async (chatId, text) => sent.push({ chatId, text }),
    logChat: () => {},
  }
  const memory = {
    list: () => [{ text: '主人喜欢猫', about: '10000001' }],
    recentEvents: () => [],
    addEvent: (e) => events.push(e.text),
    add: (m) => facts.push(m.text),
  }
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', bili: { enabled: true, perRun: 2, maxCommentsPerDay: 1, ...cfgOver } })
  const b = duty.createBili({ getConfig: () => cfg, hub, memory, log: { info() {}, warn() {}, debug() {} }, api: fakeApi })
  return { b, posted, sent, events, facts }
}

test('刷一轮：看视频、按每天上限评论、分享给主人、记成她的经历', async () => {
  const { b, posted, sent, events, facts } = fakes({ decisions: [
    { i: 1, feeling: '米饭好香', comment: '看饿了', share: '', remember: '有个米饭大赛很好玩' },
    { i: 2, feeling: '猫好可爱', comment: '猫猫好会', share: '主人你看这只猫会做饭！', remember: '' },
  ] })
  const r = await b.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.watched, 2)
  assert.equal(posted.length, 1, '每天最多 1 条，只发了第一条')
  assert.equal(posted[0].message, '看饿了')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, 'private:10000001')
  assert.match(sent[0].text, /会做饭！\nhttps:\/\/www\.bilibili\.com\/video\/BV1/)
  assert.ok(events.some((e) => e.includes('在B站看了《米饭大赛》') && e.includes('米饭好香')))
  assert.ok(events.some((e) => e.includes('下评论：看饿了')))
  assert.deepEqual(facts, ['有个米饭大赛很好玩'])
  assert.equal(b.state().comments, 1)
  // 看过的不会再看
  const r2 = await b.run({ force: true })
  assert.equal(r2.ok, false)
})

test('回复别人：带上楼层、按格式回，回过的不再回', async () => {
  const { b, posted, events } = fakes({ decisions: [] })
  const r = await b.checkReplies()
  assert.equal(r.replied, 1)
  assert.deepEqual(posted[0], { aid: 1, message: '回复 @路人甲 :是呀 我也觉得', root: 100, parent: 101 })
  assert.ok(events.some((e) => e.includes('在B站回复了 路人甲')))
  assert.equal((await b.checkReplies()).replied, 0)
})

test('看你发来的视频（短链也行）；主人让她评论才发', async () => {
  const { b, posted } = fakes({ decisions: [] })
  const w = await b.watch('https://b23.tv/abc123')
  assert.equal(w.ok, true)
  assert.match(w.message, /《猫猫做饭》/)
  assert.match(w.message, /字幕（节选）：大家好今天做饭/)
  const c = await b.comment('BV1bbbbbbbbb', '太会了')
  assert.equal(c.ok, true)
  assert.deepEqual(posted[0], { aid: 2, message: '太会了' })
  assert.equal((await b.watch('没有链接')).ok, false)
})
