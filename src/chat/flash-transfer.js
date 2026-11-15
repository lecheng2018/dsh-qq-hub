// 闪传（QQ 闪传文件集）能力层：SnowLuma 扩展动作的参数/结果整形与编排。
//
// 动作面（SnowLuma 专属，NapCat 没有）：
//   get_fileset_id({share_code})            分享码 → 文件集 id（只读）
//   get_flash_file_list({fileset_id})       文件集内容清单（只读）
//   download_fileset({fileset_id})          下载信息（含直链；只读，落盘是本层做的事）
//   send_flash_msg({fileset_id, group_id?/user_id?})   发闪传（副作用；模块经 api.onebot 自动进 Outbox）
//
// 网关返回形状一律不做假设（不同版本字段名会漂），抽取函数全部防御式：
// 认得出就整形，认不出返回空——调用方拿到空按「网关没给」如实报告，绝不猜。

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchImage } from '../core/net.js'

/** 分享码：字母数字与 -_，4~64 位（QQ 闪传码的常见形状；宁可收窄也不误认）。 */
const SHARE_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/
/** 文件集 id：比分享码宽松（可能数字/长串），但不允许空白与协议分隔符。 */
const FILESET_ID_RE = /^[\w.:-]{4,128}$/

/**
 * 从 flash_file 段的 data（或主人手填的对象）里认出分享码 / 文件集 id / 标题。
 * 认不出返回 {}（调用方按「只有标题」处理，绝不猜一个码出来）。
 * @param {object} [data]
 * @returns {{filesetId?: string, shareCode?: string, title?: string}}
 */
export function flashShareInfo(data) {
  const d = (data && typeof data === 'object') ? data : {}
  const out = {}
  const fileset = String(d.fileset_id ?? d.filesetId ?? '').trim()
  if (FILESET_ID_RE.test(fileset)) out.filesetId = fileset
  const code = String(d.share_code ?? d.shareCode ?? d.code ?? '').trim()
  if (SHARE_CODE_RE.test(code)) out.shareCode = code
  const url = String(d.url ?? d.jump_url ?? '').trim()
  if (url) {
    try {
      const u = new URL(url)
      for (const [key, value] of u.searchParams) {
        if (!out.shareCode && /^share_?code$|^code$/i.test(key) && SHARE_CODE_RE.test(value)) out.shareCode = value
        if (!out.filesetId && /^fileset_?id$/i.test(key) && FILESET_ID_RE.test(value)) out.filesetId = value
      }
    } catch { /* 不是合法 URL 就当没有 */ }
  }
  const title = String(d.title ?? d.file_name ?? '').trim()
  if (title) out.title = title.slice(0, 120)
  return out
}

/** 人类可读的体积（清单与下载结果共用）。 */
export function humanSize(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}

/** 从任意网关返回形状里抽文件清单 [{name, size}]（认不出返回空数组）。 */
export function extractFlashFileList(result) {
  const candidates = []
  if (Array.isArray(result)) candidates.push(result)
  else if (result && typeof result === 'object') {
    for (const key of ['files', 'file_list', 'list', 'items', 'data']) {
      if (Array.isArray(result[key])) candidates.push(result[key])
      else if (result[key] && typeof result[key] === 'object' && Array.isArray(result[key].files)) candidates.push(result[key].files)
    }
  }
  const arr = candidates.find((a) => a.length > 0) || []
  return arr.map((it) => {
    const o = (it && typeof it === 'object') ? it : {}
    return {
      name: String(o.file_name ?? o.name ?? o.title ?? o.file ?? '').trim(),
      size: Number(o.file_size ?? o.size ?? o.bytes ?? 0) || 0,
    }
  }).filter((x) => x.name)
}

/** 从 download_fileset 的返回里抽直链 [{name, url, size}]（认不出返回空数组）。 */
export function extractFlashDownloadUrls(result) {
  const candidates = []
  if (Array.isArray(result)) candidates.push(result)
  else if (result && typeof result === 'object') {
    for (const key of ['files', 'downloads', 'list', 'items', 'data']) {
      if (Array.isArray(result[key])) candidates.push(result[key])
      else if (result[key] && typeof result[key] === 'object' && Array.isArray(result[key].files)) candidates.push(result[key].files)
    }
    // 单文件形状：{url, name?}
    const single = String(result.url ?? result.download_url ?? '').trim()
    if (single) return [{ name: String(result.file_name ?? result.name ?? 'file'), url: single, size: Number(result.file_size ?? result.size ?? 0) || 0 }]
  }
  const arr = candidates.find((a) => a.length > 0) || []
  return arr.map((it) => {
    const o = (it && typeof it === 'object') ? it : {}
    return {
      name: String(o.file_name ?? o.name ?? o.title ?? o.file ?? 'file').trim(),
      url: String(o.url ?? o.download_url ?? o.link ?? '').trim(),
      size: Number(o.file_size ?? o.size ?? o.bytes ?? 0) || 0,
    }
  }).filter((x) => x.url)
}

