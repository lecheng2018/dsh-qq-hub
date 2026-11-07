// 蒸馏统计学特征硬提取（1.3.63，主人提供的行业架构落地）：
// 先用确定性代码算出「这个人打字的物理指标」，作为锚点喂给 LLM 做基准约束——
// 不完全依赖模型的「感觉」。指标：
//   · 消息长度中位数 / P90（长篇大论还是碎句刷屏）
//   · 突发合并（Burst Merge）：≤10 秒内的连发短句合成一条带换行的消息块（防学成断裂单句）
//   · 句末标点率、空格使用率、问号/叹号倾向
//   · 表情包/Emoji 频率、中英混杂率
//   · 高频 n-gram（2~3 字词组，供口癖交叉验证）

const BURST_WINDOW_MS = 10_000

/** 突发合并：同一人 ≤10 秒内的连发合成一条（换行连接）。输入须按时间正序。 */
export function burstMerge (lines, { windowMs = BURST_WINDOW_MS } = {}) {
  const out = []
  let cur = null
  for (const l of lines || []) {
    if (!l || !l.text) continue
    const t = Number(l.t || l.at || 0)
    if (cur && t - cur.t <= windowMs) {
      cur.text += '\n' + l.text
      cur.count++
      continue
    }
    if (cur) out.push(cur)
    cur = { t, text: String(l.text), count: 1, ...(l.uid ? { uid: l.uid } : {}), ...(l.at ? { at: l.at } : {}) }
  }
  if (cur) out.push(cur)
  return out
}

const median = (arr) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0)

/**
 * 硬提取统计特征。
 * @param {Array<{text:string,t?:number,at?:number}>} lines 该人清洗后的发言（时间正序）
 * @returns {{burstMerged: Array, lengthMedian: number, lengthP90: number,
 *   endPunctRate: number, spaceRate: number, questionRate: number, exclaimRate: number,
 *   stickerRate: number, emojiRate: number, mixedEnRate: number, topNGrams: Array<{g:string,n:number}>}}
 */
export function extractStats (lines) {
  const burst = burstMerge(lines)
  const texts = burst.map((x) => x.text)
  const lens = texts.map((t) => t.replace(/\n/g, '').length)
  const sorted = [...lens].sort((a, b) => a - b)
  const lengthP90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : 0
  let endPunct = 0
  let hasSpace = 0
  let question = 0
  let exclaim = 0
  let sticker = 0
  let emoji = 0
  let mixedEn = 0
  const CJK = /[\u4e00-\u9fff]/
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u
  for (const t of texts) {
    const trimmed = t.trim()
    if (/[。．.，,？！?~～…]\s*$/.test(trimmed)) endPunct++
    if (/[ \u3000]/.test(trimmed)) hasSpace++
    if (/[?？]/.test(trimmed)) question++
    if (/[!！]/.test(trimmed)) exclaim++
    if (/^\[(分享卡片|图片|动画表情|表情包|视频|文件)|^<sticker|^发起了/.test(trimmed)) sticker++
    if (EMOJI.test(trimmed)) emoji++
    if (CJK.test(trimmed) && /[a-zA-Z]{2,}/.test(trimmed)) mixedEn++
  }
  // 高频 2-gram（中文）：取所有相邻二字组合，滤标点/空白/纯数字
  const grams = new Map()
  for (const t of texts) {
    const clean = t.replace(/[\s\d\p{P}\p{S}]/gu, '')
    for (let i = 0; i < clean.length - 1; i++) {
      const g = clean.slice(i, i + 2)
      if (!CJK.test(g[0]) || !CJK.test(g[1])) continue
      grams.set(g, (grams.get(g) || 0) + 1)
    }
  }
  const topNGrams = [...grams.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([g, n]) => ({ g, n }))
  return {
    burstMerged: burst,
    lengthMedian: median(lens),
    lengthP90,
    endPunctRate: pct(endPunct, texts.length),
    spaceRate: pct(hasSpace, texts.length),
    questionRate: pct(question, texts.length),
    exclaimRate: pct(exclaim, texts.length),
    stickerRate: pct(sticker, texts.length),
    emojiRate: pct(emoji, texts.length),
    mixedEnRate: pct(mixedEn, texts.length),
    topNGrams,
  }
}

/** 统计锚点 → 提示词文本块（给 LLM 当基准约束）。 */
export function statsToPrompt (stats) {
  if (!stats || !stats.burstMerged || !stats.burstMerged.length) return ''
  const L = []
  L.push(`【统计学锚点（代码硬提取，必须遵守）】`)
  L.push(`- 合并突发后单条长度：中位 ${stats.lengthMedian} 字、P90 ${stats.lengthP90} 字。生成时模仿这个量级。`)
  if (stats.burstMerged.some((x) => x.count > 1)) {
    L.push(`- 他有连发习惯：多条短消息在 ${Math.round(10)} 秒内连着发。模仿时也允许拆成几条短句连发（用换行表示），不要总合成一段。`)
  }
  L.push(`- 句末带标点率 ${stats.endPunctRate}%、消息含空格率 ${stats.spaceRate}%、带问号 ${stats.questionRate}%、带叹号 ${stats.exclaimRate}%。`)
  if (stats.stickerRate) L.push(`- 表情/卡片使用率 ${stats.stickerRate}%。`)
  if (stats.emojiRate) L.push(`- Emoji 使用率 ${stats.emojiRate}%。`)
  if (stats.mixedEnRate) L.push(`- 中英混杂率 ${stats.mixedEnRate}%（中文句里夹英文术语）。`)
  const grams = Array.isArray(stats.topNGrams)
    ? stats.topNGrams.filter((x) => x && typeof x === 'object' && 'g' in x)
    : []
  if (grams.length) {
    L.push(`- 高频二字组合（供口癖交叉验证）：${grams.slice(0, 8).map((x) => `${x.g}×${x.n}`).join('、')}`)
  }
  return L.join('\n')
}
