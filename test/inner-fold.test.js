// 正文里 <inner> 独白的显示层折叠：切块口径的回归钉。
//
// 报障现场（真机 2026-11-24 07:55，主人私聊 session-7234dde0）：那一轮的 assistant 消息只有一条
// text 段，内容是 `<inner>【意图】早上报天气…</inner>早 哥|||今天南宁…`。QQ 侧三条投递干干净净
// （deliveries.json 有据），但 DSH 会话里主人自己看到的是一坨标签 —— 因为聊天视图只折 provider 的
// reasoning 段，text 段一律当正文渲染。网页半边因此加了一层纯显示层的折叠（client/src/core/inner-fold.js）。
//
// 这里钉住最容易写错的三条：没闭合的不能藏、空标签不能当独白吞掉后面的正文、多段要按顺序切。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldChatInner, hasInnerBlock, splitInnerBlocks, splitFoldableBlocks, findMemoStart, splitMarkupTags, hasMarkupTag } from '../client/src/core/inner-fold.js'
import { stripInternalMemo } from '../src/chat/reply.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('独白在正文前面：切一刀，标签不进正文', () => {
  const parts = splitInnerBlocks('<inner>\n【意图】早上报天气\n【闭环】\n【情感】刚醒，有点蔫\n【备忘】\n</inner>早 哥|||今天南宁 16 到 20 度 阴天 毛毛雨 出门概率 84%')
  assert.deepEqual(parts.map((p) => p.type), ['inner', 'text'])
  assert.match(parts[0].value, /【意图】早上报天气/)
  assert.ok(!parts[0].value.includes('<inner>'), '独白内容里不该留标签')
  assert.equal(parts[1].value, '早 哥|||今天南宁 16 到 20 度 阴天 毛毛雨 出门概率 84%')
})

test('独白夹在中间、出现多段：按顺序切成 文字 / 独白 / 文字 / 独白', () => {
  const parts = splitInnerBlocks('先说一句<inner>甲</inner>中间一句<inner>乙</inner>收尾')
  assert.deepEqual(parts.map((p) => p.type), ['text', 'inner', 'text', 'inner', 'text'])
  assert.deepEqual(parts.map((p) => p.value), ['先说一句', '甲', '中间一句', '乙', '收尾'])
})

test('没闭合的开标签（流式未写完 / 被截断）：一个字都不许藏', () => {
  const raw = '<inner>\n【意图】他回来了，接着刚才的话问他洗完没\n<inner>早 哥|||今天南宁'
  const parts = splitInnerBlocks(raw)
  assert.deepEqual(parts.map((p) => p.type), ['text'])
  assert.equal(parts[0].value, raw)
})

test('空标签 <inner/> 当普通文字，不能把后面的正文一起吞进独白', () => {
  const raw = '<inner/>早 哥|||记得带伞'
  const parts = splitInnerBlocks(raw)
  assert.ok(parts.every((p) => p.type === 'text'), '空标签不该折')
  assert.equal(parts.map((p) => p.value).join(''), raw)
})

test('大小写与属性写法都认；纯正文原样返回', () => {
  assert.deepEqual(splitInnerBlocks('<INNER>甲</INNER>乙').map((p) => p.value), ['甲', '乙'])
  assert.deepEqual(splitInnerBlocks('<inner class="x">甲</inner>乙').map((p) => p.type), ['inner', 'text'])
  assert.deepEqual(splitInnerBlocks('早 哥|||记得带伞'), [{ type: 'text', value: '早 哥|||记得带伞' }])
  assert.deepEqual(splitInnerBlocks(''), [{ type: 'text', value: '' }])
})

test('hasInnerBlock：只有真的能折的才返回 true', () => {
  assert.equal(hasInnerBlock('<inner>甲</inner>乙'), true)
  assert.equal(hasInnerBlock('<inner>甲'), false, '没闭合的不算可折')
  assert.equal(hasInnerBlock('早 哥'), false)
  assert.equal(hasInnerBlock('3<5 且 7>4'), false)
})

test('产物里必须带上这层折叠（改了源码不重新构建，CI 与本机都会不一致）', () => {
  const bundle = readFileSync(join(ROOT, 'client/client.js'), 'utf8')
  assert.match(bundle, /qqhub-inner/, 'client/client.js 里没有折叠样式，忘了 npm run build:client')
  assert.match(bundle, /installInnerFold/, '产物里没有 installInnerFold')
})

