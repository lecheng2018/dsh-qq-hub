// 审计 S13 的回归锁：记忆 Markdown 往返必须无损，且损坏要在写入前被拦住。
//
// 原始问题（实测复现）：
//   · 正文若以 `### 饮食偏好` 开头 → 该行被吃成条目标题，正文少一行；
//   · 正文里出现 `#### 来源与依据` → 其后内容整体搬进 evidence，正文被截断；
//   · 正文以 `#### 来源与依据` 开头 → 正文整个消失（text 变 undefined）。
//   而 memory-files 写盘前只 `parseMarkdownArchive()` 确认「能解析」，不对账字段，
//   所以损坏是静默的——记忆是长期事实源，丢了读回来才发现。
//
// 修复两步：
//   ① 格式升级 v2：写侧转义行首 `###`/`####`，读侧只在 format=v2 时反转义；
//      v1 老文件按原样解析（行为不变），下次写盘升级为 v2。
//   ② 写盘前往返自检：序列化→解析→逐字段比对（忽略首尾空白这一已知无害差异），
//      不一致就抛错阻止写入，绝不落一份坏档。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const M = await import('../src/features/memory-markdown.js')

const entry = (id, text, extra = {}) => ({ id, kind: 'fact', text, evidence: '', revision: '', tags: [], ...extra })
const roundtrip = (entries, { format } = {}) => {
  const md = M.serializeMarkdownArchive({ meta: { scope: 'private:1', ...(format ? { format } : {}) }, entries })
  const parsed = M.parseMarkdownArchive(md, { expectedScope: 'private:1' })
  return { md, parsed, byId: new Map(parsed.entries.map((e) => [e.id, e])) }
}

test('S13 · 正文里的结构行不再被当成标题/区段分隔（v2）', () => {
  const cases = [
    ['a1', '### 饮食偏好\n不吃香菜，爱喝冰美式'],
    ['a2', '#### 来源与依据\n（这是正文的一部分）'],
    ['a3', '正文提到小节标题\n#### 来源与依据\n后面这行不能被搬走'],
    ['a4', '正文里有三号标题\n### 饮食偏好\n后面还有内容'],
  ]
  const { byId } = roundtrip(cases.map(([id, text]) => entry(id, text)))
  for (const [id, text] of cases) {
    const got = byId.get(id)
    assert.ok(got, `${id} 不应消失`)
    assert.equal(got.text, text, `${id} 正文必须原样往返`)
    assert.equal(got.title, undefined, `${id} 不应被解析出标题`)
    assert.equal(got.evidence, undefined, `${id} 不应有内容被搬进 evidence`)
  }
})

test('S13 · evidence / revision 里的结构行同样安全', () => {
  const e = entry('b1', '正文', { evidence: '### 依据里的小标题\n内容', revision: '#### 修订说明\n改了啥' })
  const { byId } = roundtrip([e])
  const got = byId.get('b1')
  assert.equal(got.text, '正文')
  assert.equal(got.evidence, '### 依据里的小标题\n内容')
  assert.equal(got.revision, '#### 修订说明\n改了啥')
})

test('S13 · v1 老文件按原样解析，不被重新解释（行为不变）', () => {
  const v1 = [
    '---', 'format: qqhub-memory-v1', 'scope: private:1', '---', '',
    '# 私聊记忆档案', '', '## 当前记忆', '',
    '<!-- qqhub:entry {"id":"old1","kind":"fact"} -->',
    '### 饮食偏好', '不吃香菜', '', '<!-- /qqhub:entry -->', '',
  ].join('\n')
  const parsed = M.parseMarkdownArchive(v1, { expectedScope: 'private:1' })
  const got = parsed.entries[0]
  // v1 语义：首行 ### 被当标题。刻意保持——重新解释存量文件等于凭空改内容。
  assert.equal(got.title, '饮食偏好')
  assert.equal(got.text, '不吃香菜')
})

test('S13 · 旧文件读进来再写盘会升级成 v2', () => {
  const v1 = [
    '---', 'format: qqhub-memory-v1', 'scope: private:1', '---', '',
    '## 当前记忆', '',
    '<!-- qqhub:entry {"id":"x","kind":"fact"} -->',
    '老内容', '', '<!-- /qqhub:entry -->', '',
  ].join('\n')
  const parsed = M.parseMarkdownArchive(v1, { expectedScope: 'private:1' })
  const md = M.serializeMarkdownArchive({ meta: { scope: 'private:1' }, entries: parsed.entries })
  assert.match(md, /^format: qqhub-memory-v2$/m, '下一次写盘应升级格式版本')
})

