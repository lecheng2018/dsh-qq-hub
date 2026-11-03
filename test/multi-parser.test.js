import test from 'node:test'
import assert from 'node:assert/strict'
import { extractUrls, looksBlocked, vetResult } from '../src/modules/multi-parser/parser.js'
import { formatCardText, probeVideoSizeMB } from '../src/modules/multi-parser/delivery.js'
import multiParser from '../src/modules/multi-parser/index.js'
import { BUILTINS } from '../src/modules/index.js'

test('multi-parser: 模块注册与定义完整性', () => {
  assert.equal(multiParser.id, 'multi-parser')
  assert.equal(multiParser.tab, 'multiParser')
  assert.ok(BUILTINS.some((m) => m.id === 'multi-parser'), 'multi-parser 必须在 BUILTINS 列表中')

  // 检查 defaults 是否包含核心开关
  assert.equal(typeof multiParser.defaults, 'object')
  assert.ok('enabled' in multiParser.defaults)
  assert.ok('feedToAi' in multiParser.defaults, '必须包含 AI 注入开关 feedToAi')
  assert.ok('sendMedia' in multiParser.defaults)
  assert.ok('forwardMode' in multiParser.defaults)
  assert.ok('imageThreshold' in multiParser.defaults)
  assert.ok('maxVideoMB' in multiParser.defaults)
  assert.ok('videoOverLimit' in multiParser.defaults)
})

