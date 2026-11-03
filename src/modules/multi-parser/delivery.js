import { downloadVideo, safeName, discardDownloaded } from '../../douyin/media.js'

// 媒体投递与卡片渲染引擎：将解析结果安全转换为 QQ 消息段或合并转发卡片

/** 卡片里链接最多留这么长：再长就在手机上占一大片，把媒体挤到屏幕外 */
const MAX_URL_IN_CARD = 80

/**
 * 把链接收拾成能看的短样子。
 * 有些平台（尤其抖音分享页）会给一条八百多字、带满 utm/share_sign 的追踪链接，
 * 原样贴进卡片要占二十多行 —— 留着主链接，把没用的查询串去掉。
 */
export function tidyUrl(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (s.length <= MAX_URL_IN_CARD) return s
  try {
    const u = new URL(s)
    // 查询串里有语义的（视频 id / 帖子 id）留下，其余追踪参数全丢
    const keep = ['id', 'aweme_id', 'itemId', 'p', 'bvid', 'v', 'target']
    const kept = new URLSearchParams()
    for (const k of keep) {
      const v = u.searchParams.get(k)
      if (v) kept.set(k, v)
    }
    const query = kept.toString() ? '?' + kept.toString() : ''
    const bare = u.origin + u.pathname + query
    if (bare.length <= MAX_URL_IN_CARD) return bare
    // 路径本身就长：先截路径再拼查询串，别把 id 参数一起截掉
    const room = MAX_URL_IN_CARD - 1 - query.length
    if (room > u.origin.length + 4) return u.origin + u.pathname.slice(0, room - u.origin.length - 1) + '…' + query
    return bare.slice(0, MAX_URL_IN_CARD - 1) + '…'
  } catch {
    return s.slice(0, MAX_URL_IN_CARD - 1) + '…'
  }
}

/**
 * 摘要有必要显示吗？
 * 有些平台的「描述」和标题是同一段文字（抖音的 desc 本身就是标题、
 * 小红书 og:description 常常就是标题句），照着原样再打一行「摘要」纯属重复。
 * 只有明显比标题多出内容时才单独显示。
 */