// ---- 内部备忘块（purpose 回合写在 </inner> 之后的那一段）----
//
// 真机 2026-11-25 08:00/09:40/12:32：`<inner>…</inner>正文` 后面还有
// `内部备忘\n【目的】…【状态】完成`。上一版只折 <inner>，这块原样摊在会话里，
// 主人自己翻记录时还是能看到一坨目的/情绪/待续。
test('内部备忘块：认无冒号裸行小标题，切在正文与备忘之间', () => {
  const raw = '早八要困死了|||昨晚熬那么晚你起得来吗\n\n内部备忘\n【目的】戳他一下\n【需求】陪\n【状态】完成'
  const parts = splitFoldableBlocks(raw)
  assert.deepEqual(parts.map((p) => p.type), ['text', 'memo'])
  assert.equal(parts[0].value.trim(), '早八要困死了|||昨晚熬那么晚你起得来吗')
  assert.match(parts[1].value, /【目的】戳他一下/)
})

test('内部备忘块：<inner> + 正文 + 备忘 三段按顺序切', () => {
  const raw = '<inner>【意图】随口戳他</inner>早八要困死了|||昨晚熬那么晚你起得来吗\n\n内部备忘\n【目的】戳他一下'
  assert.deepEqual(splitFoldableBlocks(raw).map((p) => p.type), ['inner', 'text', 'memo'])
})

test('内部备忘块：没有小标题但有两个以上行首标签时也认', () => {
  assert.deepEqual(splitFoldableBlocks('正文。\n【目的】x\n【状态】完成').map((p) => p.type), ['text', 'memo'])
})

test('内部备忘块：单个标签 / 正常提到「内部备忘」都不算', () => {
  assert.equal(findMemoStart('她问：\n【目的】是什么意思？'), -1)
  assert.equal(findMemoStart('内部备忘发我看看'), -1)
  assert.equal(findMemoStart('【备忘录】\n1. 买牛奶'), -1)
  assert.equal(findMemoStart('纯正文|||没别的'), -1)
})

// ---- 下面用极简假 DOM 跑真实的 foldChatInner：钉住三件最容易写坏的事：
// ① 顺序（原文本节点留着、其余插在它前后）—— React 拿着那个节点的引用；
// ② 默认折叠、点一下能展开再收起 —— 真机 2026-11-24 13:07「包装的思考块默认展开不能折叠」；
// ③ 重复渲染不叠块 —— 真机 12:37 出现两个一模一样的「思考」。----

const ELEMENT = 1
const TEXT = 3
const DOCUMENT = 9

/**
 * 极简假 DOM：够 inner-fold.js 用的那点 API。
 * 每个节点都带 parentNode、childNodes、siblings（after/before），元素带 attributes/hidden/class，
 * 并且 document 支持 createTreeWalker 与 querySelectorAll（按 class 找折叠行）。
 */
