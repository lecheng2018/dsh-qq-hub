// 通用工具审批流（Tool Approval / approval/request）状态机与审批卡系统
//
// 当模型需要执行高权限或敏感工具时（DSH approval/request waterfall）：
// 1. 生成带编号（#1, #2...）的审批卡推送给主人私聊；
// 2. 挂起工具执行等待主人审批决策；
// 3. 校验主人身份与 security-lock（权限锁）；
// 4. 解析「通过 #编号」或「拒绝 #编号」，返回 'allowed-once' 或 'rejected'。

import { redact } from '../core/redact.js'

let nextApprovalId = 1

/**
 * 格式化审批卡文本
 * @param {object} entry 审批条目
 */
export function formatApprovalCard(entry) {
  const parts = []
  parts.push(`📋 待审批操作 #${entry.id}`)
  parts.push(`🔧 工具：${entry.toolName}`)

  if (entry.command) {
    const cmd = String(entry.command).trim()
    parts.push(`💻 命令：${redact(cmd.length > 300 ? cmd.slice(0, 300) + '…' : cmd)}`)
  } else if (entry.args) {
    const raw = typeof entry.args === 'string' ? entry.args : JSON.stringify(entry.args)
    parts.push(`📦 参数：${redact(raw.length > 200 ? raw.slice(0, 200) + '…' : raw)}`)
  }

  if (entry.reason) {
    parts.push(`❓ 原因：${String(entry.reason).trim()}`)
  }

  if (entry.locked) {
    parts.push(`🔒 提示：当前权限锁处于锁定状态，回复前请先发 /unlock 输入动态口令。`)
  }

  parts.push(`\n回复「通过 #${entry.id}」放行，回复「拒绝 #${entry.id}」拦截（60秒内有效）`)
  return parts.join('\n')
}

/**
 * 解析用户在 QQ 里的审批回复
 * @param {string} text 用户回复内容
 * @returns {{ action: 'approve'|'deny', id?: number } | null}
 */
