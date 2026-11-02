// 极简 QR 编码器（字节模式，版本 1~10，纠错等级 M）。
// 只为了把 otpauth:// 链接画成二维码，不引第三方依赖。
// 参考 ISO/IEC 18004：数据编码 → 分块加纠错 → 交织 → 掩码选优 → 画矩形。
//
// 用法：qrMatrix('otpauth://totp/...') → boolean[][]（true = 黑）

/** 每块纠错码字数（等级 M，版本 1~10）。 */
// 版本 → [每块数据码字数, 块数]，有两种块大小时用 [大块字数, 大块数, 小块字数, 小块数]
const BLOCK_TABLE_M = [
  null,
  [16, 1],
  [28, 1],
  [44, 1],
  [32, 2],
  [43, 2],
  [27, 4],
  [31, 4],
  [39, 2, 38, 2],
  [37, 2, 36, 3],
  [44, 1, 43, 4],
  [51, 4, 50, 1],
  [37, 2, 36, 6],
  [38, 1, 37, 8],
  [41, 5, 40, 4],
  [42, 5, 41, 5],
]
/** 每块纠错码字数（等级 M，版本 1~15）。 */
const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24]
/** 数据码字总数（等级 M，版本 1~15）。 */
const TOTAL_DATA_M = [-1, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216, 254, 290, 334, 365, 415]

/** 版本 v 的块分配：返回 [{ data: 每块数据字数 }...]（大块在前）。 */
function blocksOf(v) {
  const t = BLOCK_TABLE_M[v]
  if (!t) throw new Error('不支持的版本：' + v)
  const out = []
  if (t.length === 2) for (let i = 0; i < t[1]; i++) out.push({ data: t[0] })
  else for (let i = 0; i < t[3]; i++) out.push({ data: t[2] })
  if (t.length === 4) for (let i = 0; i < t[1]; i++) out.unshift({ data: t[0] })
  return out
}
/** 版本 → 对齐图案中心坐标。 */
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70]]

const bit = (n, i) => ((n >>> i) & 1) === 1

/** GF(256) 乘法（本原多项式 0x11d）。 */
function gfMul(a, b) {
  let r = 0
  for (let i = 7; i >= 0; i--) {
    r = (r << 1) ^ ((r >>> 7) * 0x11d)
    r ^= ((b >>> i) & 1) * a
  }
  return r & 0xff
}

/** 生成 degree 次的纠错生成多项式系数（不含最高次 1）。 */
function rsPoly(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1)
      next[j + 1] ^= gfMul(poly[j], Math.pow(2, i))
    }
    poly = next
  }
  return poly.slice(1)
}

/** 算一段数据的 RS 纠错码字。 */
function rsEncode(data, degree) {
  const gen = rsPoly(degree)
  const res = new Array(degree).fill(0)
  for (const d of data) {
    const factor = d ^ res[0]
    res.shift()
    res.push(0)
    for (let i = 0; i < degree; i++) res[i] ^= gfMul(gen[i], factor)
  }
  return res
}

/** UTF-8 编码成字节数组。 */
function utf8Bytes(str) {
  const out = []
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    let c = s.codePointAt(i)
    if (c > 0xffff) i++
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return out
}

/** 选最小的能装下这些字节的版本（字节模式，等级 M）。 */
function pickVersion(byteLen) {
  for (let v = 1; v <= 15; v++) {
    const capacityBits = TOTAL_DATA_M[v] * 8
    const countBits = v < 10 ? 8 : 16
    if (byteLen * 8 + 4 + countBits <= capacityBits) return v
  }
  throw new Error('内容太长，画不下（最多约 400 字节）')
}

