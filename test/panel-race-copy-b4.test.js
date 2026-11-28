// T4.2：面板的剪贴板兜底、外链安全与 TAB_KEYS 覆盖。
//
// 报障口径：
//   · 面板常跑在 `http://192.168.x.x:port`（非安全上下文），`navigator.clipboard` 在那里
//     根本不存在。旧 `copy()` 直接 `navigator.clipboard.writeText(...)` → TypeError，
//     被外层 try 吞掉后只弹「复制失败」，「复制给 DSH 的话」这类按钮等于废的。
//   · `window.open(url, '_blank')` 不带 `noopener`，打开页能通过 `window.opener` 反向操作
//     面板；地址来自配置/后端，`javascript:` 之类也没人挡。
//   · `TAB_KEYS` 漏登记 = 改完不出现「未保存」标记，关掉面板改动静默丢失。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copy, openExternal, isSafeHttpUrl } from '../client/src/core/utils.js'
import { TAB_KEYS } from '../client/src/domain/tab-keys.js'
import { DEFAULTS } from '../src/core/config-defaults.js'

/** 临时换上假的 navigator / document，结束后按原描述符还原（含「本来就没有」的情况）。 */
async function withGlobals({ navigator, document }, fn) {
  const savedNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const savedDoc = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const hadDoc = Object.prototype.hasOwnProperty.call(globalThis, 'document')
  try {
    if (navigator !== undefined) Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true, writable: true })
    else delete globalThis.navigator
    if (document !== undefined) Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true })
    else delete globalThis.document
    // 必须 await：copy() 在第一个 await 之后才走兜底路径，提前还原全局会让它看不见假 DOM
    return await fn()
  } finally {
    if (savedNav) Object.defineProperty(globalThis, 'navigator', savedNav)
    else delete globalThis.navigator
    if (hadDoc && savedDoc) Object.defineProperty(globalThis, 'document', savedDoc)
    else if (!hadDoc) delete globalThis.document
  }
}

const toasts = () => {
  const list = []
  const toast = (text, kind) => list.push({ text, kind })
  return { list, toast }
}

/** 极简假 DOM：只提供 copy() 兜底路径用到的 textarea 三件套。 */
function makeFakeDoc({ execResult = true } = {}) {
  const calls = { created: [], appended: [], selected: 0, removed: 0, exec: [] }
  const body = {
    childNodes: [],
    appendChild(node) { node.parentNode = body; body.childNodes.push(node); calls.appended.push(node) },
    removeChild(node) { const at = body.childNodes.indexOf(node); if (at >= 0) body.childNodes.splice(at, 1); calls.removed++ },
  }
  return {
    calls,
    doc: {
      body,
      createElement(tag) {
        const node = {
          tagName: String(tag).toUpperCase(),
          style: {},
          value: '',
          parentNode: null,
          attributes: {},
          setAttribute(key, value) { node.attributes[key] = String(value) },
          select() { calls.selected += 1 },
        }
        calls.created.push(node)
        return node
      },
      execCommand(cmd) { calls.exec.push(cmd); return execResult },
    },
  }
}

test('copy：安全上下文用 navigator.clipboard，await 之后才提示成功', async () => {
  const written = []
  const { list, toast } = toasts()
  await withGlobals({ navigator: { clipboard: { writeText: async (text) => { written.push(text) } } } }, async () => {
    const ok = await copy('给 DSH 的话', toast, '复制好了')
    assert.equal(ok, true)
  })
  assert.deepEqual(written, ['给 DSH 的话'], '内容要原样交给 clipboard')
  assert.deepEqual(list, [{ text: '复制好了', kind: 'ok' }], '只在真的写进去之后才提示成功')
})

test('copy：局域网 http（没有 navigator.clipboard）退回 textarea + execCommand', async () => {
  const { doc, calls } = makeFakeDoc({ execResult: true })
  const { list, toast } = toasts()
  await withGlobals({ navigator: {}, document: doc }, async () => {
    const ok = await copy('兜底复制的文本', toast, '复制好了')
    assert.equal(ok, true, 'http 页面下必须复制成功，而不是弹「复制失败」')
  })
  assert.equal(calls.exec.length, 1)
  assert.deepEqual(calls.exec, ['copy'])
  assert.equal(calls.selected, 1, 'textarea 要选中才复制得到')
  assert.equal(calls.appended.length, 1)
  assert.equal(calls.removed, 1, '兜底用的 textarea 必须从 DOM 里摘掉')
  assert.equal(calls.created[0].value, '兜底复制的文本')
  assert.equal(calls.created[0].style.position, 'fixed', '不能因为插进来把面板顶下去')
  assert.deepEqual(list, [{ text: '复制好了', kind: 'ok' }])
})

test('copy：clipboard 抛错时也走兜底；两条路都失败才报错', async () => {
  const { doc, calls } = makeFakeDoc({ execResult: true })
  const { list, toast } = toasts()
  await withGlobals({
    navigator: { clipboard: { writeText: async () => { throw new Error('NotAllowedError') } } },
    document: doc,
  }, async () => {
    assert.equal(await copy('x', toast, '复制好了'), true, 'clipboard 被拒 → 应退回 execCommand')
  })
  assert.equal(calls.exec.length, 1)

  const failing = makeFakeDoc({ execResult: false })
  const failed = toasts()
  await withGlobals({ navigator: {}, document: failing.doc }, async () => {
    assert.equal(await copy('x', failed.toast, '复制好了'), false, 'execCommand 返回 false 就是没复制上')
  })
  assert.deepEqual(failed.list, [{ text: '复制失败，手动选中复制吧', kind: 'err' }], '失败不许谎报成功')
})

test('openExternal：只放行 http(s)，并强制 noopener,noreferrer', () => {
  const opened = []
  const fakeOpen = (...args) => { opened.push(args); return {} }
  assert.equal(openExternal('https://example.com/a', '_blank', fakeOpen), true)
  assert.deepEqual(opened[0], ['https://example.com/a', '_blank', 'noopener,noreferrer'])
  // 夹具用主机名而不是私网 IP：行为只取决于协议是不是 http，写 IP 会触发仓库的 PII 扫描
  assert.equal(openExternal('http://panel.lan:5700/', '_blank', fakeOpen), true)

  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd', '']) {
    assert.equal(openExternal(bad, '_blank', fakeOpen), false, `不该打开：${bad}`)
  }
  assert.equal(opened.length, 2, '被拒的地址连 window.open 都不该调')
  assert.equal(isSafeHttpUrl('https://ok'), true)
  assert.equal(isSafeHttpUrl('vbscript:x'), false)
  // 浏览器拦截弹窗时 window.open 返回 null：要如实告诉调用方没打开
  assert.equal(openExternal('https://example.com', '_blank', () => null), false)
})

test('TAB_KEYS：persona / connect.gateway / model.visionHelper 都已登记，且都是真实配置根', () => {
  assert.ok(TAB_KEYS.persona?.includes('persona'), '人设页整页都没登记过 → 改完不显示未保存')
  assert.ok(TAB_KEYS.connect.includes('gateway'), '连接页的网关开关改完不显示未保存')
  assert.ok(TAB_KEYS.model.includes('visionHelper'), '视觉模型选择改完不显示未保存')

  const unknown = []
  for (const [tab, roots] of Object.entries(TAB_KEYS)) {
    for (const root of roots) if (!(root in DEFAULTS)) unknown.push(`${tab}.${root}`)
  }
  assert.deepEqual(unknown, [], 'TAB_KEYS 里的根必须真的存在于默认配置（拼错等于永远不脏）')
})
