// T4.1：前端卸载资源泄漏（client/src/core/inner-fold.js 与 client/src/styles/use-style.js）。
//
// 报障口径：面板是多标签页里的一张卡，切走 / 插件停用 / 热更都会卸载组件。
// 旧实现的 installInnerFold 卸载函数只做了 `observer.disconnect()` + `clearTimeout`，
// 已经折好的「思考」行、chip 和被清空的原文本节点全部留在宿主聊天视图里；样式元素
// 也从不摘除，插件停用后继续影响 DSH 自己的界面。use-style.js 同理：只插不摘，
// 且内容比对命中也直接 `return`（连清理函数都不注册）。
//
// 这里用极简假 DOM 跑真实的 installInnerFold / mountStyleSheet，钉住：
// ① 卸载会撤回所有折叠（原文本恢复、派生节点清空、样式元素摘掉）；
// ② HMR/升级后样式表内容会被原地刷新，而不是「id 在就跳过」；
// ③ 两个实例同时挂着时，先卸载的那个不能把样式摘掉（引用计数）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installInnerFold } from '../client/src/core/inner-fold.js'
import { mountStyleSheet, releaseStyleSheet, styleHolderCount, STYLE_ID } from '../client/src/styles/style-sheet.js'

const ELEMENT = 1
const TEXT = 3
const FOLD_STYLE_ID = 'qqhub-inner-fold-style'

/** 极简假 DOM：只提供 inner-fold.js / style-sheet.js 真正用到的那几个 API。 */
function makeDom({ kind = 'assistant-step', parts = [''] } = {}) {
  const all = []
  const siblingAt = (node, step) => {
    const parent = node.parentNode
    if (!parent) return null
    const at = parent.childNodes.indexOf(node)
    return at < 0 ? null : (parent.childNodes[at + step] ?? null)
  }
  const detach = (node) => {
    const parent = node.parentNode
    if (!parent) return
    const at = parent.childNodes.indexOf(node)
    if (at >= 0) parent.childNodes.splice(at, 1)
    node.parentNode = null
  }
  const makeText = (value) => {
    const node = { nodeType: TEXT, nodeValue: String(value), parentNode: null, childNodes: [], parentElement: null }
    Object.defineProperties(node, {
      previousSibling: { get: () => siblingAt(node, -1) },
      nextSibling: { get: () => siblingAt(node, 1) },
    })
    node.after = (...kids) => {
      const at = node.parentNode.childNodes.indexOf(node)
      for (const [offset, kid] of kids.entries()) {
        kid.parentNode = node.parentNode
        node.parentNode.childNodes.splice(at + 1 + offset, 0, kid)
      }
    }
    node.before = (...kids) => {
      const at = node.parentNode.childNodes.indexOf(node)
      for (const [offset, kid] of kids.entries()) {
        kid.parentNode = node.parentNode
        node.parentNode.childNodes.splice(at + offset, 0, kid)
      }
    }
    node.remove = () => detach(node)
    all.push(node)
    return node
  }
  const makeElement = (tag) => {
    const node = {
      nodeType: ELEMENT,
      tagName: String(tag).toUpperCase(),
      parentNode: null,
      childNodes: [],
      attributes: {},
      className: '',
      hidden: false,
      listeners: [],
      id: '',
    }
    node.getAttribute = (key) => node.attributes[key] ?? null
    node.setAttribute = (key, value) => { node.attributes[key] = String(value) }
    node.removeAttribute = (key) => { delete node.attributes[key] }
    node.hasAttribute = (key) => key in node.attributes
    node.append = (...kids) => { for (const kid of kids) { kid.parentNode = node; node.childNodes.push(kid) } }
    node.remove = () => { detach(node); node.removedFlag = true }
    node.addEventListener = (type, fn) => node.listeners.push({ type, fn })
    node.querySelectorAll = (selector) => {
      if (!selector.startsWith('.')) return []
      const want = selector.slice(1)
      const out = []
      const walk = (cur) => {
        for (const kid of cur.childNodes) {
          if (kid.nodeType !== ELEMENT) continue
          if (kid.className.split(' ').includes(want)) out.push(kid)
          walk(kid)
        }
      }
      walk(node)
      return out
    }
    Object.defineProperties(node, {
      textContent: {
        get: () => node.childNodes.map((kid) => (kid.nodeType === TEXT ? kid.nodeValue : kid.textContent)).join(''),
        set: (value) => { node.childNodes = []; node.append(makeText(String(value))) },
      },
      previousSibling: { get: () => siblingAt(node, -1) },
      nextSibling: { get: () => siblingAt(node, 1) },
    })
    all.push(node)
    return node
  }
  const body = makeElement('body')
  const head = makeElement('head')
  // 假 DOM 也要有文档节点：inner-fold 的 isAttached 靠 parentNode 链走到 DOCUMENT 判断「还挂在页面上」
  const documentNode = { nodeType: 9, parentNode: null }
  body.parentNode = documentNode
  head.parentNode = documentNode
  const root = makeElement('div')
  root.setAttribute('data-chat-flow-kind', kind)
  const paragraph = makeElement('p')
  paragraph.append(...parts.map((chunk) => makeText(chunk)))
  root.append(paragraph)
  body.append(root)
  const doc = {
    body,
    head,
    defaultView: undefined,
    createElement: (tag) => makeElement(tag),
    createTextNode: (value) => makeText(String(value)),
    getElementById: (id) => all.find((node) => node.nodeType === ELEMENT && !node.removedFlag && (node.id === id || node.attributes.id === id)) ?? null,
    querySelectorAll: (selector) => (selector === '[data-chat-flow-kind]'
      ? all.filter((node) => node.nodeType === ELEMENT && node.attributes['data-chat-flow-kind'] !== undefined)
      : []),
    createTreeWalker(node) {
      const queue = []
      const walk = (cur) => { for (const kid of cur.childNodes) { if (kid.nodeType === TEXT) queue.push(kid); walk(kid) } }
      walk(node)
      let index = 0
      return { nextNode: () => (index < queue.length ? queue[index++] : null), currentNode: null }
    },
  }
  return { doc, root, paragraph }
}

