import { join, resolve, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileSegmentBytes } from '../core/net.js'

const TEXT_EXT = new Set(['md', 'txt', 'json', 'csv', 'log', 'yml', 'yaml', 'xml', 'html', 'htm', 'js', 'ts', 'mjs', 'cjs', 'py', 'sh', 'css', 'ini', 'toml', 'sql', 'java', 'go', 'rs', 'c', 'h', 'cpp', 'rb', 'php'])
const TEXT_MAX_CHARS = 60000

/** 收件目录里一个由服务端命名的文件路径：UUID + 白名单扩展名，且断言仍在 dir 内。 */
function inboxPath(dir, ext) {
  const safeExt = /^[a-z0-9]{1,10}$/.test(String(ext || '')) ? `.${ext}` : '.bin'
  const file = join(dir, `${Date.now()}-${randomUUID()}${safeExt}`)
  const root = resolve(dir)
  if (resolve(file) !== resolve(root, basename(file))) throw new Error('收件路径越界，已拒绝写盘')
  return file
}

export async function readInboundFiles(msg, { onebot, workspaceDir, log, maxBytes = 20 * 1024 * 1024 } = {}) {
  const out = []
  const files = Array.isArray(msg.files) ? msg.files : []
  const dir = join(workspaceDir, 'qq-inbox')
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
        // 审计 S03：落盘名不再采信网关注入的 name。
        // 旧实现 `name.replace(/[\/:*?"<>|]/g, '_').slice(-100)` 漏掉了 Windows 分隔符
        // `\\`，也没有处理 `..` 段 —— 在 Windows 上 `..\\..\\x.exe` 能穿过收件目录。
        // 现在磁盘名由服务端生成（UUID + 白名单扩展名），原始文件名只用于展示；
        // 再补一道 resolve 后的根目录断言（防御深度：即使生成逻辑再变，也写不出去）。
        await mkdir(dir, { recursive: true })
        const file = inboxPath(dir, ext)
        await writeFile(file, buf, { flag: 'wx' }) // 独占创建：同名不覆盖
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
