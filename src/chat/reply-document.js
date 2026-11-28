// 文档/报告型长回复检测与按章节切分，绕过聊天碎句切分器以保留表格与章节结构。

import { stripMarkdown } from './reply-markdown.js'
import { isSilence } from './reply-sanitize.js'

const MAX_BUBBLES = 6

/**
 * 判断一段未剥离 Markdown 的原文是不是「文档/报告型长回复」。
 * 命中后走按章节分大段，不进聊天气泡切碎机，也不被 capBubbles 按条数硬缝。
 * 普通闲聊（无表格、无分割线、无多级 Markdown 标题）绝不命中。
 */
export function isLongDocument(raw) {
  const s = String(raw || '').trim()
  if (s.length < 180) return false
  // 去掉围栏代码块后再检测文档结构，避免单段脚本里的 `# 注释` / `---` 误触长文档分章
  const prose = s.replace(/```[\s\S]*?```/g, '')
  // 含 Markdown 表格（表头 + `| :--- |` 对齐行）
  if (/^\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(prose)) return true
  if (s.length < 260) return false
  // 含独立分割线 `---` / `***`
  if (/^\s*(?:[-*_]){3,}\s*$/m.test(prose)) return true
  // 含 2 个及以上 Markdown 标题行（# / ## / ### / ####）
  const mdHeads = prose.match(/^#{1,4}\s+\S/gm)
  if (mdHeads && mdHeads.length >= 2) return true
  // 含 2 个及以上中文大章节（一、 / 二、 / 三、）
  const cnHeads = prose.match(/^[一二三四五六七八九十]+、\S/gm)
  if (cnHeads && cnHeads.length >= 2) return true
  // 含 2 个及以上【小标题】
  const bracketHeads = prose.match(/【[^】\n]{1,20}】/g)
  if (bracketHeads && bracketHeads.length >= 2) return true
  // 含 2 个及以上独立 **加粗标题** 行
  const boldHeads = prose.match(/^\s*\*\*[^*\n]{2,36}\*\*[：:]?\s*$/gm)
  if (boldHeads && boldHeads.length >= 2) return true
  // 多段长清单/长文档（≥400 字且 ≥6 行）
  const nonEmptyLines = prose.split('\n').map((x) => x.trim()).filter(Boolean)
  if (s.length >= 400 && nonEmptyLines.length >= 6) return true
  return false
}

/**
 * 把文档型长回复按章节切分成干净的大段气泡：
 * - 按 `---` 分割线和顶级标题（`### 一、` / `## ` / `【小标题】` / `**加粗标题**`）分章，丢弃多余的 `---` 横线；
 * - 每章内部跑 `stripMarkdown`（含 Markdown 表格转规格卡、清加粗旁多余空格、保留小节空行）；
 * - 单章超长（> 480 字）时再按二级小节（`#### 1.` / `1. ` / `2. `）、空行或列表项自然切分；
 * - 章节总数超过 `maxBubbles` 时，将较短的相邻章节用 `\n\n` 合并，绝不把下一章孤立标题缝到上一章尾巴。
 */
export function splitDocumentBySections(raw, maxBubbles = MAX_BUBBLES) {
  const limit = Math.max(1, Math.round(Number(maxBubbles) || MAX_BUBBLES))
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n')
  const isFence = (l) => /^\s*```/.test(l)
  const isRule = (l) => /^\s*(?:[-*_]){3,}\s*$/.test(l)
  const isMajorHead = (l) => (
    /^#{1,3}\s+\S/.test(l)
    || /^[一二三四五六七八九十]+、\S/.test(l)
    || /^\s*【[^】\n]{1,20}】/.test(l)
    || /^\s*\*\*[^*\n]{2,36}\*\*[：:]?\s*$/.test(l)
  )
  const isSubHead = (l) => /^#{4,6}\s+\S/.test(l) || /^\d+(?:\.(?!\d)|、)\s*\S/.test(l)
  const isBullet = (l) => /^\s*[-*•·]\s+\S/.test(l)
  const SECTION_MAX = 480

  const rawSections = []
  let buf = []
  let inFence = false
  const flush = () => {
    const joined = buf.join('\n').trim()
    if (joined) rawSections.push(joined)
    buf = []
  }

  for (const line of lines) {
    if (isFence(line)) {
      inFence = !inFence
      buf.push(line)
      continue
    }
    if (!inFence) {
      if (isRule(line)) {
        flush()
        continue
      }
      if (isMajorHead(line) && buf.some((x) => x.trim())) {
        flush()
      }
    }
    buf.push(line)
  }
  flush()

  // 超长章节（> 480 字）按二级小节自然切分，避免单条刷满整个手机屏幕
  const expanded = []
  for (const sec of rawSections) {
    if (sec.length <= SECTION_MAX) {
      expanded.push(sec)
      continue
    }
    const sLines = sec.split('\n')
    const chunks = []
    let cur = []
    let subInFence = false
    for (const l of sLines) {
      if (isFence(l)) {
        subInFence = !subInFence
        cur.push(l)
        continue
      }
      // 保留大标题跟着第 1 个小节一起，不在大标题后立刻切开；代码块内部绝不切分
      const hasBody = cur.some((x) => x.trim() && !isMajorHead(x))
      if (!subInFence && isSubHead(l) && hasBody && cur.join('\n').length >= 200) {
        chunks.push(cur.join('\n').trim())
        cur = [l]
      } else {
        cur.push(l)
      }
    }
    if (cur.join('\n').trim()) chunks.push(cur.join('\n').trim())
    // 若二级小节切完后仍有单块 > 480 字，按空行或列表项再温和切分（不劈代码块）
    for (const chunk of chunks) {
      if (chunk.length <= SECTION_MAX) {
        expanded.push(chunk)
        continue
      }
      const cLines = chunk.split('\n')
      let part = []
      let partInFence = false
      for (const l of cLines) {
        if (isFence(l)) {
          partInFence = !partInFence
          part.push(l)
          continue
        }
        const curText = part.join('\n').trim()
        const hasBody = part.some((x) => x.trim() && !isMajorHead(x))
        if (!partInFence && hasBody && curText.length >= 200 && (!l.trim() || (isBullet(l) && curText.length >= 240))) {
          expanded.push(curText)
          part = l.trim() ? [l] : []
          continue
        }
        part.push(l)
      }
      if (part.join('\n').trim()) expanded.push(part.join('\n').trim())
    }
  }

  const cleaned = expanded
    .map((sec) => stripMarkdown(sec))
    .filter((sec) => sec && !isSilence(sec))

  // 若仍超过气泡上限，优先合并相邻最短的两段（用 \n\n 分隔，绝不粘死）
  while (cleaned.length > limit && cleaned.length > 1) {
    let bestIdx = 0
    let bestLen = Infinity
    for (let i = 0; i < cleaned.length - 1; i += 1) {
      const pairLen = cleaned[i].length + cleaned[i + 1].length
      if (pairLen < bestLen) {
        bestLen = pairLen
        bestIdx = i
      }
    }
    cleaned.splice(bestIdx, 2, `${cleaned[bestIdx]}\n\n${cleaned[bestIdx + 1]}`)
  }
  return cleaned
}
