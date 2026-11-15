// 内置模块：闪传。读懂别人发来的 QQ 闪传（文件清单进她的上下文）；主人可让她把闪传文件
// 下载到工作区、把收到过的闪传转发给白名单里的会话。
//
// 接线方式（刻意不在老文件上堆代码）：
//   · 闪传段不入 parseMessageEvent 主干 —— 这里自己从 msg.raw 里抽（segmentsOf 是现成的纯函数）；
//   · 只读动作在本模块 setup 里 registerReadActions 登记进 ./onebot/read-actions.js，
//     client.js 不需要为闪传改一行；
//   · send_flash_msg 命中 modules.js 的 send|upload 路由，自动进统一 Outbox（台账/dryRun 生效）。
//
// 内存纪律：recent 表有界（50 条）+ 5 分钟过期，存的是文件清单文本（几百字节级），不存文件内容；
// 下载一律按需触发（工具/命令），绝不在事件里自动拖文件。

import { defineTool, str } from '../../tools/tools.js'
import { segmentsOf } from '../../chat/inbound.js'
import { registerReadActions } from '../../onebot/read-actions.js'
import {
  flashShareInfo, formatFlashFileList, formatFlashDownloadResult,
  resolveFlashFileset, downloadFlashFileset,
} from '../../chat/flash-transfer.js'

/** recent 表容量上限（超出丢最旧的）。 */
const RECENT_CAP = 50
/** recent 过期时间：闪传链接有时效，清单放太久没意义。 */
const RECENT_TTL_MS = 5 * 60_000

