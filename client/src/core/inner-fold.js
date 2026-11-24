// 正文里 <inner> 心智独白的显示层折叠（网页半边）。
//
// 背景：v3.4 起人设每轮要求在正文最前面写一段 <inner>…</inner>（src/persona/personas.js），
// 出站由 src/chat/reply.js: extractAndStripInnerMonologue 100% 剥离，QQ 上谁都看不到；
// 但它确实是模型**正文 text 段**的一部分，而 DSH 的聊天视图只把 provider 的 reasoning 段折成
// 「思考」行，text 段一律原样当正文渲染 —— 于是主人自己翻会话时看到的是
// `<inner>【意图】…【备忘】</inner>早 哥|||今天…`（2026-11-24 07:55 私聊实机就是这个形状）。
//
// 这里只做显示层：把正文文本节点里的 <inner> 段换成一个点开才展开的「思考」行。
// 不碰 QQ 侧任何逻辑，也不改 DSH 的会话记录 —— 刷新页面就回到原样。
//
// 为什么不走 slot：DSH 0.2.3 的聊天视图没有「正文渲染」这类插槽
// （conversation.chat.node 的 assistant-step 由 ui-chat 自己注册，markdown 是固定的 MarkdownText，
// 只有 reasoning.body / markdown.fence 可挂），所以只能对已经渲染出来的文本节点做一次改写。

/** 开标签：`<inner>`，也认带属性的写法；大小写不敏感。 */
const OPEN_TAG = /<inner(?![A-Za-z0-9_-])[^>]*>/gi
/** 闭标签。 */
const CLOSE_TAG = /<\/inner\s*>/gi

/**
 * 把一段正文按心智独白切开，给显示层用。
 *
 * 口径（与出站剥离的宽松度对齐，但**只折完整的块**）：
 * - 成对的 `<inner>…</inner>` 整段变成 `{ type: 'inner' }`，标签不进正文；
 * - `<inner/>` 这种空标签当普通文字留着，不折；
 * - 没闭合的开标签（流式还没写完 / 模型被截断）整段保持原样：
 *   宁可多露一坨字，也不能把还没闭合的正文藏进折叠里；
 * - 不做嵌套配对，模型不会写嵌套（出站那边有嵌套保护，这里只负责好看）。
 *
 * @param {string} text 一段正文
 * @returns {Array<{type: 'text' | 'inner', value: string}>} 按出现顺序切好的段
 */
export function splitInnerBlocks(text) {
  const source = String(text ?? '')
  const parts = []
  let cursor = 0
  let searchAt = 0
  for (;;) {
    OPEN_TAG.lastIndex = searchAt
    const open = OPEN_TAG.exec(source)
    if (!open) break
    const contentStart = open.index + open[0].length
    searchAt = contentStart
    // 空标签 `<inner/>`：不折，也不吃掉它，继续往后找
    if (/\/>\s*$/.test(open[0])) continue
    CLOSE_TAG.lastIndex = contentStart
    const close = CLOSE_TAG.exec(source)
    if (!close) break
    if (open.index > cursor) parts.push({ type: 'text', value: source.slice(cursor, open.index) })
    parts.push({ type: 'inner', value: source.slice(contentStart, close.index) })
    cursor = close.index + close[0].length
    searchAt = cursor
  }
  if (cursor === 0) return [{ type: 'text', value: source }]
  if (cursor < source.length) parts.push({ type: 'text', value: source.slice(cursor) })
  return parts
}

/** 这段文字里有没有可折的心智独白（扫描用，避免每个文本节点都白切一遍）。 */
export function hasInnerBlock(text) {
  return /<inner(?![A-Za-z0-9_-])[^>]*>/i.test(String(text ?? '')) && splitInnerBlocks(text).some((part) => part.type === 'inner')
}

/** 聊天流里的节点类型：这些不是「她这一轮说的话」，跳过。 */
const SKIP_KINDS = new Set(['user', 'steering', 'context', 'turn-trigger', 'system-prompt', 'command'])
/** 代码块里的 <inner> 是内容，不是独白。 */
const SKIP_CLOSEST = 'pre, code, .qqhub-inner'
const FOLD_ATTR = 'data-qqhub-fold'
const STYLE_ID = 'qqhub-inner-fold-style'
/** 折叠行的 class（清理孤儿/重复时按它找）。 */
const FOLD_CLASS = 'qqhub-inner'
/** 折叠行记住「我这条盯的是哪个文本节点 / 哪段独白」，重渲染时据此判断该留还是该删。 */
const FOLD_SRC = 'qqhubFoldSrc'
const FOLD_SRC_TEXT = 'qqhubFoldText'

/**
 * 折叠行的样式：跟 DSH 的「思考」行同一套口径（次级文字色 + 小箭头 + 缩进竖线），
 * 全部用宿主的主题变量，浅色/深色自动跟随；变量缺失时回退到 currentColor。
 */
