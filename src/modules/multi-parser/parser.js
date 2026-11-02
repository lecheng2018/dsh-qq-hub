// 多平台内容解析器核心（移植自 astrbot_plugin_multi_parser）
//
// 纯 Node.js 实现，零外部依赖。
// 支持提取短链、重定向追踪、元数据提取（标题、作者、正文、高清图片、无水印视频直链）。

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** 从文本或口令中提取所有链接（兼容带协议、不带协议的分享短链与纯 BV 号） */
export function extractUrls(text) {
  const s = String(text || '')
  const urls = []

  // 1. 标准 HTTP/HTTPS 链接（支持单字母短域名如 t.cn, x.com，排除中文字符与表情）
  const reHttp = /https?:\/\/(?:[a-zA-Z0-9][-a-zA-Z0-9_]*\.)*[a-zA-Z0-9][-a-zA-Z0-9_]*\.[a-zA-Z0-9]{2,8}(?::\d+)?(?:\/[^\s<>\[\](){}，。！？、；：'\"`\u4e00-\u9fa5\ud800-\udfff]*)?/gi
  const mHttp = s.match(reHttp) || []
  for (const u of mHttp) {
    urls.push(u.replace(/[)\]}>，。！？、；：'\"`]+$/, ''))
  }

  // 2. 匹配常见无协议前缀的平台短链 (t.cn / v.douyin.com / b23.tv / xhslink.com / tb.cn / bili2233.cn)
  const reBare = /(?:^|[^\w/.-])((?:v|jx)\.douyin\.com\/[A-Za-z0-9_-]+\/?|b23\.tv\/[A-Za-z0-9]+\/?|bili2233\.cn\/[A-Za-z0-9]+\/?|xhslink\.(?:com|cn)\/[A-Za-z0-9/_-]+\/?|t\.cn\/[A-Za-z0-9]+\/?|tb\.cn\/[A-Za-z0-9]+\/?)/gi
  let m
  while ((m = reBare.exec(s)) !== null) {
    const bare = m[1].replace(/[)\]}>，。！？、；：'\"`]+$/, '')
    const full = 'https://' + bare
    if (!urls.some((u) => u.includes(bare))) {
      urls.push(full)
    }
  }

  // 3. 匹配纯 BV 号（口令中未带任何链接的场景）
  const reBv = /(?:^|[^\w/.-])(BV[0-9A-Za-z]{10})(?:[^\w/.-]|$)/i
  const mBv = s.match(reBv)
  if (mBv && !urls.some((u) => u.includes(mBv[1]))) {
    urls.push(`https://www.bilibili.com/video/${mBv[1]}`)
  }

  return [...new Set(urls)]
}

/** 跟踪 URL 的重定向，获取落地真实地址（支持移动端短链跳转） */
export async function resolveUrl(url, maxRedirects = 5) {
  let cur = String(url || '').trim()
  let count = 0
  while (count < maxRedirects) {
    try {
      // 许多短链服务（微博 t.cn、小红书 xhslink、B站 b23.tv）对 HEAD 请求会拒绝或不跳转，优先采用带 Range 的 GET 请求
      const res = await fetch(cur, {
        method: 'GET',
        headers: { 'User-Agent': UA_MOBILE, Range: 'bytes=0-10' },
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
export async function parseUrl(rawUrl, { platforms = {}, cookies = {}, rawText = '' } = {}) {
  let url = await resolveUrl(rawUrl)

  // 知乎外链跳板 link.zhihu.com/?target=... 还原真实目标
  if (/link\.zhihu\.com/i.test(url)) {
    try {
      const u = new URL(url)
      const target = u.searchParams.get('target')
      if (target) url = await resolveUrl(decodeURIComponent(target))
    } catch {}
  }

  // 1. 哔哩哔哩 Bilibili (支持 b23.tv / bili2233.cn / bilibili.com)
  if (platforms.bilibili !== false && /(?:b23\.tv|bili2233\.cn|bilibili\.com)/i.test(url)) {
    return await parseBilibili(url, cookies.bilibili)
  }

  // 2. 微博 Weibo (支持 t.cn / weibo.com / weibo.cn / card.weibo.com)
  if (platforms.weibo !== false && /(?:weibo\.com|weibo\.cn|t\.cn)/i.test(url)) {
    return await parseWeibo(url, cookies.weibo, rawText)
  }

  // 3. 小红书 RedBook (支持 xhslink.com / xhslink.cn / xiaohongshu.com / xiaohongshu.cn)
  if (platforms.redbook !== false && /(?:xhslink\.com|xhslink\.cn|xiaohongshu\.com|xiaohongshu\.cn)/i.test(url)) {
    return await parseRedBook(url, cookies.redbook, rawText)
  }

  // 4. 知乎 Zhihu (支持 zhihu.com / zhuanlan.zhihu.com)
  if (platforms.zhihu !== false && /zhihu\.com/i.test(url)) {
    return await parseZhihu(url, cookies.zhihu)
  }

  // 5. 微信公众号 Wechat
  if (platforms.wechat !== false && /mp\.weixin\.qq\.com/i.test(url)) {
    return await parseWechat(url)
  }

  // 6. 百度贴吧 Tieba (支持 tieba.baidu.com / tb.cn)
  if (platforms.tieba !== false && /(?:tieba\.baidu\.com|tb\.cn)/i.test(url)) {
    return await parseTieba(url, cookies.tieba)
  }

  // 7. 番茄小说 Fanqie (支持 changdunovel.com / fanqienovel.com)
  if (platforms.fanqie !== false && /(?:changdunovel\.com|fanqienovel\.com)/i.test(url)) {
    return await parseFanqie(url)
  }

  // 8. GitHub
  if (platforms.github !== false && /github\.com/i.test(url)) {
    return await parseGithub(url)
  }

  // 9. 抖音 Douyin (支持 v.douyin.com / jx.douyin.com / douyin.com / iesdouyin.com)
  if (platforms.douyin !== false && /(?:v\.douyin\.com|jx\.douyin\.com|douyin\.com|iesdouyin\.com)/i.test(url)) {
    return await parseDouyin(url, cookies.douyin, rawText)
  }

  // 10. 小黑盒 Heybox (支持 xiaoheihe.cn / heybox.com.cn)
  if (platforms.xiaoheihe !== false && /(?:xiaoheihe\.cn|heybox\.com\.cn)/i.test(url)) {
    return await parseHeybox(url, cookies.xiaoheihe)
  }

  return null
}

// ---------------- 各平台解析实现 ----------------

async function parseBilibili(url, cookie = '') {
  const bvidMatch = url.match(/BV[0-9A-Za-z]{10}/i)
  if (!bvidMatch) return null
  const bvid = bvidMatch[0]

  try {
    const headers = { 'User-Agent': UA_PC, Referer: 'https://www.bilibili.com/' }
    if (cookie) headers.Cookie = cookie

    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    })
    const json = await res.json()
    if (json.code !== 0 || !json.data) return null
    const d = json.data

    let videoUrl = ''
    if (d.cid) {
      try {
        const playRes = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${d.cid}&qn=64&fnval=1`, {
          headers,
          signal: AbortSignal.timeout(6000),
        })
        const playJson = await playRes.json()
        videoUrl = playJson?.data?.durl?.[0]?.url || ''
      } catch {}
    }

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
      videoUrl,
      stat: `播放: ${d.stat?.view || 0} · 弹幕: ${d.stat?.danmaku || 0}`,
    }
  } catch {
    return null
  }
}

async function parseWeibo(url, cookie = '', rawText = '') {
  const idMatch = url.match(/(?:status|detail|\d+)\/([0-9A-Za-z]+)/) || url.match(/weibo\.com\/\d+\/([0-9A-Za-z]+)/)
  const id = idMatch ? idMatch[1] : ''

  try {
    if (id) {
      const headers = {
        'User-Agent': UA_MOBILE,
        Referer: `https://m.weibo.cn/detail/${id}`,
        'X-Requested-With': 'XMLHttpRequest',
        'MWeibo-Pwa': '1',
      }
      if (cookie) headers.Cookie = cookie

      const res = await fetch(`https://m.weibo.cn/statuses/show?id=${id}`, {
        headers,
        signal: AbortSignal.timeout(8000),
      })
      const json = await res.json()
      const d = json?.data
      if (d) {
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
      }
    }
  } catch {}

  // 口令兜底提取
  let titleFallback = '微博内容'
  if (rawText) {
    const textM = rawText.match(/(?:微博|分享)[:：]?\s*(.*?)(?:https?:\/\/|t\.cn|$)/i)
    if (textM && textM[1].trim()) titleFallback = textM[1].trim()
  }

  return {
    platform: 'weibo',
    platformName: '微博',
    type: 'post',
    title: titleFallback,
    author: '微博用户',
    summary: titleFallback,
    cover: '',
    images: [],
    videoUrl: '',
    url,
  }
}

async function parseRedBook(url, cookie = '', rawText = '') {
  try {
    const headers = { 'User-Agent': UA_MOBILE, Referer: 'https://www.xiaohongshu.com/' }
    if (cookie) headers.Cookie = cookie

    const res = await fetch(url, {
      headers,
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
  } catch {}

  // 口令兜底提取
  let titleFallback = '小红书笔记'
  let authorFallback = '小红书创作者'
  if (rawText) {
    const authorM = rawText.match(/(\S+)发布了一篇小红书笔记/)
    if (authorM) authorFallback = authorM[1].trim()
    const textM = rawText.match(/【(.*?)】/)
    if (textM) titleFallback = textM[1].trim()
  }

  return {
    platform: 'redbook',
    platformName: '小红书',
    type: 'post',
    title: titleFallback,
    author: authorFallback,
    summary: titleFallback,
    cover: '',
    images: [],
    url,
  }
}

async function parseZhihu(url, cookie = '') {
  try {
    const headers = { 'User-Agent': UA_PC, Referer: 'https://www.zhihu.com/' }
    if (cookie) headers.Cookie = cookie

    const res = await fetch(url, {
      headers,
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

async function parseTieba(url, cookie = '') {
  const tidMatch = url.match(/p\/(\d+)/)
  if (!tidMatch) return null
  const tid = tidMatch[1]

  try {
    const headers = { 'User-Agent': UA_PC }
    if (cookie) headers.Cookie = cookie

    const res = await fetch(`https://tieba.baidu.com/p/${tid}`, {
      headers,
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

let cachedDouyinTtwid = ''
let ttwidExpireAt = 0

async function getDouyinTtwid() {
  if (cachedDouyinTtwid && Date.now() < ttwidExpireAt) return cachedDouyinTtwid
  try {
    const regRes = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://www.iesdouyin.com/' },
      body: JSON.stringify({ region: 'cn', aid: 1768, needFid: false, service: 'www.iesdouyin.com', union: true, fid: '' }),
      signal: AbortSignal.timeout(5000),
    })
    const setCookie = regRes.headers.get('set-cookie') || ''
    const m = setCookie.match(/ttwid=([^;]+)/)
    if (m) cachedDouyinTtwid = m[1]
    const regJson = await regRes.json().catch(() => ({}))
    if (!cachedDouyinTtwid && regJson.redirect_url) {
      const cbRes = await fetch(regJson.redirect_url, {
        headers: { Referer: 'https://www.iesdouyin.com/' },
        signal: AbortSignal.timeout(5000),
      })
      const cbCookie = cbRes.headers.get('set-cookie') || ''
      const m2 = cbCookie.match(/ttwid=([^;]+)/)
      if (m2) cachedDouyinTtwid = m2[1]
    }
    if (cachedDouyinTtwid) ttwidExpireAt = Date.now() + 24 * 3600_000
  } catch {}
  return cachedDouyinTtwid
}

async function parseDouyin(url, cookie = '', rawText = '') {
  try {
    let workId = ''
    const idMatch = url.match(/\/(?:video|note|slides)\/(\d+)/i) || url.match(/[?&]aweme_id=(\d+)/i) || url.match(/[?&]itemId=(\d+)/i)
    if (idMatch) workId = idMatch[1]

    const ttwid = await getDouyinTtwid()
    const cookieHeader = [cookie, ttwid ? `ttwid=${ttwid}` : ''].filter(Boolean).join('; ')
    const headers = {
      'User-Agent': UA_MOBILE,
      Referer: 'https://www.iesdouyin.com/',
    }
    if (cookieHeader) headers.Cookie = cookieHeader

    const targetUrl = workId ? `https://www.iesdouyin.com/share/video/${workId}/` : url
    const res = await fetch(targetUrl, {
      headers,
      signal: AbortSignal.timeout(8000),
    })
    const html = await res.text()

    const routerMatch = html.match(/window\._ROUTER_DATA\s*=\s*(.*?);?<\/script>/s)
    if (routerMatch) {
      try {
        const data = JSON.parse(routerMatch[1].trim())
        const loaderData = data.loaderData || {}
        for (const k in loaderData) {
          if (k.startsWith('video_') || k.startsWith('note_') || k.startsWith('slides_')) {
            const item = loaderData[k]?.videoInfoRes?.item_list?.[0]
            if (item) {
              const title = item.desc || '抖音作品'
              const author = item.author?.nickname || '抖音创作者'
              const playUrls = item.video?.play_addr?.url_list || []
              const rawVideoUrl = playUrls[0] || ''
              const videoUrl = rawVideoUrl ? rawVideoUrl.replace('playwm', 'play') : ''
              const cover = item.video?.cover?.url_list?.[0] || ''
              const images = (item.images || []).map((img) => img?.url_list?.[0]).filter(Boolean)

              return {
                platform: 'douyin',
                platformName: '抖音',
                type: images.length ? 'gallery' : 'video',
                title,
                author,
                summary: title,
                cover: cover || images[0] || '',
                images: images.length ? images : (cover ? [cover] : []),
                videoUrl,
                url,
                stat: `点赞: ${item.statistics?.digg_count || 0} · 评论: ${item.statistics?.comment_count || 0}`,
              }
            }
          }
        }
      } catch {}
    }

    // 口令文本解析兜底：从「看看【...的作品】标题」中提取
    let authorFallback = '抖音创作者'
    let titleFallback = '抖音视频'
    if (rawText) {
      const authorM = rawText.match(/【(.*?)的作品】/)
      if (authorM) authorFallback = authorM[1].trim()
      const textM = rawText.match(/【.*?的作品】\s*(.*?)(?:https?:\/\/|$)/)
      if (textM && textM[1].trim()) titleFallback = textM[1].trim()
    }

    return {
      platform: 'douyin',
      platformName: '抖音',
      type: 'video',
      title: titleFallback,
      author: authorFallback,
      summary: titleFallback,
      cover: '',
      images: [],
      videoUrl: '',
      url,
    }
  } catch {
    return null
  }
}

async function parseHeybox(url, cookie = '') {
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