export function shouldShowSummary(title, summary) {
  const s = String(summary || '').trim()
  if (!s) return false
  const t = String(title || '').trim()
  if (!t) return true
  // 去掉空白和话题井号再比，避免「# 三角洲」和「#三角洲」被当成不一样
  const norm = (x) => x.replace(/\s+/g, '').replace(/[#＃]/g, '')
  const ns = norm(s)
  const nt = norm(t)
  if (!ns) return false
  // 完全一样，或者说来说去就是标题里那点话 → 不重复显示
  if (ns === nt) return false
  if (nt && ns.startsWith(nt)) return false
  if (nt && nt.startsWith(ns)) return false
  return true
}

/**
 * 格式化纯文本摘要卡片。
 * @param {object} result 解析结果
 * @param {object} [opts]
 * @param {boolean} [opts.withLink=true] 要不要带链接。视频/图片本身已经发过去了就别带，
 *        只有发不出去（超体积、下载失败、图文兜底）时才需要拿链接兜底。
 */
export function formatCardText(result, { withLink = true } = {}) {
  const parts = []
  parts.push(`📌【${result.platformName} · 内容解析】`)
  if (result.title) parts.push(`标题：${result.title}`)
  if (result.author) parts.push(`作者：${result.author}`)
  if (shouldShowSummary(result.title, result.summary)) parts.push(`摘要：${result.summary}`)
  if (result.stat) parts.push(`数据：${result.stat}`)
  if (withLink) {
    const link = tidyUrl(result.url)
    if (link) parts.push(`🔗 链接：${link}`)
  }
  return parts.join('\n')
}

/** 探测视频体积 (MB) */
export async function probeVideoSizeMB(url) {
  if (!url) return 0
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    const len = Number(res.headers.get('content-length') || 0)
    return len > 0 ? Math.round((len / 1024 / 1024) * 10) / 10 : 0
  } catch {
    return 0
  }
}

/**
 * 将解析出的结果以卡片/图集/视频形式发送到 QQ
 */
export async function deliverParseResult(api, chatId, result, cfg = {}) {
  const cardText = formatCardText(result)
  // 媒体真的发出去时用这份：不带链接
  const cardTextNoLink = formatCardText(result, { withLink: false })
  const cardTextVideoSent = cardTextNoLink
  const images = Array.isArray(result.images) ? result.images.filter(Boolean) : []
  const videoUrl = result.videoUrl || ''

  const forwardMode = cfg.forwardMode || 'threshold'
  const threshold = Number(cfg.imageThreshold) || 2
  // 下载上限要和「发文件」的上限取小：不然会下完 100MB 才在 sendFile 那里被 50MB 拦掉，
  // 白下一遍还发不出去（以前就是这样，用户只看到一条解析卡片，视频没了）
  const fileMaxMB = Number(api.config?.()?.files?.maxMB) || 50
  const maxVideoMB = Math.min(Number(cfg.maxVideoMB) || 100, fileMaxMB)
  const videoOverLimit = cfg.videoOverLimit || 'direct_link'

  const selfId = String(api.config().botQQ || '10000')
  const botName = '内容解析'

  // 1. 如果包含视频
  if (videoUrl) {
    // 用链接里的数字 id 当文件名尾巴，免得两条视频撞名互相覆盖
    const vid = (String(result.url || '') + String(videoUrl)).match(/(\d{6,})/)?.[1] || ''
    // 先把视频真正下到本地再发：直链直接丢给 OneBot 十有八九拉不动
    // （抖音/B站直链都带防盗链，网关那边拿不到就会静默失败），
    // 而且下载下来才能确认真实体积，限额才算数。
    let localFile = ''
    let sizeMB = 0
    let overLimit = false
    try {
      const dir = typeof api.workspaceDir === 'function'
        ? api.workspaceDir('multi-parser-media')
        : ''
      if (dir) {
        const got = await downloadVideo(
          { videoUrls: [videoUrl], title: result.title, awemeId: vid },
          { dir, maxMB: maxVideoMB, referer: result.referer || undefined },
        )
        localFile = got.path
        sizeMB = Math.round((got.bytes / 1024 / 1024) * 10) / 10
        api.log.debug?.(`[multi-parser] 视频已下载：${localFile}（${sizeMB} MB）`)
      }
    } catch (err) {
      api.log.debug?.('[multi-parser] 视频下载失败，退回直链:', err.message)
      // 是被体积上限挡下的：说明这视频很大，不要再拿直链去试小视频那条路
      if (/超过上限/.test(err.message)) overLimit = true
    }

      try {
      // 超体积的走群文件 / 直链
      if (sizeMB > maxVideoMB) {
        if (videoOverLimit === 'group_file' && chatId.startsWith('group:')) {
          const gid = Number(chatId.slice(6))
          try {
            await api.sendText(chatId, `${cardText}\n⏳ 视频约 ${sizeMB}MB，正在上传至群文件...`)
            await api.onebot('upload_group_file', {
              group_id: gid,
              file: localFile || videoUrl,
              name: safeName(result.title, vid),
            })
            return true
          } catch (err) {
            api.log.debug('[multi-parser] 上传群文件失败，回退直链:', err.message)
          }
        }
        await api.sendText(chatId, `${cardText}\n📹 视频较大（约 ${sizeMB}MB），直链播放：${videoUrl}`)
        return true
      }

      // 正常视频：优先发本地的（能真发出去），下载失败才把直链交给网关一试
      try {
        // 视频能发出去时，卡片不带链接——东西都到手了，再挂条点不开的分享链接只是占地方
        if (localFile && typeof api.sendFile === 'function') {
          await api.sendText(chatId, cardTextVideoSent)
          await api.sendFile(chatId, localFile, safeName(result.title, vid))
          return true
        }
        // 发不出视频：链接就是唯一的观看途径，这时候才带
        await api.sendText(chatId, cardText)
        if (overLimit) {
          await api.sendText(chatId, `📹 视频超出可发体积，直链播放：${videoUrl}`)
          return true
        }
        await api.sendSegments(chatId, [{ type: 'video', data: { file: videoUrl } }])
        return true
      } catch (err) {
        api.log.debug('[multi-parser] 发送视频失败，回退发图文:', err.message)
      }
    } finally {
      // 发完即删：QQ 那边已经收到了，本地再留一份只是占盘。
      // 用 finally 是为了把上面每条 return 分支都盖住，不会漏。
      if (localFile && discardDownloaded(localFile)) {
        api.log.debug?.(`[multi-parser] 已清理本地视频：${localFile}`)
      }
    }
  }

  // 2. 如果包含图集：判断是否走合并转发卡片
  const shouldForward = (forwardMode === 'always') || (forwardMode === 'threshold' && images.length >= threshold)

  if (images.length > 0 && shouldForward) {
    const nodes = [
      {
        type: 'node',
        data: {
          name: botName,
          uin: selfId,
          // 图都在卡片下面了，链接没意义
          content: [{ type: 'text', data: { text: cardTextNoLink } }],
        },
      },
      ...images.map((img) => ({
        type: 'node',
        data: {
          name: botName,
          uin: selfId,
          content: [{ type: 'image', data: { file: img } }],
        },
      })),
    ]

    try {
      if (chatId.startsWith('group:')) {
        await api.onebot('send_group_forward_msg', {
          group_id: Number(chatId.slice(6)),
          messages: nodes,
        })
      } else if (chatId.startsWith('private:')) {
        await api.onebot('send_private_forward_msg', {
          user_id: Number(chatId.slice(8)),
          messages: nodes,
        })
      }
      return true
    } catch (err) {
      api.log.debug('[multi-parser] 合并转发失败，回退为普通图文:', err.message)
    }
  }

  // 3. 普通图文发送：带图就不需要链接；纯文字结果才给链接兜底
  const segs = [{ type: 'text', data: { text: images.length ? cardTextNoLink : cardText } }]
  for (const img of images.slice(0, 4)) {
    segs.push({ type: 'image', data: { file: img } })
  }
  await api.sendSegments(chatId, segs)
  return true
}
