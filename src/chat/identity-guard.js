// 身份泄露闸（纯函数，无 IO）。
//
// 移植自 surfcore 的 src/identity-guard.js（MIT，2026-11-04 存档见 docs/reference/）。
//
// 为什么要这层硬闸：
//   跨平台互认、白名单管理、群号查询这些场景必然让「谁的哪个号」进入上下文，
//   模型一旦在**公开面**（B站评论、QQ空间动态、别人的群里）复述出来，就再也收不回去
//   （2026-11-03 实测：她在群里复述过群号 333444555、在群聊里报过主人的号）。
//   提示词里的「不要泄露」只是概率约束，正则才是确定性的。
//
// 边界（别把它当万能）：
//   · 只认「已知 ID 精确命中」和明确的「QQ/群号 + 数字」形态；
//   · 不拦普通数字（年份、播放量、楼层、BV 号里的数字），免得把正常内容全拦掉；
//   · 不拦昵称：昵称会撞、会重复，误伤成本远高于收益；
//   · 只回答「要不要发」，发出去之后怎么补救不归它管。

/**
 * 在文本里找受保护 ID 的命中。
 * @param {string} text 准备发出去的正文
 * @param {{ids?: Iterable<string|number>, allowIds?: Iterable<string|number>}} options
 *   ids = 受保护 ID（主人/别人的 QQ 号、B站 mid 等）；allowIds = 允许出现（比如这个群自己的群号）
 * @returns {Array<{kind:string,label:string,value:string,index:number}>}
 */
export function findIdentityLeaks(text, { ids = [], allowIds = [] } = {}) {
  const raw = String(text ?? '')
  if (!raw.trim()) return []
  const allow = new Set([...allowIds].map((x) => String(x ?? '').trim()).filter(Boolean))
  const hits = []
  const seen = new Set()
  // 1) 已知 ID 精确命中：这些号码本来就只在配置/对齐表里，不该出现在公开文本里
  for (const value of ids ?? []) {
    const id = String(value ?? '').trim()
    if (!/^\d{4,15}$/.test(id) || seen.has(id) || allow.has(id)) continue
    seen.add(id)
    const index = raw.indexOf(id)
    if (index >= 0) hits.push({ kind: 'known-id', label: '账号标识', value: id, index })
  }
  // 2) 明确的「QQ / 群号 + 数字」：即使不在名单里，也是在往外递联系方式
  const explicit = /(?:QQ|qq|Q群|q群|群号|群\s*号|加群|企鹅号)\s*[：:=是为]?\s*(\d{5,12})/g
  let match
  while ((match = explicit.exec(raw)) !== null) {
    const v = match[1]
    if (allow.has(v) || seen.has(`pattern:${v}`)) continue
    seen.add(`pattern:${v}`)
    hits.push({ kind: 'qq-context', label: 'QQ/群号', value: v, index: match.index })
  }

  // 3) 裸的 5~12 位连续数字：QQ 号/群号最常见的形态（「333444555 加进白名单了」）。
  // 只认**独立成词**的长数字串，长度 ≥8（QQ 号/群号现在普遍 9~11 位；5~7 位更像数量/楼层，误伤代价高）。
  // 误伤代价：把播放量/楼层当成号码会拦掉正常内容——所以要求长度 ≥5 且前后不接数字/小数点。
  const bare = /(?<![\d.])(\d{8,12})(?![\d.]|\.\d)/g
  while ((match = bare.exec(raw)) !== null) {
    const v = match[1]
    if (allow.has(v) || seen.has('bare:' + v)) continue
    // 年份（19xx / 20xx）和全 0 开头不当作号码
    if (/^(19|20)\d{2}$/.test(v)) continue
    if (/^0/.test(v)) continue
    seen.add('bare:' + v)
    hits.push({ kind: 'bare-number', label: '疑似账号', value: v, index: match.index + match[0].indexOf(v) })
  }
  return hits.sort((a, b) => a.index - b.index)
}

/** 把命中的 ID 打码后再拼进错误信息：错误信息本身也可能被贴进日志/给模型看。 */
export function maskLeakValue(value) {
  const s = String(value ?? '')
  if (!/^\d{5,}$/.test(s)) return s
  if (s.length <= 6) return `${s.slice(0, 1)}****${s.slice(-1)}`
  return `${s.slice(0, 3)}****${s.slice(-3)}`
}

/** 出站前的人话拒绝语（给日志/面板看）。 */
export function formatIdentityLeakError(hits, surface = '消息') {
  const list = (hits ?? []).map((h) => maskLeakValue(h.value)).filter(Boolean)
  const uniq = [...new Set(list)].join('、')
  return `这条${surface}里出现了主人/别人的账号标识（${uniq}）。`
    + '账号信息不许外传：把号码删掉再发（用「主人」「那位」这类称呼代替），也不要暗示是哪个号。'
}

/**
 * 判断这条要发出去的消息能不能放行。
 * @param {string} text 正文
 * @param {{surface?:string, ids?:Iterable, allowIds?:Iterable, mode?:'block'|'warn'}} opts
 *   mode=block 直接拦下（返回 ok:false）；mode=warn 只记日志照发
 * @returns {{ok:boolean, hits:Array, message:string}}
 */
export function checkIdentityLeak(text, { surface = '消息', ids = [], allowIds = [], mode = 'block' } = {}) {
  const hits = findIdentityLeaks(text, { ids, allowIds })
  if (!hits.length) return { ok: true, hits: [], message: '' }
  const message = formatIdentityLeakError(hits, surface)
  if (mode === 'warn') return { ok: true, hits, message }
  return { ok: false, hits, message }
}
