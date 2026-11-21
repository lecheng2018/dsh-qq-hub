// 记忆 Markdown 编解码器（1.3.65 重构 A-01）。
//
// 职责：
//   1. 将单个 scope 的 memory.md 与内存条目数据结构进行无损相互转换。
//   2. 严格校验文档头 format（qqhub-memory-v1）、scope 作用域、块标记闭合与 ID 唯一性。
//   3. 提取与保留正文、来源与依据（evidence）、修订说明（history）以及必要的元数据标记。
//   4. 0、false、空字符串等假值绝不用 || 错换成默认值。

// 审计 S13：v1 的序列化只转义 `<!-- qqhub:entry -->` 一种标记，而解析器还把
// `### xxx`（条目标题）与 `#### 来源与依据` / `#### 修订说明`（区段分隔）当结构。
// 于是正文里出现这些行时，往返后会**位移或丢内容**（实测：正文若以 `### 饮食偏好`
// 开头，该行被吃成 title；正文里出现 `#### 来源与依据`，其后内容整体搬进 evidence，
// 正文被截断）。记忆是长期事实源，这类静默损坏无法接受。
//
// v2 在写侧转义所有「会被误认为结构」的行首标记，读侧只在 format=v2 时反转义。
// v1 老文件按原样解析（**行为完全不变**），避免存量文件被重新解释成另一份内容；
// 下一次写盘会自动升级成 v2。
export const MEMORY_FORMAT_V1 = 'qqhub-memory-v1'
export const MEMORY_FORMAT = 'qqhub-memory-v2'
export const SUPPORTED_FORMATS = new Set([MEMORY_FORMAT_V1, MEMORY_FORMAT])

const ENTRY_START_RE = /^<!--\s*qqhub:entry\s+(\{.*?\})\s*-->$/
const ENTRY_END_RE = /^<!--\s*\/qqhub:entry\s*-->$/
const SECTION_EVIDENCE_RE = /^####\s*来源与依据\s*$/
const SECTION_REVISION_RE = /^####\s*修订说明\s*$/

/**
 * 转义正文中可能出现的标记行，避免序列化后被误识别为块边界。
 */
function escapeEntryMarkers(text) {
  return String(text || '').replace(/^<!--\s*qqhub:entry/gm, '<!--\u200B qqhub:entry')
    .replace(/^<!--\s*\/qqhub:entry\s*-->/gm, '<!--\u200B /qqhub:entry -->')
}

function unescapeEntryMarkers(text) {
  return String(text || '').replace(/^<!--\u200B\s*qqhub:entry/gm, '<!-- qqhub:entry')
    .replace(/^<!--\u200B\s*\/qqhub:entry\s*-->/gm, '<!-- /qqhub:entry -->')
}

