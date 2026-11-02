import test from 'node:test'
import assert from 'node:assert/strict'
import { extractUrls } from '../src/modules/multi-parser/parser.js'
import { formatCardText, probeVideoSizeMB } from '../src/modules/multi-parser/delivery.js'
import multiParser from '../src/modules/multi-parser/index.js'
import { BUILTINS } from '../src/modules/index.js'

test('multi-parser: 模块注册与定义完整性', () => {
  assert.equal(multiParser.id, 'multi-parser')
  assert.equal(multiParser.tab, 'multiParser')
  assert.ok(BUILTINS.some((m) => m.id === 'multi-parser'), 'multi-parser 必须在 BUILTINS 列表中')

  // 检查 settings 是否包含核心开关
  const keys = multiParser.settings.map((s) => s.key)
  assert.ok(keys.includes('enabled'))
  assert.ok(keys.includes('feedToAi'), '必须包含 AI 注入开关 feedToAi')
  assert.ok(keys.includes('sendMedia'))
  assert.ok(keys.includes('forwardMode'))
  assert.ok(keys.includes('imageThreshold'))
  assert.ok(keys.includes('maxVideoMB'))
  assert.ok(keys.includes('videoOverLimit'))
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

test('extractUrls: 识别真实复杂的抖音分享口令及裸短链', () => {
  const douyinCommand = '2.07 复制打开抖音，看看【天美工作室群TiMi的作品】到总裁室要走员工通道 # 谭谈交通 # 二仙桥 #... https://v.douyin.com/1tB92IqN3yM/ cnQ:/ 04/14 J@i.ca :7pm'
  const urls = extractUrls(douyinCommand)
  assert.equal(urls.length, 1)
  assert.equal(urls[0], 'https://v.douyin.com/1tB92IqN3yM/')

  // 无协议头口令识别
  const bareCommand = '复制本段打开抖音，看看这个作品 v.douyin.com/1tB92IqN3yM/ 精彩内容'
  const bareUrls = extractUrls(bareCommand)
  assert.equal(bareUrls.length, 1)
  assert.equal(bareUrls[0], 'https://v.douyin.com/1tB92IqN3yM/')
})
