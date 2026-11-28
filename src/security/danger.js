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
  { label: '关闭/重启电脑', re: /\b(?:shutdown|Stop-Computer|Restart-Computer|reboot|halt|poweroff)(?:\s|$)/i },
  { label: '删除卷影副本/引导配置', re: /\b(?:vssadmin\s+delete\s+shadows|bcdedit|wbadmin\s+delete)\b/i },
  { label: '改注册表关键项', re: /\breg\s+(?:add|delete)\s+(?:HKLM|HKEY_LOCAL_MACHINE)\b/i },
  { label: '直接写磁盘', re: /\bdd\s+if=/i },
  { label: '提权/改管理员组', re: /\bnet\s+(?:user\s+\S+\s+\S+\s+\/add|localgroup\s+(?:administrators|admin)\b)/i },
  { label: '强制改系统目录权限', re: /\b(?:takeown|icacls)\s+[^\n]*(?:[a-zA-Z]:\\Windows|\/etc|\/usr|\/bin)\b/i },
  { label: 'chmod 根目录', re: /\bchmod\s+-R\s+777\s+\/(?:\s|$)/i },
  { label: 'pwsh 直接执行下载内容', re: /\b(?:iex|Invoke-Expression)(?:\s|$)/i },
  // 管道、重定向、解释器选项由结构检查处理，不能在拼接后的参数里扫描。

]

// A bounded lexical view, not a complete shell parser. Keep argument data separate
// from operators and expansions; never evaluate the supplied command.
function isProcessSubstitution (text, start) {
  return (text[start] === '<' || text[start] === '>') && text[start + 1] === '('
}

function substitutionAt (text, start, depth = 0) {
  if (depth > 12) return null
  const backtick = text[start] === '`'
  const processSubstitution = isProcessSubstitution(text, start)
  if (!backtick && !processSubstitution && !text.startsWith('$(', start)) return null
  const begin = start + (backtick ? 1 : 2)
  let quote = ''
  let nesting = 1
  for (let i = begin; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && quote !== "'") { i++; continue }
    if (backtick) {
      if (ch === '`') return { code: text.slice(begin, i), end: i, processSubstitution }
      continue
    }
    if (quote === "'") { if (ch === "'") quote = ''; continue }
    if (ch === '`' || text.startsWith('$(', i) || (!quote && isProcessSubstitution(text, i))) {
      const nested = substitutionAt(text, i, depth + 1)
      if (nested) { i = nested.end; continue }
    }
    if (quote === '"') { if (ch === '"') quote = ''; continue }
    if (ch === '#' && (i === begin || /[\s;|&()<>]/.test(text[i - 1]))) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++
    } else if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(') nesting++
    else if (ch === ')' && --nesting === 0) return { code: text.slice(begin, i), end: i, processSubstitution }
  }
  return null
}

