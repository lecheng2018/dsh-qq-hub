import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs'
import { basename, resolve, relative, isAbsolute, sep } from 'node:path'
import { parseChatKey } from './chat-key.js'
import { workspaceDirOf } from './workspace.js'
import { fetchImage } from '../core/net.js'

const FILE_TIMEOUT_MS = 120_000
const FILE_BASE64_MAX = 30 * 1024 * 1024
const isExternalFile = (src) => /^(https?:\/\/|base64:\/\/)/i.test(src)
const fileLabel = (name, src) => String(name || '').trim() || basename(src.split(/[?#]/)[0]) || '文件'

/**
 * 允许目录一律取「真实规范路径」（解开中间层软链接）；根目录还不存在时退回字面解析。
 * 用字面路径比较就等于把软链接当成目录内的文件（缺陷：软链接可指向任意敏感文件）。
 */
function fileRootsOf(cfg) {
  return [workspaceDirOf(cfg), ...(Array.isArray(cfg?.files?.dirs) ? cfg.files.dirs : [])].filter(Boolean).map((dir) => {
    try { return realpathSync(String(dir)) } catch { try { return resolve(String(dir)) } catch { return '' } }
  }).filter(Boolean)
}

/** 目标文件必须真实落在某个允许目录内；realpath 失败（不存在/断链/越权）按拒绝处理。 */
function insideRoots(file, roots) {
  let path
  try { path = realpathSync(String(file)) } catch { return false }
  return roots.some((root) => {
    const rel = relative(root, path)
    // '..' 本身、'../x' 与绝对路径（不同盘/不同根）都算越界
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
  })
}

export function createOutboundFiles({ getConfig, log, outbox, sendSegments, captureOnly, onStats, deliveryContext }) {
  async function sendVoiceFile(chatId, file, note, opts = {}) {
    const b64 = readFileSync(file).toString('base64')
    const result = await sendSegments(chatId, [{ type: 'record', data: { file: 'base64://' + b64 } }], note || '[语音]', { sourceModuleId: opts?.sourceModuleId })
    if (result || getConfig().dryRun || !getConfig().enabled) onStats?.('voice')
    if (!result && getConfig().enabled && !getConfig().dryRun) throw new Error('网关没接受这条语音')
    return result
  }

  async function sendFile(chatId, file, name, opts = {}) {
    const cfg = getConfig()
    const target = parseChatKey(chatId)
    if (!cfg.files?.enabled) throw new Error('发文件没打开（面板「聊天」页 → 发文件），打开后才能发')
    const src = String(file ?? '').trim()
    if (!src) throw new Error('要发哪个文件？')
    const external = isExternalFile(src)
    const maxBytes = Math.max(1, Number(cfg.files.maxMB) || 50) * 1024 * 1024
    let size = 0
    let realPath = ''
    if (!external) {
      if (!isAbsolute(src)) throw new Error('要发本机文件得给绝对路径')
      if (!existsSync(src)) throw new Error(`找不到这个文件：${src}`)
      const stat = statSync(src)
      if (!stat.isFile()) throw new Error(`这不是文件：${src}`)
      size = stat.size
      const roots = fileRootsOf(cfg)
      if (roots.length && !insideRoots(src, roots)) throw new Error('这个文件不在允许发送的目录里（面板「聊天」页 → 发文件 可以加目录）')
      try { realPath = realpathSync(src) } catch { realPath = src }
      if (size > maxBytes) throw new Error(`文件太大（${(size / 1024 / 1024).toFixed(1)} MB），上限 ${Math.round(maxBytes / 1024 / 1024)} MB`)
    }
    const label = fileLabel(name, src)
    const captured = captureOnly?.(chatId, [{ type: 'file', data: { file: src, name: label } }], `[文件] ${label}`)
    if (captured) return captured

    // 外部 http(s) 文件先由插件侧安全下载（字面地址 + 连接层二次解析双重校验），
    // 再以 base64 交给网关：不把未经校验的 URL 丢给 OneBot 去拉（网关侧没有 SSRF 校验）。
    let wireSrc = src
    if (external && /^https?:\/\//i.test(src)) {
      try {
        const buf = await fetchImage(src, { maxBytes: Math.min(FILE_BASE64_MAX, maxBytes), allowLocal: false, timeoutMs: 30_000 })
        wireSrc = 'base64://' + buf.toString('base64')
      } catch (error) {
        onStats?.('errors')
        throw new Error(`发文件失败：${error.message}`)
      }
    }

    const action = target.kind === 'group' ? 'upload_group_file' : 'upload_private_file'
    const params = target.kind === 'group'
      ? { group_id: Number(target.id), file: wireSrc, name: label }
      : { user_id: Number(target.id), file: wireSrc, name: label }
    const callFile = async (next) => {
      const result = await outbox.request({
        chatKey: chatId, action, params: next, opts: { timeoutMs: FILE_TIMEOUT_MS }, receipt: 'optional',
        note: `[文件] ${label}`, sourceModuleId: opts?.sourceModuleId || 'core', _outboxTicket: deliveryContext?.getStore()?.ticket,
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
        // 回退读盘前用已解析的真实路径再确认一次仍在白名单目录内（防校验后换软链接的 TOCTOU）
        const roots = fileRootsOf(cfg)
        if (roots.length && !insideRoots(realPath || src, roots)) throw new Error('这个文件不在允许发送的目录里（面板「聊天」页 → 发文件 可以加目录）')
        const result = await callFile({ ...params, file: 'base64://' + readFileSync(realPath || src).toString('base64') })
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