const foldsIn = (node) => node.querySelectorAll('.qqhub-inner')

test('卸载折叠：原文本写回、折叠行清空、样式元素摘掉', () => {
  const { doc, paragraph } = makeDom({ parts: ['<inner>【意图】报天气</inner>早 哥|||记得带伞'] })
  const stop = installInnerFold({ doc, observe: false })
  assert.equal(foldsIn(paragraph).length, 1, '装上之后应该折出一行「思考」')
  assert.ok(doc.getElementById(FOLD_STYLE_ID), '装上之后应该有样式元素')

  stop()

  assert.equal(foldsIn(paragraph).length, 0, `卸载后不许留折叠行，实际还剩 ${foldsIn(paragraph).length} 行`)
  const textNode = paragraph.childNodes.find((kid) => kid.nodeType === TEXT)
  assert.equal(textNode.nodeValue, '<inner>【意图】报天气</inner>早 哥|||记得带伞', '卸载要把原文一字不差写回锚点')
  assert.equal(doc.getElementById(FOLD_STYLE_ID), null, '卸载要摘掉自己插的样式元素')
})

test('卸载折叠：锚点已被 React 换掉时，残留折叠行也要清干净', () => {
  const { doc, paragraph } = makeDom({ parts: ['<inner>【意图】甲</inner>正文一句'] })
  const stop = installInnerFold({ doc, observe: false })
  assert.equal(foldsIn(paragraph).length, 1)
  // React 把文本节点整个换新（旧节点脱离文档），折叠行里的源引用就悬空了
  const old = paragraph.childNodes.find((kid) => kid.nodeType === TEXT)
  old.remove()
  paragraph.append(doc.createTextNode('<inner>【意图】甲</inner>正文一句更长了'))

  stop()

  assert.equal(foldsIn(paragraph).length, 0, '源节点没了，无主的折叠行也必须被清掉')
  assert.equal(doc.getElementById(FOLD_STYLE_ID), null)
})