function shellCommands (text) {
  const commands = []
  let words = []
  let substitutions = []
  let redirects = []
  let redirect = false
  let word = ''
  let started = false
  let quote = ''
  let ansi = false
  const pushWord = () => {
    if (started) {
      if (redirect) { redirects.push(word); redirect = false } else words.push(word)
    }
    word = ''
    started = false
  }
  const pushCommand = (operator = '') => {
    pushWord()
    if (words.length || substitutions.length || redirects.length) commands.push({ words, substitutions, redirects, operator })
    words = []
    substitutions = []
    redirects = []
    redirect = false
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") { quote = ''; ansi = false }
      else if (ansi && ch === '\\' && /^x[\da-f]{2}/i.test(text.slice(i + 1))) {
        word += String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16)); i += 3
      } else word += ch
      continue
    }
    // Process substitutions are single outer words, not command separators.
    // Unlike $(), <(...) and >(...) inside quotes are literal text.
    if (ch === '`' || text.startsWith('$(', i) || (!quote && isProcessSubstitution(text, i))) {
      const sub = substitutionAt(text, i)
      if (sub) {
        const token = `__QQ_SUB_${substitutions.length}__`
        substitutions.push({ ...sub, token })
        word += token
        started = true
        i = sub.end
        continue
      }
    }
    if (quote === '"') {
      if (ch === '"') quote = ''
      else if (ch === '\\' && /["\\$`\n]/.test(text[i + 1] || '')) {
        if (text[++i] !== '\n') word += text[i]
      } else word += ch
      continue
    }
    if (ch === '$' && text[i + 1] === "'") {
      ansi = true; quote = "'"; started = true; i++
    } else if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (ch === '\\' && i + 1 < text.length) {
      started = true
      // Preserve Windows paths and printf escapes for their respective rules.
      if (/^(?:[a-z]:|HKLM|HKEY_)/i.test(word) || text[i + 1] === 'x') word += ch
      else if (text[++i] !== '\n') word += text[i]
    } else if (ch === '#' && !started) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++
    } else if (ch === '>') {
      pushWord(); redirect = true
      if (text[i + 1] === '>') i++
    } else if (';|&()\n'.includes(ch)) {
      const double = (ch === '|' || ch === '&') && text[i + 1] === ch
      pushCommand(double ? ch + ch : ch)
      if (double) i++
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

const WRAPPER_OPTS_WITH_ARG = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-T', '-r', '-t', '--user', '--group', '--host', '--prompt']),
  // -S / --split-string 会把一个字符串重新拆成 argv（等价于再执行一段命令），
  // 必须在 commandWords 里展开后继续检查，不能当普通「带值选项」跳过。
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  command: new Set([]),
  nohup: new Set([]),
  timeout: new Set(['-k', '-s', '--kill-after', '--signal']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata']),
  time: new Set(['-f', '-o', '--format', '--output']),
  exec: new Set(['-a']),
  builtin: new Set([]),
  setsid: new Set([]),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  busybox: new Set([]),
  xargs: new Set(['-I', '-n', '-P', '-d', '-L', '-s', '-a', '-E', '-J', '--max-args', '--max-procs', '--delimiter', '--max-lines', '--max-chars', '--arg-file', '--eof', '--replace']),
  // chrt / taskset 的 -p / -c 是「纯开关」，优先级/掩码是位置参数，由下面统一跳一个位置参数处理。
  chrt: new Set([]),
  taskset: new Set([]),
}

function commandWords (input) {
  // env -S 需要把 payload 拆回单词插进队列，所以这里用可重写的副本
  let words = input.slice()
  let i = 0
  while (i < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) { i++; continue }
    if (['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{'].includes(words[i])) { i++; continue }
    const name = words[i].split('/').pop()
    const optsWithArg = WRAPPER_OPTS_WITH_ARG[name]
    if (!optsWithArg) break
    i++
    while (i < words.length && words[i].startsWith('-')) {
      const option = words[i++]
      if (option === '--') break
      // 单字符选项可合并写法（如 -0n5、-c0）：取首字符判断是否需要消费下一个参数。
      // 但「值已内联」的形式（-n1、-I{}、--user=root）不能再吞掉后面的词，否则会把真正的命令吃掉。
      const eq = option.indexOf('=')
      const flag = option.startsWith('--')
        ? (eq >= 0 ? option.slice(0, eq) : option)
        : option.slice(0, 2)
      // env -S "rm -rf /" / env --split-string="rm -rf /"：把 payload 拆回单词重新入队
      if (name === 'env' && /^(?:-S|--split-string)$/i.test(flag)) {
        const payload = eq >= 0 ? option.slice(eq + 1) : words[i++]
        if (payload !== undefined) {
          const parts = String(payload).split(/\s+/).filter(Boolean)
          words = [...words.slice(0, i), ...parts, ...words.slice(i)]
        }
        continue
      }
      const inlineValue = eq >= 0 || (!option.startsWith('--') && option.length > 2)
      if (!inlineValue && (optsWithArg.has(option) || optsWithArg.has(flag))) i++
    }
    // timeout [opts] <duration> <cmd...>：跳掉必选的时长位置参数
    if (name === 'timeout' && i < words.length) i++
    // chrt [opts] <prio> <cmd...>：-p 是「显示/设置调度策略」开关（chrt -p 1 中 1 是优先级）
    if (name === 'chrt' && i < words.length) i++
    // taskset [opts] <mask> <cmd...>：-c 是「指定 CPU」开关（taskset -c 0 中 0 是 CPU 掩码）
    if (name === 'taskset' && i < words.length) i++
    // xargs [opts] <cmd...>：这里不能提前 return，否则 `xargs sudo rm -rf /` 只看到
    // `sudo ...` 就被当成一条普通命令，后续的 env/timeout 等包装器不会被继续剥离。
    // 剥掉 xargs 自身选项后让外层 while 继续处理下一层包装器即可。
  }
  return words.slice(i)
}

