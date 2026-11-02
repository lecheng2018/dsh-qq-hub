// 多平台内容解析器模块（移植自 astrbot_plugin_multi_parser）
//
// 1. 自动识别聊天中的链接，提取标题、作者、高清大图、无水印视频；
// 2. 具备【AI 注入开关 (feedToAi)】：将解析内容注入大模型上下文，让 AI 能读懂并参与聊天；
// 3. 支持 QQ 合并转发卡片与视频群文件转存，防刷屏。

import { extractUrls, parseUrl } from './parser.js'
import { deliverParseResult } from './delivery.js'

const ID = 'multi-parser'

export default {
  id: ID,
  name: '内容解析',
  version: '1.0.0',
  api: 1,
  tab: 'multiParser',
  description: '自动识别消息中的 B站/微博/小红书/知乎/微信/贴吧/番茄/GitHub等链接，发送无水印图文视频并支持AI上下文注入',
  defaults: {
    enabled: false,
    feedToAi: true,
    sendMedia: true,
    forwardMode: 'threshold',
    imageThreshold: 2,
    maxVideoMB: 50,
    videoOverLimit: 'direct_link',
  },
  settings: [
    { key: 'enabled', label: '启用内容解析', type: 'switch', hint: '自动识别消息中的多平台链接并解析' },
    { key: 'feedToAi', label: '注入大模型上下文 (AI 看懂链接)', type: 'switch', hint: '开启后将解析出的标题与摘要自动喂给 AI，让她能看懂群友分享并参与讨论' },
    { key: 'sendMedia', label: '发送解析媒体到 QQ', type: 'switch', hint: '将解析出的高清图集、无水印视频卡片发回 QQ' },
    {
      key: 'forwardMode', label: '图文发送策略', type: 'select',
      options: [
        { value: 'threshold', label: '超过图片阈值时合并转发 (推荐)' },
        { value: 'always', label: '总是使用合并转发卡片' },
        { value: 'never', label: '逐条发送普通消息' },
      ],
      hint: '多图时是否打包为 QQ 聊天记录合并转发卡片（防刷屏）',
    },
    { key: 'imageThreshold', label: '合并转发图片张数门槛', type: 'number', min: 1, max: 20, step: 1, hint: '图片张数达到此阈值时转为合并转发卡片' },
    { key: 'maxVideoMB', label: '视频直接发送上限 (MB)', type: 'number', min: 5, max: 200, step: 5, hint: '超过此体积将转为下载直链或上传群文件' },
    {
      key: 'videoOverLimit', label: '视频超限处理动作', type: 'select',
      options: [
        { value: 'direct_link', label: '发送下载直链' },
        { value: 'group_file', label: '上传至群文件 (群聊有效)' },
        { value: 'notice', label: '仅提示视频超限' },
      ],
    },
  ],
  setup(api) {
    // chatId -> { at, result } 记录最近解析的内容
    const recentParsed = new Map()

    const cfg = () => {
      const g = api.config().multiParser || {}
      const s = api.settings()
      const full = api.config()
      const rawCookies = g.cookies || {}
      const cookies = {
        bilibili: rawCookies.bilibili || full.bili?.cookie || (full.bili?.sessdata ? `SESSDATA=${full.bili.sessdata}` : ''),
        douyin: rawCookies.douyin || '',
        redbook: rawCookies.redbook || '',
        weibo: rawCookies.weibo || '',
        zhihu: rawCookies.zhihu || '',
        tieba: rawCookies.tieba || '',
        xiaoheihe: rawCookies.xiaoheihe || full.heybox?.cookie || '',
      }
      return { ...s, ...g, platforms: g.platforms || {}, cookies }
    }

    // 🌟 AI 上下文注入机制：大模型对话前，若当前聊天有新鲜解析的内容，自动拼入提示词
    api.context(({ chat }) => {
      const c = cfg()
      if (!c.enabled || !c.feedToAi) return ''

      const recent = recentParsed.get(chat?.chatId)
      if (!recent || Date.now() - recent.at > 3 * 60_000) return ''

      const r = recent.result
      const statLine = r.stat ? `\n数据：${r.stat}` : ''
      return `【系统提示：对方刚才在聊天中分享了一条来自 ${r.platformName} 的链接】\n` +
             `标题：《${r.title}》\n` +
             `作者：${r.author || '未知'}\n` +
             `内容摘要：${r.summary || '无'}${statLine}\n` +
             `（提示：你可以根据以上内容自然地接话、吐槽或发表看法，像真人一样随性交流，不要生硬背诵）`
    })

    // 监听进站消息，检测链接
    api.on('message', async (msg) => {
      const c = cfg()
      if (!c.enabled) return false

      const urls = extractUrls(msg.text)
      if (!urls.length) return false

      let handledAny = false

      for (const rawUrl of urls.slice(0, 3)) {
        try {
          const result = await parseUrl(rawUrl, { platforms: c.platforms, cookies: c.cookies })
          if (!result) continue

          handledAny = true
          api.log.info(`[multi-parser] 成功解析 ${result.platformName} 链接: ${result.title}`)

          // 记录到最近解析表，供 AI 注入读取
          recentParsed.set(msg.chatId, { at: Date.now(), result })

          // 发送到 QQ
          if (c.sendMedia) {
            await deliverParseResult(api, msg.chatId, result, c)
          }
        } catch (err) {
          api.log.debug(`[multi-parser] 解析链接失败 (${rawUrl}):`, err.message)
        }
      }

      // 返回 false：让普通消息继续往后流转，模型可以同时参与回复
      return false
    })

    // 面板测试接口：手动输入链接测试解析效果
    api.route('/multi-parser/test', async (req) => {
      const body = await api.core.http.body(req)
      const url = String(body.url || '').trim()
      if (!url) return { ok: false, message: '请提供测试链接' }

      try {
        const c = cfg()
        const result = await parseUrl(url, { platforms: c.platforms, cookies: c.cookies })
        if (!result) return { ok: false, message: '暂不支持该平台链接或解析失败' }
        return { ok: true, result }
      } catch (err) {
        return { ok: false, message: '解析异常：' + err.message }
      }
    })

    // 面板状态接口
    api.route('/multi-parser/status', async () => {
      const c = cfg()
      const ck = c.cookies || {}
      return {
        ok: true,
        active: c.enabled,
        recentCount: recentParsed.size,
        cookieStatus: {
          bilibili: Boolean(ck.bilibili),
          weibo: Boolean(ck.weibo),
          redbook: Boolean(ck.redbook),
          zhihu: Boolean(ck.zhihu),
          tieba: Boolean(ck.tieba),
          douyin: Boolean(ck.douyin),
          xiaoheihe: Boolean(ck.xiaoheihe),
        },
        platforms: [
          'bilibili (B站)', 'weibo (微博)', 'redbook (小红书)', 'zhihu (知乎)',
          'wechat (微信公众号)', 'tieba (百度贴吧)', 'fanqie (番茄小说)',
          'github (GitHub)', 'douyin (抖音)', 'xiaoheihe (小黑盒)',
        ],
      }
    })

    return {
      parse: (url) => parseUrl(url, { platforms: cfg().platforms, cookies: cfg().cookies }),
      recent: () => [...recentParsed.values()],
    }
  },
}
