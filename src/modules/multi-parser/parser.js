// 多平台内容解析器核心（移植自 astrbot_plugin_multi_parser）
//
// 纯 Node.js 实现，零外部依赖。
// 支持提取短链、重定向追踪、元数据提取（标题、作者、正文、高清图片、无水印视频直链）。

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** 从文本中提取所有 HTTP/HTTPS 链接 */
export function extractUrls(text) {
  const s = String(text || '')
  const re = /https?:\/\/[^\s<>\[\](){}，。！？、；：'\"`]+/gi
  const matches = s.match(re) || []
  return [...new Set(matches.map((u) => u.replace(/[)\]}>，。！？、；：'\"`]+$/, '')))]
}

/** 跟踪 URL 的重定向，获取落地真实地址 */
export async function resolveUrl(url, maxRedirects = 5) {
  let cur = url
  let count = 0
  while (count < maxRedirects) {
    try {
      const res = await fetch(cur, {
        method: 'HEAD',
        headers: { 'User-Agent': UA_MOBILE },
        redirect: 'manual',
        signal: AbortSignal.timeout(6000),
      })
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        cur = new URL(res.headers.get('location'), cur).href
        count++
      } else {
        break
      }
    } catch {
      break
    }
  }
  return cur
}

/**
 * 平台解析入口
 * @param {string} rawUrl 用户发来的原始 URL
 * @param {object} [opts]
 * @returns {Promise<object|null>} 返回规范化的 ParseResult 或 null
 */
export async function parseUrl(rawUrl, { platforms = {} } = {}) {
  const url = await resolveUrl(rawUrl)

  // 1. 哔哩哔哩 Bilibili
  if (platforms.bilibili !== false && /(?:b23\.tv|bilibili\.com)/i.test(url)) {
    return await parseBilibili(url)
  }

  // 2. 微博 Weibo
  if (platforms.weibo !== false && /(?:weibo\.com|weibo\.cn)/i.test(url)) {
    return await parseWeibo(url)
  }

  // 3. 小红书 RedBook
  if (platforms.redbook !== false && /(?:xhslink\.com|xiaohongshu\.com)/i.test(url)) {
    return await parseRedBook(url)
  }

  // 4. 知乎 Zhihu
  if (platforms.zhihu !== false && /zhihu\.com/i.test(url)) {
    return await parseZhihu(url)
  }

  // 5. 微信公众号 Wechat
  if (platforms.wechat !== false && /mp\.weixin\.qq\.com/i.test(url)) {
    return await parseWechat(url)
  }

  // 6. 百度贴吧 Tieba
  if (platforms.tieba !== false && /tieba\.baidu\.com/i.test(url)) {
    return await parseTieba(url)
  }

  // 7. 番茄小说 Fanqie
  if (platforms.fanqie !== false && /(?:changdunovel\.com|fanqienovel\.com)/i.test(url)) {
    return await parseFanqie(url)
  }

  // 8. GitHub
  if (platforms.github !== false && /github\.com/i.test(url)) {
    return await parseGithub(url)
  }

  // 9. 抖音 Douyin
  if (platforms.douyin !== false && /(?:v\.douyin\.com|douyin\.com)/i.test(url)) {
    return await parseDouyin(url)
  }

  // 10. 小黑盒 Heybox
  if (platforms.xiaoheihe !== false && /xiaoheihe\.cn/i.test(url)) {
    return await parseHeybox(url)
  }

  return null
}

// ---------------- 各平台解析实现 ----------------

async function parseBilibili(url) {
  const bvidMatch = url.match(/BV[0-9A-Za-z]{10}/i)
  if (!bvidMatch) return null
  const bvid = bvidMatch[0]

  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: { 'User-Agent': UA_PC, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(8000),
    })
    const json = await res.json()
    if (json.code !== 0 || !json.data) return null
    const d = json.data

    return {
      platform: 'bilibili',
      platformName: 'Bilibili',
      type: 'video',
      title: d.title || '哔哩哔哩视频',
      author: d.owner?.name || '',
      summary: (d.desc || '').slice(0, 300),
      cover: d.pic,
      images: d.pic ? [d.pic] : [],
      url: `https://www.bilibili.com/video/${bvid}`,
      videoUrl: '', // 需 SESSDATA，基础解析提供封面与摘要
      stat: `播放: ${d.stat?.view || 0} · 弹幕: ${d.stat?.danmaku || 0}`,
    }
  } catch {
    return null
  }
}