function rootTarget (target) {
  const normalized = path.posix.normalize(target)
  return normalized === '/' || /^\/\*+\/?$/.test(normalized) || /^(?:~|\$HOME)(?:\/\*?)?$/.test(target)
}

function systemTarget (target) {
  if (!target || target.startsWith('-')) return false
  const normalized = path.posix.normalize(target)
  return rootTarget(target) || /^\/(?:etc|usr|bin|sbin|boot|lib|lib64)(?:\/|$)/.test(normalized)
}

function shellCommandArg (args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') return null
    if (arg === '--command' || /^-[^-]*c/.test(arg)) {
      let j = i + 1
      while (j < args.length && args[j] === '--') j++
      return j < args.length ? args[j] : null
    }
  }
  return null
}

function evalArgsText (args) {
  let start = 0
  while (start < args.length && args[start] === '--') start++
  return args.slice(start).join(' ')
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
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  let value = ''
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) value += text[++i]
    else if (text[i] === quote) {
      if (text.slice(i + 1).trim()) return null
      if (quote === '`' && value.includes('${')) return null
      return value
    } else value += text[i]
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

function maskStrings (code, language = 'shell') {
  let masked = ''
  let quote = ''
  let lineComment = false
  let blockComment = false
  const isJs = language === 'node'
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (blockComment) {
      if (ch === '*' && code[i + 1] === '/') { blockComment = false; masked += '  '; i++ }
      else masked += ch === '\n' ? '\n' : ' '
    } else if (lineComment) {
      if (ch === '\n') { lineComment = false; masked += '\n' } else masked += ' '
    } else if (quote) {
      masked += ' '
      if (ch === '\\' && i + 1 < code.length) { masked += ' '; i++ }
      else if (ch === quote) quote = ''
    } else if (ch === "'" || ch === '"' || (isJs && ch === '`')) {
      quote = ch
      masked += ' '
    } else if (isJs && ch === '/' && code[i + 1] === '/') {
      lineComment = true
      masked += '  '
      i++
    } else if (isJs && ch === '/' && code[i + 1] === '*') {
      blockComment = true
      masked += '  '
      i++
    } else if (!isJs && ch === '#') {
      lineComment = true
      masked += ' '
    } else masked += ch
  }
  return masked
}

