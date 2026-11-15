// 内置模块：工作区文件。给她「写文本文件 / 读文本文件」的基本能力——
// 此前她没有任何文件读写工具，「生成一个 txt 再传群文件」这类事只能干看着（真机 2026-11-15）。
//
// 纪律：
//   · 路径由本模块构造（workspaceDir('files')），**不接受任意路径**——没有目录穿越面；
//   · 写 = UTF-8 文本，单文件上限 512KB；重名直接覆盖（她自己的工作区草稿，不做版本管理）；
//   · 读 = 文本 ≤64KB 直接给内容（超长截断），二进制文件如实说「这是二进制，给了路径不给内容」；
//   · 门控：主人私聊可用；群聊里这一轮有主人发言也可以（她替主人办事）。
//
// 内存纪律：无状态、无定时器、无子进程——纯 fs 调用，写完即返回路径。

import { defineTool, str } from '../../tools/tools.js'
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'

/** 单文件写入上限（字节）。十个字的 txt 和几百 KB 的说明文档都够用，防的是灌盘。 */
export const MAX_WRITE_BYTES = 512 * 1024
/** 读文本的内容上限（字符）——与 inbound-files 的口径一致。 */
export const READ_MAX_CHARS = 60000

/** 文件名清洗：剥路径分隔符与 Windows 保留字符，只留文件名本身。 */
export function sanitizeName(name) {
  const n = String(name ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').slice(0, 100)
  return n || 'file.txt'
}

/**
 * 门控（纯函数）：主人私聊（level full）直接可用；群聊/别人场合要求这一轮有主人发言。
 */
export function writeGate({ level, ownerInTurn }) {
  if (level === 'full') return { ok: true }
  if (ownerInTurn) return { ok: true }
  return { ok: false, message: '只有主人（或主人在这个群里开口）能让我写文件' }
}

/** 路径是否在工作区根下（防工具链路把文件读出工作区）。 */
export function insideWorkspace(path, workspaceRoot) {
  let p
  try { p = resolve(String(path || '')) } catch { return false }
  const root = resolve(String(workspaceRoot || ''))
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export default {
  id: 'workspace-files',
  name: '工作区文件',
  version: '1.0.0',
  description: '写/读工作区里的文本文件（qq_write_file / qq_read_file）——生成 txt/md/json 这类小文件、回头看自己写过什么。配合 qq_send_file 或 qq_group_file 的 upload 就能「写好再传出去」。',
  defaults: {},
  settings: [],
  setup(api) {
    const filesDir = () => api.workspaceDir('files')

    api.tool(({ chat, level, sessionId }) => {
      if (chat.kind === 'system') return []
      const gateArgs = { level, ownerInTurn: api.core.hub.turnHasOwner(sessionId) }

      const writer = defineTool({
        name: 'qq_write_file',
        description: '在工作区写一个文本文件（txt / md / json / csv / 代码……），返回绝对路径。写好之后可以用 qq_send_file 发给聊天、或 qq_group_file 的 upload 子命令传进群文件。重名会覆盖。',
        properties: {
          name: str('文件名（只要名字，不要路径；如 reply.txt）'),
          content: str('文件内容（纯文本）'),
        },
        required: ['name', 'content'],
        execute: async ({ name, content }) => {
          const gate = writeGate(gateArgs)
          if (!gate.ok) return { ok: false, message: gate.message }
          const safe = sanitizeName(name)
          const buf = Buffer.from(String(content ?? ''), 'utf8')
          if (buf.length > MAX_WRITE_BYTES) return { ok: false, message: `内容太大（${Math.round(buf.length / 1024)}KB > 512KB），拆成几个文件或精简一下` }
          const file = join(filesDir(), safe)
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, buf)
          return { ok: true, message: `写好了：${file}（${buf.length} 字节）` }
        },
      })

      const reader = defineTool({
        name: 'qq_read_file',
        description: '读工作区里的一个文本文件（qq_write_file 写的、qq_group_file 下载的都在工作区下）。文本直接给内容；二进制文件（图片/压缩包）只给路径和大小，看不到内容。',
        properties: { path: str('文件的绝对路径（必须在工作区里）') },
        required: ['path'],
        execute: async ({ path }) => {
          const gate = writeGate(gateArgs)
          if (!gate.ok) return { ok: false, message: gate.message }
          const root = api.workspaceDir('.')
          if (!insideWorkspace(path, root)) return { ok: false, message: '这个路径不在工作区里，不读' }
          const st = await stat(resolve(path)).catch(() => null)
          if (!st || !st.isFile()) return { ok: false, message: `找不到这个文件：${path}` }
          const buf = await readFile(resolve(path))
          if (buf.includes(0)) return { ok: false, message: `这是二进制文件（${buf.length} 字节），读不了内容。路径：${resolve(path)}` }
          let text = buf.toString('utf8')
          let truncated = false
          if (text.length > READ_MAX_CHARS) { text = text.slice(0, READ_MAX_CHARS); truncated = true }
          return { ok: true, message: truncated ? `${text}\n【太长了，只给前 ${READ_MAX_CHARS} 字】` : text }
        },
      })

      return [writer, reader]
    })

    return { sanitizeName, insideWorkspace }
  },
}
