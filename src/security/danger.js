// 危险终端命令确认（可选保护，默认关）：
// 打开后，她在主人私聊里要执行「删根目录 / 格式化 / 关机 / 下载后直接执行」这类命令时，
// 插件先不发出去，而是给主人 QQ 发一条确认消息；主人回复「确认」才放行，
// 回复「取消」或超时（60 秒）就拦下，并把她实际要执行的命令如实告诉模型。
//
// 为什么放在 tools/pre-execute 这一层：DSH 在工具真正执行前会走这个 waterfall，
// 这里返回 deny 就不会执行，能拿到「命令原文」，比只靠提示词可靠。

import path from 'node:path'
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

function shellCommands (text) {
  const commands = []
  let words = []
  let word = ''
  let started = false
  let quote = ''
  const pushWord = () => {
    if (started) words.push(word)
    word = ''
    started = false
  }
  const pushCommand = () => {
    pushWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") quote = ''
      else word += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = ''
      else if (ch === '\\' && /["\\$`\n]/.test(text[i + 1] || '')) {
        if (text[++i] !== '\n') word += text[i]
      } else word += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (ch === '\\' && i + 1 < text.length) {
      started = true
      if (text[++i] !== '\n') word += text[i]
    } else if (ch === '#' && !started) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++
    } else if (';|&()\n'.includes(ch)) {
      pushCommand()
    } else if (/\s/.test(ch)) {
      pushWord()
    } else {
      word += ch
      started = true
    }
  }
  pushCommand()
  return commands
}

function commandWords (words) {
  let i = 0
  while (i < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) { i++; continue }
    const name = words[i].split('/').pop()
    if (!['sudo', 'env', 'command'].includes(name)) break
    i++
    while (i < words.length && words[i].startsWith('-')) {
      const option = words[i++]
      if (option === '--') break
      if (['-u', '-g', '-h', '-p', '--user', '--group', '--unset'].includes(option)) i++
    }
  }
  return words.slice(i)
}

function rootTarget (target) {
  const normalized = path.posix.normalize(target)
  return normalized === '/' || /^\/\*+\/?$/.test(normalized) || /^(?:~|\$HOME)(?:\/\*?)?$/.test(target)
}

function systemTarget (target) {
  const normalized = path.posix.normalize(target)
  return rootTarget(target) || /^\/(?:etc|usr|bin|sbin|boot|lib|lib64)(?:\/|$)/.test(normalized)
}

function callArguments (text, start, parenthesized) {
  const args = []
  const closing = { '(': ')', '[': ']', '{': '}' }
  const stack = []
  let quote = ''
  let argStart = start
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
    } else if (ch === "'" || ch === '"') {
      quote = ch
    } else if (closing[ch]) {
      stack.push(closing[ch])
    } else if (stack.length && ch === stack[stack.length - 1]) {
      stack.pop()
    } else if (!stack.length && ((parenthesized && ch === ')') || (!parenthesized && (ch === ';' || ch === '\n')))) {
      args.push(text.slice(argStart, i).trim())
      return args
    } else if (!stack.length && ch === ',') {
      args.push(text.slice(argStart, i).trim())
      argStart = i + 1
    }
  }
  if (!parenthesized) args.push(text.slice(argStart).trim())
  return args
}

function literalString (expression) {
  const text = expression.trim()
  const quote = text[0]
  if (quote !== "'" && quote !== '"') return null
  let value = ''
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) value += text[++i]
    else if (text[i] === quote) return text.slice(i + 1).trim() ? null : value
    else value += text[i]
  }
  return null
}

function literalList (expression) {
  const text = expression.trim()
  if (!((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('(') && text.endsWith(')')))) return null
  const args = callArguments(`(${text.slice(1, -1)})`, 1, true).filter(Boolean)
  const values = args.map(literalString)
  return values.every((value) => value !== null) ? values : null
}

function maskStrings (code) {
  let masked = ''
  let quote = ''
  let comment = false
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (comment) {
      if (ch === '\n') { comment = false; masked += '\n' } else masked += ' '
    } else if (quote) {
      masked += ' '
      if (ch === '\\' && i + 1 < code.length) { masked += ' '; i++ }
      else if (ch === quote) quote = ''
    } else if (ch === "'" || ch === '"') {
      quote = ch
      masked += ' '
    } else if (ch === '#') {
      comment = true
      masked += ' '
    } else masked += ch
  }
  return masked
}