function inspectCode (code, language, depth) {
  const masked = maskStrings(code, language)
  if (language === 'node') {
    const execCalls = /\b(?:execSync|exec|spawnSync|spawn|execFileSync|execFile)\s*\(/g
    for (const match of masked.matchAll(execCalls)) {
      const fn = match[0].replace(/\s*\($/, '')
      const args = callArguments(code, match.index + match[0].length, true)
      if (!args.length) continue
      const first = literalString(args[0])
      if (first === null) continue
      if (fn === 'exec' || fn === 'execSync') {
        const danger = inspectShell(first, depth + 1)
        if (danger) return danger
      } else {
        const argv = args.length > 1 ? literalList(args[1]) : null
        const danger = argv ? inspectWords([first, ...argv], depth + 1) : inspectShell(first, depth + 1)
        if (danger) return danger
      }
    }
    const fsDeleteCalls = /\b(?:rmSync|rm|rmdirSync|rmdir|unlinkSync|unlink|truncateSync|truncate)\s*\(/g
    for (const match of masked.matchAll(fsDeleteCalls)) {
      const args = callArguments(code, match.index + match[0].length, true)
      const first = args.length ? literalString(args[0]) : null
      if (first !== null && systemTarget(first)) return { label: '递归删除根目录/系统目录' }
    }
    return null
  }
  if (language === 'python') {
    for (const match of masked.matchAll(/\b(?:shutil\.)?rmtree\s*\(/g)) {
      const args = callArguments(code, match.index + match[0].length, true)
      const first = args.length ? literalString(args[0]) : null
      if (first !== null && systemTarget(first)) return { label: '递归删除根目录/系统目录' }
    }
  }
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

const FIND_EXEC_OPTS = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/** find 的搜索路径（跳过 -H/-L/-P 与首个 -option 之前的位置参数）。 */
function findPaths (args) {
  const paths = []
  for (const arg of args) {
    if (['-H', '-L', '-P'].includes(arg) && !paths.length) continue
    if (arg.startsWith('-') || arg === '!' || arg === '(') break
    paths.push(arg)
  }
  return paths
}

function inspectWords (input, depth) {
  if (depth > 12) return null
  const words = commandWords(input)
  if (!words.length) return null
  const name = words[0].split('/').pop()
  const args = words.slice(1)
  if (name === 'eval') {
    const script = evalArgsText(args)
    return script ? inspectShell(script, depth + 1) : null
  }
  const normalized = [name, ...args].join(' ')
  for (const rule of DANGER_RULES) {
    const match = rule.re.exec(normalized)
    if (match && match.index === 0) return { label: rule.label }
  }
  if (name === 'rm' && args.some((arg) => arg === '--recursive' || (/^-[^-]+$/.test(arg) && /[rR]/.test(arg))) && args.some(systemTarget)) {
    return { label: '递归删除根目录/盘符' }
  }
  if (name === 'find' && args.includes('-delete')) {
    if (findPaths(args).some(systemTarget)) return { label: '递归删除根目录/系统目录' }
  }
  if (name === 'find') {
    // find -exec/-execdir/-ok/-okdir 后面到 ';' / '+' 之间是真正被执行的命令
    const execIndex = args.findIndex((arg) => FIND_EXEC_OPTS.has(arg))
    if (execIndex >= 0) {
      const subWords = []
      for (let i = execIndex + 1; i < args.length; i++) {
        if (args[i] === ';' || args[i] === '+') break
        subWords.push(args[i])
      }
      if (subWords.length) {
        // find 会把命中路径填进 {}：用搜索路径近似替换，让 `find / -exec rm -rf {} +` 命中删除规则
        const paths = findPaths(args)
        const target = paths[0] || '{}'
        const expanded = subWords.map((word) => word.split('{}').join(target))
        const danger = inspectWords(expanded, depth + 1)
        if (danger) return danger
      }
    }
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
    const script = shellCommandArg(args)
    if (script !== null) return inspectShell(script, depth + 1)
  }
  if (/^(?:powershell|pwsh)(?:\.exe)?$/i.test(name)) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      const policy = PWSH_EXEC_POLICY.exec(arg)
      if (policy) {
        const value = policy[1] !== undefined ? policy[1] : (args[i + 1] || '')
        if (/^(?:Bypass|Unrestricted)$/i.test(value)) return { label: 'pwsh 绕过执行策略' }
      }
      const window = PWSH_WINDOW_STYLE.exec(arg)
      if (window) {
        const value = window[1] !== undefined ? window[1] : (args[i + 1] || '')
        if (/^(?:hidden|1)$/i.test(value)) return { label: 'pwsh 隐藏窗口执行' }
      }
      const encoded = PWSH_ENCODED.exec(arg)
      if (encoded && (encoded[1] !== undefined || args[i + 1] !== undefined)) return { label: 'pwsh 编码命令执行' }
      if (/^-(?:c|co|com|comm|comma|comman|command)$/i.test(arg)) {
        return inspectShell(args.slice(i + 1).join(' '), depth + 1) || null
      }
    }
  }
  if (/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(name)) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '-c') {
        if (args[i + 1] !== undefined) return inspectCode(args[i + 1], 'python', depth + 1)
      } else if (/^-c./.test(arg)) {
        // -c<code> 合并写法
        return inspectCode(arg.slice(2), 'python', depth + 1)
      }
    }
  }
  if (/^node(?:\.exe)?$/i.test(name)) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      const eq = arg.indexOf('=')
      if (eq > 0 && /^--(?:eval|print)$/i.test(arg.slice(0, eq))) {
        // --eval=... / --print=... 内联等号写法
        return inspectCode(arg.slice(eq + 1), 'node', depth + 1)
      }
      if (arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print') {
        if (args[i + 1] !== undefined) return inspectCode(args[i + 1], 'node', depth + 1)
      }
    }
  }
  if (/^perl(?:\d+(?:\.\d+)*)?$/.test(name)) {
    const index = args.findIndex((arg) => /^-[^-]*[eE]$/.test(arg))
    if (index >= 0 && args[index + 1] !== undefined) return inspectCode(args[index + 1], 'perl', depth + 1)
  }
  return null
}