const STYLE_TEXT = `
.qqhub-inner { display: block; margin: 2px 0; }
.qqhub-inner-head {
  display: inline-flex; align-items: center; gap: 6px;
  margin: 0; padding: 0; border: 0; background: none;
  color: var(--dsw-alias-label-tertiary, currentColor);
  font: inherit; font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  cursor: pointer;
}
.qqhub-inner-head::before {
  content: ""; flex: none; width: 5px; height: 5px;
  border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg); transition: transform .12s;
}
.qqhub-inner-head[aria-expanded="true"]::before { transform: rotate(45deg); }
.qqhub-inner-head:focus-visible {
  outline: 1.5px solid var(--dsw-focus-ring-color, currentColor);
  outline-offset: 2px; border-radius: 2px;
}
.qqhub-inner-body {
  display: block; white-space: pre-wrap; overflow-wrap: anywhere;
  margin: 2px 0 4px; padding-left: 12px;
  border-left: 1px solid var(--dsw-alias-border-l2, currentColor);
  color: var(--dsw-alias-label-secondary, currentColor);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
}
/* hidden 属性 + 这条规则一起管折叠：只靠 UA 的 [hidden]{display:none} 会被上面的
   display:block 按特异性盖掉，于是正文永远摊开、点箭头也没反应（真机 2026-11-24 13:07）。 */
.qqhub-inner-body[hidden],
.qqhub-inner-body[data-collapsed="true"] { display: none !important; }
@media (prefers-reduced-motion: reduce) { .qqhub-inner-head::before { transition: none; } }
`

/** 建一个折叠行：一行「思考」+ 展开后的独白原文。只用 textContent，不碰 innerHTML。 */
function createFold(doc, raw, srcNode) {
  const wrap = doc.createElement('span')
  wrap.className = FOLD_CLASS
  wrap.setAttribute(FOLD_ATTR, '')
  const text = String(raw ?? '').trim()
  // 记下来源，重渲染时 pruneFolds 才知道这条还该不该在
  if (srcNode !== undefined) wrap[FOLD_SRC] = srcNode
  wrap[FOLD_SRC_TEXT] = text
  const head = doc.createElement('button')
  head.type = 'button'
  head.className = 'qqhub-inner-head'
  head.setAttribute('aria-expanded', 'false')
  head.textContent = '思考'
  const body = doc.createElement('span')
  body.className = 'qqhub-inner-body'
  // 默认折叠：hidden 属性 + data-collapsed 双保险（样式里两条选择器都写着 display:none），
  // 因为 .qqhub-inner-body 自己带 display:block，单靠 UA 的 [hidden] 规则压不住它。
  const setOpen = (next) => {
    head.setAttribute('aria-expanded', next ? 'true' : 'false')
    body.setAttribute('data-collapsed', next ? 'false' : 'true')
    if (next) body.removeAttribute('hidden')
    else body.setAttribute('hidden', '')
    body.hidden = !next
  }
  setOpen(false)
  body.textContent = text
  head.addEventListener('click', (event) => {
    event.preventDefault()
    setOpen(head.getAttribute('aria-expanded') !== 'true')
  })
  wrap.append(head, body)
  return wrap
}

function removeNode(node) {
  if (typeof node?.remove === 'function') {
    node.remove()
  } else if (node?.parentNode && typeof node.parentNode.removeChild === 'function') {
    node.parentNode.removeChild(node)
  }
}

/** 节点还在文档里吗（假 DOM 没有 isConnected，按 parentNode 链走）。 */
function isAttached(node) {
  if (typeof node?.isConnected === 'boolean') return node.isConnected
  let cur = node
  for (let depth = 0; cur !== null && cur !== undefined && depth < 500; depth += 1) {
    if (cur.nodeType === 9 /* DOCUMENT_NODE */) return true
    cur = cur.parentNode
  }
  return false
}

/**
 * 清理紧邻当前文本节点的历史折叠行。
 * React 在组件重渲染或追加流式片段时会改写文本节点 nodeValue，但不会主动移除先前插入的非受控兄弟节点；
 * 若不清理，多次渲染会导致同一段独白堆叠出多个「思考」行。
 */
function removeStaleSiblings(node) {
  let prev = node.previousSibling
  while (prev && prev.nodeType === 1 && prev.hasAttribute?.(FOLD_ATTR)) {
    const stale = prev
    prev = prev.previousSibling
    removeNode(stale)
  }
  let next = node.nextSibling
  while (next && next.nodeType === 1 && next.hasAttribute?.(FOLD_ATTR)) {
    const stale = next
    next = next.nextSibling
    removeNode(stale)
  }
}

/**
 * 扫一遍这个聊天根里的折叠行，清掉两种残留：
 * ① **孤儿** —— 它盯着的那个正文文本节点已经被 React 换掉/移除（流式重渲染、重挂载都常见）；
 * ② **重复** —— 同一段独白在这个根里折出了不止一行。
 *    真机 2026-11-24 12:37 那两个一模一样的「思考」块就是这个：React 把整段原文重新写了一遍，
 *    我们在新节点上又折了一次，旧的那条没人收。
 *
 * 去重按「每个根里每段独白只留最后一条」：后折的那条才是当前渲染对应的；
 * 而「同一条消息渲染在两处（过程组 / 回复行）」是**不同的根**，各折各的，不会被这里误删。
 */
