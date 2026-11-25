// 内部备忘块（purpose / 漏写 <inner> 的心智独白）的共享切分口径。
//
// 为什么抽成零依赖共享模块：出站清洗（src/chat/reply.js: stripInternalMemo）与网页显示层折叠
// （client/src/core/inner-fold.js: findMemoStart）必须保持完全一致，不能手抄两份正则各自漂移。

/** 内部备忘块的边界：行首、换行、`|||` 分隔符，或紧跟已闭合 `<inner>` 的等长遮蔽占位（\uE002）。 */
const MEMO_BOUNDARY = String.raw`(?:^|\n|\|\|\||(?<=\uE002))`

/** 备忘块里的结构化标签词（同时覆盖 purpose 内部备忘与心智独白）。 */
const MEMO_LABEL_WORD = String.raw`(?:目的|需求|情绪|情感|类型|状态|待续|意图|闭环|备忘|顺承前情)`

/**
 * 备忘块的小标题：`【内部备忘】` / `【备忘】` / `内部备忘：` / 裸行 `内部备忘`（允许标题号、加粗与行首缩进）。
 *
 * - 方括号允许短前缀 + `备忘` + 至多 12 字短后缀（如 `【内部备忘·非QQ内容】`），`备忘录` 除外；
 * - 带冒号的裸写法同理（如 `内部备忘（不发）：`）；
 * - 无方括号、无冒号的裸行写法（真机 2026-11-25 08:00/09:40/12:32 实测形状）限定其后必须紧跟
 *   换行 / 结尾 / `|||` / 备忘标签，避免误杀「内部备忘发给我看看」这类正常句子。
 */
const MEMO_HEADER = new RegExp(
  `${MEMO_BOUNDARY}[ \\t]*(?:#{1,6}[ \\t]+)?(?:\\*\\*|__)?[ \\t]*(?:`
  + String.raw`[【\[]\s*[^】\]]{0,6}?备忘(?!录)[^】\]]{0,12}[】\]]`
  + String.raw`|内部备忘(?!录)[^：:\n]{0,12}[：:]`
  + String.raw`|(?:[「『]内部备忘(?!录)[^」』\n]{0,12}[」』]|内部备忘(?!录)(?:[ \t]*(?:[（(][^）)\n]{1,16}[）)]|[·•\-—/][^\s\n，。！？!?,;；【\[\]]{1,12}))?)[ \t]*(?:\*\*|__)?[ \t]*(?=\r?\n|$|\|\|\||[【\[]\s*` + MEMO_LABEL_WORD + String.raw`\s*[】\]])`
  + ')',
)

/** 备忘块里的行首结构化标签（兜底：至少命中两个才当备忘块，避免误删单标签正常行文）。 */
const MEMO_LABELS = new RegExp(`${MEMO_BOUNDARY}\\s*(?:\\*\\*|__)?\\s*[【\\[]\\s*${MEMO_LABEL_WORD}\\s*[】\\]]`, 'g')

/**
 * 同行分隔的后续标签（如 `【目的】无 【状态】跳过` 或提示词原文要求的 `【目的】无、【状态】跳过`）。
 * 只在首个行首标签的同一行内扫描，不跨行，避免「单行首标签 + 后文行内顺口提到【状态】」被误切。
 */
const MEMO_LABEL_FOLLOW = new RegExp(
  `(?:^|[ \\t、，,;；|/])[ \\t]*(?:\\*\\*|__)?[ \\t]*[【\\[]\\s*${MEMO_LABEL_WORD}\\s*[】\\]]`,
)

/**
 * 查找内部备忘块在文本中的起始下标；没有备忘块时返回 -1。
 * 同时检查小标题与双标签兜底，都命中时取更靠前的切点。
 *
 * @param {string} text
 * @returns {number}
 */
export function findMemoStart(text) {
  const s = String(text ?? '')
  // 便宜的预筛：既没有「备忘」二字、也没有任何方括号，就不可能是备忘块。
  if (!s.includes('备忘') && !s.includes('【') && !s.includes('[')) return -1
  const header = MEMO_HEADER.exec(s)
  const headerCut = header ? header.index : -1
  MEMO_LABELS.lastIndex = 0
  const first = MEMO_LABELS.exec(s)
  let second = first ? MEMO_LABELS.exec(s) : null
  MEMO_LABELS.lastIndex = 0
  if (first && !second) {
    const afterFirst = first.index + first[0].length
    const lineEnd = s.indexOf('\n', afterFirst)
    const sameLine = lineEnd < 0 ? s.slice(afterFirst) : s.slice(afterFirst, lineEnd)
    second = MEMO_LABEL_FOLLOW.exec(sameLine)
  }
  const labelCut = second ? first.index : -1
  return headerCut < 0 ? labelCut : (labelCut < 0 ? headerCut : Math.min(headerCut, labelCut))
}