test('S13 · 两种格式都能解析（v1 不被拒）', () => {
  assert.ok(M.SUPPORTED_FORMATS.has('qqhub-memory-v1'))
  assert.ok(M.SUPPORTED_FORMATS.has('qqhub-memory-v2'))
  assert.equal(M.MEMORY_FORMAT, 'qqhub-memory-v2', '新写默认 v2')
})

test('S13 · 未知格式仍然拒绝（不静默当成某种版本）', () => {
  const bad = ['---', 'format: qqhub-memory-v9', 'scope: private:1', '---', '', '## 当前记忆', ''].join('\n')
  assert.throws(() => M.parseMarkdownArchive(bad, { expectedScope: 'private:1' }), /不支持的记忆格式版本/)
})

test('S13 · 往返只丢首尾空白（既有 trim 设计，已知且无害）', () => {
  const { byId } = roundtrip([entry('c1', '末尾有空行\n\n\n')])
  assert.equal(byId.get('c1').text, '末尾有空行', 'trim 是既有设计：不 trim 会让每条记忆都拖着空行')
})

// ---------- 止损：写盘前的往返自检（真实 store 写入路径） ----------

test('S13 · v2 下含结构行的记忆能写入并原样召回（自检不误伤）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-rt-'))
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const { createMemoryStore } = await import('../src/features/memory.js')
  const { normalize } = await import('../src/core/config.js')
  const cfg = normalize({ ownerQQ: '1', model: { provider: 'p', model: 'm' } })
  const store = createMemoryStore({
    dsh: {}, getConfig: () => cfg,
    hub: { chatLogOf: () => [], chatLogDays: () => [] },
    log: { info() {}, warn() {}, debug() {} }, personaText: () => '',
  })
  const r = store.add({ text: '### 饮食偏好\n不吃香菜', scope: 'private:1', source: 'manual' })
  assert.equal(r.ok, true, `v2 下应写入成功：${r.message || ''}`)
  const back = store.recall('饮食偏好', { scopes: ['private:1'] })
  assert.ok(back.some((h) => String(h.it?.text || '').includes('### 饮食偏好')), '写进去的正文必须原样可召回')
})

// ---------- 护栏本身必须可验证：diffRoundTrip 能识别破坏性差异 ----------

test('S13 · diffRoundTrip 能识别「正文被截断 / 内容搬进 evidence / 条目消失」', () => {
  const source = [
    { id: 'x1', text: '正文提到小节标题\n后面还有内容', evidence: '', revision: '', title: '' },
    { id: 'x2', text: '整条内容', evidence: '', revision: '', title: '' },
    { id: 'x3', text: '会消失的条目', evidence: '', revision: '', title: '' },
  ]
  // 模拟 v1 解析出来的破坏结果：
  //  x1 正文被截断、后半段进了 evidence；x2 正文整个变成 title；x3 不见
  const parsed = [
    { id: 'x1', text: '正文提到小节标题', evidence: '后面还有内容', revision: '', title: '' },
    { id: 'x2', text: '', evidence: '', revision: '', title: '整条内容' },
  ]
  const problems = M.diffRoundTrip(parsed, source)
  // x1 报 text+evidence、x2 报 text+title、x3 报消失 = 5 处
  assert.equal(problems.length, 5, `应报出 5 处差异，实际 ${problems.length} 处`)
  assert.ok(problems.some((p) => p.includes('x1') && p.includes('text')), '应报 x1 正文不一致')
  assert.ok(problems.some((p) => p.includes('x1') && p.includes('evidence')), '应报 x1 evidence 被写入')
  assert.ok(problems.some((p) => p.includes('x2') && p.includes('title')), '应报 x2 title 被写入')
  assert.ok(problems.some((p) => p.includes('x3') && p.includes('消失')), '应报 x3 消失')
})

test('S13 · diffRoundTrip 不把首尾空白当差异（避免误拦正常写入）', () => {
  const source = [{ id: 'w1', text: '正文\n\n', evidence: ' 依据 ', revision: '', title: '' }]
  const parsed = [{ id: 'w1', text: '正文', evidence: '依据', revision: undefined, title: undefined }]
  assert.deepEqual(M.diffRoundTrip(parsed, source), [], '仅首尾空白差异应放行')
})

test('S13 · diffRoundTrip 对无损往返返回空', () => {
  const src = [entry('p1', '### 饮食偏好\n不吃香菜', { evidence: '### 依据', revision: '改了' })]
  const { parsed } = roundtrip(src)
  assert.deepEqual(M.diffRoundTrip(parsed.entries, src), [], 'v2 往返应完全无损（除首尾空白）')
})
