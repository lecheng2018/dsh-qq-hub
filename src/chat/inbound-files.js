import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileSegmentBytes } from '../core/net.js'

const TEXT_EXT = new Set(['md', 'txt', 'json', 'csv', 'log', 'yml', 'yaml', 'xml', 'html', 'htm', 'js', 'ts', 'mjs', 'cjs', 'py', 'sh', 'css', 'ini', 'toml', 'sql', 'java', 'go', 'rs', 'c', 'h', 'cpp', 'rb', 'php'])
const TEXT_MAX_CHARS = 60000

export async function readInboundFiles(msg, { onebot, workspaceDir, log, maxBytes = 20 * 1024 * 1024 } = {}) {
  const out = []
  const files = Array.isArray(msg.files) ? msg.files : []
  for (const seg of files.slice(0, 3)) {
    const data = seg.data || {}
    const name = String(data.file_name || data.name || data.file || 'file')
    const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase()
    try {
      const buf = await fileSegmentBytes(seg, onebot, {
        chat: { kind: msg.kind, userId: msg.userId, groupId: msg.groupId },
        maxBytes,
      })
      if (TEXT_EXT.has(ext) || (buf.length < 1024 * 1024 && !buf.includes(0))) {
        let body = buf.toString('utf8')
        let truncated = false
        if (body.length > TEXT_MAX_CHARS) { body = body.slice(0, TEXT_MAX_CHARS); truncated = true }
        out.push({ kind: 'text', name, text: body, truncated, bytes: buf.length })
      } else {
        const dir = join(workspaceDir, 'qq-inbox')
        await mkdir(dir, { recursive: true })
        const safe = name.replace(/[\/:*?"<>|]/g, '_').slice(-100)
        const file = join(dir, `${Date.now()}-${safe}`)
        await writeFile(file, buf)
        out.push({ kind: 'file', name, path: file, bytes: buf.length })
      }
    } catch (error) {
      log?.warn?.(`取文件失败（${name}）：`, error.message)
      out.push({ kind: 'failed', name, reason: error.message })
    }
  }
  for (const seg of files.slice(3)) {
    const data = seg.data || {}
    out.push({ kind: 'skipped', name: String(data.file_name || data.name || data.file || 'file'), reason: '一条消息最多读取前 3 个文件，这个文件未下载' })
  }
  return out
}

function fileSize(bytes) {
  const n = Number(bytes) || 0
  if (n > 0 && n < 1024) return '<1KB'
  return `${Math.round(n / 1024)}KB`
}

export function inboundFileBlocks(files, nickname) {
  return files.map((file) => {
    if (file.kind === 'text') {
      return {
        type: 'text',
        text: `【${nickname} 发来文件 ${file.name}（${fileSize(file.bytes)}）${file.truncated ? '，太长了只给了前 6 万字' : ''}】\n${file.text}\n【文件结束】`,
      }
    }
    if (file.kind === 'file') {
      return { type: 'text', text: `【${nickname} 发来文件 ${file.name}（${fileSize(file.bytes)}），已经存在 ${file.path}，要看得用工具读】` }
    }
    return { type: 'text', text: `【${nickname} 发来文件 ${file.name}，但没取下来：${file.reason}】` }
  })
}
