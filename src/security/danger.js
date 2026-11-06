// 危险终端命令确认（可选保护，默认关）：
// 打开后，她在主人私聊里要执行「删根目录 / 格式化 / 关机 / 下载后直接执行」这类命令时，
// 插件先不发出去，而是给主人 QQ 发一条确认消息；主人回复「确认」才放行，
// 回复「取消」或超时（60 秒）就拦下，并把她实际要执行的命令如实告诉模型。
//
// 为什么放在 tools/pre-execute 这一层：DSH 在工具真正执行前会走这个 waterfall，
// 这里返回 deny 就不会执行，能拿到「命令原文」，比只靠提示词可靠。

import { isOwner } from '../chat/access.js'

const CONFIRM_RE = /^(确认|确认执行|同意|同意执行|允许|允许执行|可以|执行吧|放行|yes|y|ok)$/i
const CANCEL_RE = /^(取消|取消执行|拒绝|不要|不|不行|别|停|停手|拦下|no|n)$/i

/** 危险命令规则：命中就要求主人确认。宁少勿多——真正致命的那几类，别把正常命令全拦了。 */
const DANGER_RULES = [
  { label: '递归删除根目录/盘符', re: /\brm\s+-[a-z]*(?:rf|fr)[a-z]*\s+(?:\/|~|\$HOME|[a-zA-Z]:[\\/])(?:\s|$|\*)/i },
  { label: '递归删除根目录/盘符', re: /\bRemove-Item\b[^\n]*(-Recurse|-r\b)[^\n]*(-Force|-fo\b)?[^\n]*["']?(?:[a-zA-Z]:[\\/]|\/(?:\s|$)|~)/i },
  { label: '清空磁盘/分区', re: /\b(?:mkfs(?:\.\w+)?|mke2fs|fdisk|parted|diskpart|wipefs)\b/i },
  { label: '格式化磁盘', re: /\bformat\s+[a-zA-Z]:/i },
  { label: '递归删除盘符', re: /\b(?:del|erase)\s+(?:\/[a-z]+\s+)*[a-zA-Z]:[\\/]?(\s|$|\*)/i },
  { label: '递归删除目录', re: /\b(?:rd|rmdir)\s+\/[a-z]*s[a-z]*\s+[a-zA-Z]:[\\/]/i },
  { label: '关闭/重启电脑', re: /\b(?:shutdown|Stop-Computer|Restart-Computer|reboot|halt|poweroff)\b/i },
  { label: '下载后直接执行', re: /(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|k|da)?sh\b/i },
  { label: '下载后直接执行', re: /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*(?:\||>)[^\n]*(?:iex|Invoke-Expression)\b/i },
  { label: '删除卷影副本/引导配置', re: /\b(?:vssadmin\s+delete\s+shadows|bcdedit|wbadmin\s+delete)\b/i },
  { label: '改注册表关键项', re: /\breg\s+(?:add|delete)\s+(?:HKLM|HKEY_LOCAL_MACHINE)\b/i },
  { label: '直接写磁盘', re: /\bdd\s+if=|>\s*\/dev\/(?:sd|nvme|disk)/i },
  { label: '提权/改管理员组', re: /\bnet\s+(?:user\s+\S+\s+\S+\s+\/add|localgroup\s+(?:administrators|admin)\b)/i },
  { label: '强制改系统目录权限', re: /\b(?:takeown|icacls)\s+[^\n]*(?:[a-zA-Z]:\\Windows|\/etc|\/usr|\/bin)\b/i },
  { label: 'chmod 根目录', re: /\bchmod\s+-R\s+777\s+\/(?:\s|$)/i },
  { label: 'forkshell 炸弹', re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/ },
  // pwsh 高频直接执行（1.3.49 补）：iex/iwr 一行流在原规则里要求「同条命令里下载+执行」，
  // 变量中转（$d=iwr …; iex $d）或单独 iex 执行已编码命令漏网——这里直接盯 iex 本体。
  { label: 'pwsh 直接执行下载内容', re: /\b(?:iex|Invoke-Expression)\b/i },
  { label: 'pwsh 绕过执行策略', re: /(?:-ep\b|-ExecutionPolicy\s+(?:Bypass|Unrestricted))/i },
  { label: 'pwsh 隐藏窗口执行', re: /(?:-w\s+(?:hidden|1)\b|-WindowStyle\s+Hidden)/i },
  { label: 'bash 解码后执行', re: /(?:base64|openssl)\s+(?:-d|--decode|-D)[^\n|;]*\|\s*(?:ba|z|k|da)?sh\b/i },
  { label: 'xxd/printf 解码执行', re: /\b(?:xxd\s+-[rp]|printf\s+(?:\\x|0x))[^\n|;]*\|\s*(?:ba|z|k|da)?sh\b/i },
]

/** 判断一条命令是否危险；返回命中的规则（含中文标签），不危险返回 null。
 *  1.3.49 起：明文判完再做一层「解码探测」——base64/hex/拼接变形的命令还原后再判一遍，
 *  绕过姿势（`echo cm0gLXJmIC8= | base64 -d | sh`、`\rm -rf /`、`r''m -rf /`、`$(printf ...) | sh`）不再漏网。 */
export function isDangerousCommand (command) {
  const text = String(command || '')
  if (!text.trim()) return null
  for (const rule of DANGER_RULES) {
    if (rule.re.test(text)) return { label: rule.label }
  }
  // 解码探测：把命令里可还原的片段解出来再判一轮。命中同一条规则，标签标注「变形」。
  for (const variant of decodeVariants(text)) {
    for (const rule of DANGER_RULES) {
      if (rule.re.test(variant)) return { label: rule.label, label2: `${rule.label}（编码/变形绕过）`, obfuscated: true }
    }
  }
  return null
}

/**
 * 从命令里挖出可能的「隐藏载荷」并还原：base64 / hex / $'\x..' 拼接 / 反斜杠插空。
 * 只做探测用——解出来的文本不执行，只喂给同一套规则再判一遍。宁多勿漏（这里只影响是否要确认）。
 */
export function decodeVariants (command) {
  const text = String(command || '')
  const out = new Set()

  // 1) base64：命令里出现的 base64 样式长串（含 -d/--decode 上下文更可疑，但无上下文也探）
  for (const m of text.matchAll(/[A-Za-z0-9+/=]{16,}/g)) {
    try {
      const decoded = Buffer.from(m[0].replace(/=+$/, ''), 'base64').toString('utf8')
      // 还原结果要有可打印主体才算（乱码说明不是 base64 文本）
      const printable = decoded.replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '')
      if (decoded.length >= 4 && printable.length >= decoded.length * 0.7) out.add(decoded)
    } catch {}
  }
  // 2) hex：\x##、0x## 连续串、以及 $'\x2frm\x20-rf' 这类 ANSI-C 拼接
  const hexRuns = []
  for (const m of text.matchAll(/(?:\\x[0-9a-fA-F]{2}){3,}/g)) {
    hexRuns.push(m[0].replace(/\\x/g, ''))
  }
  for (const m of text.matchAll(/\b[0-9a-fA-F]{16,}\b/g)) {
    if (m[0].length % 2 === 0) hexRuns.push(m[0])
  }
  for (const hex of hexRuns) {
    try {
      const decoded = Buffer.from(hex, 'hex').toString('utf8')
      const printable = decoded.replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '')
      if (decoded.length >= 4 && printable.length >= decoded.length * 0.7) out.add(decoded)
    } catch {}
  }
  // 3) 反斜杠插空 / shell 引号拆词（\rm、r''m、r"m" -rf）：剥掉反斜杠和空引号对还原
  const stripped = text.replace(/\\([a-zA-Z./-])/g, '$1').replace(/''|""|''''|""""/g, '')
  if (stripped !== text) out.add(stripped)
  // 4) printf/echo 拼接执行：把管道右侧是否接 sh/iex 的判定交给规则本身——
  //    这里只补一个「管道右边还原后的整段」不需要，规则已覆盖 | sh / iex。
  return [...out]
}

const clip = (text, n = 300) => (text.length > n ? text.slice(0, n) + '…' : text)

/**
 * 危险命令确认器。host 负责把 DSH 的 tools/pre-execute 和 QQ 私聊回复接进来。
 * @param {object} o
 * @param {() => object} o.getConfig 读最新配置（每次工具调用都重新判断开关）
 * @param {(chatId:string, text:string) => Promise<any>} o.deliver 发 QQ 消息（主人私聊）
 * @param {(sessionId:string) => string} o.chatOfSession DSH session → QQ chatId
 * @param {() => string} o.ownerQQ 主人 QQ 号
 * @param {number} [o.timeoutMs] 等确认的超时（默认 60 秒）
 * @param {() => ({ locked: boolean, remainingMin: () => number }|null)} [o.securityLock] 权限锁（没启用时为 null）
 * @param {object} [o.log]
 */
export function createDangerGuard ({ getConfig, deliver, chatOfSession, ownerQQ, timeoutMs = 60_000, securityLock, log } = {}) {
  const pending = new Map() // chatId → { resolve, timer }

  function cleanup (chatId, value) {
    const p = pending.get(chatId)
    if (!p) return false
    pending.delete(chatId)
    clearTimeout(p.timer)
    p.resolve(value)
    return true
  }

  /**
   * 工具执行前：命中危险规则就发 QQ 问主人，等回复；确认才放行。
   * next() 返回 allow；返回 deny 时 DSH 会把 reason 给模型。
   */
  async function preExecute (exec, next) {
    const cfg = getConfig() || {}
    if (!cfg.security || cfg.security.dangerConfirm !== true) return next()
    const tool = String(exec && exec.name || '')
    if (tool !== 'bash' && tool !== 'pwsh') return next()
    const command = String(exec.arguments && exec.arguments.command || '')
    const danger = isDangerousCommand(command)
    if (!danger) return next()
    // 权限锁优先：锁着的时候，危险命令连「发确认」这一步都不给，直接拦下，
    // 提示主人先在私聊里 /unlock（手机 TOTP 口令），免得手机不在身边被人绕过确认。
    const lock = typeof securityLock === 'function' ? securityLock() : null
    if (lock && lock.locked) {
      log?.warn?.(`权限锁拦下危险命令（${danger.label}）：${clip(command, 120)}`)
      return {
        kind: 'deny',
        reason: `权限锁锁着，这条危险命令（${danger.label}）不放行。请主人在私聊里发 /unlock，用手机上的 6 位口令解锁后再试。`
      }
    }
    const sessionId = exec.agent && exec.agent.session && exec.agent.session.id
    const chatId = chatOfSession ? String(chatOfSession(sessionId) || '') : ''
    const owner = String(ownerQQ ? ownerQQ() : '')
    const ownerChat = owner ? `private:${owner}` : ''
    // 只有主人私聊可能有终端工具；别的会话真调到了就直接拦（不打扰主人）
    if (!chatId || chatId !== ownerChat) {
      log?.warn?.(`危险命令已拦下（非主人私聊 ${chatId || '未知'}）：${clip(command, 120)}`)
      return { kind: 'deny', reason: `这条命令被安全策略拦下了（${danger.label}）：只有主人私聊里、并且经过主人确认才能执行。` }
    }
    // 同一个人已经在等确认：别再发第二条，直接拦
    if (pending.has(chatId)) {
      return { kind: 'deny', reason: `上一条危险命令还在等主人确认（${danger.label}），这条先不执行。` }
    }
    const seconds = Math.max(1, Math.round(timeoutMs / 1000))
    const question = [
      `⚠️ 危险命令确认（${danger.label}）`,
      clip(command, 260),
      `回复「确认」执行，回复「取消」拦下；${seconds} 秒内没回也会拦下。`,
    ].join('\n')
    let ok = false
    try {
      const asked = new Promise((resolve) => {
        // 注意别 unref：系统就在等这个确认（工具调用被挂住），计时器必须撑着
        const timer = setTimeout(() => { cleanup(chatId, false); log?.warn?.(`危险命令确认超时，已拦下：${clip(command, 120)}`) }, timeoutMs)
        pending.set(chatId, { resolve, timer })
      })
      ;(async () => { try { await deliver(ownerChat, question) } catch (error) { log?.warn?.('危险命令确认消息没发出去：', error.message); cleanup(chatId, false) } })()
      ok = await asked
    } catch (error) {
      log?.warn?.('危险命令确认出错：', error.message)
      ok = false
    }
    if (ok) {
      log?.info?.(`主人确认执行危险命令（${danger.label}）：${clip(command, 120)}`)
      return next()
    }
    log?.info?.(`主人没确认危险命令（${danger.label}），已拦下：${clip(command, 120)}`)
    return { kind: 'deny', reason: `危险命令被主人拦下了（${danger.label}）：主人没有回复「确认」。要执行的话，请主人在私聊里回复「确认」后再试；也可以换个安全的做法。` }
  }

  /**
   * 处理主人 QQ 私聊回复。命中的确认/取消返回 true（这条消息被消费，不再交给她）；
   * 其它消息返回 false，照常走原来的聊天流程。
   */
  function handleReply (chatId, userId, text) {
    if (!pending.has(String(chatId || ''))) return false
    const owner = String(ownerQQ ? ownerQQ() : '')
    if (!isOwner({ ownerQQ: owner }, userId)) return false
    const t = String(text || '').trim()
    if (CONFIRM_RE.test(t)) return cleanup(String(chatId), true)
    if (CANCEL_RE.test(t)) return cleanup(String(chatId), false)
    return false
  }

  return {
    preExecute,
    handleReply,
    /** 等确认中的数量（测试/排查用） */
    get pendingCount () { return pending.size },
  }
}