export default {
  id: 'flash-transfer',
  name: '闪传',
  version: '1.0.0',
  tab: 'enhance',
  description: '别人发来的 QQ 闪传能看到文件清单；主人可让她下载到工作区（qq_flash_download）、把收到过的闪传转发给白名单会话（qq_flash_forward）、/闪传 命令按分享码查',
  defaults: {
    autoList: true,     // 把清单自动塞进她的上下文（关掉后只有占位文本）
    maxListFiles: 8,    // 上下文里最多列几个文件
    maxDownloadFiles: 5, // 一次下载最多拖几个文件
    maxBytesMB: 100,    // 单文件下载上限
  },
  settings: [
    { key: 'autoList', label: '自动看清单', type: 'switch', hint: '收到闪传时把文件清单（名字/大小）自动给她看，她才知道能下载。关掉后只有「[闪传文件]」占位' },
    { key: 'maxListFiles', label: '清单最多列几个', type: 'number', min: 1, max: 20, step: 1 },
    { key: 'maxDownloadFiles', label: '一次最多下载几个', type: 'number', min: 1, max: 20, step: 1 },
    { key: 'maxBytesMB', label: '单文件下载上限 (MB)', type: 'number', min: 1, max: 1024, step: 1 },
  ],
  setup(api) {
    const { onebot } = api.core

    // 只读动作登记进统一白名单（client.js 零改动）。拒收名单如实记日志。
    const reg = registerReadActions(['get_fileset_id', 'get_flash_file_list', 'download_fileset'])
    if (reg.rejected.length) api.log.warn(`只读动作登记被拒收（前缀不在允许列表）：${reg.rejected.join('、')}`)

    const settingsOf = () => {
      const s = api.settings() || {}
      return {
        autoList: s.autoList !== false,
        maxListFiles: Math.max(1, Math.min(20, Number(s.maxListFiles) || 8)),
        maxDownloadFiles: Math.max(1, Math.min(20, Number(s.maxDownloadFiles) || 5)),
        maxBytes: Math.max(1, Number(s.maxBytesMB) || 100) * 1024 * 1024,
      }
    }

    /** chatId → { files:[{name,size}], title, at }。有界 + 过期，只在 message 里写、prompt 里消费。 */
    const recent = new Map()
    const noteRecent = (chatId, entry) => {
      const now = Date.now()
      for (const [key, value] of recent) if (now - value.at > RECENT_TTL_MS) recent.delete(key)
      while (recent.size >= RECENT_CAP) {
        const oldest = recent.keys().next().value
        recent.delete(oldest)
      }
      recent.set(chatId, { ...entry, at: now })
    }
    api.onDispose?.(() => recent.clear())

    /** 从一条消息里抽闪传段（msg.raw 原文，不经主干解析）。 */
    const flashSegmentsOf = (msg) => {
      try {
        return segmentsOf(msg?.raw).filter((seg) => seg?.type === 'flash_file')
      } catch { return [] }
    }

    // 只看不接管：把本条消息里的闪传记下来，供 prompt 接线用。返回 false = 不抢处理权。
    api.on('message', (msg) => {
      try {
        const segs = flashSegmentsOf(msg)
        if (!segs.length) return false
        const files = []
        let title = ''
        for (const seg of segs) {
          const info = flashShareInfo(seg.data)
          if (info.title && !title) title = info.title
          if (info.filesetId || info.shareCode) {
            files.push({ name: info.title || info.filesetId || info.shareCode, ...(info.filesetId ? { filesetId: info.filesetId } : {}), ...(info.shareCode ? { shareCode: info.shareCode } : {}) })
          }
        }
        if (files.length) noteRecent(msg.chatId, { files, title })
      } catch (error) {
        api.log.debug('闪传段收集失败（忽略）：', error?.message || error)
      }
      return false
    })

    // 她的上下文接线：本轮 prompt 里补一份文件清单（消费即清，绝不重复注入）。
    api.on('prompt', (content, { chat } = {}) => {
      try {
        if (!settingsOf().autoList || !Array.isArray(content)) return
        const rec = recent.get(chat?.chatId)
        if (!rec) return
        recent.delete(chat.chatId)
        const list = formatFlashFileList(rec.files, { limit: settingsOf().maxListFiles })
        if (!list) return
        const hint = rec.files.some((f) => f.filesetId || f.shareCode)
          ? '；主人要文件时用 qq_flash_download 下载到工作区'
          : ''
        content.push({ type: 'text', text: `【对方发来闪传${rec.title ? `「${rec.title}」` : ''}，文件清单：\n${list}\n${hint}】` })
      } catch (error) {
        api.log.debug('闪传清单注入失败（忽略）：', error?.message || error)
      }
    })

    /** 统一的解析入口：share_code / fileset_id 二选一 → { filesetId, files }。 */
    async function resolve(args) {
      const s = settingsOf()
      return resolveFlashFileset({
        onebot,
        shareCode: args.share_code || args.shareCode,
        filesetId: args.fileset_id || args.filesetId,
      })
    }

    // 主人私聊工具：按分享码/文件集 id 下载到工作区
    api.tool(({ chat, level }) => {
      if (level !== 'full') return []
      return defineTool({
        name: 'qq_flash_download',
        description: '把一个 QQ 闪传（分享码或文件集 id）的文件下载到本机工作区，之后就能用文件工具读。只有主人让你下的时候用。',
        properties: {
          share_code: str('闪传分享码（和 fileset_id 二选一）'),
          fileset_id: str('文件集 id（收到过的闪传可以直接传这个，不用分享码）'),
        },
        execute: async (args) => {
          if (!args.share_code && !args.fileset_id) return { ok: false, message: '要给 share_code 或 fileset_id 之一' }
          const s = settingsOf()
          const { filesetId, files } = await resolve(args)
          if (!files.length) return { ok: true, message: '文件集认出来了，但网关没给出文件清单' }
          const results = await downloadFlashFileset({
            onebot, dir: api.workspaceDir('flash'), filesetId,
            maxFiles: s.maxDownloadFiles, maxBytes: s.maxBytes,
          })
          const text = formatFlashDownloadResult(results)
          return { ok: true, message: `文件集 ${filesetId}（${files.length} 个文件）：\n${text || '（网关没给可下载直链）'}` }
        },
      })
    })

    // 主人私聊工具：把收到过的闪传转发给白名单里的会话
    api.tool(({ chat, level }) => {
      if (level !== 'full') return []
      return defineTool({
        name: 'qq_flash_forward',
        description: '把一个闪传（文件集）转发到某个 QQ 会话。target 写 private:QQ号 或 group:群号；只能发白名单里的人和群。文件集必须先拿到（收到过或用分享码换过）。',
        properties: {
          fileset_id: str('文件集 id'),
          share_code: str('只有分享码时先填这个，会先换成文件集'),
          target: str('private:QQ号 或 group:群号'),
        },
        required: ['target'],
        execute: async (args) => {
          const cfg = api.config()
          const [kind, id] = String(args.target || '').split(':')
          const okList = kind === 'group' ? cfg.allow.groups : kind === 'private' ? [cfg.ownerQQ, ...cfg.allow.private] : []
          if (!okList.includes(String(id))) return { ok: false, message: '不在白名单里，不能发' }
          const { filesetId } = await resolve(args)
          // send_ 前缀动作：api.onebot 自动转进统一 Outbox（台账/dryRun/身份闸都生效）
          const params = { fileset_id: filesetId, ...(kind === 'group' ? { group_id: Number(id) } : { user_id: Number(id) }) }
          // send_ 前缀动作：api.onebot 自动转进统一 Outbox（台账/dryRun/身份闸都生效）；
          // 被闸拦下（试运行/总开关/泄露闸）返回空，如实告知而不是谎报成功。
          const r = await api.onebot('send_flash_msg', params, { timeoutMs: 30000 })
          if (!r) return { ok: false, message: '没发出去（被试运行/总开关/出站闸拦下），台账已记' }
          return { ok: true, message: `闪传转发出去了（文件集 ${filesetId}）` }
        },
      })
    })

    // 主人命令：/闪传 <分享码或文件集id> —— 只看清单不下载（下载走工具，避免命令里拖大文件）
    api.command({
      name: '闪传',
      desc: '查一个闪传的文件清单（分享码或文件集 id）',
      run: async (arg) => {
        const code = String(arg || '').trim()
        if (!code) return '用法：/闪传 <分享码或文件集id>'
        try {
          const { filesetId, files } = await resolve({ share_code: code, fileset_id: code })
          const list = formatFlashFileList(files, { limit: settingsOf().maxListFiles })
          return `文件集 ${filesetId}（${files.length} 个文件）：\n${list || '（网关没给出清单）'}\n要下载就在对话里让我用 qq_flash_download。`
        } catch (error) {
          return `没查到：${String(error?.message || error).slice(0, 120)}`
        }
      },
    })

    // 导出给别的模块/测试：纯编排（网关注入式），不含任何状态
    return { resolve: resolveFlashFileset, download: downloadFlashFileset }
  },
}