// v2：把「行首 ### / ####」也当结构标记转义（插入零宽空格，肉眼不可见，
// 解析时不匹配 ^#{3,4}\s，因此不会被当成标题/区段分隔）。
const STRUCT_LINE_RE = /^(#{3,4})(\s)/gm
function escapeStructLines(text) {
  return String(text || '').replace(STRUCT_LINE_RE, '$1\u200B$2')
}
function unescapeStructLines(text) {
  return String(text || '').replace(/^(#{3,4})\u200B(\s)/gm, '$1$2')
}

/** 按格式版本做「正文 → 落盘文本」的转义。v1 保持原样（只转义 entry 标记）。 */
function escapeForFormat(text, format) {
  const base = escapeEntryMarkers(text)
  return format === MEMORY_FORMAT ? escapeStructLines(base) : base
}

/** 按格式版本做「落盘文本 → 正文」的反转义。 */
function unescapeForFormat(text, format) {
  const base = unescapeEntryMarkers(text)
  return format === MEMORY_FORMAT ? unescapeStructLines(base) : base
}

/**
 * 解析 frontmatter 头部
 */
function parseFrontmatter(lines) {
  if (lines.length < 3 || lines[0].trim() !== '---') {
    throw new Error('Markdown 缺少合法 frontmatter 头部（须以 --- 开头）')
  }
  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i
      break
    }
  }
  if (endIndex === -1) {
    throw new Error('Markdown frontmatter 头部未闭合（缺少结尾 ---）')
  }

  const meta = {}
  for (let i = 1; i < endIndex; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    meta[key] = val
  }

  if (!SUPPORTED_FORMATS.has(meta.format)) {
    throw new Error(`不支持的记忆格式版本: "${meta.format || ''}"（当前支持 ${[...SUPPORTED_FORMATS].join(' / ')}）`)
  }
  if (!meta.scope) {
    throw new Error('frontmatter 头部缺少 scope 声明')
  }

  return { meta, bodyLines: lines.slice(endIndex + 1) }
}

/**
 * 解析单个 entry 块的正文与子章节
 */
function parseEntryBody(lines, format = MEMORY_FORMAT_V1) {
  let title = ''
  const contentLines = []
  const evidenceLines = []
  const revisionLines = []
  let currentSection = 'body' // 'body' | 'evidence' | 'revision'

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const trimmed = rawLine.trim()

    // 提取条目顶部标题（如 ### 饮食偏好）
    if (!title && currentSection === 'body' && contentLines.length === 0 && /^###\s+/.test(trimmed)) {
      title = trimmed.replace(/^###\s+/, '')
      continue
    }

    if (SECTION_EVIDENCE_RE.test(trimmed)) {
      currentSection = 'evidence'
      continue
    }
    if (SECTION_REVISION_RE.test(trimmed)) {
      currentSection = 'revision'
      continue
    }

    if (currentSection === 'body') {
      contentLines.push(rawLine)
    } else if (currentSection === 'evidence') {
      evidenceLines.push(rawLine)
    } else if (currentSection === 'revision') {
      revisionLines.push(rawLine)
    }
  }

  const text = unescapeForFormat(contentLines.join('\n'), format).trim()
  const evidence = unescapeForFormat(evidenceLines.join('\n'), format).trim()
  const revision = unescapeForFormat(revisionLines.join('\n'), format).trim()

  return { title, text, evidence, revision }
}

/**
 * 解析 Markdown 记忆文档为内存对象
 * @param {string} markdownRaw 原始 Markdown 文本
 * @param {object} [options]
 * @param {string} [options.expectedScope] 期望的作用域（若指定且与文档头不符则报错）
 * @returns {{ meta: { format: string, scope: string, [key: string]: string }, entries: object[], prologue: string }}
 */
/**
 * 审计 S13：比对「解析回来的条目」与「写入前的条目」，返回内容字段的差异列表。
 *
 * 抽成纯函数是为了可测：往返破坏（内容被搬进 evidence、正文被截断、条目消失）
 * 必须在写盘前被拦住，而这条护栏本身也需要能被验证。
 *
 * 比对口径刻意**忽略首尾空白**：序列化对正文做 trim 是既有设计（不 trim 会让
 * 每条记忆都拖着聊天原文的空行），属已知且无害的差异。
 *
 * @param {{id:any}[]} parsedEntries 解析结果
 * @param {{id:any}[]} sourceEntries 写入前的条目
 * @returns {string[]} 差异描述（空数组 = 无损）
 */
export function diffRoundTrip(parsedEntries, sourceEntries) {
  const problems = []
  const byId = new Map((parsedEntries || []).map((e) => [String(e.id), e]))
  const norm = (v) => String(v ?? '').trim()
  const brief = (v) => (v.length > 60 ? `${v.slice(0, 60)}…` : v)
  for (const src of sourceEntries || []) {
    const id = String(src.id)
    const got = byId.get(id)
    if (!got) { problems.push(`条目 ${id} 往返后消失`); continue }
    for (const field of ['text', 'evidence', 'revision', 'title']) {
      const want = norm(src[field])
      const have = norm(got[field])
      if (want !== have) {
        problems.push(`条目 ${id} 的 ${field} 往返不一致：写入前「${brief(want)}」→ 解析后「${brief(have)}」`)
      }
    }
  }
  return problems
}

export function parseMarkdownArchive(markdownRaw, { expectedScope = '' } = {}) {
  const raw = String(markdownRaw || '').replace(/^\uFEFF/, '')
  const lines = raw.split(/\r?\n/)
  const { meta, bodyLines } = parseFrontmatter(lines)

  if (expectedScope && String(meta.scope).trim() !== String(expectedScope).trim()) {
    throw new Error(`作用域不匹配: 文件声明为 "${meta.scope}"，但期望为 "${expectedScope}"`)
  }

  const entries = []
  const seenIds = new Set()
  const prologueLines = []

  let inEntry = false
  let entryMeta = null
  let entryLines = []
  let entryStartLine = 0

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]
    const trimmed = line.trim()
    const startMatch = trimmed.match(ENTRY_START_RE)

    if (startMatch) {
      if (inEntry) {
        throw new Error(`解析错误（行 ${i + 1}）：前一个条目 "${entryMeta?.id}" 未闭合，检测到嵌套或多余的 entry 开始标记`)
      }
      try {
        entryMeta = JSON.parse(startMatch[1])
      } catch (err) {
        throw new Error(`解析错误（行 ${i + 1}）：entry 元数据 JSON 不合法: ${err.message}`)
      }
      if (!entryMeta || typeof entryMeta !== 'object' || !entryMeta.id || typeof entryMeta.id !== 'string') {
        throw new Error(`解析错误（行 ${i + 1}）：entry 元数据缺少有效的 "id" 字段`)
      }
      if (seenIds.has(entryMeta.id)) {
        throw new Error(`解析错误（行 ${i + 1}）：发现重复的 entry ID "${entryMeta.id}"`)
      }
      seenIds.add(entryMeta.id)
      inEntry = true
      entryLines = []
      entryStartLine = i + 1
      continue
    }

    if (ENTRY_END_RE.test(trimmed)) {
      if (!inEntry) {
        throw new Error(`解析错误（行 ${i + 1}）：遇到未配对的 entry 闭合标记 <!-- /qqhub:entry -->`)
      }
      const { title, text, evidence, revision } = parseEntryBody(entryLines, meta.format)
      const item = {
        ...entryMeta,
        kind: entryMeta.kind || 'fact',
        scope: meta.scope,
      }
      if (title) item.title = title
      if (text) item.text = text
      if (evidence) item.evidence = evidence
      if (revision) item.revision = revision

      entries.push(item)
      inEntry = false
      entryMeta = null
      entryLines = []
      continue
    }

    if (inEntry) {
      entryLines.push(line)
    } else {
      if (!/^##\s+(当前记忆|历史记录|历史档案)\s*$/.test(trimmed)) {
        prologueLines.push(line)
      }
    }
  }

  if (inEntry) {
    throw new Error(`解析错误：条目 "${entryMeta?.id}"（始于行 ${entryStartLine}）未闭合，文件提前结束`)
  }

  return {
    meta,
    entries,
    prologue: prologueLines.join('\n').trim(),
  }
}