function inspectCode (code, language, depth) {
  const masked = maskStrings(code)
  const calls = language === 'python'
    ? /\b(?:os\.(?:system|popen|exec(?:l|le|lp|lpe|v|ve|vp|vpe))|subprocess\.(?:run|call|check_call|check_output|Popen))\s*\(/g
    : /\b(?:system|exec)\b/g
  for (const match of masked.matchAll(calls)) {
    let open = match.index + match[0].length
    if (language === 'perl') while (/\s/.test(code[open] || '')) open++
    const parenthesized = language === 'python' || masked[open] === '('
    const args = callArguments(code, open + (language === 'perl' && parenthesized ? 1 : 0), parenthesized)
    if (!args.length) continue
    const list = literalList(args[0])
    if (list) {
      const danger = inspectWords(list, depth + 1)
      if (danger) return danger
      continue
    }
    const first = literalString(args[0])
    if (first === null) continue
    if (language === 'perl' && args.length > 1) {
      const values = args.map(literalString)
      if (values.every((value) => value !== null)) {
        const danger = inspectWords(values, depth + 1)
        if (danger) return danger
      }
    } else if (/\bos\.exec/.test(match[0]) && args.length > 1) {
      const argv = literalList(args[1])
      const values = args.map(literalString)
      const command = argv ? [first, ...argv.slice(1)] : values.every((value) => value !== null) ? [first, ...values.slice(2)] : null
      if (command) {
        const danger = inspectWords(command, depth + 1)
        if (danger) return danger
      }
    } else {
      const danger = inspectShell(first, depth + 1)
      if (danger) return danger
    }
  }
  return null
}

function inspectWords (input, depth) {
  if (depth > 12) return null
  const words = commandWords(input)
  if (!words.length) return null
  const name = words[0].split('/').pop()
  const args = words.slice(1)
  const normalized = [name, ...args].join(' ')
  for (const rule of DANGER_RULES) {
    const match = rule.re.exec(normalized)
    if (match && match.index === 0) return { label: rule.label }
  }
  if (name === 'rm' && args.some((arg) => arg === '--recursive' || (/^-[^-]+$/.test(arg) && /[rR]/.test(arg))) && args.some(rootTarget)) {
    return { label: '递归删除根目录/盘符' }
  }
  if (name === 'find' && args.includes('-delete')) {
    const paths = []
    for (const arg of args) {
      if (['-H', '-L', '-P'].includes(arg) && !paths.length) continue
      if (arg.startsWith('-') || arg === '!' || arg === '(') break
      paths.push(arg)
    }
    if (paths.some(rootTarget)) return { label: '递归删除根目录' }
  }
  if (name === 'truncate') {
    let zeroSize = false
    const targets = []
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '-s' || arg === '--size') zeroSize = args[++i] === '0' || zeroSize
      else if (arg === '-s0' || arg === '--size=0') zeroSize = true
      else if (arg === '-r' || arg === '--reference') i++
      else if (!arg.startsWith('-')) targets.push(arg)
    }
    if (zeroSize && targets.some(systemTarget)) return { label: '清空根目录/系统文件' }
  }
  if (name === 'chmod' && args.some((arg) => arg === '--recursive' || (/^-[^-]+$/.test(arg) && arg.includes('R'))) && args.some((arg) => /^0*777$/.test(arg)) && args.some(systemTarget)) {
    return { label: '强制改系统目录权限' }
  }
  if (/^(?:ba|da|z|k|a)?sh$/.test(name)) {
    const index = args.findIndex((arg) => arg === '--command' || /^-[^-]*c/.test(arg))
    if (index >= 0 && args[index + 1] !== undefined) return inspectShell(args[index + 1], depth + 1)
  }
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(name)) {
    const index = args.indexOf('-c')
    if (index >= 0 && args[index + 1] !== undefined) return inspectCode(args[index + 1], 'python', depth + 1)
  }
  if (/^perl(?:\d+(?:\.\d+)*)?$/.test(name)) {
    const index = args.findIndex((arg) => /^-[^-]*[eE]$/.test(arg))
    if (index >= 0 && args[index + 1] !== undefined) return inspectCode(args[index + 1], 'perl', depth + 1)
  }
  return null
}

function inspectShell (text, depth = 0) {
  if (depth > 12) return null
  for (const words of shellCommands(text)) {
    const danger = inspectWords(words, depth)
    if (danger) return danger
  }
  return null
}

/** 判断命令是否命中静态危险规则；返回中文标签，否则返回 null。
 *  同时探测部分 shell/解释器包装及编码变形；不能保证识别动态生成的全部命令。 */
export function isDangerousCommand (command) {
  const text = String(command || '')
  if (!text.trim()) return null
  for (const rule of DANGER_RULES) {
    if (rule.re.test(text)) return { label: rule.label }
  }
  const parsed = inspectShell(text)
  if (parsed) return parsed
  // 解码探测：把命令里可还原的片段解出来再判一轮。命中同一条规则，标签标注「变形」。
  for (const variant of decodeVariants(text)) {
    for (const rule of DANGER_RULES) {
      if (rule.re.test(variant)) return { label: rule.label, label2: `${rule.label}（编码/变形绕过）`, obfuscated: true }
    }
    const parsedVariant = inspectShell(variant)
    if (parsedVariant) return { ...parsedVariant, label2: `${parsedVariant.label}（编码/变形绕过）`, obfuscated: true }
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