async function parseWeibo(url) {
  const idMatch = url.match(/(?:status|detail|\d+)\/([0-9A-Za-z]+)/) || url.match(/weibo\.com\/\d+\/([0-9A-Za-z]+)/)
  if (!idMatch) return null
  const id = idMatch[1]

  try {
    const res = await fetch(`https://m.weibo.cn/statuses/show?id=${id}`, {
      headers: {
        'User-Agent': UA_MOBILE,
        Referer: `https://m.weibo.cn/detail/${id}`,
        'X-Requested-With': 'XMLHttpRequest',
        'MWeibo-Pwa': '1',
      },
      signal: AbortSignal.timeout(8000),
    })
    const json = await res.json()
    const d = json?.data
    if (!d) return null

    const cleanText = (d.text || '').replace(/<[^>]+>/g, '').trim()
    const images = (d.pics || []).map((p) => p.large?.url || p.url).filter(Boolean)
    const videoUrl = d.page_info?.urls?.mp4_720p_mp4 || d.page_info?.urls?.mp4_hd_mp4 || d.page_info?.media_info?.stream_url_hd || ''

    return {
      platform: 'weibo',
      platformName: '微博',
      type: videoUrl ? 'video' : (images.length ? 'gallery' : 'post'),
      title: `${d.user?.screen_name || '微博博主'} 的微博`,
      author: d.user?.screen_name || '',
      summary: cleanText.slice(0, 300),
      cover: images[0] || d.page_info?.page_pic?.url || '',
      images,
      videoUrl,
      url: `https://weibo.com/${d.user?.id}/${d.bid || id}`,
      stat: `转发: ${d.reposts_count || 0} · 评论: ${d.comments_count || 0} · 点赞: ${d.attitudes_count || 0}`,
    }
  } catch {
    return null
  }
}

async function parseRedBook(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.xiaohongshu.com/' },
      signal: AbortSignal.timeout(8000),
    })
    const html = await res.text()

    // 提取标题与描述
    const titleMatch = html.match(/<meta\s+name="og:title"\s+content="([^"]*)"/i) || html.match(/<title>([^<]*)<\/title>/i)
    const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i) || html.match(/<meta\s+name="og:description"\s+content="([^"]*)"/i)
    const imgMatches = [...html.matchAll(/https:\/\/[^"'\s]+\.xhscdn\.com\/[^"'\s]+/gi)].map((m) => m[0])

    const title = titleMatch ? titleMatch[1].replace(/ - 小红书$/, '').trim() : '小红书笔记'
    const desc = descMatch ? descMatch[1].trim() : ''
    const images = [...new Set(imgMatches)].slice(0, 9)

    return {
      platform: 'redbook',
      platformName: '小红书',
      type: images.length ? 'gallery' : 'post',
      title,
      author: '小红书创作者',
      summary: desc.slice(0, 300),
      cover: images[0] || '',
      images,
      url,
    }
  } catch {
    return null
  }
}

async function parseZhihu(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA_PC, Referer: 'https://www.zhihu.com/' },
      signal: AbortSignal.timeout(8000),
    })
    const html = await res.text()

    const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) || html.match(/<title>([^<]*)<\/title>/i)
    const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)
    const imgMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/i)

    const title = titleMatch ? titleMatch[1].replace(/ - 知乎$/, '').trim() : '知乎内容'
    const desc = descMatch ? descMatch[1].trim() : ''
    const cover = imgMatch ? imgMatch[1] : ''

    return {
      platform: 'zhihu',
      platformName: '知乎',
      type: 'article',
      title,
      author: '知乎答主',
      summary: desc.slice(0, 300),
      cover,
      images: cover ? [cover] : [],
      url,
    }
  } catch {
    return null
  }
}

async function parseWechat(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA_MOBILE },
      signal: AbortSignal.timeout(8000),
    })
    const html = await res.text()

    const titleMatch = html.match(/var\s+msg_title\s*=\s*'([^']*)'/i) || html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i)
    const descMatch = html.match(/var\s+msg_desc\s*=\s*'([^']*)'/i) || html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i)
    const coverMatch = html.match(/var\s+msg_cdn_url\s*=\s*"([^"]*)"/i) || html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/i)
    const authorMatch = html.match(/var\s+nickname\s*=\s*"([^"]*)"/i)

    const title = titleMatch ? titleMatch[1].trim() : '微信公众号文章'
    const desc = descMatch ? descMatch[1].trim() : ''
    const cover = coverMatch ? coverMatch[1] : ''
    const author = authorMatch ? authorMatch[1].trim() : ''

    return {
      platform: 'wechat',
      platformName: '微信公众号',
      type: 'article',
      title,
      author,
      summary: desc.slice(0, 300),
      cover,
      images: cover ? [cover] : [],
      url,
    }
  } catch {
    return null
  }
}