const SHELL_NAME = /^(?:ba|da|z|k|a)?sh$/i

// 管道右侧只要是「能解释/执行文本」的程序就是执行位置（curl ... | python3 / node / pwsh）
const PIPE_EXEC_NAME = /^(?:(?:ba|da|z|k|a)?sh|python(?:\d+(?:\.\d+)*)?(?:\.exe)?|node(?:\.exe)?|perl(?:\d+(?:\.\d+)*)?|ruby|pwsh(?:\.exe)?|powershell(?:\.exe)?|source|\.|xargs)$/i

// PowerShell 缩写参数：-ep / -ExecutionPolicy[:|=]Bypass、-w:hidden、-ec <base64>
const PWSH_EXEC_POLICY = /^-(?:ep|ex|exe|exec|execu|execut|executi|executio|execution|executionp|executionpo|executionpol|executionpoli|executionpolic|executionpolicy)(?:[:=](.*))?$/i
const PWSH_WINDOW_STYLE = /^-(?:w|wi|win|wind|windo|window|windows|windowst|windowsty|windowstyl|windowstyle)(?:[:=](.*))?$/i
const PWSH_ENCODED = /^-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?:[:=](.*))?$/i

function producerRisk (input, depth) {
  const [executable = '', ...args] = commandWords(input)
  const name = executable.split('/').pop().toLowerCase()
  if (name === 'eval') {
    const script = evalArgsText(args)
    return script ? inspectShell(script, depth + 1, true) : null
  }
  if (['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod'].includes(name)) return { label: '下载后直接执行' }
  if (['base64', 'openssl'].includes(name) && args.some((arg) => /^-(?:d|D|-[Dd]ecode)$/.test(arg))) return { label: 'bash 解码后执行' }
  if ((name === 'xxd' && args.some((arg) => /^-[rp]/.test(arg))) ||
      (name === 'printf' && args.some((arg) => /(?:\\x|0x)[\da-f]{2}|\\[0-7]{3}/i.test(arg)))) return { label: 'xxd/printf 解码执行' }
  // Only inspect literal output when it is fed into execution, not ordinary echo.
  if (name === 'echo') return inspectShell(args.filter((arg, i) => i !== 0 || !/^-[neE]+$/.test(arg)).join(' '), depth + 1)
  if (name === 'printf' && args[0] === '%s') return inspectShell(args.slice(1).join(''), depth + 1)
  if (name === 'printf' && args.length === 1) return inspectShell(args[0], depth + 1)
  return null
}

function tokenIsCommand (script, token, depth) {
  if (depth > 12) return false
  return shellCommands(script).some(({ words }) => {
    const command = commandWords(words)
    if (command[0]?.includes(token)) return true
    const name = (command[0] || '').split('/').pop()
    if (name === 'eval') {
      const body = evalArgsText(command.slice(1))
      return Boolean(body && tokenIsCommand(body, token, depth + 1))
    }
    if (!SHELL_NAME.test(name)) return false
    const shellScript = shellCommandArg(command.slice(1))
    return shellScript !== null && tokenIsCommand(shellScript, token, depth + 1)
  })
}

