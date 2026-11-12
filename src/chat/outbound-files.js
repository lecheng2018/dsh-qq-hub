import { readFileSync, existsSync, statSync } from 'node:fs'
import { basename, resolve, relative, isAbsolute } from 'node:path'
import { parseChatKey } from './chat-key.js'
import { workspaceDirOf } from './workspace.js'

const FILE_TIMEOUT_MS = 120_000
const FILE_BASE64_MAX = 30 * 1024 * 1024
const isExternalFile = (src) => /^(https?:\/\/|base64:\/\/)/i.test(src)
const fileLabel = (name, src) => String(name || '').trim() || basename(src.split(/[?#]/)[0]) || '文件'

function fileRootsOf(cfg) {
  return [workspaceDirOf(cfg), ...(Array.isArray(cfg?.files?.dirs) ? cfg.files.dirs : [])].filter(Boolean).map((dir) => {
    try { return resolve(String(dir)) } catch { return '' }
  }).filter(Boolean)
}

function insideRoots(file, roots) {
  let path
  try { path = resolve(file) } catch { return false }
  return roots.some((root) => {
    const rel = relative(root, path)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

export function createOutboundFiles({ getConfig, log, outbox, sendSegments, captureOnly, onStats, deliveryContext }) {
  async function sendVoiceFile(chatId, file, note) {
    const b64 = readFileSync(file).toString('base64')
    const result = await sendSegments(chatId, [{ type: 'record', data: { file: 'base64://' + b64 } }], note || '[语音]')
    if (result || getConfig().dryRun || !getConfig().enabled) onStats?.('voice')
    if (!result && getConfig().enabled && !getConfig().dryRun) throw new Error('网关没接受这条语音')
    return result
  }

  async function sendFile(chatId, file, name) {
    const cfg = getConfig()
    const target = parseChatKey(chatId)
    if (!cfg.files?.enabled) throw new Error('发文件没打开（面板「聊天」页 → 发文件），打开后才能发')
    const src = String(file ?? '').trim()
    if (!src) throw new Error('要发哪个文件？')
    const external = isExternalFile(src)
    const maxBytes = Math.max(1, Number(cfg.files.maxMB) || 50) * 1024 * 1024
    let size = 0
    if (!external) {
      if (!isAbsolute(src)) throw new Error('要发本机文件得给绝对路径')
      if (!existsSync(src)) throw new Error(`找不到这个文件：${src}`)
      const stat = statSync(src)
      if (!stat.isFile()) throw new Error(`这不是文件：${src}`)
      size = stat.size
      const roots = fileRootsOf(cfg)
      if (roots.length && !insideRoots(src, roots)) throw new Error('这个文件不在允许发送的目录里（面板「聊天」页 → 发文件 可以加目录）')
      if (size > maxBytes) throw new Error(`文件太大（${(size / 1024 / 1024).toFixed(1)} MB），上限 ${Math.round(maxBytes / 1024 / 1024)} MB`)
    }
    const label = fileLabel(name, src)
    const captured = captureOnly?.(chatId, [{ type: 'file', data: { file: src, name: label } }], `[文件] ${label}`)
    if (captured) return captured

    const action = target.kind === 'group' ? 'upload_group_file' : 'upload_private_file'
    const params = target.kind === 'group'
      ? { group_id: Number(target.id), file: src, name: label }
      : { user_id: Number(target.id), file: src, name: label }
    const callFile = async (next) => {
      const result = await outbox.request({
        chatKey: chatId, action, params: next, opts: { timeoutMs: FILE_TIMEOUT_MS }, receipt: 'optional',
        note: `[文件] ${label}`, sourceModuleId: 'core', _outboxTicket: deliveryContext?.getStore()?.ticket,
      })
      if (result?.state === 'sent') return result.raw ?? result
      if (result?.state === 'cancelled') return null
      const error = new Error(result?.reason || '文件发送失败')
      error.unknown = result?.state === 'unknown'
      throw error
    }
    const srcLabel = external ? (src.startsWith('base64://') ? 'base64' : '外部地址') : size < 1024 ? size + ' B' : Math.round(size / 1024) + ' KB'
    try {
      const result = await callFile(params)
      if (result === null) return null
      onStats?.('sent')
      log.info(`${chatId}：发文件「${label}」（${srcLabel}）`)
      return result
    } catch (error) {
      const canRetryBase64 = !external && size <= Math.min(FILE_BASE64_MAX, maxBytes) && error?.unknown !== true
      if (!canRetryBase64) {
        onStats?.('errors')
        throw new Error(`发文件失败：${error.message}`)
      }
      try {
        const result = await callFile({ ...params, file: 'base64://' + readFileSync(src).toString('base64') })
        if (result === null) return null
        onStats?.('sent')
        log.info(`${chatId}：发文件「${label}」（网关看不到本机路径，改走 base64）`)
        return result
      } catch (error2) {
        onStats?.('errors')
        throw new Error(`发文件失败：${error2.message || error.message}`)
      }
    }
  }

  return { sendFile, sendVoiceFile }
}
