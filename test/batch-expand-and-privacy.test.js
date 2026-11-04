// 回归（v1.3.21 复审修复）：
// 1) 记忆库「批量展开」按钮反了 —— setCollapsed({}) 空对象下 collapsed[m.id] !== false 恒 true，展开变折叠
// 2) memory-privacy 隔离开关是假开关（死代码 listFor 不跑）—— 现在接主库 registerScopeOverride，且只放行主人私聊
// 3) 英文长句/URL 兜底 —— sentencePieces 空格层硬切，URL 占位不切坏
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname

test('client.js 批量展开按钮：展开=全部 false，折叠=全部 true（不能两个都折叠）', () => {
  const src = readFileSync(join(root, 'client/client.js'), 'utf8')
  const expand = src.match(/'批量展开'\)/)?.index
  assert.ok(expand !== undefined, '批量展开按钮存在')
  const expandSeg = src.slice(Math.max(0, expand - 200), expand)
  assert.match(expandSeg, /m\.id, false/, '批量展开必须把每行设为 false')
  const collapse = src.match(/'批量折叠'\)/)?.index
  assert.ok(collapse !== undefined, '批量折叠按钮存在')
  const collapseSeg = src.slice(Math.max(0, collapse - 200), collapse)
  assert.match(collapseSeg, /m\.id, true/, '批量折叠必须把每行设为 true')
})

test('memory.js 有 registerScopeOverride 挂点（隔离开关生效通道）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-priv-'))
  mkdirSync(join(dir, 'aurabot'), { recursive: true })
  process.env.AURABOT_DATA_DIR = dir
  process.env.DSH_PLUGIN_DATA = dir
  const m = await import('../src/features/memory.js')
  const cfg = { botQQ: '10001', ownerQQ: '10001', memory: { enabled: true, recallCount: 4, autoExtract: false } }
  const noop = () => {}
  const mem = m.createMemoryStore({ dsh: { get: () => null }, getConfig: () => cfg, hub: { ask: noop }, log: { info: noop, warn: noop, debug: noop, error: noop } })
  const group = { chatId: 'group:888', kind: 'group', groupId: '888' }
  mem.add({ text: '主人私聊里的秘密', importance: 0.7, source: 'tool', chatId: 'private:10001', scope: 'private:10001' })
  // 默认：群里看不到主人私聊
  assert.equal(mem.recall('秘密', { chat: group }).length, 0)
  // 注册 override：group:888 开放 → 只放行 private:10001
  mem.registerScopeOverride((scope, chat) => chat?.groupId === '888' && scope === 'private:10001')
  const hits = mem.recall('秘密', { chat: group })
  assert.equal(hits.length, 1, 'override 开放后群能看到主人私聊记忆')
  // 别的群不行
  const other = { chatId: 'group:999', kind: 'group', groupId: '999' }
  assert.equal(mem.recall('秘密', { chat: other }).length, 0, '没开放的群仍然隔离')
  // 其他私聊也不放行
  mem.add({ text: '老张家的钥匙藏在门垫下面', importance: 0.7, source: 'tool', chatId: 'private:555', scope: 'private:555' })
  assert.equal(mem.recall('钥匙', { chat: group }).length, 0, 'override 只放行声明的 scope，别的私聊仍隔离')
  mem.dispose()
})

test('memory-privacy 不再有死代码 listFor/recordFilter（假开关已移除）', () => {
  const src = readFileSync(join(root, 'src/modules/memory-privacy/index.js'), 'utf8')
  assert.doesNotMatch(src, /function listFor/, '死代码 listFor 已删')
  assert.doesNotMatch(src, /recordFilter/, '死代码 recordFilter 已删')
  assert.match(src, /registerScopeOverride/, '隔离开关改走主库挂点')
})

test('英文长句有空格兜底切分，不再整段发出', async () => {
  process.env.AURABOT_DATA_DIR = process.env.AURABOT_DATA_DIR || mkdtempSync(join(tmpdir(), 'ab-rp-'))
  const m = await import('../src/chat/reply.js')
  const en = 'Honestly the whole thing started when we were debugging the websocket gateway and it kept dropping connections every thirty seconds which made the retries pile up like crazy and eventually the whole queue backed up for hours before anyone noticed what was actually happening'
  const r = m.parseReply(en)
  const texts = r.items.filter((i) => i.kind === 'text').map((i) => i.value)
  assert.ok(texts.every((t) => t.length <= 240), '每条 ≤240')
  assert.ok(texts.length >= 2, '长英文句要被切开')
})

test('URL（含查询串）不切坏', async () => {
  process.env.AURABOT_DATA_DIR = process.env.AURABOT_DATA_DIR || mkdtempSync(join(tmpdir(), 'ab-rp2-'))
  const m = await import('../src/chat/reply.js')
  const url = 'https://example.com/docs/very/long/path/query?param=1&other=2'
  const r = m.parseReply('看这个 ' + url + ' 以及后面的说明文字'.padEnd(260, '长'))
  const texts = r.items.filter((i) => i.kind === 'text').map((i) => i.value)
  const whole = texts.find((t) => t.includes(url))
  assert.ok(whole, 'URL 要完整出现在某一条里（不切坏查询串）')
})

// —— v1.3.22 二轮复审修复 ——

test('memory-privacy/list 没有 all=1 旁路：私聊打码只由 previewPrivate 开关决定', () => {
  const src = readFileSync(join(root, 'src/modules/memory-privacy/index.js'), 'utf8')
  const seg = src.slice(src.indexOf("/memory-privacy/list"), src.indexOf("/memory-privacy/clear-scope"))
  assert.doesNotMatch(seg, /query\?\.all/, 'list 路由不再读 all 参数（旁路已删）')
  assert.match(seg, /previewPrivate/, '打码判定走 previewPrivate 开关')
  // 打码逻辑：private: 且未开 preview 才替换文本
  assert.match(seg, /startsWith\('private:'\)/, '按作用域前缀打码')
})

test('clear-main 连软删条目一起清（不加 !invalidAt 过滤）', () => {
  const src = readFileSync(join(root, 'src/modules/memory-privacy/index.js'), 'utf8')
  const seg = src.slice(src.indexOf("/memory-privacy/clear-main"), src.indexOf("/memory-privacy/set-override"))
  assert.doesNotMatch(seg, /!m\.invalidAt/, 'clear-main 不再跳过软删条目')
})

test('ListInput numbers=true：敲一半的短数字不被吃（strict 只在失焦生效）', () => {
  const src = readFileSync(join(root, 'client/client.js'), 'utf8')
  const i = src.indexOf('function ListInput')
  const seg = src.slice(i, i + 1400)
  assert.match(seg, /strict/, 'parse 有 strict 模式')
  // onChange 也传 strict（draft 只收有效值），但输入框 text 保留原文 —— 关键断言：useEffect 对比用 strict，
  // text 不被非 strict parse 覆盖
  assert.match(seg, /onChange: \(e\) => \{ setText\(e\.target\.value\)/, '输入时 text 保留原文')
})

test('heybox dutyInFlight 挂进程级单例（热重载不失效）', () => {
  const src = readFileSync(join(root, 'src/heybox/site.js'), 'utf8')
  assert.match(src, /globalThis\.__qqhubHeyboxDuty/, '锁挂 globalThis 跨热重载')
  assert.doesNotMatch(src, /let dutyInFlight/, '不再用闭包变量')
})
