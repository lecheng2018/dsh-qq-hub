// 内置模块：群文件。浏览群文件盘、把群文件下载到工作区（读）；建夹/移动/转存/删除是
// 共享空间的变更，只给主人且要显式确认（manage 子命令，面板默认关）。
//
// 接线方式（不在老文件上堆代码）：
//   · 只读动作（get_group_file_system_info / get_group_root_files / get_group_files_by_folder）
//     在 setup 里 registerReadActions 登记进 onebot/read-actions.js，client.js 零改动；
//   · 上传走已有的 qq_send_file（qq-tools），这里不重复做发送；
//   · 纯函数（整形/门控判定）从本文件导出，测试直接 import，不起插件。

import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { defineTool, str, int } from '../../tools/tools.js'
import { fetchImage } from '../../core/net.js'
import { registerReadActions } from '../../onebot/read-actions.js'

/** 人类可读体积（列表/下载结果共用）。 */
export function humanSize(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}

/** 网关文件条目整形：不同版本字段名会漂，防御式抽取（认不出给占位名，绝不丢条目）。 */
export function normalizeFileEntry(it) {
  const o = (it && typeof it === 'object') ? it : {}
  return {
    id: String(o.file_id ?? o.fileId ?? o.id ?? o.fid ?? '').trim(),
    name: String(o.file_name ?? o.name ?? o.title ?? '').trim() || '（未命名）',
    size: Number(o.file_size ?? o.size ?? o.bytes ?? 0) || 0,
    // busid：换下载地址（get_group_file_url）要带原值，缺了网关会报参数错误（真机 2026-11-15）
    busid: Number(o.busid ?? o.bus_id ?? 0) || 0,
    isDir: Boolean(o.is_dir ?? o.isDir ?? o.folder ?? false) || String(o.type ?? '') === 'folder',
    folderId: String(o.folder_id ?? o.folderId ?? o.id ?? '').trim(),
  }
}

/** 从任意返回形状抽条目数组（files/list/items/data 都试一遍）。 */
export function extractEntries(result) {
  const candidates = []
  if (Array.isArray(result)) candidates.push(result)
  else if (result && typeof result === 'object') {
    for (const key of ['files', 'list', 'items', 'data', 'file_list']) {
      if (Array.isArray(result[key])) candidates.push(result[key])
      else if (result[key] && typeof result[key] === 'object' && Array.isArray(result[key].files)) candidates.push(result[key].files)
    }
  }
  const arr = candidates.find((a) => a.length > 0) || []
  return arr.map(normalizeFileEntry)
}

/** 目录列表 → 给模型/主人看的文本（目录在前，条目封顶 limit）。 */
export function formatDirListing(entries, { limit = 40 } = {}) {
  if (!Array.isArray(entries) || !entries.length) return '（这个目录是空的）'
  const dirs = entries.filter((e) => e.isDir)
  const files = entries.filter((e) => !e.isDir)
  const lines = [
    ...dirs.slice(0, limit).map((e) => `📁 ${e.name}  [目录 id=${e.folderId || e.id}]`),
    ...files.slice(0, limit).map((e) => `${e.name}（${humanSize(e.size)}）  [文件 id=${e.id}${e.busid ? ` busid=${e.busid}` : ''}]`),
  ]
  const shown = dirs.length + files.length
  if (shown > lines.length || entries.length > limit) lines.push(`…共 ${entries.length} 项，只列了前 ${Math.min(limit, entries.length)} 项`)
  return lines.join('\n')
}

/** 容量摘要文本（get_group_file_system_info 的防御式整形；拿不到返回空串）。 */
export function formatSystemInfo(info) {
  const d = (info && typeof info === 'object') ? info : {}
  const total = Number(d.total ?? d.total_space ?? d.capacity ?? 0) || 0
  const used = Number(d.used ?? d.used_space ?? 0) || 0
  if (!(total > 0)) return ''
  return `群文件空间：已用 ${humanSize(used)} / 共 ${humanSize(total)}`
}

/**
 * manage 子命令的门控判定（纯函数，测试直接打）。
 * 三重门：这一轮有主人说话 + 显式确认词 + 非试运行。任何一条不满足都拒绝。
 */
export function manageGate({ ownerInTurn, confirm, dryRun, allowManage }) {
  if (allowManage === false) return { ok: false, message: '群文件管理没开：主人在面板「群文件」页打开「允许管理」才能用' }
  if (!ownerInTurn) return { ok: false, message: '只有主人能让我做群文件管理操作' }
  if (String(confirm || '').trim() !== '确认') return { ok: false, message: '这是改共享空间的操作，confirm 要明确写「确认」才执行' }
  if (dryRun) return { ok: true, dryRun: true, message: '试运行：没动群文件' }
  return { ok: true }
}