function makeDom(bodyText) {
  const all = []
  const siblings = {
    after(...kids) {
      const at = this.parentNode.childNodes.indexOf(this)
      for (const [offset, kid] of kids.entries()) { kid.parentNode = this.parentNode; this.parentNode.childNodes.splice(at + 1 + offset, 0, kid) }
    },
    before(...kids) {
      const at = this.parentNode.childNodes.indexOf(this)
      for (const [offset, kid] of kids.entries()) { kid.parentNode = this.parentNode; this.parentNode.childNodes.splice(at + offset, 0, kid) }
    },
  }
  const text = (value) => {
    const node = { nodeType: TEXT, nodeValue: value, parentNode: null, childNodes: [] }
    // 文本节点也要 previousSibling / nextSibling（清理陈旧折叠行要用）
    Object.defineProperties(node, {
      previousSibling: { get: () => siblingAt(node, -1) },
      nextSibling: { get: () => siblingAt(node, 1) },
      remove: { value: () => detach(node) },
    })
    Object.assign(node, siblings)
    all.push(node)
    return node
  }
  const element = (tag) => {
    const node = {
      nodeType: ELEMENT,
      tagName: tag.toUpperCase(),
      parentNode: null,
      childNodes: [],
      attributes: {},
      hidden: false,
      className: '',
      listeners: [],
      get textContent() { return node.childNodes.map((kid) => (kid.nodeType === TEXT ? kid.nodeValue : kid.textContent)).join('') },
      set textContent(value) {
        node.childNodes = []
        node.append(text(String(value)))
      },
      setAttribute(key, value) { node.attributes[key] = String(value) },
      removeAttribute(key) { delete node.attributes[key] },
      hasAttribute(key) { return key in node.attributes },
      getAttribute(key) { return node.attributes[key] ?? null },
      addEventListener(type, fn) { node.listeners.push({ type, fn }) },
      append(...kids) { for (const kid of kids) { kid.parentNode = node; node.childNodes.push(kid) } },
      after(...kids) { siblings.after.apply(node, kids) },
      before(...kids) { siblings.before.apply(node, kids) },
      remove() { detach(node) },
      get previousSibling() { return siblingAt(node, -1) },
      get nextSibling() { return siblingAt(node, 1) },
      closest(selector) {
        const tags = selector.split(',').map((one) => one.trim())
        for (let cur = node; cur !== null; cur = cur.parentNode) {
          if (cur.nodeType !== ELEMENT) continue
          if (tags.includes(cur.tagName.toLowerCase())) return cur
          if (tags.includes('.' + cur.className.split(' ')[0])) return cur
        }
        return null
      },
      querySelectorAll(selector) {
        const out = []
        const want = selector.startsWith('.') ? selector.slice(1) : null
        const walk = (cur) => {
          for (const kid of cur.childNodes) {
            if (kid.nodeType !== ELEMENT) continue
            if (want !== null && kid.className.split(' ').includes(want)) out.push(kid)
            walk(kid)
          }
        }
        walk(node)
        return out
      },
    }
    all.push(node)
    return node
  }
  const body = element('body')
  const head = element('head')
  const paragraph = element('p')
  if (Array.isArray(bodyText)) paragraph.append(...bodyText.map((chunk) => text(chunk)))
  else paragraph.append(text(bodyText))
  const root = element('div')
  root.setAttribute('data-chat-flow-kind', 'assistant-step')
  root.append(paragraph)
  body.append(root)
  const documentNode = { nodeType: DOCUMENT, parentNode: null }
  body.parentNode = documentNode
  const doc = {
    body,
    head,
    defaultView: undefined,
    createElement: (tag) => element(tag),
    createTextNode: (value) => text(String(value)),
    getElementById: (id) => all.find((one) => one.nodeType === ELEMENT && one.attributes.id === id) ?? null,
    querySelectorAll: (selector) => (selector === '[data-chat-flow-kind]'
      ? all.filter((one) => one.nodeType === ELEMENT && one.attributes['data-chat-flow-kind'] !== undefined)
      : []),
    createTreeWalker(node) {
      const queue = []
      const walk = (cur) => { for (const kid of cur.childNodes) { if (kid.nodeType === TEXT) queue.push(kid); walk(kid) } }
      walk(node)
      let index = 0
      return { nextNode: () => (index < queue.length ? queue[index++] : null), currentNode: null }
    },
  }
  return { doc, paragraph, root, body }
}

function siblingAt(node, offset) {
  const parent = node.parentNode
  if (!parent) return null
  const at = parent.childNodes.indexOf(node)
  if (at < 0) return null
  return parent.childNodes[at + offset] ?? null
}

function detach(node) {
  const parent = node.parentNode
  if (!parent) return
  const at = parent.childNodes.indexOf(node)
  if (at >= 0) parent.childNodes.splice(at, 1)
  node.parentNode = null
}

/** 找段落里所有折叠行（.qqhub-inner）。 */
const foldsIn = (paragraph) => paragraph.querySelectorAll('.qqhub-inner')

test('折完的顺序：独白在开头时，原文本节点留着后半句正文，折叠行插在它前面', () => {
  const { doc, paragraph } = makeDom('<inner>【意图】报天气</inner>早 哥|||记得带伞')
  assert.equal(foldChatInner(doc), 1)
  assert.deepEqual(paragraph.childNodes.map((kid) => kid.nodeType), [ELEMENT, TEXT])
  assert.equal(paragraph.childNodes[0].className, 'qqhub-inner')
  assert.equal(paragraph.childNodes[1].nodeValue, '早 哥|||记得带伞')
  const [head, body] = paragraph.childNodes[0].childNodes
  assert.equal(head.textContent, '思考')
  assert.equal(body.textContent, '【意图】报天气')
})

