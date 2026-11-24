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
@media (prefers-reduced-motion: reduce) { .qqhub-inner-head::before { transition: none; } }
`

/** 建一个折叠行：一行「思考」+ 展开后的独白原文。只用 textContent，不碰 innerHTML。 */
function createFold(doc, raw) {
  const wrap = doc.createElement('span')
  wrap.className = 'qqhub-inner'
  wrap.setAttribute(FOLD_ATTR, '')
  const head = doc.createElement('button')
  head.type = 'button'
  head.className = 'qqhub-inner-head'
  head.setAttribute('aria-expanded', 'false')
  head.textContent = '思考'
  const body = doc.createElement('span')
  body.className = 'qqhub-inner-body'
  body.hidden = true
  body.textContent = String(raw ?? '').trim()
  head.addEventListener('click', (event) => {
    event.preventDefault()
    const open = head.getAttribute('aria-expanded') === 'true'
    head.setAttribute('aria-expanded', open ? 'false' : 'true')
    body.hidden = open
  })
  wrap.append(head, body)
  return wrap
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
  const parts = splitInnerBlocks(node.nodeValue)
  if (!parts.some((part) => part.type === 'inner')) return false
  const built = parts
    .filter((part) => part.value !== '')
    .map((part) => (part.type === 'inner'
      ? { kind: 'inner', dom: createFold(doc, part.value) }
      : { kind: 'text', dom: doc.createTextNode(part.value) }))
  const first = built[0]
  const last = built[built.length - 1]
  if (first === undefined || last === undefined) return false
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
