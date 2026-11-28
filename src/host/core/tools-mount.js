// 工具挂载 + 回合入站补水 + 按会话图片额度。
//
// 从 host/modular-core.js 原样搬出（纯结构重构，行为逐行一致）：函数体按行切片搬运，
// 只做一处最小闭包改写 —— 原根作用域的 `outbox` 改成 `getOutbox()` 延迟读取
// （outbox 在装配根里比本模块晚装配，运行时才解析，与拆分前的时序相同）。
//
// 状态表（mountedTools / slowNoticeSent / imageBudget）随实现一起搬进来，但仍以**活引用**
// 交回装配根：session-lifecycle 的 cleanupSession 与核心的 dispose / stats 读写同一份，
// 拆走的是实现，不是状态副本。

import { levelFor } from '../../chat/access.js'
import { readInboundFiles, inboundFileBlocks, inboundFileMaxBytes } from '../../chat/inbound-files.js'
import { neutralizeInboundDsl } from '../../chat/inbound.js'
import { workspaceDirOf } from '../../chat/workspace.js'
import { aclMsgFromInbound } from './inbound-prep.js'

export function createToolsMount({
  getConfig, debug, log, onebot, chatViewFor, buildTools, toolsGeneration, moduleHooks,
  getOutbox, replyIdOf, quotedInfo, quoteNote,
}) {
  /** 每个会话挂一次模块工具（= legacy hub.mount 的工具部分；名字清单变了就整套重挂）。 */
  const mountedTools = new Map() // sessionId -> { agent, key, offs }
  const slowNoticeSent = new Set()

  // ---------- 图片进历史的预算（按会话累计） ----------
  // 服务端对「会话累计上下文 + 图片字节」有硬上限（真机 2026-11-19：413 plugin_request_too_large，
  // 请求约 5.8 MiB、插件内存上限 64 MiB）。关键点：图片块一旦进历史，**之后每一轮都会重新发一遍**，
  // 所以额度得按会话累加着算 —— 每轮重置等于没管。
  //
  // 额度用完后的新图不再进上下文，只留一句占位文字（不说「看不到」是骗人：确实没带进去）。
  // 计数在 admit 之前累加（fail-closed）：admit 失败时那几张图也不会进历史，多算一点更安全。
  //
  // 已知边界：计数在内存里、按 sessionId 记；插件热重载/重启后从 0 重新算（历史里的图说不清大小）。
  // 所以它只是「延缓增长」，兜底仍然是 413 自愈换会话。
  const imageBudget = new Map() // sessionId → { images, bytes }
  const IMAGE_BLOCK_DEFAULT_BYTES = 400 * 1024 // 只有 http(s) 地址、还没下载的图，按 400 KB 估
  const imageBlockBytes = (block) => {
    // 未下载的入站图分两种：已带 data（测试/本地已取字节）、url 是 base64://（内联）。两者都能算准；
    // http(s) 地址此刻还没取字节，只能估 —— 真实字节由 inbound-images 下载后才知道，这里不追着改。
    const encoded = typeof block?.data === 'string' && block.data
      ? block.data
      : typeof block?.url === 'string' && block.url.startsWith('base64://')
        ? block.url.slice('base64://'.length)
        : ''
    if (encoded) return Math.ceil(encoded.length * 3 / 4)
    const n = Number(block?.bytes)
    return Number.isFinite(n) && n > 0 ? n : IMAGE_BLOCK_DEFAULT_BYTES
  }
  /** 按会话额度裁掉超出的图片块；返回裁剪后的内容与本次计入的用量。 */
  function trimToImageBudget(content, sessionId, cfg) {
    const budgetCfg = cfg?.imageBudget
    if (!sessionId || budgetCfg?.enabled === false) return { content, added: { images: 0, bytes: 0 } }
    if (!Array.isArray(content) || !content.some((b) => b?.type === 'image')) return { content, added: { images: 0, bytes: 0 } }
    // 配置可能来自 normalize 之前（老配置文件 / 直接注入的 cfg）：缺字段时按默认额度来，
    // 绝不能因为「没写 imageBudget」就当成 maxImages=0 把所有图都裁掉（那等于凭空关掉看图能力）。
    const maxImages = budgetCfg?.maxImages === undefined ? 24 : Math.max(0, Number(budgetCfg.maxImages) || 0)
    const maxMiB = budgetCfg?.maxMiB === undefined ? 12 : Math.max(0, Number(budgetCfg.maxMiB) || 0)
    const maxBytes = maxMiB * 1024 * 1024
    const used = imageBudget.get(sessionId) || { images: 0, bytes: 0 }
    let images = used.images
    let bytes = used.bytes
    let dropped = 0
    const kept = []
    for (const block of content) {
      if (block?.type !== 'image') { kept.push(block); continue }
      const cost = imageBlockBytes(block)
      // 已经超了就别再加；额度足够才收（同一轮里多张图按顺序收，先到先得）
      if (images + 1 > maxImages || bytes + cost > maxBytes) { dropped++; continue }
      images++
      bytes += cost
      kept.push(block)
    }
    const added = { images: images - used.images, bytes: bytes - used.bytes }
    if (added.images > 0) imageBudget.set(sessionId, { images, bytes })
    if (!dropped) return { content: kept, added }
    kept.push({ type: 'text', text: `（这一轮有 ${dropped} 张图没带进上下文：本会话的图片额度用完了，只看得到文字。想让她看新图，可以让她重开一个会话。）` })
    return { content: kept, added }
  }
  /** 让一个会话的图片额度归零（换会话/重置时调用）。 */
  function resetImageBudget(sessionId) { if (sessionId) imageBudget.delete(String(sessionId)) }

  async function hydrateQuotes(members, chatKey) {
    const out = []
    for (const member of Array.isArray(members) ? members : []) {
      const replyId = replyIdOf(member)
      if (!replyId) { out.push(member); continue }
      const quoted = await quotedInfo(replyId, chatKey)
      const note = quoteNote(quoted)
      out.push({
        ...member,
        quoteNote: note,
        segments: [...(member.segments || []), { type: 'text', data: { text: `\n${note}` } }, ...quoted.media],
      })
    }
    return out
  }

  function mountTools(agent, chatKey, sessionId) {
    slowNoticeSent.delete(sessionId)
    if (typeof buildTools !== 'function') return
    const cfg = getConfig()
    const level = levelFor(cfg, aclMsgFromInbound({ chatKey }))
    if (level === 'chat') return // 系统会话不挂业务工具（同 legacy）
    const parts = String(chatKey).split(':')
    const chat = parts[0] === 'group'
      ? { chatId: chatKey, kind: 'group', groupId: parts[1], userId: '', nickname: '' }
      : { chatId: chatKey, kind: 'private', userId: parts[1], groupId: '', nickname: cfg.ownerName || '' }
    let tools = []
    try { tools = buildTools({ chat, level, sessionId }) || [] } catch (error) { debug(`工具生成失败：${error?.message || error}`); return }
    let gen = 0
    try { gen = typeof toolsGeneration === 'function' ? Number(toolsGeneration()) || 0 : 0 } catch { gen = 0 }
    let denied = []
    try { denied = moduleHooks?.deniedTools?.() || [] } catch {}
    const key = `${tools.map((t) => t.name).sort().join(',')}|gen:${gen}|deny:${[...denied].sort().join(',')}`
    const prev = mountedTools.get(sessionId)
    if (prev && prev.agent === agent && prev.key === key) return
    if (prev) for (const off of prev.offs) { try { off?.() } catch {} }
    const offs = []
    try {
      const off = agent.ctx?.tools?.restrict?.({ deny: denied })
      if (typeof off === 'function') offs.push(off)
    } catch (error) { debug(`联动工具屏蔽失败：${error?.message || error}`) }
    let already = 0
    let failed = 0
    for (const tool of tools) {
      let registration = tool
      if (tool.slow) {
        const { slow, ...base } = tool
        const notice = typeof slow === 'string' ? slow : '好，我这就去做，做完跟你说一声。'
        registration = {
          ...base,
          async execute(args, exec) {
            let fired = false
            const timer = setTimeout(() => {
              if (fired || slowNoticeSent.has(sessionId)) return
              fired = true
              slowNoticeSent.add(sessionId)
              Promise.resolve(getOutbox().request({
                chatKey, sourceModuleId: 'core',
                segments: [{ type: 'text', data: { text: notice } }],
              })).catch((error) => debug(`慢工具提示没发出去：${error?.message || error}`))
            }, 1500)
            timer.unref?.()
            try { return await tool.execute(args, exec) } finally { clearTimeout(timer) }
          },
        }
      }
      try {
        const off = agent.ctx?.tools?.register?.(registration)
        if (typeof off === 'function') offs.push(off)
      } catch (error) {
        const msg = String(error?.message || error)
        if (msg.includes('already registered')) {
          try {
            // 热重载保护：若会话作用域内残留同名工具，从作用域层强制移除旧登记项并重挂新实例
            const scope = agent.ctx?._scope || agent.ctx
            const layer = agent.ctx?.tools?.layers?.peek?.(scope)
            if (layer?.tools?.data?.has?.(tool.name)) {
              layer.tools.data.delete(tool.name)
              const offRetry = agent.ctx?.tools?.register?.(registration)
              if (typeof offRetry === 'function') {
                offs.push(offRetry)
                continue
              }
            }
          } catch {}
          already++
        } else {
          failed++
          debug(`工具 ${tool?.name} 挂载失败：${msg}`)
        }
      }
    }
    mountedTools.set(sessionId, { agent, key, offs })
    debug(`模块工具 → ${chatKey}：新挂 ${offs.length}、已存在 ${already}、失败 ${failed}（清单 ${tools.length} 个）`)
  }

  async function hydrateInboundFiles(members, chatKey) {
    const out = []
    // 入站单文件上限跟随面板里的 files.maxMB（和出站发文件同一个开关，默认 50MB）。
    // 原先这里吃 readInboundFiles 写死的 20MB 默认值，而面板只调得到出站，于是主人发个
    // 37MB 的包会被直接挡在下载前（2026-11-22 实测：「文件太大了（37MB > 20MB）」）。
    const inboundMaxBytes = inboundFileMaxBytes(getConfig())
    for (const member of members) {
      const fileSegments = (member.segments || []).filter((segment) => segment?.type === 'file')
      if (!fileSegments.length) { out.push(member); continue }
      const memberChat = chatViewFor(chatKey, [member])
      const files = await readInboundFiles({
        kind: memberChat.kind, userId: memberChat.userId, groupId: memberChat.groupId, files: fileSegments,
      }, { onebot, workspaceDir: workspaceDirOf(getConfig()), log, maxBytes: inboundMaxBytes })
      if (files.length) log.info(`${chatKey} 收到 ${files.length} 个文件：` + files.map((file) => file.name).join('、'))
      out.push({
        ...member,
        segments: [
          ...(member.segments || []).filter((segment) => segment?.type !== 'file'),
          // 文件块是「抬头 + 正文」一整段，正文是纯入站原文：必须在源头就整块中和，
          // 否则换个下游渲染点（如私聊 steer）就漏出裸 DSL。此处与 groupPromptContent 的
          // inboundFile 落点构成双保险（neutralizeInboundDsl 幂等，不会二次转义）。
          ...inboundFileBlocks(files, member.sender?.nickname || memberChat.userId).map((block) => ({ type: 'text', data: { text: neutralizeInboundDsl(block.text), inboundFile: true } })),
        ],
      })
    }
    return out
  }

  return {
    mountTools, hydrateInboundFiles, hydrateQuotes,
    trimToImageBudget, resetImageBudget, mountedTools, slowNoticeSent,
  }
}
