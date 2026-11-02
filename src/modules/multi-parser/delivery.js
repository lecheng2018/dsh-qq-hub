// 媒体投递与卡片渲染引擎：将解析结果安全转换为 QQ 消息段或合并转发卡片

/** 格式化纯文本摘要卡片 */
export function formatCardText(result) {
  const parts = []
  parts.push(`📌【${result.platformName} · 内容解析】`)
  if (result.title) parts.push(`标题：${result.title}`)
  if (result.author) parts.push(`作者：${result.author}`)
  if (result.summary) parts.push(`摘要：${result.summary}`)
  if (result.stat) parts.push(`数据：${result.stat}`)
  parts.push(`🔗 链接：${result.url}`)
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
  const images = Array.isArray(result.images) ? result.images.filter(Boolean) : []
  const videoUrl = result.videoUrl || ''

  const forwardMode = cfg.forwardMode || 'threshold'
  const threshold = Number(cfg.imageThreshold) || 2
  const maxVideoMB = Number(cfg.maxVideoMB) || 100
  const videoOverLimit = cfg.videoOverLimit || 'direct_link'

  const selfId = String(api.config().botQQ || '10000')
  const botName = '内容解析'

  // 1. 如果包含视频
  if (videoUrl) {
    const sizeMB = await probeVideoSizeMB(videoUrl)
    if (sizeMB > maxVideoMB) {
      if (videoOverLimit === 'group_file' && chatId.startsWith('group:')) {
        const gid = Number(chatId.slice(6))
        try {
          await api.sendText(chatId, `${cardText}\n⏳ 视频约 ${sizeMB}MB，正在上传至群文件...`)
          await api.onebot('upload_group_file', {
            group_id: gid,
            file: videoUrl,
            name: `${(result.title || 'video').slice(0, 40)}.mp4`,
          })
          return true
        } catch (err) {
          api.log.debug('[multi-parser] 上传群文件失败，回退直链:', err.message)
        }
      }
      // 回退直链
      await api.sendText(chatId, `${cardText}\n📹 视频较大（约 ${sizeMB}MB），直链播放：${videoUrl}`)
      return true
    }

    // 正常视频：发送文本 + 视频段
    try {
      await api.sendText(chatId, cardText)
      await api.sendSegments(chatId, [{ type: 'video', data: { file: videoUrl } }])
      return true
    } catch (err) {
      api.log.debug('[multi-parser] 发送视频失败，回退发图文:', err.message)
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
          content: [{ type: 'text', data: { text: cardText } }],
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

  // 3. 普通图文发送
  const segs = [{ type: 'text', data: { text: cardText } }]
  for (const img of images.slice(0, 4)) {
    segs.push({ type: 'image', data: { file: img } })
  }
  await api.sendSegments(chatId, segs)
  return true
}