test('extractUrls: 从消息文本中准确提取多平台链接并去除中文标点', () => {
  const text = '群友们看看这个：https://www.bilibili.com/video/BV1xx411c7mD，还有小红书 https://xhslink.com/a/xyz123！以及微博https://m.weibo.cn/status/123456789。'
  const urls = extractUrls(text)

  assert.equal(urls.length, 3)
  assert.equal(urls[0], 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(urls[1], 'https://xhslink.com/a/xyz123')
  assert.equal(urls[2], 'https://m.weibo.cn/status/123456789')
})

test('formatCardText: 结构化渲染卡片文本', () => {
  const mockResult = {
    platform: 'weibo',
    platformName: '微博',
    title: '数码博主的微博',
    author: '数码博主',
    summary: '今天测了一款全新的千元神机，表现超出预期！',
    stat: '转发: 120 · 评论: 340 · 点赞: 1500',
    url: 'https://weibo.com/123/abc',
  }

  const card = formatCardText(mockResult)
  assert.match(card, /📌【微博 · 内容解析】/)
  assert.match(card, /标题：数码博主的微博/)
  assert.match(card, /作者：数码博主/)
  assert.match(card, /摘要：今天测了一款全新的千元神机/)
  assert.match(card, /数据：转发: 120/)
  assert.match(card, /🔗 链接：https:\/\/weibo\.com\/123\/abc/)
})

test('multi-parser setup: feedToAi 开关控制上下文注入', async () => {
  let contextProvider = null
  let messageHandler = null

  const mockApi = {
    config: () => ({
      multiParser: {
        enabled: true,
        feedToAi: true,
        sendMedia: false,
      },
    }),
    settings: () => ({
      enabled: true,
      feedToAi: true,
      sendMedia: false,
    }),
    context: (fn) => { contextProvider = fn },
    on: (event, fn) => { if (event === 'message') messageHandler = fn },
    route: () => {},
    log: { info() {}, debug() {}, warn() {} },
  }

  const inst = multiParser.setup(mockApi)
  assert.ok(contextProvider, '必须注册 context provider')
  assert.ok(messageHandler, '必须注册 message 监听器')

  // 模拟没有解析记录时，context 为空
  assert.equal(contextProvider({ chat: { chatId: 'group:123456' } }), '')

  // 当 feedToAi 为 false 时，不注入
  mockApi.settings = () => ({ enabled: true, feedToAi: false })
  assert.equal(contextProvider({ chat: { chatId: 'group:123456' } }), '')
})

test('multi-parser setup: 支持专属 Cookie 并可自动复用全局 B站/小黑盒 Cookie', async () => {
  let contextProvider = null
  let statusHandler = null

  const mockApi = {
    config: () => ({
      bili: { cookie: 'SESSDATA=bili_global_123' },
      heybox: { cookie: 'pkey=heybox_global_456' },
      multiParser: {
        enabled: true,
        feedToAi: true,
        cookies: {
          weibo: 'SUB=weibo_sub_789',
        },
      },
    }),
    settings: () => ({
      enabled: true,
      feedToAi: true,
    }),
    context: (fn) => { contextProvider = fn },
    on: () => {},
    route: (path, fn) => {
      if (path === '/multi-parser/status') statusHandler = fn
    },
    log: { info() {}, debug() {}, warn() {} },
  }

  multiParser.setup(mockApi)
  assert.ok(statusHandler)
  const st = await statusHandler()
  assert.equal(st.cookieStatus.bilibili, true, 'B站 Cookie 应该自动复用全局')
  assert.equal(st.cookieStatus.xiaoheihe, true, '小黑盒 Cookie 应该自动复用全局')
  assert.equal(st.cookieStatus.weibo, true, '微博 Cookie 应该由专属配置提供')
  assert.equal(st.cookieStatus.zhihu, false, '知乎未配置')
})

test('extractUrls: 识别真实复杂的各平台分享口令与短链 (抖音/小红书/微博/知乎/B站/贴吧/番茄)', () => {
  // 1. 抖音口令
  const douyinCommand = '2.07 复制打开抖音，看看【天美工作室群TiMi的作品】到总裁室要走员工通道 # 谭谈交通 # 二仙桥 #... https://v.douyin.com/1tB92IqN3yM/ cnQ:/ 04/14 J@i.ca :7pm'
  assert.deepEqual(extractUrls(douyinCommand), ['https://v.douyin.com/1tB92IqN3yM/'])

  // 2. 小红书口令（带表情、口令码、中文字符紧贴）
  const xhsCommand = '42 你的小可爱发布了一篇小红书笔记，快来看吧！ 😆 hIqX8wQ12345 😆 http://xhslink.com/a/bCdEfG，复制本条信息，打开【小红书】App查看精彩内容！'
  assert.deepEqual(extractUrls(xhsCommand), ['http://xhslink.com/a/bCdEfG'])

  // 3. 微博短链 (t.cn 单字母短域名及裸短链)
  const weiboCommand = '微博分享：今天吃了超好吃的大餐 http://t.cn/A6xxxxxx 值得推荐！'
  assert.deepEqual(extractUrls(weiboCommand), ['http://t.cn/A6xxxxxx'])
  assert.deepEqual(extractUrls('快来看 t.cn/A6yyyyyy 精彩微博'), ['https://t.cn/A6yyyyyy'])

  // 4. B站口令与纯 BV 号
  const biliCommand = '来看这期超强剪辑【某某作品】 https://b23.tv/BV1xx411c7mD 也可以点此播放'
  assert.deepEqual(extractUrls(biliCommand), ['https://b23.tv/BV1xx411c7mD'])
  assert.deepEqual(extractUrls('群友发了这期 BV1xx411c7mD 快去看'), ['https://www.bilibili.com/video/BV1xx411c7mD'])

  // 5. 贴吧与番茄小说分享文案
  const tiebaCommand = '老哥们看我这个配置行不行 百度贴吧:https://tieba.baidu.com/p/1234567890?share=1'
  assert.deepEqual(extractUrls(tiebaCommand), ['https://tieba.baidu.com/p/1234567890?share=1'])

  const fanqieCommand = '我在番茄免费小说看《大奉打更人》，强烈推荐！ https://changdunovel.com/t/abcxyz/ 点击阅读'
  assert.deepEqual(extractUrls(fanqieCommand), ['https://changdunovel.com/t/abcxyz/'])
})

test('looksBlocked: 反爬验证页要被认出来，不能当正常内容发出去', () => {
  // 贴吧无 cookie 时真实返回的就是这个标题
  assert.equal(looksBlocked('百度安全验证'), true, '「百度安全验证」必须判定为拦截页')
  assert.equal(looksBlocked('请完成人机验证'), true)
  assert.equal(looksBlocked('访问过于频繁，请稍后再试'), true)
  assert.equal(looksBlocked('Just a moment...'), true)
  assert.equal(looksBlocked('Enable JavaScript and cookies to continue'), true)
  assert.equal(looksBlocked('该内容已被删除'), true)
  assert.equal(looksBlocked(''), false, '空文本不算拦截页')
  // 正文里出现也不行（有时候标题正常、正文是验证页）
  assert.equal(looksBlocked('正常标题', '请输入验证码后继续'), true)
  // 正常内容不能误杀
  assert.equal(looksBlocked('【官方 MV】Never Gonna Give You Up', '一首歌'), false)
})

test('vetResult: 拦截页与空壳结果一律丢弃，不发给用户', () => {
  // 1. 反爬页：贴吧真实遇到的情况
  assert.equal(vetResult({ platformName: '百度贴吧', title: '百度安全验证', summary: '', images: [] }), null)

  // 2. 套话空壳：微博兜底分支把标题抄进摘要，看着有内容其实啥也没有
  assert.equal(
    vetResult({ platformName: '微博', title: '微博内容', summary: '微博内容', images: [], videoUrl: '' }),
    null,
    '标题和摘要都是套话时算空壳',
  )
  assert.equal(vetResult({ platformName: '知乎', title: '知乎内容', summary: '', images: [] }), null)
  assert.equal(vetResult(null), null)

  // 3. 有真实内容要放过
  const ok = vetResult({
    platformName: 'Bilibili',
    title: '【官方 MV】Never Gonna Give You Up',
    author: 'Rick Astley',
    summary: '经典 MV',
    images: ['https://i0.hdslb.com/a.jpg'],
    videoUrl: 'https://x.bilivideo.com/a.mp4',
  })
  assert.ok(ok, '真内容不能被误杀')
  assert.equal(ok.title, '【官方 MV】Never Gonna Give You Up')
})

test('vetResult: 字段结构补齐，下游不必到处判 undefined', () => {
  // 小红书/知乎/微信/贴吧/番茄/GitHub/小黑盒 原本压根没有 videoUrl 字段
  const r = vetResult({ platformName: 'GitHub', title: 'some/repo', url: 'https://github.com/a/b' })
  assert.ok(r)
  assert.equal(r.videoUrl, '', 'videoUrl 必须补成空字符串，而不是 undefined')
  assert.deepEqual(r.images, [], 'images 必须是数组')
  assert.equal(r.author, '')
  assert.equal(r.summary, '')
  assert.equal(r.cover, '')
  // images 里有 null 也要清掉
  const r2 = vetResult({ platformName: '小红书', title: '标题', summary: '有描述', images: ['a.jpg', null, '', 'b.jpg'] })
  assert.deepEqual(r2.images, ['a.jpg', 'b.jpg'])
})