async function parseTieba(url) {
  const tidMatch = url.match(/p\/(\d+)/)
  if (!tidMatch) return null
  const tid = tidMatch[1]

  try {
    const res = await fetch(`https://tieba.baidu.com/p/${tid}`, {
      headers: { 'User-Agent': UA_PC },
      signal: AbortSignal.timeout(8000),
    })
    const html = await res.text()

    const titleMatch = html.match(/<h[13][^>]*class="[^"]*core_title_txt[^"]*"[^>]*>([^<]+)<\/h[13]>/i) || html.match(/<title>([^<]*)<\/title>/i)
    const textMatch = html.match(/class="d_post_content j_d_post_content[^"]*">([\s\S]*?)<\/div>/i)
    const title = titleMatch ? titleMatch[1].replace(/_百度贴吧$/, '').trim() : '贴吧帖子'
    const rawText = textMatch ? textMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim() : ''

    const imgMatches = [...html.matchAll(/<img[^>]+class="BDE_Image"[^>]+src="([^">]+)"/gi)].map((m) => m[1])

    return {
      platform: 'tieba',
      platformName: '百度贴吧',
      type: imgMatches.length ? 'gallery' : 'post',
      title,
      author: '贴吧吧友',
      summary: rawText.slice(0, 300),
      cover: imgMatches[0] || '',
      images: imgMatches.slice(0, 9),
      url: `https://tieba.baidu.com/p/${tid}`,
    }
  } catch {
    return null
  }
}

async function parseFanqie(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA_MOBILE },
      signal: AbortSignal.timeout(8000),
    })
    const html = await res.text()

    const nameMatch = html.match(/<div[^>]*class="[^"]*book-name[^"]*"[^>]*>([^<]+)<\/div>/i) || html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i)
    const authorMatch = html.match(/<span[^>]*class="[^"]*author-name[^"]*"[^>]*>([^<]+)<\/span>/i)
    const introMatch = html.match(/<p[^>]*class="[^"]*book-abstract[^"]*"[^>]*>([^<]+)<\/p>/i) || html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)
    const coverMatch = html.match(/<img[^>]*class="[^"]*book-cover[^"]*"[^>]+src="([^">]+)"/i)

    return {
      platform: 'fanqie',
      platformName: '番茄小说',
      type: 'book',
      title: nameMatch ? nameMatch[1].trim() : '番茄小说',
      author: authorMatch ? authorMatch[1].trim() : '',
      summary: introMatch ? introMatch[1].trim().slice(0, 300) : '',
      cover: coverMatch ? coverMatch[1] : '',
      images: coverMatch ? [coverMatch[1]] : [],
      url,
    }
  } catch {
    return null
  }
}

async function parseGithub(url) {
  const m = url.match(/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:\/)?$/i)
  if (!m) return null
  const owner = m[1]
  const repo = m[2]

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { 'User-Agent': 'aurabot-plugin' },
      signal: AbortSignal.timeout(8000),
    })
    const d = await res.json()
    if (!d || d.message) return null

    const ogImage = `https://opengraph.githubassets.com/1/${owner}/${repo}`

    return {
      platform: 'github',
      platformName: 'GitHub',
      type: 'repo',
      title: `${d.full_name} (${d.language || 'Code'})`,
      author: d.owner?.login || owner,
      summary: d.description || '暂无简介',
      cover: ogImage,
      images: [ogImage],
      url: d.html_url || url,
      stat: `★ ${d.stargazers_count || 0} · Forks: ${d.forks_count || 0}`,
    }
  } catch {
    return null
  }
}

async function parseDouyin(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA_MOBILE },
      signal: AbortSignal.timeout(8000),
    })
    const html = await res.text()
    const titleMatch = html.match(/<title>([^<]*)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/ - 抖音$/, '').trim() : '抖音视频'

    return {
      platform: 'douyin',
      platformName: '抖音',
      type: 'video',
      title,
      author: '抖音创作者',
      summary: title,
      cover: '',
      images: [],
      url,
    }
  } catch {
    return null
  }
}

async function parseHeybox(url) {
  return {
    platform: 'xiaoheihe',
    platformName: '小黑盒',
    type: 'post',
    title: '小黑盒社区资讯',
    author: '盒友',
    summary: '点击查看小黑盒社区动态与游戏资讯',
    cover: '',
    images: [],
    url,
  }
}