export function parseApprovalCommand(text) {
  const t = String(text || '').trim().toLowerCase()

  // 匹配：通过 #1, 同意 2, 放行, pass 1, yes, ok #3
  const approveMatch = t.match(/^(?:通过|同意|允许|放行|批准|pass|yes|ok|y)\s*(?:#?(\d+))?$/i)
  if (approveMatch) {
    const id = approveMatch[1] ? parseInt(approveMatch[1], 10) : undefined
    return { action: 'approve', id }
  }

  // 匹配：拒绝 #1, 取消 2, 不行, deny 1, no, 别
  const denyMatch = t.match(/^(?:拒绝|取消|不行|拦下|别|deny|no|n)\s*(?:#?(\d+))?$/i)
  if (denyMatch) {
    const id = denyMatch[1] ? parseInt(denyMatch[1], 10) : undefined
    return { action: 'deny', id }
  }

  return null
}

/**
 * 创建审批管理器
 */
export function createApprovalRegistry({ deliver, ownerQQ, securityLock, timeoutMs = 60_000, log } = {}) {
  // id (number) → { id, toolName, reason, command, args, resolve, timer, createdAt, sessionId, chatId }
  const pending = new Map()

  /**
   * 注册一项审批请求并返回 Promise<'allowed-once'|'rejected'>
   */
  async function request(req, { chatId, sessionId, command, args } = {}) {
    const id = nextApprovalId++
    const owner = typeof ownerQQ === 'function' ? ownerQQ() : ownerQQ
    const targetChat = owner ? `private:${owner}` : (chatId || '')

    if (!targetChat) {
      log?.warn?.(`[approvals] 未配置主人 QQ，无法发送审批卡，直接拒绝`)
      return 'rejected'
    }

    const lockState = typeof securityLock === 'function' ? securityLock() : null
    const locked = Boolean(lockState && lockState.locked)

    const entry = {
      id,
      toolName: req.toolName || 'unknown',
      reason: req.reason || '',
      command: command || req.arguments?.command || '',
      args: args || req.arguments || null,
      callId: req.callId,
      sessionId,
      chatId: targetChat,
      locked,
      createdAt: Date.now()
    }

    const cardText = formatApprovalCard(entry)

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        log?.warn?.(`[approvals] 审批超时 #${id} (${entry.toolName})`)
        resolve('rejected')
        if (typeof deliver === 'function') {
          deliver(targetChat, `⏰ 操作 #${id} (${entry.toolName}) 审批已超时，已自动拦截。`).catch(() => {})
        }
      }, timeoutMs)

      // 监听 signal 中止
      if (req.signal) {
        req.signal.addEventListener('abort', () => {
          if (!pending.has(id)) return
          pending.delete(id)
          clearTimeout(timer)
          resolve('cancelled')
        }, { once: true })
      }

      pending.set(id, {
        ...entry,
        resolve,
        timer
      })

      // 即刻发送审批卡给主人
      if (typeof deliver === 'function') {
        Promise.resolve(deliver(targetChat, cardText)).catch((error) => {
          log?.warn?.(`[approvals] 发送审批卡失败:`, error.message)
        })
      }
    })
  }

  /**
   * 尝试处理主人在 QQ 里回复的审批指令
   * @param {string} text 用户输入的文字
   * @param {string} userId 发送者 QQ 号
   * @param {string} chatId 所在会话
   * @returns {boolean} 是否被审批处理器处理
   */
  function handleReply(text, userId, chatId) {
    const owner = typeof ownerQQ === 'function' ? String(ownerQQ()) : String(ownerQQ || '')
    if (owner && String(userId) !== owner) {
      return false
    }

    const parsed = parseApprovalCommand(text)
    if (!parsed) return false

    if (pending.size === 0) {
      return false
    }

    // 匹配待审批条目
    let target = null
    if (parsed.id !== undefined) {
      target = pending.get(parsed.id)
      if (!target) {
        if (typeof deliver === 'function') {
          deliver(chatId, `⚠️ 未找到编号为 #${parsed.id} 的待审批操作（可能已超时或已处理）。`).catch(() => {})
        }
        return true
      }
    } else {
      // 未带编号：不自动选中（审计建议——宽匹配「可以/ok」可能误批别的待办项），
      // 无论几个待审批，都回显编号与工具名让主人确认。
      const lines = [...pending.entries()].map(([i, t]) => `#${i} ${t.toolName || '操作'}`).join('、')
      if (typeof deliver === 'function') {
        deliver(chatId, `⚠️ 当前有待审批操作：${lines}。请指定编号，例如「通过 #${[...pending.keys()][0]}」`).catch(() => {})
      }
      return true
    }

    // 检查权限锁
    if (parsed.action === 'approve') {
      const lockState = typeof securityLock === 'function' ? securityLock() : null
      if (lockState && lockState.locked) {
        if (typeof deliver === 'function') {
          deliver(chatId, `🔒 权限锁当前处于锁定状态！请在私聊中输入 /unlock 完成动态口令验证后再审批。`).catch(() => {})
        }
        return true
      }
    }

    pending.delete(target.id)
    clearTimeout(target.timer)

    if (parsed.action === 'approve') {
      log?.info?.(`[approvals] 主人批准了操作 #${target.id} (${target.toolName})`)
      target.resolve('allowed-once')
      if (typeof deliver === 'function') {
        deliver(chatId, `✅ 已批准操作 #${target.id} (${target.toolName})，继续执行。`).catch(() => {})
      }
    } else {
      log?.info?.(`[approvals] 主人拒绝了操作 #${target.id} (${target.toolName})`)
      target.resolve('rejected')
      if (typeof deliver === 'function') {
        deliver(chatId, `❌ 已拦截操作 #${target.id} (${target.toolName})。`).catch(() => {})
      }
    }

    return true
  }

  /**
   * 取消所有审批
   */
  function clear(reason = '已清空') {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer)
      entry.resolve('cancelled')
    }
    pending.clear()
  }

  return {
    request,
    handleReply,
    clear,
    list: () => [...pending.values()],
    count: () => pending.size
  }
}