/**
 * upload 子命令的门控（纯函数）：往共享空间新增条目，要求这一轮有主人发言；
 * 发文件能力（面板「聊天」页）没开时如实提示。dryRun 由 outbox 兜，这里提前说明。
 */
export function uploadGate({ ownerInTurn, dryRun, filesEnabled }) {
  if (!filesEnabled) return { ok: false, message: '发文件没打开（面板「聊天」页 → 发文件），打开后才能传' }
  if (!ownerInTurn) return { ok: false, message: '只有主人（或主人在这个群里开口）能让我往群文件传东西' }
  if (dryRun) return { ok: false, message: '试运行：没真传，台账会记一条' }
  return { ok: true }
}

export default {
  id: 'group-files',
  name: '群文件',
  version: '1.0.0',
  tab: 'enhance',
  description: '浏览群文件盘、把群文件下载到工作区（qq_group_file browse/download）；主人可开管理（建夹/移动/转存/删除，manage 子命令）',
  defaults: {
    allowManage: false,
    listLimit: 40,
    maxDownloadMB: 100,
  },
  settings: [
    { key: 'allowManage', label: '允许管理', type: 'switch', hint: '开之后主人才可以用 manage 子命令建夹/移动/转存/删除群文件（改的是大家的共享空间，默认关）' },
    { key: 'listLimit', label: '列表最多列几项', type: 'number', min: 5, max: 100, step: 5 },
    { key: 'maxDownloadMB', label: '单文件下载上限 (MB)', type: 'number', min: 1, max: 1024, step: 1 },
  ],
  setup(api) {
    const { onebot, hub } = api.core

    const reg = registerReadActions(['get_group_file_system_info', 'get_group_root_files', 'get_group_files_by_folder'])
    if (reg.rejected.length) api.log.warn(`只读动作登记被拒收：${reg.rejected.join('、')}`)

    const settingsOf = () => {
      const s = api.settings() || {}
      return {
        allowManage: s.allowManage === true,
        listLimit: Math.max(5, Math.min(100, Number(s.listLimit) || 40)),
        maxBytes: Math.max(1, Number(s.maxDownloadMB) || 100) * 1024 * 1024,
      }
    }

    /** 群号解析 + 白名单（browse/download 与 manage 共用）。 */
    function resolveGroup(cfg, chat, requested) {
      const gid = Number(requested || (chat?.kind === 'group' ? chat.groupId : 0))
      if (!gid) return { error: '不知道是哪个群（群聊里用可省略群号）' }
      if (!cfg.allow.groups.includes(String(gid))) return { error: '这个群不在白名单里' }
      return { gid }
    }

    api.tool(({ chat, level, sessionId }) => {
      if (chat.kind === 'system') return []
      return defineTool({
        name: 'qq_group_file',
        description: '群文件盘：browse 浏览目录（只读）、download 把一个群文件下载到工作区再用文件工具读（只读）、upload 把工作区里的文件传进群文件（主人要求时）、manage 建夹/移动/转存/删除（改共享空间，仅主人 + confirm=确认）。默认当前群，别的群要给群号且必须在白名单里。',
        properties: {
          action: { type: 'string', enum: ['browse', 'download', 'upload', 'manage'], description: 'browse 浏览 / download 下载 / upload 上传 / manage 管理' },
          group_id: str('群号；在群聊里用可省略'),
          folder_id: str('browse：要看的目录 id，省略 = 根目录'),
          file_id: str('download/manage：文件 id（browse 结果里方括号里的）'),
          busid: int('download：browse 结果里的 busid 原值（缺了网关会报参数错误）'),
          file: str('upload：工作区里文件的绝对路径（qq_write_file 写的、download 下载的都行）'),
          name: str('upload：传上去显示的文件名；manage mkdir：要建的文件夹名'),
          op: { type: 'string', enum: ['mkdir', 'move', 'trans', 'delete'], description: 'manage 的具体操作' },
          dest_folder_id: str('manage move：目标目录 id'),
          confirm: str('manage：必须写「确认」'),
        },
        execute: async (args) => {
          const cfg = api.config()
          const s = settingsOf()
          const action = String(args.action || 'browse')
          const g = resolveGroup(cfg, chat, args.group_id)
          if (g.error) return { ok: false, message: g.error }
          const gid = g.gid

          if (action === 'browse') {
            const parts = []
            try {
              const info = await onebot.call('get_group_file_system_info', { group_id: gid }, { timeoutMs: 10000 })
              const summary = formatSystemInfo(info)
              if (summary) parts.push(summary)
            } catch { /* 容量拿不到就只列文件 */ }
            const folderId = String(args.folder_id || '').trim()
            const raw = folderId
              ? await onebot.call('get_group_files_by_folder', { group_id: gid, folder_id: folderId }, { timeoutMs: 15000 })
              : await onebot.call('get_group_root_files', { group_id: gid }, { timeoutMs: 15000 })
            const listing = formatDirListing(extractEntries(raw), { limit: s.listLimit })
            parts.push(folderId ? `目录 ${folderId}：\n${listing}` : `根目录：\n${listing}`)
            return { ok: true, message: parts.join('\n') }
          }

          if (action === 'download') {
            const fileId = String(args.file_id || '').trim()
            if (!fileId) return { ok: false, message: 'download 要给 file_id（browse 结果里方括号里的）' }
            // busid 必须用 browse 原值（真机 2026-11-15：缺 busid 网关报参数错误）
            const info = await onebot.call('get_group_file_url', { group_id: gid, file_id: fileId, busid: Number(args.busid) || 0 }, { timeoutMs: 15000 })
            const url = info?.url || info?.file || info?.data?.url
            if (!url) return { ok: false, message: '没能换来下载地址（链接有时效，浏览后尽快下载）' }
            const buf = await fetchImage(url, { maxBytes: s.maxBytes, timeoutMs: 60000 })
            const dir = api.workspaceDir('group-files')
            await mkdir(dir, { recursive: true })
            const name = String(args.name || '').replace(/[\\/:*?"<>|]/g, '_').slice(-100) || `file-${fileId}`
            const file = join(dir, `${Date.now()}-${name}`)
            await writeFile(file, buf)
            return { ok: true, message: `已下载到 ${file}（${humanSize(buf.length)}），可以用文件工具读了` }
          }

          if (action === 'upload') {
            // 上传走 hub.sendFile：它自带目录白名单校验、大小上限、以及网关看不到
            // 本机路径时的 base64 兜底——群聊发文件底层就是 upload_group_file。
            const gate = uploadGate({
              ownerInTurn: api.core.hub.turnHasOwner(sessionId),
              dryRun: Boolean(cfg.dryRun),
              filesEnabled: Boolean(cfg.files?.enabled),
            })
            if (!gate.ok) return { ok: false, message: gate.message }
            const file = String(args.file || '').trim()
            if (!file) return { ok: false, message: 'upload 要给 file（工作区里文件的绝对路径）' }
            const label = String(args.name || '').trim() || file.split(/[\\/]/).pop()
            await hub.sendFile(`group:${gid}`, file, label)
            return { ok: true, message: `已传到群文件：${label}` }
          }

          if (action === 'manage') {
            const gate = manageGate({
              ownerInTurn: api.core.hub.turnHasOwner(sessionId),
              confirm: args.confirm,
              dryRun: Boolean(cfg.dryRun),
              allowManage: s.allowManage,
            })
            if (!gate.ok || gate.dryRun) return { ok: gate.ok, message: gate.message }
            const op = String(args.op || '').trim()
            const fileId = String(args.file_id || '').trim()
            switch (op) {
              case 'mkdir': {
                const name = String(args.name || '').trim()
                if (!name) return { ok: false, message: 'mkdir 要给 name（文件夹名）' }
                await onebot.call('create_group_file_folder', { group_id: gid, name, parent_id: String(args.dest_folder_id || '/') }, { timeoutMs: 15000 })
                return { ok: true, message: `文件夹建好了：${name}` }
              }
              case 'move': {
                if (!fileId) return { ok: false, message: 'move 要给 file_id' }
                await onebot.call('move_group_file', { group_id: gid, file_id: fileId, dest_folder_id: String(args.dest_folder_id || '/') }, { timeoutMs: 15000 })
                return { ok: true, message: '文件移动好了' }
              }
              case 'trans': {
                if (!fileId) return { ok: false, message: 'trans 要给 file_id' }
                await onebot.call('trans_group_file', { group_id: gid, file_id: fileId }, { timeoutMs: 15000 })
                return { ok: true, message: '文件已转存' }
              }
              case 'delete': {
                if (!fileId) return { ok: false, message: 'delete 要给 file_id' }
                await onebot.call('delete_group_file', { group_id: gid, file_id: fileId }, { timeoutMs: 15000 })
                return { ok: true, message: '文件删除了（群文件删除通常不可恢复）' }
              }
              default:
                return { ok: false, message: 'op 要是 mkdir / move / trans / delete' }
            }
          }

          return { ok: false, message: 'action 要是 browse / download / manage' }
        },
      })
    })

    return { formatDirListing, extractEntries, manageGate }
  },
}
