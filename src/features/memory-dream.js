// 梦境记忆巩固（Dream Consolidation）：闲时把碎片事实去重、证伪、归纳为经验条目。
//
// 设计约束（对齐 memory-archive 的墓碑语义，物理档案只增不改）：
// 1. 纯函数：零 I/O、零网络，可注入时钟（now）与随机源（random）以便单测复现；
// 2. 不删除任何事实源：被合并/证伪的条目只产出 supersede 墓碑操作
//    （invalidAt + supersededBy + supersededFrom），由调用方交给 memoryArchive.supersede() 落盘；
// 3. 输入只读：返回对象全部是新建对象，改返回值不会污染入参，也互不影响；
// 4. 非法输入 fail-closed：容器非法直接 ok:false；单条非法只记录 rejected，不静默污染；
// 5. Token 硬顶可配置：超限按优先级截断并返回 truncated，被截断条目绝不写墓碑（不丢事实）。

export const DREAM_VERSION = 1

export const DEFAULT_DREAM_OPTIONS = {
  tokenBudget: 1200,
  // 判定重复的**内容相似度**下限（0~1，去虚词后的二元字组 Jaccard）。
  //
  // 实测依据（真实中文样本，回归见 test/memory-dream-threshold.test.js）：
  //   · 旧默认 0.82 对真实改写完全失效：同一件事的两种说法
  //     「主人下雨天喜欢呆在家里看书」/「下雨天主人最喜欢呆在家里面看书」
  //     归一词 Jaccard 只有 0.563（原串 0.529）—— 一条都不合并，梦境等于白跑；
  //   · 但**单纯降阈值必然误并**：这套指标上「换了一个字的另一件事」比真实改写更像。
  //     同一份样本：猫/狗 0.636、3月5日/3月6日 0.600、早上/晚上 0.600、红衣/蓝衣 0.818，
  //     前三条全都高于改写的 0.563。任何单一阈值都不可能同时「并改写」和「不并猫狗」。
  // 所以这里不是一个阈值说了算，而是**两级判定**（见 isDuplicate）：
  //   第一级 strictDedupeSimilarity（0.82，沿用旧值）：几乎逐字相同的，直接并，行为和以前完全一致；
  //   第二级才看 dedupeSimilarity，并且必须同时过完三道闸门 + 一条硬否决：
  //     ① 内容相似度 ≥ dedupeSimilarity（粗筛，排除明显不同的事实）
  //     ② 内容字符袋重合 ≥ dedupeBag（语序可以变，但用到的字必须几乎一样 —— 挡「换了主宾」）
  //     ③ 内容串 LCS-Dice ≥ dedupeOrder（语序崩了就不是同一句）
  //     ④ contradicts() 判为矛盾/取值改写的一律不并（猫狗、喜欢/不喜欢、日期、数字都靠这条兜）
  //   实测这三道门把上面所有「不应合并」样本全部挡住（误并 0 条），只漏掉 2 条极端改写 ——
  //   漏并在本模块是安全方向（少并一条只是多留一条记忆），误并才是不可恢复的错误。
  dedupeSimilarity: 0.55,
  // 第一级：几乎逐字相同就直接判重（旧的 0.82 语义原样保留）。
  strictDedupeSimilarity: 0.82,
  // ② 内容字符袋（多重集）Jaccard 下限：语序可变，用字必须几乎一致。
  dedupeBag: 0.9,
  // ③ 内容串 LCS-Dice 下限（0~1，衡量语序一致性）。
  dedupeOrder: 0.7,
  // 判定矛盾所需的最小主体重叠度（同一 entity/topic 槽位下，陈述指向同一主体才算证伪）
  conflictOverlap: 0.5,
  // 共性归纳的最小成员数
  minCluster: 2,
  // 闲时抽样上限，0/未设表示全量
  sampleLimit: 0,
  seed: 0,
  // 归纳条目最多引用多少条证据
  maxEvidence: 4,
}

const NEGATIONS = ['不', '没', '未', '别', '无需', '不再', '戒', '停止', '放弃', '取消', '拒绝']

