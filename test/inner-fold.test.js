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
import { foldChatInner, hasInnerBlock, splitInnerBlocks } from '../client/src/core/inner-fold.js'

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

// ---- 下面两个用极简假 DOM 跑真实的 foldChatInner：钉住「原文本节点留着、其余插在它后面」
// 这条最容易写反的顺序（React 拿着那个节点的引用，顺序反了会看到一个句子被拆散重组）。----

const ELEMENT = 1
const TEXT = 3

function makeDom(bodyText) {
  const doc = {}
  /** after/before 用 this 取节点，文本节点和元素共用一份实现。 */
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
  const text = (value) => Object.assign({ nodeType: TEXT, nodeValue: value, parentNode: null, childNodes: [] }, siblings)
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
      getAttribute(key) { return node.attributes[key] ?? null },
      addEventListener(type, fn) { node.listeners.push({ type, fn }) },
      append(...kids) { for (const kid of kids) { kid.parentNode = node; node.childNodes.push(kid) } },
      after(...kids) { siblings.after.apply(node, kids) },
      before(...kids) { siblings.before.apply(node, kids) },
      closest(selector) {
        const tags = selector.split(',').map((one) => one.trim())
        for (let cur = node; cur !== null; cur = cur.parentNode) {
          if (cur.nodeType !== ELEMENT) continue
          if (tags.includes(cur.tagName.toLowerCase())) return cur
          if (tags.includes('.' + cur.className.split(' ')[0])) return cur
        }
        return null
      },
    }
    return node
  }
  const body = element('body')
  const head = element('head')
  const paragraph = element('p')
  paragraph.append(text(bodyText))
  const root = element('div')
  root.setAttribute('data-chat-flow-kind', 'assistant-step')
  root.append(paragraph)
  body.append(root)
  const all = [root, body, head, paragraph]
  Object.assign(doc, {
    body,
    head,
    defaultView: undefined,
    createElement: (tag) => element(tag),
    createTextNode: (value) => text(String(value)),
    getElementById: (id) => all.find((one) => one.attributes.id === id) ?? null,
    querySelectorAll: (selector) => (selector === '[data-chat-flow-kind]' ? all.filter((one) => one.attributes['data-chat-flow-kind'] !== undefined) : []),
    createTreeWalker(node) {
      const queue = []
      const walk = (cur) => { for (const kid of cur.childNodes) { if (kid.nodeType === TEXT) queue.push(kid); walk(kid) } }
      walk(node)
      let index = 0
      return { nextNode: () => (index < queue.length ? queue[index++] : null), currentNode: null }
    },
  })
  return { doc, paragraph, root, body }
}

test('折完的顺序：独白在开头时，原文本节点留着后半句正文，折叠行插在它前面', () => {
  const { doc, paragraph } = makeDom('<inner>【意图】报天气</inner>早 哥|||记得带伞')
  assert.equal(foldChatInner(doc), 1)
  assert.deepEqual(paragraph.childNodes.map((kid) => kid.nodeType), [ELEMENT, TEXT])
  assert.equal(paragraph.childNodes[0].className, 'qqhub-inner')
  assert.equal(paragraph.childNodes[1].nodeValue, '早 哥|||记得带伞')
  const [head, body] = paragraph.childNodes[0].childNodes
  assert.equal(head.textContent, '思考')
  assert.equal(head.getAttribute('aria-expanded'), 'false')
  assert.equal(body.hidden, true)
  assert.equal(body.textContent, '【意图】报天气')
  // 点一下展开、再点收起来
  head.listeners[0].fn({ preventDefault() {} })
  assert.equal(head.getAttribute('aria-expanded'), 'true')
  assert.equal(body.hidden, false)
  head.listeners[0].fn({ preventDefault() {} })
  assert.equal(body.hidden, true)
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