function inspectShell (text, depth = 0, outputExecuted = false) {
  if (depth > 12) return null
  // This operator pattern must ignore quoted examples and comments.
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/.test(maskStrings(text))) return { label: 'forkshell 炸弹' }
  const commands = shellCommands(text)
  let pipelineDanger = null
  for (let i = 0; i < commands.length; i++) {
    const { words, substitutions, redirects, operator } = commands[i]
    const command = commandWords(words)
    const name = (command[0] || '').split('/').pop()
    const shellScript = SHELL_NAME.test(name) ? shellCommandArg(command.slice(1)) : null
    const evalScript = name === 'eval' ? evalArgsText(command.slice(1)) : null
    for (const sub of substitutions) {
      // Inspect the commands inside both substitution forms. A process
      // substitution supplies a file path, not command-substitution output.
      let executed
      if (sub.processSubstitution) {
        // `bash <(curl ...)` / `source <(wget ...)` / `. <(base64 -d ...)`：
        // 进程替换的结果在这里是「脚本文本」而不是文件路径，必须算作被执行
        const takesScript = SHELL_NAME.test(name) || name === 'source' || name === '.'
        executed = takesScript && command.slice(1).some((word) => word.includes(sub.token))
      } else {
        executed = command[0]?.includes(sub.token)
          || (shellScript !== null && tokenIsCommand(shellScript, sub.token, depth + 1))
          || (evalScript !== null && tokenIsCommand(evalScript, sub.token, depth + 1))
      }
      const danger = inspectShell(sub.code, depth + 1, Boolean(executed))
      if (danger) return danger
    }
    if (redirects.some((target) => /^\/dev\/(?:sd|nvme|disk|vd|xvd|mmcblk|md|mapper\/)/.test(target))) return { label: '直接写磁盘' }
    if (pipelineDanger && PIPE_EXEC_NAME.test(name)) return pipelineDanger
    const prodDanger = (outputExecuted || operator === '|') ? producerRisk(words, depth) : null
    if (outputExecuted && prodDanger) return prodDanger
    if (operator === '|') {
      pipelineDanger = pipelineDanger || prodDanger
    } else {
      if (outputExecuted && pipelineDanger) return pipelineDanger
      pipelineDanger = null
    }
    const danger = inspectWords(words, depth)
    if (danger) return danger
  }
  return null
}

/** 静态启发式：检查执行位置及部分 shell/解释器包装，不执行或全局解码参数。
 *  不能保证识别动态生成、外部脚本或所有 shell 方言；不是执行沙箱。 */
export function isDangerousCommand (command) {
  const text = String(command || '')
  return text.trim() ? inspectShell(text) : null
}

/**
 * 从命令里挖出可能的「隐藏载荷」并还原：base64 / hex / $'\x..' 拼接 / 反斜杠插空。
 * 保留的解码诊断工具，不参与审批判断：脱离执行位置的解码结果会误伤普通数据。
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
 * @param {(sessionId:string, exec:object) => boolean} [o.isQqSession] 判定是否属于 QQ Hub 会话；普通 DSH 网页会话返回 false 直接放行
 * @param {() => string} o.ownerQQ 主人 QQ 号
 * @param {number} [o.timeoutMs] 等确认的超时（默认 60 秒）
 * @param {object} [o.log]
 */
export function createDangerGuard ({ getConfig, deliver, chatOfSession, isQqSession, ownerQQ, timeoutMs = 60_000, log } = {}) {
  const pending = new Map() // chatId → { resolve, timer }

  function cleanup (chatId, value) {
    const p = pending.get(chatId)
    if (!p) return false
    pending.delete(chatId)
    clearTimeout(p.timer)
    p.resolve(value)
    return true
  }

  function dispose () {
    for (const chatId of [...pending.keys()]) cleanup(chatId, false)
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
    const sessionId = exec.agent && exec.agent.session && exec.agent.session.id
    // 普通 DSH 网页端会话与 QQ Hub 无关：只有 QQ 会话或 qq-hub-* preset 才进入危险命令守卫。
    if (typeof isQqSession === 'function' && !isQqSession(sessionId, exec)) return next()
    const command = String(exec.arguments && exec.arguments.command || '')
    const danger = isDangerousCommand(command)
    if (!danger) return next()
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
        const timer = setTimeout(() => { cleanup(chatId, false); log?.warn?.(`危险命令确认超时，已拦下：${clip(command, 120)}`) }, timeoutMs)
        timer.unref?.()
        pending.set(chatId, { resolve, timer })
      })
      ;(async () => {
        try {
          if (typeof deliver !== 'function') {
            log?.warn?.('危险命令确认消息没发出去：未配置发送通道')
            cleanup(chatId, false)
            return
          }
          const res = await deliver(ownerChat, question)
          // hub.sendText 发送失败时返回 null/false（不抛错），立即快速拒绝而非静默挂死 60 秒；
          // 显式排除 undefined 以兼容无返回值的异步回调。
          if (res !== undefined && !res) {
            log?.warn?.('危险命令确认消息没发出去（发送返回空/失败），已立即拦下')
            cleanup(chatId, false)
          }
        } catch (error) {
          log?.warn?.('危险命令确认消息没发出去：', error.message)
          cleanup(chatId, false)
        }
      })()
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
    dispose,
    /** 等确认中的数量（测试/排查用） */
    get pendingCount () { return pending.size },
  }
}
