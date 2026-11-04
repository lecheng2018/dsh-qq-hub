// RSS 2.0 / Atom / RDF 的极简解析器（纯函数，无依赖）。
//
// 为什么手写而不引 XML 库：整个插件是零依赖的（package.json 里没有 dependencies），
// 加一个 XML 解析器只为了拿标题/链接/摘要是杀鸡用牛刀，而且会引入供应链面。
// 这里的取舍是：**只提取需要的几个字段，其余一律忽略**，解析不了的条目直接跳过，
// 绝不因为一条怪条目就让整次拉取失败。
//
// 支持的变体（实测常见站点都在里面）：
//   · RSS 2.0：<rss><channel><item><title>/<link>/<description>/<pubDate>/<guid>
//   · Atom：  <feed><entry><title>/<link href>/<summary|content>/<updated|published>/<id>
//   · RDF(RSS 1.0)：<rdf:RDF><item>… 结构和 RSS 2.0 的 item 一样
//   · CDATA 包裹、HTML 实体（含 &#38; / &#x1F600;）、命名空间前缀（dc:date、content:encoded）

/** HTML/XML 实体解码。数字实体（十进制/十六进制）和常见命名实体都要认。 */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCode(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&amp;/g, '&') // 必须最后：否则 &amp;lt; 会被解成 <
}

function safeFromCode(code) {
  try { return String.fromCodePoint(code) } catch { return '' }
}

/** 去掉 CDATA 包装、标签、多余空白，得到一个干净的纯文本。 */
export function plainText(raw, { keepBreaks = false } = {}) {
  let s = String(raw ?? '')
  // 反复剥 CDATA：有些站点会套两层
  for (let i = 0; i < 3 && /<!\[CDATA\[/.test(s); i += 1) {
    s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  }
  s = decodeEntities(s)
  // 段落分隔要保留一点（摘要读起来才不粘连），其余标签去掉
  s = s.replace(/<\s*br\s*\/?>/gi, keepBreaks ? '\n' : ' ')
  s = s.replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, keepBreaks ? '\n' : ' ')
  s = s.replace(/<[^>]*>/g, ' ')
  s = s.replace(/[ \t\u00a0]+/g, ' ')
  s = keepBreaks ? s.replace(/\n{2,}/g, '\n').trim() : s.replace(/\s+/g, ' ').trim()
  return s
}

/** 从块里取第一个同名标签的原始内容（含 CDATA 原文，交给 plainText 再清）。 */
function tagOf(block, names) {
  for (const name of names) {
    // 允许命名空间前缀与属性：<dc:date>、<link href="…"/>
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')
    const m = block.match(re)
    if (m) return m[1]
  }
  return ''
}

/** Atom 的 <link> 是自闭合带 href；RSS 的 <link> 是文本。两种都试。 */
function linkOf(block) {
  const text = tagOf(block, ['link'])
  const bare = plainText(text)
  if (bare && /^https?:\/\//i.test(bare)) return bare
  // Atom：<link rel="alternate" href="https://…"/>
  const hrefs = [...block.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/gi)].map((m) => decodeEntities(m[1]))
  if (!hrefs.length) return ''
  // 优先 alternate，其次第一个 http(s)
  const alt = block.match(/<link\b[^>]*\brel\s*=\s*["']alternate["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i)
  if (alt) return decodeEntities(alt[1])
  return hrefs.find((h) => /^https?:\/\//i.test(h)) || ''
}

/** 解析时间：RFC822（RSS）和 ISO8601（Atom）都认，认不出返回 0。 */
export function parseDate(raw) {
  const s = plainText(raw)
  if (!s) return 0
  const t = Date.parse(s)
  if (Number.isFinite(t)) return t
  // RFC822 里常见的 +0800 形式某些运行时解析不了，手动补冒号再试一次
  const fixed = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
  const t2 = Date.parse(fixed)
  return Number.isFinite(t2) ? t2 : 0
}

/** 切出 <item> / <entry> 块。RDF 里也是 <item>。 */
function blocksOf(xml) {
  const out = []
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let m
  while ((m = re.exec(xml)) !== null) out.push({ kind: m[1].toLowerCase(), body: m[2] })
  return out
}

/** 频道级信息（标题、站点地址）。 */
function channelOf(xml) {
  const head = xml.match(/<(channel|feed)\b[^>]*>([\s\S]*?)<\/\1>/i)
  if (!head) return { title: '', link: '' }
  const body = head[2]
  return {
    title: plainText(tagOf(body, ['title'])).slice(0, 120),
    link: linkOf(body),
  }
}

/**
 * 解析一份 feed。
 * @param {string} xml 原始 XML 文本
 * @param {{limit?: number, summaryChars?: number}} [opts]
 * @returns {{ok: boolean, title: string, siteUrl: string, items: Array, error?: string}}
 */
export function parseFeed(xml, { limit = 60, summaryChars = 400 } = {}) {
  const raw = String(xml ?? '')
  if (!raw.trim()) return { ok: false, title: '', siteUrl: '', items: [], error: '内容为空' }
  // 明显的 HTML（不是 feed）：一眼能看出来，给个明确的错误比静默返回空好
  if (/^\s*<!doctype\s+html/i.test(raw) || /<html[\s>]/i.test(raw.slice(0, 2000))) {
    return { ok: false, title: '', siteUrl: '', items: [], error: '这个地址返回的是网页，不是 RSS/Atom' }
  }
  if (!/<(rss|feed|rdf:RDF)\b/i.test(raw)) {
    return { ok: false, title: '', siteUrl: '', items: [], error: '不是 RSS/Atom 格式' }
  }
  const ch = channelOf(raw)
  const blocks = blocksOf(raw)
  const items = []
  const seen = new Set()
  for (const b of blocks) {
    const title = plainText(tagOf(b.body, ['title'])).slice(0, 200)
    const url = linkOf(b.body)
    // 没有标题且没有链接的条目没有价值（常见于广告位/占位符）
    if (!title && !url) continue
    const rawSummary = tagOf(b.body, ['summary', 'description', 'content:encoded', 'content'])
    // keepBreaks: HTML 列表（ol/ul 里的 li）每个 <li> 是一条独立内容（例如福利站的
    // 「多条福利」），keepBreaks:false 会全并成一行，名称和描述直接粘连错乱
    // （实测 saibodan：HeyGen TTS 和 Shakti (Yotta) 两条福利粘成一坨）。
    const summary = plainText(rawSummary, { keepBreaks: true }).slice(0, summaryChars)
    const at = parseDate(tagOf(b.body, ['pubDate', 'published', 'updated', 'dc:date', 'date']))
    const guid = plainText(tagOf(b.body, ['guid', 'id'])) || url || title
    const key = `${guid}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ key, title, url, summary, at })
    if (items.length >= limit) break
  }
  // 有的 feed 顺序是倒的；按时间倒序，没有时间的排后面（保持原序）
  items.sort((a, b) => (b.at || 0) - (a.at || 0))
  return { ok: true, title: ch.title, siteUrl: ch.link, items }
}