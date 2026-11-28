// Markdown 表格转 QQ 可读规格卡与通用 Markdown 格式剥离。

import { stripReasoning } from './reply-sanitize.js'

/** 把 Markdown 表格（含 `| :--- |` 对齐行）转为手机 QQ 易读的逐条规格卡，消除 `| :--- |` 乱码。 */
export function convertMarkdownTables(text) {
  const lines = String(text || '').split('\n')
  const out = []
  const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  const isSepLine = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
  const isTableRow = (line) => {
    const t = line.trim()
    return t.includes('|') && (t.startsWith('|') || t.endsWith('|') || (t.match(/\|/g) || []).length >= 2)
  }

  let i = 0
  while (i < lines.length) {
    if (i + 1 < lines.length && isTableRow(lines[i]) && isSepLine(lines[i + 1])) {
      const start = i
      const headers = splitRow(lines[i])
      const rows = []
      i += 2
      while (i < lines.length && lines[i].trim() && isTableRow(lines[i]) && !isSepLine(lines[i])) {
        rows.push(splitRow(lines[i]))
        i += 1
      }
      if (rows.length > 0 && headers.length >= 2) {
        const cards = rows.map((cells) => {
          const title = cells[0] || ''
          const fields = []
          for (let j = 1; j < Math.max(headers.length, cells.length); j += 1) {
            const val = cells[j] || ''
            if (!val || val === '-' || val === '—') continue
            const key = headers[j] || ''
            fields.push(key ? `${key}：${val}` : val)
          }
          if (!title) return fields.join('｜')
          if (!fields.length) return `▪ ${title}`
          return `▪ ${title}\n${fields.join('｜')}`
        })
        out.push(cards.join('\n\n'))
        continue
      }
      i = start
    }
    out.push(lines[i])
    i += 1
  }
  return out.join('\n')
}

/**
 * 把围栏代码块与行内代码换成占位符，返回 { text, restore }。
 *
 * 审计 T3.11：剥 Markdown 的规则（`__x__`、`*x*`、`# 标题`、`---` 分隔线、`|` 表格）
 * 会**改动代码本身**：`def __init__` 被当加粗去掉下划线、`a * b * c` 被当斜体吃掉星号、
 * `# note` 被当标题删掉、`---` 被换成一条分割线。代码块本来该原样发出。
 * 所以先把代码换成 \uFFF9N\uFFFA 占位符（不含任何 Markdown 字符），剥完再还原。
 *
 * 调用方（parseReply）需要在切 `|||` / 匹配 <voice>/<sticker>/<poke> 之前也先 mask，
 * 这样代码里出现的 `|||` 不会被当成气泡分隔符。
 */
export function protectCode(text) {
  const store = []      // 代码**内容**（不含围栏）
  const originals = []  // 原始片段（围栏块保留 ``` 行）
  // T3.11 修补：围栏块的占位符带 F 前缀（\uFFF9F<n>\uFFFA），行内代码不带。
  // 下游「带代码就不拆泡」只能对**围栏块**生效：以前分不清两者，只要聊天里有一个
  // 行内反引号（`ls`）整段长回复就不拆泡，几百字挤成一条。
  const mask = (code, original, fenced) => {
    store.push(code)
    originals.push(original)
    return `\uFFF9${fenced ? 'F' : ''}${store.length - 1}\uFFFA`
  }
  const out = String(text ?? '')
    .replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (full, lang, code) => mask(String(code).replace(/\n$/, ''), full, true))
    .replace(/`([^`\n]+)`/g, (full, code) => mask(code, code, false))
  const swap = (value, list) => String(value ?? '').replace(/\uFFF9F?(\d+)\uFFFA/g,
    (m, i) => (Number(i) < list.length ? list[Number(i)] : m))
  return {
    text: out,
    // 只还原**自己**登记过的下标：外层（parseReply）已经 mask 过的文本里也有占位符，
    // 内层 stripMarkdown 的 store 是空的，越界时必须原样保留（否则会把外层占位符吃掉）。
    restore: (value) => swap(value, store),
    // 还原成「原文」：围栏行保留。文档分章/长度判定需要看到真正的代码块边界，
    // 否则代码里的 `# 注释` 会被当成章节标题、`---` 被当成分隔线，长文档被切碎。
    restoreFenced: (value) => swap(value, originals),
    // 只问「有没有围栏代码块」（行内代码不算）。给分泡逻辑用。
    hasFenced: (value) => /\uFFF9F\d+\uFFFA/.test(String(value ?? '')),
    size: store.length,
  }
}

/** 去掉 Markdown 痕迹，转换为 QQ 友好的清晰排版。 */
export function stripMarkdown(text) {
  // 先把代码换占位符（围栏本身去掉、内容一个字不动），剥完正文再还原。
  // 注意顺序：连 stripReasoning 也要在 mask 之后跑 —— 代码块里写「【思考】示例【/思考】」
  // 是**示例**，不该被当成模型独白删掉（既有测试「围栏代码块与行内代码里的思考标记豁免」）。
  const code = protectCode(text)
  let s = stripReasoning(code.text)
  // 仅清掉因 Markdown 加粗语法而在「中文 ↔ 中文」之间多打的空格；保留中英文/数字间的自然半角空格，也不误伤平时口语打字的空格断句
  s = s.replace(/([\u4e00-\u9fff])[ \t]+\*\*([\u4e00-\u9fff][^*\n]*)\*\*/g, '$1**$2**')
  s = s.replace(/\*\*([^*\n]*[\u4e00-\u9fff])\*\*[ \t]+([\u4e00-\u9fff])/g, '**$1**$2')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  s = s.replace(/__([^_\n]+)__/g, '$1')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
  s = convertMarkdownTables(s)
  s = s.replace(/^#{1,6}\s+/gm, '')
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  s = s.replace(/^\s*>\s?/gm, '')
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2')

  // 破折号硬拦（主人要求禁用 ——）：提示词禁令实测压不住（群友示范+styles 强化会把它顶回来），
  // 所以在发送出口直接替换。破折号常见两种用法：
  //   A——B（解释/转折）→ 逗号最稳妥，任何语境都通顺
  //   行尾挂 dash 拖音（"反正就这样——"）→ 收尾直接删掉，不留半个符号
  // 先删行尾孤立的（包括后跟空白），再把句中的换成逗号；顺序不能反，否则行尾那个会先被换成逗号。
  s = s.replace(/——+\s*$/gm, '')
  s = s.replace(/——+/g, '，')

  // 核心排版：数字列表项（1. 2. 3. / 1、2、等）前面如果不是空行，自动补空行，强制撑开呼吸感；
  // 排除小数开头（如 2.5G / 1.5W / 3.14），避免把「2.5G 线速能力」误认成第 2 条列表强插空行把上一行标题劈孤立。
  s = s.replace(/([^\n])\r?\n(\d+(?:\.(?!\d)|、)\s*)/g, '$1\n\n$2')

  // 分割线转为清晰的 QQ 细分割线
  s = s.replace(/^[*-]{3,}$/gm, '━━━━━━━━━━━━━━')

  s = s.replace(/[ \t]+$/gm, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return code.restore(s).trim()
}