test('样式表内容过期就原地改写（升级/HMR 不刷新页面也能自愈）', () => {
  const { doc } = makeDom({ parts: ['早 哥'] })
  const stale = doc.createElement('style')
  stale.id = FOLD_STYLE_ID
  stale.textContent = '.qqhub-inner{display:block}'
  doc.head.append(stale)

  const stop = installInnerFold({ doc, observe: false })

  const style = doc.getElementById(FOLD_STYLE_ID)
  assert.ok(style, '样式元素还是那一份（不重复插）')
  assert.equal(style, stale, 'id 相同就该复用同一个节点，而不是再插一份')
  assert.ok(style.textContent.includes('.qqhub-mark'), '旧内容的样式表必须被新版内容覆盖')
  assert.ok(style.textContent.includes('.qqhub-inner-body'), '覆盖后的内容要含折叠正文样式')
  stop()
})

test('两个实例同时在册：先卸载的不许摘掉别人还在用的样式（引用计数）', () => {
  // 同一个 document 才有意义：热更时新旧两个实例会短暂共用一份样式表
  const { doc, paragraph } = makeDom({ parts: ['<inner>【意图】甲</inner>正文一句'] })
  const stopA = installInnerFold({ doc, observe: false })
  const stopB = installInnerFold({ doc, observe: false })
  assert.ok(doc.getElementById(FOLD_STYLE_ID))

  stopA()
  assert.ok(doc.getElementById(FOLD_STYLE_ID), '还有一个实例在册，样式表不能摘')

  stopB()
  assert.equal(doc.getElementById(FOLD_STYLE_ID), null, '最后一个实例卸载后才摘样式表')
  assert.equal(foldsIn(paragraph).length, 0, '两个实例的折叠都要撤回')
})

// ---- use-style 的底层挂载/回收（client/src/styles/style-sheet.js）----

function makeStyleDoc() {
  const all = []
  const makeElement = (tag) => {
    const node = { nodeType: ELEMENT, tagName: String(tag).toUpperCase(), parentNode: null, childNodes: [], id: '', textContent: '' }
    node.append = (...kids) => { for (const kid of kids) { kid.parentNode = node; node.childNodes.push(kid) } }
    node.remove = () => {
      node.removedFlag = true
      const parent = node.parentNode
      if (!parent) return
      const at = parent.childNodes.indexOf(node)
      if (at >= 0) parent.childNodes.splice(at, 1)
      node.parentNode = null
    }
    all.push(node)
    return node
  }
  const head = makeElement('head')
  const doc = {
    head,
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => all.find((node) => !node.removedFlag && node.id === id) ?? null,
  }
  return { doc, head }
}

test('useStyle：内容变了原地替换，卸载时按引用计数摘除', () => {
  const { doc, head } = makeStyleDoc()
  const before = styleHolderCount()

  mountStyleSheet(doc, '.a{color:red}')
  const first = doc.getElementById(STYLE_ID)
  assert.ok(first, '第一次挂载要插一份样式表')
  assert.equal(head.childNodes.length, 1)

  mountStyleSheet(doc, '.a{color:blue}')
  assert.equal(doc.getElementById(STYLE_ID), first, '内容变了要原地改写同一份，不能叠第二份')
  assert.equal(head.childNodes.length, 1)
  assert.equal(first.textContent, '.a{color:blue}')
  assert.equal(styleHolderCount(), before + 2)

  assert.equal(releaseStyleSheet(doc), false, '还有一个持有者：这次不该摘')
  assert.ok(doc.getElementById(STYLE_ID))
  assert.equal(releaseStyleSheet(doc), true, '最后一个持有者走了才真的摘')
  assert.equal(doc.getElementById(STYLE_ID), null)
  assert.equal(head.childNodes.length, 0)
  assert.equal(styleHolderCount(), before)
})