export function qrMatrix(text) {
  const bytes = utf8Bytes(text)
  const version = pickVersion(bytes.length)
  const size = version * 4 + 17

  // ---- 1. 数据位流：模式 0100 + 长度 + 数据 + 终止符 + 补齐 ----
  const bits = []
  // 注意：这里必须用 >>>（无符号右移）。长度 67 的左移会溢出到负数，
  // 用 >> 会把符号位补进来，写出的字节就全错了。
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1) }
  push(4, 4)
  push(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) push(b, 8)
  const totalDataBits = TOTAL_DATA_M[version] * 8
  const term = Math.min(4, totalDataBits - bits.length)
  push(0, term)
  while (bits.length % 8 !== 0) bits.push(0)
  const padBytes = [0xec, 0x11]
  let pi = 0
  while (bits.length < totalDataBits) push(padBytes[pi++ % 2], 8)

  const dataCw = []
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]
    dataCw.push(v)
  }

  // ---- 2. 分块 + 纠错 ----
  const eccLen = ECC_PER_BLOCK_M[version]
  const plan = blocksOf(version)
  const dBlocks = []
  const eBlocks = []
  let off = 0
  for (const blk of plan) {
    const chunk = dataCw.slice(off, off + blk.data)
    off += blk.data
    dBlocks.push(chunk)
    eBlocks.push(rsEncode(chunk, eccLen))
  }
  // 交织：先按列取所有块的数据字（短块跳过缺的那一列），再按列取纠错字
  const maxPer = Math.max(...plan.map((b) => b.data))
  const final = []
  for (let i = 0; i < maxPer; i++) for (const blk of dBlocks) if (i < blk.length) final.push(blk[i])
  for (let i = 0; i < eccLen; i++) for (const blk of eBlocks) final.push(blk[i])

  // ---- 3. 画功能图案 ----
  const m = Array.from({ length: size }, () => new Array(size).fill(null)) // true/false = 数据；null = 未定
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))
  const setF = (x, y, v) => { if (x >= 0 && y >= 0 && x < size && y < size) { m[y][x] = v; reserved[y][x] = true } }

  // 定位图案：7x7 本体 + 一圈分隔符（共 8x8），只标到该标的范围，多标会让数据索引偏移。
  const finder = (cx, cy) => {
    for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || y < 0 || x >= size || y >= size) continue
      // 距离 7x7 中心的最大偏移：0..3 是本体，4 是分隔符
      const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
      const dark = d === 0 || d === 2 // 中心 3x3 + 最外环 7x7 边框
      setF(x, y, d === 4 ? false : dark)
    }
  }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4)

  // 定位图案（虚线）：第 6 行 / 第 6 列，从 index 8 到 size-9，每隔一格一个深色，起点是深色。
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0
    setF(6, i, dark)
    setF(i, 6, dark)
  }
  // 对齐图案
  for (const ax of ALIGN[version]) for (const ay of ALIGN[version]) {
    if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy))
      setF(ax + dx, ay + dy, d !== 1)
    }
  }
  // 格式信息（先占位，后面用真值覆盖）
  for (let i = 0; i < 9; i++) { setF(i, 8, false); setF(8, i, false) }
  for (let i = 0; i < 8; i++) { setF(size - 1 - i, 8, false); setF(8, size - 1 - i, false) }
  setF(8, size - 8, true) // 固定深色模块
  // 版本信息（版本 >= 7）
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const vb = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const v = bit(vb, i)
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setF(a, b, v); setF(b, a, v)
    }
  }

  // ---- 4. 摆数据（右下往上，Z 字） ----
  let idx = 0
  const totalBits = final.length * 8
  // 标准走法：从右下开始，每两列一组；组内先右列后左列；第一组向上，之后交替。
  // 走法：列从右往左每两列一组（组内先右列后左列），行从下往上、走到顶再往下，来回折。
  // 第 6 列是时序图案要跳过；不按「每组重新定向」，而是持续 zigzag（这才是标准）。
  let row = size - 1
  let inc = -1
  let bitIndex = 7
  let byteIndex = 0
  for (let col = size - 1; col > 0; col -= 2) {
    if (col <= 6) col -= 1
    const cols = [col, col - 1]
    for (;;) {
      for (const c of cols) {
        if (reserved[row][c]) continue
        let dark = false
        if (byteIndex < final.length) {
          dark = bit(final[byteIndex], bitIndex)
          bitIndex--
          if (bitIndex === -1) { byteIndex++; bitIndex = 7 }
        }
        m[row][c] = dark
        idx++
      }
      row += inc
      if (row < 0 || row >= size) { row -= inc; inc = -inc; break }
    }
  }

  // ---- 5. 掩码：8 种挑惩罚分最低的 ----
  const maskFn = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ]
  const formatBits = (maskId) => {
    const data = (0 << 3) | maskId // 纠错等级 M = 00
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    return ((data << 10) | rem) ^ 0x5412
  }
  const applyMask = (grid, maskId) => {
    const g = grid.map((r) => r.slice())
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (reserved[y][x]) continue
      if (maskFn[maskId](x, y)) g[y][x] = !g[y][x]
    }
    // 写格式信息（两个副本，共 15 位；纠错等级 M = 00）
    const fb = formatBits(maskId)
    const put = (x, y, v) => { g[y][x] = v }
    // 副本 1：左上角，沿第 8 列往下（跳过第 6 行）再沿第 8 行往右（跳过第 6 列）
    for (let i = 0; i <= 5; i++) put(8, i, bit(fb, i))
    put(8, 7, bit(fb, 6))
    put(8, 8, bit(fb, 7))
    put(7, 8, bit(fb, 8))
    for (let i = 9; i < 15; i++) put(14 - i, 8, bit(fb, i))
    // 第 6 行 / 第 6 列与时序图案交汇的两格：标准里固定是深色，不承载格式位
    put(8, 6, true)
    put(6, 8, true)
    // 副本 2：右上 + 左下
    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(fb, i))
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(fb, i))
    // 固定深色模块
    put(8, size - 8, true)
    return g
  }
  const penalty = (g) => {
    let p = 0
    // 规则 1：连续同色
    for (let y = 0; y < size; y++) { let run = 1; for (let x = 1; x < size; x++) { if (g[y][x] === g[y][x - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++ } else run = 1 } }
    for (let x = 0; x < size; x++) { let run = 1; for (let y = 1; y < size; y++) { if (g[y][x] === g[y - 1][x]) { run++; if (run === 5) p += 3; else if (run > 5) p++ } else run = 1 } }
    // 规则 2：2x2 同色块
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = g[y][x]
      if (c === g[y][x + 1] && c === g[y + 1][x] && c === g[y + 1][x + 1]) p += 3
    }
    // 规则 3：近似定位图案
    const pat = [true, false, true, true, true, false, true]
    for (let y = 0; y < size; y++) for (let x = 0; x + 6 < size; x++) {
      let ok = true
      for (let i = 0; i < 7; i++) if (g[y][x + i] !== pat[i]) { ok = false; break }
      if (ok) p += 40
    }
    for (let x = 0; x < size; x++) for (let y = 0; y + 6 < size; y++) {
      let ok = true
      for (let i = 0; i < 7; i++) if (g[y + i][x] !== pat[i]) { ok = false; break }
      if (ok) p += 40
    }
    // 规则 4：黑白比例
    let dark = 0
    for (const row of g) for (const c of row) if (c) dark++
    const ratio = Math.abs(dark / (size * size) - 0.5)
    p += Math.floor(ratio * 20) * 10
    return p
  }

  let best = null, bestScore = Infinity
  for (let maskId = 0; maskId < 8; maskId++) {
    const g = applyMask(m, maskId)
    const score = penalty(g)
    if (score < bestScore) { bestScore = score; best = g }
  }
  return best
}
