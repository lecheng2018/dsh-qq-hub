import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 扫描本地 chatlog 目录中所有群聊及消息统计
 */
export function scanHistoryGroups(chatLogDir) {
  if (!existsSync(chatLogDir)) return []
  let files = []
  try {
    files = readdirSync(chatLogDir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse()
  } catch {
    return []
  }

  const groupStats = new Map() // gid -> { groupId, totalCount, lastAt }

  for (const f of files) {
    try {
      const content = readFileSync(join(chatLogDir, f), 'utf8')
      const lines = content.split('\n')
      for (const line of lines) {
        if (!line) continue
        try {
          const entry = JSON.parse(line)
          if (entry.chatId && entry.chatId.startsWith('group:')) {
            const gid = entry.chatId.slice(6)
            const stat = groupStats.get(gid) || { groupId: gid, totalCount: 0, lastAt: 0 }
            stat.totalCount += 1
            if (entry.t && entry.t > stat.lastAt) stat.lastAt = entry.t
            groupStats.set(gid, stat)
          }
        } catch {}
      }
    } catch {}
  }

  return Array.from(groupStats.values()).sort((a, b) => b.lastAt - a.lastAt)
}

/**
 * 从本地 chatlog 提取指定群的历史发言样本
 */
export function sampleGroupHistory(chatLogDir, groupId, { days = 3, sampleSize = 35, botQQ = '' } = {}) {
  if (!existsSync(chatLogDir) || !groupId) return []
  let files = []
  try {
    files = readdirSync(chatLogDir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse()
  } catch {
    return []
  }

  const selectedFiles = files.slice(0, Math.max(1, days))
  const targetChatId = `group:${groupId}`
  const rawEntries = []

  for (const f of selectedFiles) {
    try {
      const content = readFileSync(join(chatLogDir, f), 'utf8')
      const lines = content.split('\n')
      for (const line of lines) {
        if (!line) continue
        try {
          const entry = JSON.parse(line)
          if (entry.chatId === targetChatId) {
            rawEntries.push(entry)
          }
        } catch {}
      }
    } catch {}
  }

  // 按时间升序排序
  rawEntries.sort((a, b) => (a.t || 0) - (b.t || 0))

  // 过滤有效发言：排除 Bot、排除指令、排除纯系统通知或表情包占位符
  const botUids = new Set([String(botQQ || '').trim()].filter(Boolean))
  const validLines = []

  for (const item of rawEntries) {
    const text = String(item.text || '').trim()
    const uid = String(item.uid || '').trim()
    const who = String(item.who || '').trim()

    // 过滤 Bot
    if (botUids.has(uid) || who === '大肥鱼') continue
    // 过滤空文本、指令、超短无效符号
    if (!text || text.startsWith('/') || text.length < 2) continue
    // 过滤纯图片/动画表情占位符
    if (/^\[(图片|动画表情|分享卡片|语音|视频)\]$/.test(text)) continue

    validLines.push({
      name: who || '群友',
      userId: uid,
      isBot: false,
      text,
      t: item.t,
    })
  }

  if (validLines.length <= sampleSize) {
    return validLines
  }

  // 如果有效消息较多，做步长均匀抽样，保留代表性上下文片段
  // 选取最近的若干个活跃对话簇
  const step = validLines.length / sampleSize
  const sampled = []
  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.min(validLines.length - 1, Math.floor(i * step))
    sampled.push(validLines[idx])
  }
  return sampled
}