/**
 * 序列化条目为 Markdown
 * @param {{ meta: { format?: string, scope: string, [key: string]: string }, entries: object[], prologue?: string }} archive
 * @returns {string} 完整的 Markdown 文本
 */
export function serializeMarkdownArchive({ meta = {}, entries = [], prologue = '' }) {
  const scope = String(meta.scope || '').trim()
  if (!scope) throw new Error('序列化失败: 必须指定 scope')

  const format = meta.format || MEMORY_FORMAT
  const lines = [
    '---',
    `format: ${format}`,
    `scope: ${scope}`,
  ]

  for (const [k, v] of Object.entries(meta)) {
    if (k === 'format' || k === 'scope') continue
    if (v !== undefined && v !== null && v !== '') {
      lines.push(`${k}: ${v}`)
    }
  }
  lines.push('---', '')

  // 自愈过滤：清理传入前言中残留的结构化 Section 标题（彻底终结标题堆叠累积）
  const cleanPrologue = String(prologue || '')
    .split(/\r?\n/)
    .filter((l) => !/^##\s+(当前记忆|历史记录|历史档案)\s*$/.test(l.trim()))
    .join('\n')
    .trim()

  if (cleanPrologue) {
    lines.push(cleanPrologue, '')
  } else {
    // 默认文档大标题
    const isGroup = scope.startsWith('group:')
    const isPrivate = scope.startsWith('private:')
    const title = isGroup ? `# 群聊记忆档案 (${scope})` : isPrivate ? `# 私聊记忆档案 (${scope})` : `# 全局记忆档案`
    lines.push(title, '')
  }

  // 分组：当前有效记忆 vs 历史废弃记忆
  const currentEntries = []
  const historyEntries = []

  for (const e of entries || []) {
    if (e.invalidAt || e.supersededBy) {
      historyEntries.push(e)
    } else {
      currentEntries.push(e)
    }
  }

  const renderEntry = (e) => {
    // 提取纯元数据（不将正文与依据重复压入 JSON 块）
    const entryMeta = {
      id: String(e.id),
      kind: e.kind || 'fact',
    }

    if (e.about !== undefined && e.about !== '') entryMeta.about = String(e.about)
    if (e.aboutName !== undefined && e.aboutName !== '') entryMeta.aboutName = String(e.aboutName)
    if (e.source !== undefined && e.source !== '') entryMeta.source = String(e.source)
    if (e.sourceId !== undefined && e.sourceId !== '') entryMeta.sourceId = String(e.sourceId)
    if (e.chatId !== undefined && e.chatId !== '') entryMeta.chatId = String(e.chatId)
    if (typeof e.at === 'number' && !Number.isNaN(e.at)) entryMeta.at = e.at
    if (typeof e.eventAt === 'number' && !Number.isNaN(e.eventAt)) entryMeta.eventAt = e.eventAt
    if (typeof e.importance === 'number' && e.importance !== 0.5) entryMeta.importance = Number(e.importance.toFixed(2))
    if (e.pinned) entryMeta.pinned = 1
    if (e.ephemeral) entryMeta.ephemeral = 1
    if (typeof e.invalidAt === 'number' && e.invalidAt > 0) entryMeta.invalidAt = e.invalidAt
    if (e.supersededBy !== undefined && e.supersededBy !== '') entryMeta.supersededBy = String(e.supersededBy)
    if (Array.isArray(e.tags) && e.tags.length > 0) entryMeta.tags = e.tags
    if (Array.isArray(e.history) && e.history.length > 0) entryMeta.history = e.history
    if (e.entity !== undefined && e.entity !== '') entryMeta.entity = String(e.entity)
    if (e.topic !== undefined && e.topic !== '') entryMeta.topic = String(e.topic)

    // 保留其它自定义扩展属性
    const standardKeys = new Set(['id', 'kind', 'about', 'aboutName', 'source', 'sourceId', 'chatId', 'at', 'eventAt', 'importance', 'pinned', 'ephemeral', 'invalidAt', 'supersededBy', 'tags', 'history', 'title', 'text', 'evidence', 'revision', 'scope', 'entity', 'topic'])
    for (const [k, v] of Object.entries(e)) {
      if (!standardKeys.has(k) && v !== undefined) {
        entryMeta[k] = v
      }
    }

    const out = []
    out.push(`<!-- qqhub:entry ${JSON.stringify(entryMeta)} -->`)
    if (e.title && String(e.title).trim()) {
      out.push(`### ${String(e.title).trim()}`, '')
    }
    if (e.text && String(e.text).trim()) {
      out.push(escapeForFormat(String(e.text).trim(), format), '')
    }
    if (e.evidence && String(e.evidence).trim()) {
      out.push('#### 来源与依据', '', escapeForFormat(String(e.evidence).trim(), format), '')
    }
    if (e.revision && String(e.revision).trim()) {
      out.push('#### 修订说明', '', escapeForFormat(String(e.revision).trim(), format), '')
    }
    out.push('<!-- /qqhub:entry -->')
    return out.join('\n')
  }

  if (currentEntries.length > 0) {
    lines.push('## 当前记忆', '')
    for (const e of currentEntries) {
      lines.push(renderEntry(e), '')
    }
  }

  if (historyEntries.length > 0) {
    lines.push('## 历史记录', '')
    for (const e of historyEntries) {
      lines.push(renderEntry(e), '')
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}