function pruneFolds(root) {
  const latest = new Map()
  const order = []
  for (const span of root.querySelectorAll?.('.' + FOLD_CLASS) ?? []) {
    const src = span[FOLD_SRC]
    if (src === undefined || src === null || !isAttached(src)) {
      removeNode(span)
      continue
    }
    const text = String(span[FOLD_SRC_TEXT] ?? '')
    if (!latest.has(text)) order.push(text)
    latest.set(text, span)
  }
  for (const text of order) {
    const keep = latest.get(text)
    for (const span of root.querySelectorAll?.('.' + FOLD_CLASS) ?? []) {
      if (span === keep) continue
      if (String(span[FOLD_SRC_TEXT] ?? '') === text) removeNode(span)
    }
  }
}

/**
 * 把一个文本节点里的独白折起来。
 *
 * 关键点：**能留就留着原文本节点**（React 拿着它的引用）。挑一个位置相邻的正文段塞回原节点，
 * 其余的插在它前后：开头是正文就留开头那段，否则留结尾那段（独白在开头是最常见的形状），
 * 全是独白时才把原节点清空。这样即使 React 之后再写这个节点，写的也还是它自己那段正文，
 * 不会写进一个已经脱离文档的孤儿节点里。
 */
function foldTextNode(node, doc) {
  if (!node?.parentNode) return false
  const parts = splitInnerBlocks(node.nodeValue)
  if (!parts.some((part) => part.type === 'inner')) return false
  const built = parts
    .filter((part) => part.value !== '')
    .map((part) => (part.type === 'inner'
      ? { kind: 'inner', dom: createFold(doc, part.value, node) }
      : { kind: 'text', dom: doc.createTextNode(part.value) }))
  const first = built[0]
  const last = built[built.length - 1]
  if (first === undefined || last === undefined) return false

  removeStaleSiblings(node)

  if (first.kind === 'text') {
    node.nodeValue = first.dom.nodeValue
    node.after(...built.slice(1).map((item) => item.dom))
    return true
  }
  if (last.kind === 'text') {
    node.nodeValue = last.dom.nodeValue
    node.before(...built.slice(0, -1).map((item) => item.dom))
    return true
  }
  node.nodeValue = ''
  node.before(...built.map((item) => item.dom))
  return true
}

/** 在一个聊天节点里把所有该折的文本节点折起来。 */
function foldWithin(root, doc) {
  // 先清残留：上一轮折出来、这一轮已经失去意义的折叠行（孤儿 / 同源重复）
  try {
    pruneFolds(root)
  } catch (error) {
    console.warn('[qq-hub] 清理陈旧折叠行失败：', error)
  }
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */)
  const targets = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const value = node.nodeValue
    if (!value || value.indexOf('<') === -1 || !hasInnerBlock(value)) continue
    if (node.parentElement?.closest(SKIP_CLOSEST)) continue
    targets.push(node)
  }
  let folded = 0
  for (const node of targets) {
    try {
      if (foldTextNode(node, doc)) folded += 1
    } catch (error) {
      // 单个节点失败就当没折过，绝不让它连累聊天视图
      console.warn('[qq-hub] 折叠 <inner> 独白失败：', error)
    }
  }
  return folded
}

/** 扫一遍当前的聊天流，返回折了几处。 */
export function foldChatInner(doc) {
  if (!doc?.querySelectorAll) return 0
  let folded = 0
  for (const root of doc.querySelectorAll('[data-chat-flow-kind]')) {
    const kind = root.getAttribute('data-chat-flow-kind') || ''
    if (SKIP_KINDS.has(kind)) continue
    folded += foldWithin(root, doc)
  }
  return folded
}

/** 样式只插一份，按 id 认。 */
function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  doc.head.append(style)
}

/**
 * 装上折叠：启动扫一遍（历史消息）+ 之后按需扫（新回合、React 重渲染把节点写回来时自愈）。
 *
 * 用「安静 delayMs 之后再扫」的节流，而不是每次 DOM 变动都扫：流式输出时每个 chunk 都在改
 * characterData，逐次扫会把还没闭合的独白反复切开。回合结束后不再有变动，一次就折好。
 *
 * @param {{doc?: Document, delayMs?: number, observe?: boolean}} [options]
 * @returns {() => void} 卸载函数（插件停用/热更时由 ctx.effect 调用）
 */
export function installInnerFold({ doc = globalThis.document, delayMs = 400, observe = true } = {}) {
  if (!doc?.body || typeof doc.createTreeWalker !== 'function') return () => {}
  ensureStyle(doc)
  let timer = null
  let disposed = false
  const run = () => {
    if (disposed) return
    try {
      foldChatInner(doc)
    } catch (error) {
      console.warn('[qq-hub] 扫描聊天流失败：', error)
    }
  }
  const schedule = () => {
    if (disposed || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      run()
    }, delayMs)
  }
  let observer = null
  const View = doc.defaultView
  if (observe && typeof View?.MutationObserver === 'function') {
    observer = new View.MutationObserver(schedule)
    observer.observe(doc.body, { childList: true, subtree: true, characterData: true })
  }
  run()
  return () => {
    disposed = true
    observer?.disconnect()
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
}