test('默认折叠：文档一出来正文就是隐藏的，点一下才展开、再点收回', () => {
  const { doc, paragraph } = makeDom('<inner>【意图】报天气</inner>早 哥')
  foldChatInner(doc)
  const [head, body] = paragraph.childNodes[0].childNodes
  // 默认：折叠
  assert.equal(head.getAttribute('aria-expanded'), 'false')
  assert.equal(body.hidden, true)
  assert.equal(body.hasAttribute('hidden'), true, 'hidden 属性要真的挂上，样式才能压住 display:block')
  assert.equal(body.getAttribute('data-collapsed'), 'true')
  // 点开
  head.listeners[0].fn({ preventDefault() {} })
  assert.equal(head.getAttribute('aria-expanded'), 'true')
  assert.equal(body.hidden, false)
  assert.equal(body.hasAttribute('hidden'), false)
  assert.equal(body.getAttribute('data-collapsed'), 'false')
  // 再点收回
  head.listeners[0].fn({ preventDefault() {} })
  assert.equal(head.getAttribute('aria-expanded'), 'false')
  assert.equal(body.hidden, true)
  assert.equal(body.hasAttribute('hidden'), true)
})

test('重复渲染不叠块：同一段正文再折一次，仍然只有一个「思考」', () => {
  const raw = '<inner>【意图】甲</inner>正文一句'
  const { doc, paragraph } = makeDom(raw)
  assert.equal(foldChatInner(doc), 1)
  assert.equal(foldsIn(paragraph).length, 1)

  // 模拟 React 把整段原文又写回这个文本节点（内容不变），然后再扫一遍
  const textNode = paragraph.childNodes.find((kid) => kid.nodeType === TEXT)
  textNode.nodeValue = raw
  foldChatInner(doc)
  assert.equal(foldsIn(paragraph).length, 1, `重复扫描后仍然只该有一个折叠块，实际 ${foldsIn(paragraph).length} 个`)
})

test('流式续写：源节点被换掉后，旧的「思考」不能留在原地', () => {
  const { doc, paragraph } = makeDom('<inner>【意图】甲</inner>正文一句')
  foldChatInner(doc)
  assert.equal(foldsIn(paragraph).length, 1)

  // React 换了新的文本节点（旧的从 DOM 里摘掉），新内容还是同一段独白 + 更长的正文
  const old = paragraph.childNodes.find((kid) => kid.nodeType === TEXT)
  detach(old)
  const fresh = doc.createTextNode('<inner>【意图】甲</inner>正文一句更长了')
  paragraph.append(fresh)

  foldChatInner(doc)
  assert.equal(foldsIn(paragraph).length, 1, `孤儿折叠行必须被清掉，实际 ${foldsIn(paragraph).length} 个`)
  assert.equal(foldsIn(paragraph)[0].childNodes[1].textContent, '【意图】甲')
})

test('折完的顺序：独白在中间时，原文本节点保留前半句，折叠行和后半句插在它后面', () => {
  const { doc, paragraph } = makeDom('先说一句<inner>甲</inner>收尾')
  assert.equal(foldChatInner(doc), 1)
  assert.equal(paragraph.childNodes[0].nodeType, TEXT)
  assert.equal(paragraph.childNodes[0].nodeValue, '先说一句', '原节点必须留着前半句（React 拿着它的引用）')
  assert.equal(paragraph.childNodes[1].className, 'qqhub-inner')
  assert.equal(paragraph.childNodes[2].nodeValue, '收尾')
})

test('纯正文 / 主人自己的消息：一处都不折', () => {
  const plain = makeDom('早 哥|||记得带伞')
  assert.equal(foldChatInner(plain.doc), 0)
  assert.equal(plain.paragraph.childNodes.length, 1)

  const user = makeDom('<inner>主人自己打进群里的伪造标签</inner>')
  user.root.setAttribute('data-chat-flow-kind', 'user')
  assert.equal(foldChatInner(user.doc), 0, '主人自己的消息不折')
})