// 功能 bigram（人称/情感谓词/虚词）：不算「主体锚点」，避免把「不喜欢下雨天」和「喜欢喝茶」判成矛盾。
const STOP_BIGRAMS = new Set([
  '主人', '人的', '我的', '你的', '他的', '她的', '我们', '你们', '他们', '她们',
  '喜欢', '欢喝', '爱喝', '要喝', '不爱', '不喜', '每天', '都是', '这是', '那是',
  '是的', '也是', '还有', '没有', '已经', '正在', '可以', '应该', '觉得', '认为',
  '感觉', '时候', '一个', '一只', '这个', '那个', '什么', '怎么', '因为', '所以',
])
const PUNCT = /[\s\u3000，。！？、；：,.!?;:'"()\[\]{}<>《》「」『』…—\-~`|/\\*+=_]+/gu

/** 确定性 PRNG（mulberry32）：默认随机源也保证「同输入同输出」，可被 options.random 覆盖。 */
export function seededRandom(seed = 0) {
  let a = (Number(seed) >>> 0) || 0
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 粗略 token 估算：CJK 每字 1 token，其余字符约 4 字符 1 token。够用于预算硬顶。 */
export function estimateTokens(text) {
  const s = typeof text === 'string' ? text : ''
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(ch)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/** 规范化文本：去标点空白、统一小写，用于比较与归纳。 */
export function normalizeText(text) {
  return String(text == null ? '' : text).replace(PUNCT, '').toLowerCase()
}

/** 二元字组集合，用于相似度。 */
function bigrams(s) {
  const n = normalizeText(s)
  const set = new Set()
  if (!n) return set
  if (n.length === 1) {
    set.add(n)
    return set
  }
  for (let i = 0; i < n.length - 1; i += 1) set.add(n.slice(i, i + 2))
  return set
}

// 纯语法虚词（助词/语气/程度/量词）：增删**不承载事实**，所以判重前先剔掉。
// 注意：方位词（上/里/面/边/家）会改变语义（"在家"/"在店里"），绝不能进这张表。
const FILLER_CHARS = /[的了着过呀啊吧呢嘛哦最很太就又再个只把被们当即刻]/gu

/** 判重用的「内容串」：归一化后剔掉纯语法虚词。 */
function contentText(text) {
  return normalizeText(text).replace(FILLER_CHARS, '')
}

/** 内容二元字组：比原串更能扛住中文改写的语序调整与虚词增减。 */
function contentBigrams(text) {
  const n = contentText(text)
  const set = new Set()
  if (!n) return set
  if (n.length === 1) {
    set.add(n)
    return set
  }
  for (let i = 0; i < n.length - 1; i += 1) set.add(n.slice(i, i + 2))
  return set
}

/** 字符多重集 Jaccard：语序可以不同，但「用了哪些字、各几次」必须几乎一致。 */
function bagJaccard(a, b) {
  if (!a || !b) return 0
  const count = (s) => {
    const m = new Map()
    for (const ch of s) m.set(ch, (m.get(ch) || 0) + 1)
    return m
  }
  const A = count(a)
  const B = count(b)
  let inter = 0
  let total = 0
  for (const [ch, n] of A) {
    total += n
    inter += Math.min(n, B.get(ch) || 0)
  }
  for (const [, n] of B) total += n
  return total ? inter / (total - inter) : 0
}

/** LCS-Dice：衡量两串的语序一致性（0~1，1 表示一条是另一条的子序列且几乎等长）。 */
function lcsDice(a, b) {
  const A = String(a || '')
  const B = String(b || '')
  if (!A.length || !B.length) return 0
  if (A === B) return 1
  let prev = new Array(B.length + 1).fill(0)
  for (let i = 1; i <= A.length; i += 1) {
    const cur = new Array(B.length + 1).fill(0)
    for (let j = 1; j <= B.length; j += 1) {
      cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  return (2 * prev[B.length]) / (A.length + B.length)
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

function overlapRatio(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / Math.min(a.size, b.size)
}

function polarityOf(text) {
  const n = normalizeText(text)
  let neg = 0
  for (const w of NEGATIONS) if (n.includes(w)) neg += 1
  return neg % 2 === 1 ? -1 : 1
}

/** 文本特征：字符集（中文按字）+ 二元字组 + 极性，用于相似/矛盾判定。 */
function featurize(text) {
  const n = normalizeText(text)
  const chars = new Set()
  for (const ch of n) chars.add(ch)
  const words = new Set(n.split(/[^a-z0-9]+/u).filter(Boolean))
  return { chars, words, bigrams: bigrams(text), polarity: polarityOf(text) }
}

function num(v, fallback = 0) {
  const x = Number(v)
  return Number.isFinite(x) ? x : fallback
}

function str(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim()
}

/**
 * 归一化单条记忆事实。兼容旧字段（只读别名）：text/body/content/summary 取正文，
 * at/ts/eventAt/time 取时间戳。返回 null 表示该条非法，应记入 rejected。
 */
export function normalizeFact(raw, index = 0) {
  if (raw == null) return null
  const isStr = typeof raw === 'string'
  if (!isStr && typeof raw !== 'object') return null
  const source = isStr ? { text: raw } : raw
  if (Array.isArray(source)) return null

  // 正文必须是字符串：数字/对象等非法类型 fail-closed，不做静默 String() 兜底
  const rawText = source.text ?? source.body ?? source.content ?? source.summary ?? source.detail
  const text = typeof rawText === 'string' ? rawText.trim() : ''
  if (!text) return null
  if (text.length > 4000) return null

  const id = str(source.id) || `anon-${index}`
  // 墓碑条目（已失效）只读跳过，绝不复用
  if (str(source.supersededBy) || num(source.invalidAt, 0) > 0) return null

  return {
    id,
    text,
    kind: str(source.kind) || 'fact',
    scope: str(source.scope),
    entity: str(source.entity || source.aboutName || source.subject),
    topic: str(source.topic || source.tag),
    about: str(source.about),
    at: num(source.at || source.ts || source.eventAt || source.time, 0),
    importance: Math.max(0, Math.min(1, num(source.importance, 0.5))),
    pinned: source.pinned === true,
    source: str(source.source) || 'dream',
    sourceId: str(source.sourceId),
    evidence: str(source.evidence),
    tags: Array.isArray(source.tags) ? [...new Set(source.tags.map((t) => str(t)).filter(Boolean))] : [],
    revision: num(source.revision, 0),
    // 显式槽位与显式矛盾指认（可选契约字段，只读透传）
    slot: str(source.slot),
    supersedes: str(source.supersedes),
    contradicts: str(source.contradicts),
  }
}

function groupKey(fact) {
  return `${fact.scope}|${fact.entity}|${fact.topic}`
}

/** 挑选代表条目：pinned > 重要度高 > 时间新 > id 字典序（保证确定性）。 */
function better(a, b) {
  if (!b) return true
  if (a.pinned !== b.pinned) return a.pinned
  if (a.importance !== b.importance) return a.importance > b.importance
  if (a.at !== b.at) return a.at > b.at
  return a.id < b.id
}

function clone(fact) {
  return { ...fact, tags: [...fact.tags] }
}

/** 共享的「实词锚点」bigram 数（剔除人称/情感/虚词）。 */
function contentAnchors(a, b) {
  let n = 0
  for (const x of a.bigrams) {
    if (b.bigrams.has(x) && !STOP_BIGRAMS.has(x)) n += 1
  }
  return n
}

/** 最长公共前缀/后缀长度。 */
function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i += 1
  return i
}

function commonSuffix(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1
  return i
}

/** 抹平数字与英文后的「取值骨架」：骨架相同而值不同，说明是同一单值槽位被改写。 */
function valueSkeleton(text) {
  return normalizeText(text).replace(/[0-9a-z]+/gu, '#')
}

/**
 * 判断两条同组事实是否互相矛盾（严格保守，宁可漏判不误杀）：
 * 1. 显式契约：任一方 supersedes/contradicts 指向对方，或同 slot 而取值不同；
 * 2. 极性反转（喜欢→戒了）且至少共享一个实词锚点；
 * 3. 同一单值槽位取值改写：数字骨架相同，或前后缀覆盖 ≥60% 且分歧段 ≤4 字，且共享 ≥2 实词锚点。
 */
function contradicts(a, b, fa, fb, floor = 0.5) {
  if (a.supersedes === b.id || b.supersedes === a.id) return true
  if (a.contradicts === b.id || b.contradicts === a.id) return true
  if (a.slot && b.slot && a.slot === b.slot && normalizeText(a.text) !== normalizeText(b.text)) return true

  const anchors = contentAnchors(fa, fb)
  if (!anchors) return false

  // 极性反转：一方肯定、一方否定同一主体
  if (fa.polarity !== fb.polarity && overlapRatio(fa.chars, fb.chars) >= floor) return true

  // 单值槽位改写
  const na = normalizeText(a.text)
  const nb = normalizeText(b.text)
  if (valueSkeleton(a.text) === valueSkeleton(b.text) && na !== nb) return true
  const maxLen = Math.max(na.length, nb.length)
  if (!maxLen) return false
  const spine = commonPrefix(na, nb) + commonSuffix(na, nb)
  const gap = maxLen - spine
  if (anchors >= 2 && spine / maxLen >= 0.6 && gap <= 4) return true
  return false
}

/**
 * 梦境巩固主入口。
 * @param {Array} facts 记忆事实数组（可为字符串条目）
 * @param {Object} options 见 DEFAULT_DREAM_OPTIONS，另支持 now/random 注入
 * @returns {Object} 巩固产物（新建对象，与入参无引用共享）
 */
export function consolidate(facts, options = {}) {
  const opts = { ...DEFAULT_DREAM_OPTIONS }
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    for (const [k, v] of Object.entries(options)) {
      if (k === 'now' || k === 'random') continue
      if (v !== undefined) opts[k] = v
    }
  }
  const nowFn = typeof options?.now === 'function' ? options.now : () => 0
  const at = num(nowFn(), 0)
  const random = typeof options?.random === 'function' ? options.random : seededRandom(opts.seed)

  const budget = Math.max(0, Math.floor(num(opts.tokenBudget, DEFAULT_DREAM_OPTIONS.tokenBudget)))
  const dedupeSim = Math.max(0, Math.min(1, num(opts.dedupeSimilarity, DEFAULT_DREAM_OPTIONS.dedupeSimilarity)))
  const strictSim = Math.max(dedupeSim, Math.min(1, num(opts.strictDedupeSimilarity, DEFAULT_DREAM_OPTIONS.strictDedupeSimilarity)))
  const dedupeBag = Math.max(0, Math.min(1, num(opts.dedupeBag, DEFAULT_DREAM_OPTIONS.dedupeBag)))
  const dedupeOrder = Math.max(0, Math.min(1, num(opts.dedupeOrder, DEFAULT_DREAM_OPTIONS.dedupeOrder)))
  const conflictFloor = Math.max(0, Math.min(1, num(opts.conflictOverlap, DEFAULT_DREAM_OPTIONS.conflictOverlap)))
  const minCluster = Math.max(2, Math.floor(num(opts.minCluster, DEFAULT_DREAM_OPTIONS.minCluster)))
  const maxEvidence = Math.max(1, Math.floor(num(opts.maxEvidence, DEFAULT_DREAM_OPTIONS.maxEvidence)))

  // —— fail-closed：容器非法直接拒绝，不产出半成品 ——
  if (!Array.isArray(facts)) {
    return {
      ok: false,
      version: DREAM_VERSION,
      error: 'facts 必须是数组',
      at,
      facts: [],
      experiences: [],
      tombstones: [],
      supersede: [],
      merges: [],
      conflicts: [],
      dropped: [],
      rejected: [],
      tokens: { budget, used: 0, input: 0 },
      truncated: false,
      stats: { input: 0, valid: 0, rejected: 0, sampled: 0, merged: 0, falsified: 0, experienced: 0, kept: 0, tombstones: 0 },
    }
  }

  const rejected = []
  const valid = []
  for (let i = 0; i < facts.length; i += 1) {
    const f = normalizeFact(facts[i], i)
    if (f) valid.push(f)
    else rejected.push({ index: i, reason: 'invalid-fact' })
  }

  // 闲时抽样：显式可复现（注入 random）或默认定种子 PRNG
  let sampled = valid
  const sampleLimit = Math.floor(num(opts.sampleLimit, 0))
  if (sampleLimit > 0 && valid.length > sampleLimit) {
    sampled = [...valid]
    for (let i = sampled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1))
      const tmp = sampled[i]
      sampled[i] = sampled[j]
      sampled[j] = tmp
    }
    sampled = sampled.slice(0, sampleLimit)
  }

  const tombstones = []
  const supersede = []
  const merges = []
  const conflicts = []

  const tombstone = (victim, winner, reason) => {
    tombstones.push({
      id: victim.id,
      invalidAt: at || 1,
      supersededBy: winner.id,
      supersededFrom: '',
      reason,
    })
    supersede.push({ action: 'supersede', oldId: victim.id, newId: winner.id, invalidAt: at || 1, reason })
  }

  // —— 第一遍：分组 + 去重合并 ——
  const groups = new Map()
  for (const fact of sampled) {
    const key = groupKey(fact)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(fact)
  }

  /**
   * 判重（两级）：
   *   第一级：原串二元字组 Jaccard ≥ strictSim（默认 0.82）—— 几乎逐字相同，直接并，
   *          行为和引入第二级之前完全一致，现有数据与测试不受影响。
   *   第二级：真实中文改写。仅靠降阈值会误并（「换一个字」比「改写」更像），
   *          所以必须同时满足内容相似度、字符袋重合、语序一致，且不构成矛盾。
   * 漏并是安全方向（多留一条记忆），误并才不可恢复 —— 所有闸门都往这个方向偏。
   */
  function isDuplicate(a, b, fa, fb) {
    if (jaccard(fa.bigrams, fb.bigrams) >= strictSim) return true

    const ca = contentText(a.text)
    const cb = contentText(b.text)
    if (!ca || !cb) return false
    // ① 内容串完全相同（只差虚词/标点/语气）＝同一句话，直接判重。
    //    这一条必须放在 contradicts 之前：contradicts 对「加个虚词」也会误报成
    //    单值槽位改写（实测「主人喜欢喝咖啡」vs「主人喜欢喝咖啡的」判矛盾），
    //    不先兜住就会把真正的重复当成冲突去证伪 —— 那就从「漏并」变成「错杀」了。
    if (ca === cb) return true
    // ② 内容相似度粗筛
    if (jaccard(contentBigrams(a.text), contentBigrams(b.text)) < dedupeSim) return false
    // ③ 用字必须几乎一致（挡「换了主宾/对象」：小明喜欢小红 ≠ 小红喜欢小明）
    if (bagJaccard(ca, cb) < dedupeBag) return false
    // ④ 语序不能崩（同上，另一视角）
    if (lcsDice(ca, cb) < dedupeOrder) return false
    // ⑤ 硬否决：判为矛盾/取值改写的一律不并（猫狗、喜欢/不喜欢、日期、数字）
    if (contradicts(a, b, fa, fb, conflictFloor)) return false
    return true
  }

  const survivors = []
  for (const key of [...groups.keys()].sort()) {
    const members = groups.get(key)
    const clusters = []
    for (const fact of members) {
      const feats = featurize(fact.text)
      let target = null
      for (const c of clusters) {
        if (isDuplicate(fact, c.rep, feats, c.feats)) {
          target = c
          break
        }
      }
      if (target) {
        target.members.push(fact)
        // rep 换人时 feats 必须同步：判重/判矛盾都拿 rep 的文本配 feats，配错等于拿别人的特征比。
        if (better(fact, target.rep)) {
          target.rep = fact
          target.feats = feats
        }
      } else {
        clusters.push({ rep: fact, members: [fact], feats })
      }
    }

    for (const cluster of clusters) {
      const rep = clone(cluster.rep)
      const rest = cluster.members.filter((m) => m.id !== rep.id)
      if (rest.length) {
        rep.mergedFrom = rest.map((m) => m.id)
        rep.mergedCount = rest.length + 1
        rep.evidence = [rep.evidence, ...rest.map((m) => m.evidence)].filter(Boolean).join('；').slice(0, 800)
        rep.tags = [...new Set([...cluster.members.flatMap((m) => m.tags)])]
        rep.importance = Math.max(...cluster.members.map((m) => m.importance))
        rep.pinned = cluster.members.some((m) => m.pinned)
        merges.push({ key, representative: rep.id, merged: rest.map((m) => m.id) })
        for (const m of rest) tombstone(m, rep, 'duplicate')
      }
      survivors.push({ key, fact: rep, feats: featurize(rep.text) })
    }
  }

  // —— 第二遍：同组内矛盾证伪（时间/重要度新者胜出，旧者立墓碑） ——
  const byGroup = new Map()
  for (const s of survivors) {
    if (!byGroup.has(s.key)) byGroup.set(s.key, [])
    byGroup.get(s.key).push(s)
  }
  const falsified = new Set()
  for (const key of [...byGroup.keys()].sort()) {
    const list = byGroup.get(key)
    if (list.length < 2) continue
    const ordered = [...list].sort((a, b) => (better(b.fact, a.fact) ? 1 : -1))
    const winner = ordered[0]
    const losers = []
    for (const cand of ordered.slice(1)) {
      if (contradicts(cand.fact, winner.fact, cand.feats, winner.feats, conflictFloor)) losers.push(cand)
    }
    if (!losers.length) continue
    for (const l of losers) {
      tombstone(l.fact, winner.fact, 'conflict')
      falsified.add(l.fact.id)
    }
    winner.fact.supersededFrom = losers[losers.length - 1].fact.id
    winner.fact.falsifiedCount = losers.length
    conflicts.push({ key, winner: winner.fact.id, losers: losers.map((l) => l.fact.id) })
  }

  const keptFacts = survivors.filter((s) => !falsified.has(s.fact.id)).map((s) => s.fact)

  // —— 第三遍：共性归纳（同话题/实体且成员数达阈值 → 一条经验条目） ——
  const clusterMap = new Map()
  for (const fact of keptFacts) {
    const ck = `${fact.scope}|${fact.topic || fact.entity || '通用'}`
    if (!clusterMap.has(ck)) clusterMap.set(ck, [])
    clusterMap.get(ck).push(fact)
  }
  const experiences = []
  for (const ck of [...clusterMap.keys()].sort()) {
    const members = clusterMap.get(ck)
    if (members.length < minCluster) continue
    const freq = new Map()
    for (const m of members) {
      for (const bg of featurize(m.text).bigrams) freq.set(bg, (freq.get(bg) || 0) + 1)
    }
    const keywords = [...freq.entries()]
      .filter(([, n]) => n >= Math.max(2, Math.ceil(members.length / 2)))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 5)
      .map(([w]) => w)
    const label = members[0].topic || members[0].entity || '通用'
    const evidence = members
      .slice()
      .sort((a, b) => (better(a, b) ? -1 : 1))
      .slice(0, maxEvidence)
      .map((m) => ({ id: m.id, text: m.text.slice(0, 120) }))
    experiences.push({
      id: `exp-${normalizeText(label).slice(0, 12) || 'misc'}-${experiences.length + 1}`,
      kind: 'experience',
      scope: members[0].scope,
      topic: members[0].topic,
      entity: members[0].entity,
      label,
      summary: `关于「${label}」的共性归纳（${members.length} 条）：${keywords.length ? keywords.join('、') : members[0].text.slice(0, 40)}`,
      keywords,
      members: members.map((m) => m.id),
      evidence,
      confidence: Math.min(1, 0.5 + members.length * 0.1),
      importance: Math.max(...members.map((m) => m.importance)),
      at,
      derivedFrom: 'dream-consolidation',
    })
  }

  // —— 预算硬顶：先保事实，再保经验；被截断条目只记 dropped，绝不立墓碑 ——
  const dropped = []
  const outFacts = []
  const outExp = []
  let used = 0
  const orderedFacts = [...keptFacts].sort((a, b) => (better(a, b) ? -1 : 1))
  for (const fact of orderedFacts) {
    const cost = estimateTokens(fact.text)
    if (used + cost > budget) {
      dropped.push({ id: fact.id, kind: fact.kind || 'fact', tokens: cost })
      continue
    }
    used += cost
    outFacts.push(fact)
  }
  for (const exp of experiences) {
    const cost = estimateTokens(exp.summary)
    if (used + cost > budget) {
      dropped.push({ id: exp.id, kind: 'experience', tokens: cost })
      continue
    }
    used += cost
    outExp.push(exp)
  }
  const truncated = dropped.length > 0

  const inputTokens = facts.reduce((sum, raw) => {
    const t = typeof raw === 'string' ? raw : (raw && (raw.text || raw.body || raw.content || raw.summary)) || ''
    return sum + estimateTokens(typeof t === 'string' ? t : '')
  }, 0)

  return {
    ok: true,
    version: DREAM_VERSION,
    at,
    facts: outFacts,
    experiences: outExp,
    tombstones,
    supersede,
    merges,
    conflicts,
    dropped,
    rejected,
    tokens: { budget, used, input: inputTokens },
    truncated,
    stats: {
      input: facts.length,
      valid: valid.length,
      rejected: rejected.length,
      sampled: sampled.length,
      merged: tombstones.filter((t) => t.reason === 'duplicate').length,
      falsified: tombstones.filter((t) => t.reason === 'conflict').length,
      experienced: outExp.length,
      kept: outFacts.length,
      tombstones: tombstones.length,
    },
  }
}

export default consolidate