/** 文件清单 → 给模型/主人看的文本（一行一个，封顶 limit；空清单返回空串）。 */
export function formatFlashFileList(files, { limit = 8 } = {}) {
  if (!Array.isArray(files) || !files.length) return ''
  const lines = files.slice(0, limit).map((f, i) => `${i + 1}. ${f.name}${f.size ? `（${humanSize(f.size)}）` : ''}`)
  if (files.length > limit) lines.push(`…还有 ${files.length - limit} 个没列出来`)
  return lines.join('\n')
}

/**
 * 编排：分享码或文件集 id → { filesetId, files }。
 * 网关注入（onebot.call），失败原样上抛——调用方（工具/命令）负责把错误转成人话。
 * @param {object} o
 * @param {{call: Function}} o.onebot
 * @param {string} [o.shareCode] 二选一；都给了优先 filesetId
 * @param {string} [o.filesetId]
 * @param {number} [o.timeoutMs]
 */
export async function resolveFlashFileset({ onebot, shareCode, filesetId, timeoutMs = 15000 } = {}) {
  let id = String(filesetId || '').trim()
  if (!id) {
    const code = String(shareCode || '').trim()
    if (!code) throw new Error('要给分享码（share_code）或文件集 id（fileset_id）之一')
    const r = await onebot.call('get_fileset_id', { share_code: code }, { timeoutMs })
    id = String(r?.fileset_id ?? r?.filesetId ?? r?.data?.fileset_id ?? '').trim()
    if (!id) throw new Error('网关没认出这个分享码（get_fileset_id 没给 fileset_id）')
    if (!FILESET_ID_RE.test(id)) throw new Error('网关给的 fileset_id 形状不对，拒绝使用')
  }
  const list = await onebot.call('get_flash_file_list', { fileset_id: id }, { timeoutMs })
  return { filesetId: id, files: extractFlashFileList(list) }
}

/**
 * 下载整个文件集到指定目录（拿到直链立刻下——闪传链接有时效）。
 * 逐文件独立成败：一个挂了不影响其余，结果里如实分开。
 * @param {object} o
 * @param {{call: Function}} o.onebot
 * @param {string} o.dir 落盘目录（调用方给 api.workspaceDir(...) 的绝对路径）
 * @param {string} o.filesetId
 * @param {number} [o.maxFiles] 最多下几个（防一次拖回一座山）
 * @param {number} [o.maxBytes] 单文件上限
 * @returns {Promise<Array<{name, path?, bytes?, reason?}>>}
 */
export async function downloadFlashFileset({ onebot, dir, filesetId, maxFiles = 5, maxBytes = 100 * 1024 * 1024, timeoutMs = 30000 }) {
  const raw = await onebot.call('download_fileset', { fileset_id: String(filesetId || '') }, { timeoutMs })
  const entries = extractFlashDownloadUrls(raw)
  if (!entries.length) throw new Error('网关没给出可下载的直链（download_fileset 返回里没有 url）')
  await mkdir(dir, { recursive: true })
  const out = []
  for (const entry of entries.slice(0, Math.max(1, maxFiles))) {
    const safe = entry.name.replace(/[\\/:*?"<>|]/g, '_').slice(-100) || 'file'
    try {
      const buf = await fetchImage(entry.url, { maxBytes, timeoutMs: 60000 })
      const file = join(dir, `${Date.now()}-${safe}`)
      await writeFile(file, buf)
      out.push({ name: entry.name, path: file, bytes: buf.length })
    } catch (error) {
      out.push({ name: entry.name, reason: String(error?.message || error) })
    }
  }
  for (const entry of entries.slice(maxFiles)) {
    out.push({ name: entry.name, reason: '超过单次下载数量上限，这个文件没下载' })
  }
  return out
}

/** 下载结果 → 给调用方看的文本（路径列表 + 失败原因，如实分开）。 */
export function formatFlashDownloadResult(results) {
  const ok = results.filter((r) => r.path)
  const bad = results.filter((r) => r.reason)
  const lines = []
  for (const r of ok) lines.push(`✓ ${r.name}（${humanSize(r.bytes)}）→ ${r.path}`)
  for (const r of bad) lines.push(`✗ ${r.name}：${r.reason}`)
  return lines.join('\n')
}