// 真机 2026-11-25 08:00/09:40/12:32 的会话形状：<inner> 折成了「思考」，
// 但 </inner> 之后的「内部备忘 + 【目的】…」原样摊在正文里。
test('内部备忘段折成独立的「思考 · 内部备忘」行，正文不受影响', () => {
  const raw = '<inner>【意图】早八犯困</inner>早八要困死了|||昨晚熬那么晚你起得来吗\n\n内部备忘\n【目的】戳他一下\n【状态】完成'
  const { doc, paragraph } = makeDom(raw)
  assert.equal(foldChatInner(doc), 1, '一个文本节点里有独白 + 备忘，一次折出两行')
  const folds = foldsIn(paragraph)
  assert.equal(folds.length, 2, `应折出两个折叠块（独白 + 备忘），实际 ${folds.length}`)
  assert.equal(folds[0].childNodes[0].textContent, '思考')
  assert.match(folds[0].childNodes[1].textContent, /【意图】早八犯困/)
  assert.equal(folds[1].childNodes[0].textContent, '思考 · 内部备忘')
  assert.match(folds[1].childNodes[1].textContent, /【目的】戳他一下/)
  // 正文必须留在页面上，不能被折进任何一块
  const text = paragraph.childNodes.filter((kid) => kid.nodeType === TEXT).map((kid) => kid.nodeValue).join('')
  assert.equal(text.trim(), '早八要困死了|||昨晚熬那么晚你起得来吗')
  // 两个折叠块都是默认收起的
  for (const fold of folds) assert.equal(fold.childNodes[1].hidden, true)
})

// ---- QQ 协议标记的显示层渲染（<face:…> / <sticker:…> / <voice> / <poke>）----
//
// 报障现场 2026-11-25：「<face:白眼> 以前是蓝色的，现在变黑字了」。真实数据里这些标记
// 全是紧贴中文的（`咒谁呢<face:白眼>`），Markdown 不认它是 HTML 标签，于是原样露出裸标签。
// 这里把它渲染成带底色的 chip，主人在会话里一眼能看出「这是表情」而不是一串尖括号。
test('协议标记切分：face / sticker / voice / poke 都认，正文原样保留', () => {
  assert.deepEqual(splitMarkupTags('咒谁呢<face:白眼>|||犯困'), [
    { type: 'text', value: '咒谁呢' },
    { type: 'face', value: '白眼' },
    { type: 'text', value: '|||犯困' },
  ])
  assert.deepEqual(splitMarkupTags('<sticker:开心>好耶'), [
    { type: 'sticker', value: '开心' },
    { type: 'text', value: '好耶' },
  ])
  assert.deepEqual(splitMarkupTags('发个语音<voice>晚安啦</voice>').map((p) => p.type), ['text', 'voice'])
  assert.deepEqual(splitMarkupTags('戳你<poke>').map((p) => p.type), ['text', 'poke'])
  assert.deepEqual(splitMarkupTags('<poke/>'), [{ type: 'poke', value: '' }])
})

test('协议标记切分：普通比较符号不被当成标记', () => {
  assert.equal(hasMarkupTag('3<5 且 7>4'), false)
  assert.equal(hasMarkupTag('a<b>c'), false)
  assert.deepEqual(splitMarkupTags('纯正文'), [{ type: 'text', value: '纯正文' }])
})

test('协议标记切分：认 <sticker:…></sticker> 成对写法', () => {
  assert.deepEqual(splitMarkupTags('好耶<sticker:开心></sticker>').map((p) => p.type), ['text', 'sticker'])
})

test('协议标记渲染：文本节点里的 <face:白眼> 变成 chip，正文不丢', () => {
  const { doc, paragraph } = makeDom('活得好好的 咒谁呢<face:白眼>|||刚吃完午饭正犯困')
  assert.equal(foldChatInner(doc), 1, '应渲染出 chip')
  const chips = paragraph.querySelectorAll('.qqhub-mark')
  assert.equal(chips.length, 1, `应只有一个 chip，实际 ${chips.length}`)
  assert.equal(chips[0].getAttribute('data-qqhub-mark'), 'face')
  // chip 文本带「表」图标 + 表情名
  assert.match(chips[0].textContent, /白眼/)
  // 正文一个字都不能少（chip 替换的只是标签本身）
  const text = paragraph.childNodes.filter((kid) => kid.nodeType === TEXT).map((kid) => kid.nodeValue).join('')
  assert.equal(text, '活得好好的 咒谁呢|||刚吃完午饭正犯困')
})

test('协议标记渲染：重渲染不叠 chip', () => {
  const raw = '咒谁呢<face:白眼>'
  const { doc, paragraph } = makeDom(raw)
  assert.equal(foldChatInner(doc), 1)
  assert.equal(paragraph.querySelectorAll('.qqhub-mark').length, 1)
  // 模拟 React 把原文再写回这个文本节点，然后重扫
  const textNode = paragraph.childNodes.find((kid) => kid.nodeType === TEXT)
  textNode.nodeValue = raw
  foldChatInner(doc)
  assert.equal(paragraph.querySelectorAll('.qqhub-mark').length, 1, '重扫后仍然只有一个 chip')
})

const plainTextOf = (paragraph) => paragraph.childNodes.filter((kid) => kid.nodeType === TEXT).map((kid) => kid.nodeValue).join('')

test('协议标记渲染：chip 后有正文 / 多 chip 重渲染与流式续写不重复正文', () => {
  const raw = '咒谁呢<face:白眼>|||刚吃完午饭正犯困'
  const { doc, paragraph } = makeDom(raw)
  assert.equal(foldChatInner(doc), 1)
  assert.equal(paragraph.querySelectorAll('.qqhub-mark').length, 1)
  assert.equal(plainTextOf(paragraph), '咒谁呢|||刚吃完午饭正犯困')

  // 模拟 React 重渲染把原文写回主文本节点：旧的新建 Text 尾巴必须一并清掉，不能翻倍
  const primary = paragraph.childNodes[0]
  primary.nodeValue = raw
  foldChatInner(doc)
  assert.equal(paragraph.querySelectorAll('.qqhub-mark').length, 1)
  assert.equal(plainTextOf(paragraph), '咒谁呢|||刚吃完午饭正犯困')

  // 模拟流式续写：先截断尾巴再续长，旧截断尾不能残留
  primary.nodeValue = '咒谁呢<face:白眼>|||刚'
  foldChatInner(doc)
  assert.equal(plainTextOf(paragraph), '咒谁呢|||刚')
  primary.nodeValue = '咒谁呢<face:白眼>|||刚吃完午饭'
  foldChatInner(doc)
  assert.equal(paragraph.querySelectorAll('.qqhub-mark').length, 1)
  assert.equal(plainTextOf(paragraph), '咒谁呢|||刚吃完午饭')

  // 多 chip 重渲染：不能叠出第二套 chip 或重复中间/尾部正文
  const multi = makeDom('啊<face:白眼>真的吗<face:笑哭>绝了')
  foldChatInner(multi.doc)
  assert.equal(multi.paragraph.querySelectorAll('.qqhub-mark').length, 2)
  assert.equal(plainTextOf(multi.paragraph), '啊真的吗绝了')
  multi.paragraph.childNodes[0].nodeValue = '啊<face:白眼>真的吗<face:笑哭>绝了'
  foldChatInner(multi.doc)
  assert.equal(multi.paragraph.querySelectorAll('.qqhub-mark').length, 2)
  assert.equal(plainTextOf(multi.paragraph), '啊真的吗绝了')
})

test('独白 + 正文 + 备忘重渲染与换节点：折叠块与夹在中间的正文都不翻倍', () => {
  const raw = '<inner>【意图】早八犯困</inner>早八要困死了|||起得来吗\n\n内部备忘\n【目的】戳他一下\n【状态】完成'
  const { doc, paragraph } = makeDom(raw)
  const anchor = paragraph.childNodes[0]
  foldChatInner(doc)
  assert.equal(foldsIn(paragraph).length, 2)
  assert.equal(plainTextOf(paragraph).trim(), '早八要困死了|||起得来吗')

  // React 覆写同一个锚点
  anchor.nodeValue = raw
  foldChatInner(doc)
  assert.equal(foldsIn(paragraph).length, 2)
  assert.equal(plainTextOf(paragraph).trim(), '早八要困死了|||起得来吗')

  // React 摘掉旧锚点并挂上新文本节点：旧的新建正文 Text 节点必须随旧组一起清掉
  detach(anchor)
  paragraph.append(doc.createTextNode(raw))
  foldChatInner(doc)
  assert.equal(foldsIn(paragraph).length, 2)
  assert.equal(plainTextOf(paragraph).trim(), '早八要困死了|||起得来吗')
})

test('DSH 真实 MarkdownText 拆开的相邻 Text 节点：<voice> / <sticker:></sticker> / 行内 <inner> 都能整体识别', () => {
  // MarkdownText 把 html 节点单独渲染成相邻 Text 节点
  const voiceDom = makeDom(['发个语音', '<voice>', '晚安啦', '</voice>'])
  assert.equal(foldChatInner(voiceDom.doc), 1)
  const vChips = voiceDom.paragraph.querySelectorAll('.qqhub-mark')
  assert.equal(vChips.length, 1)
  assert.equal(vChips[0].getAttribute('data-qqhub-mark'), 'voice')
  assert.match(vChips[0].textContent, /晚安啦/)
  assert.equal(plainTextOf(voiceDom.paragraph), '发个语音')

  // <sticker:开心> 含冒号留在前一个 Text 节点，</sticker> 落在下一个 Text 节点：不能残留裸 </sticker>
  const stickerDom = makeDom(['好耶<sticker:开心>', '</sticker>'])
  assert.equal(foldChatInner(stickerDom.doc), 1)
  const sChips = stickerDom.paragraph.querySelectorAll('.qqhub-mark')
  assert.equal(sChips.length, 1)
  assert.equal(sChips[0].getAttribute('data-qqhub-mark'), 'sticker')
  assert.equal(plainTextOf(stickerDom.paragraph), '好耶')

  // 流式分两帧到达：第一帧先折了 <sticker:开心>，第二帧补上 </sticker> 时应整组合并吸收尾标签
  const streamSticker = makeDom(['好耶<sticker:开心>'])
  assert.equal(foldChatInner(streamSticker.doc), 1)
  assert.equal(streamSticker.paragraph.querySelectorAll('.qqhub-mark').length, 1)
  streamSticker.paragraph.append(streamSticker.doc.createTextNode('</sticker>'))
  foldChatInner(streamSticker.doc)
  assert.equal(streamSticker.paragraph.querySelectorAll('.qqhub-mark').length, 1)
  assert.equal(plainTextOf(streamSticker.paragraph), '好耶')

  // 行内 <inner>…</inner> 被拆成 4 个相邻 Text 节点，以及后续流式续写最后一个锚点
  const inlineInner = makeDom(['<inner>', '【意图】早八犯困', '</inner>', '早八要困死了'])
  const tailAnchor = inlineInner.paragraph.childNodes[3]
  assert.equal(foldChatInner(inlineInner.doc), 1)
  assert.equal(foldsIn(inlineInner.paragraph).length, 1)
  assert.equal(plainTextOf(inlineInner.paragraph), '早八要困死了')
  tailAnchor.nodeValue = '早八要困死了|||昨晚熬太晚'
  foldChatInner(inlineInner.doc)
  assert.equal(foldsIn(inlineInner.paragraph).length, 1)
  assert.equal(plainTextOf(inlineInner.paragraph), '早八要困死了|||昨晚熬太晚')
})

test('双端备忘切分对拍：display findMemoStart 与 outbound stripInternalMemo 口径完全一致', () => {
  const samples = [
    '正文。\n【内部备忘】这次不发了',
    '正文。\n内部备忘：目的无',
    '正文。\n**【内部备忘】** 内容',
    '正文。\n【目的】x\n【备忘】\ny',
    '正文。\n【目的】无 【状态】跳过',
    '正文。\n【目的】无、【状态】跳过',
    '她问：\n【目的】是什么意思？\n另外你今天 【状态】 看起来不错',
    '内部备忘发我看看',
  ]
  for (const s of samples) {
    const cut = findMemoStart(s)
    const expected = cut < 0 ? s : s.slice(0, cut)
    assert.equal(stripInternalMemo(s), expected, `双端口径不一致：${JSON.stringify(s)}`)
  }
  assert.equal(findMemoStart('正文。\n【目的】x\n【备忘】\ny'), '正文。'.length, '两处都命中时必须取更靠前的切点')
  assert.equal(findMemoStart('她问：\n【目的】是什么意思？\n另外你今天 【状态】 看起来不错'), -1, '单行首标签不跨行误切')
})

test('协议标记切分：大小写不敏感', () => {
  assert.deepEqual(splitMarkupTags('啊<FACE:白眼><VOICE>晚安</VOICE><POKE/>').map((p) => p.type), ['text', 'face', 'voice', 'poke'])
})
