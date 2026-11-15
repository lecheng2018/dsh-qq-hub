// 面板「小黑盒」页的源码契约 + 分区表运行时契约。
// 参考 aurabot 3c17ebb（fix(panel): 小黑盒卡片说明与刷新提示跟上模块新行为）移植到 qqhub：
//   · 卡片说明/自检要和模块真实行为一致（qqhub 的配图是她自己准备的本机图，最多 4 张，
//     传小黑盒图床；不是 aurabot 那种按字数自动配图，文案不能照抄）；
//   · 刷新类按钮按接口真实 ok 状态给提示，零结果不冒充成功；
//   · 分区下拉优先读接口拉到的全表（每天缓存一次），内置保底仍在。
// 这些点回退会直接红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const src = readFileSync(new URL('../client/src/views/platforms/heybox.js', import.meta.url), 'utf8')

test('卡片说明与模块行为一致：写帖流程完整、配图她自己准备（最多 4 张）、权限默认仅主人', () => {
  assert.ok(src.includes('再看社区高赞帖在聊什么'), '说明要写全写帖流程（热榜 → 社区角度）')
  assert.ok(src.includes('配图她自己准备'), '说明要写清配图是谁准备的')
  assert.ok(src.includes('本机图片最多 4 张'), '说明要写配图上限（heybox_post 截断到 4 张）')
  assert.ok(src.includes('哪张传不上就跳过哪张'), '说明要写上传失败不打断发帖')
  assert.ok(src.includes('默认仅主人'), '写操作权限默认 owner，说明要写出来')
  // 旧文案暗示「配图走图床」是用户要自己管的链路，且没写清行为；不该再出现
  assert.ok(!src.includes('配图走小黑盒图床'), '旧的「配图走小黑盒图床」不该还在')
})

test('发帖自检与模块规则一致：字数跟风格走，配图最多 4 张', () => {
  assert.ok(src.includes('正文符合所选风格的字数'), '自检字数要和规则一致（diary 120-300 / news 200-800 / mix 150-500）')
  assert.ok(src.includes('配图最多 4 张，至少 3 张更好'), '自检要和工具上限（4 张）与规则（至少 3 张更好）一致')
  assert.ok(!src.includes('正文 200-800 字；配图越多越好'), '旧的「正文 200-800 字；配图越多越好」不该还在')
})

test('刷新分区按接口真实 ok 状态给提示，零结果不冒充成功', () => {
  // 模块侧 topicsForPanel(true) 在「一个都没拉到」时返回 ok:false，面板要照实显示失败
  assert.ok(src.includes("toast(r.message || '已刷新', r.ok === false ? 'err' : 'ok')"),
    '刷新按钮要用 r.ok 决定提示样式')
  assert.ok(src.includes("post('/heybox/topics/refresh')"), '刷新分区要走强制重拉路由')
})

test('通用动作提示也按 r.ok，不写死成功', () => {
  assert.ok(src.includes("toast(r.message || (r.ok ? '好了' : '没成功'), r.ok === false ? 'err' : 'ok')"),
    'act() 的提示要用 r.ok 决定样式')
  assert.ok(src.includes("if (r.ok === false) { toast(r.message || '拉不到热榜', 'err'); return }"),
    '热榜拉取失败要照实提示')
})

test('分区下拉优先用接口拉到的全表，内置保底仍在', () => {
  assert.ok(src.includes('topics.list.map'), '分区下拉要读接口拉到的全表')
  assert.ok(src.includes("get('/heybox/topics')"), '打开面板要拉一次分区表（模块侧每天缓存）')
  assert.ok(src.includes("{ value: 7214, label: '盒友杂谈'"), '缺内置保底分区')
  assert.ok(src.includes("{ value: 18745, label: '数码硬件'"), '缺内置保底分区')
  assert.ok(src.includes("{ value: 806933, label: 'AI'"), '缺内置保底分区')
})

// ── 运行时：分区表缓存与 ok 语义 ─────────────────────────────────────
// site.js 在 import 时就算 HOME，先把 USERPROFILE 指到临时目录再动态 import，
// 避免污染真实的 ~/.dsh/heybox-state.json。

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'qqhub-heybox-contract-'))
process.env.USERPROFILE = tmpHome
const { createHeybox } = await import('../src/heybox/site.js')

let fetchMode = 'empty' // empty | topics | down
let fetchCalls = 0
globalThis.fetch = async () => {
  fetchCalls++
  if (fetchMode === 'down') throw new Error('network down')
  const result = fetchMode === 'topics'
    ? { topics: [{ topic_id: 7214, name: '盒友杂谈' }, { topic_id: 999001, name: '测试分区' }, { topic_id: 7214, name: '盒友杂谈（重复）' }] }
    : { topics: [] }
  return { ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({ status: 'ok', result }) }
}

const hb = createHeybox({
  getConfig: () => ({ heybox: { cookie: 'pkey=contract-test' }, ownerQQ: '', botQQ: '' }),
  hub: {}, memory: null, log: null,
})
const stateFile = path.join(tmpHome, '.dsh', 'heybox-state.json')
const FALLBACK_IDS = ['7214', '18745', '806933']

test('分区：强刷一个都没拉到 → ok:false，列表回落内置三个', async () => {
  fetchMode = 'empty'
  const r = await hb.topicsForPanel(true)
  assert.equal(r.ok, false, '零结果不冒充成功')
  assert.deepEqual(r.list.map((t) => t.id), FALLBACK_IDS)
  assert.ok(r.message, '失败要给面板一句可显示的原因')
})

test('分区：拉到了就缓存，当天再读不打接口；重复 id 去重', async () => {
  fetchMode = 'topics'
  const before = fetchCalls
  const r = await hb.topicsForPanel(true)
  assert.equal(r.ok, true)
  assert.equal(r.cached, false)
  assert.equal(fetchCalls, before + 1)
  assert.deepEqual(r.list.map((t) => t.id), ['7214', '999001'], '重复分区要去重')
  const again = await hb.topicsForPanel()
  assert.equal(again.cached, true, '当天第二次读走缓存')
  assert.equal(fetchCalls, before + 1, '缓存命中不打接口')
  assert.deepEqual(again.list, r.list)
})

test('分区：普通加载失败静默回落保底，保底不缓存（下次打开还会再试）', async () => {
  const st = JSON.parse(readFileSync(stateFile, 'utf8'))
  st.topicsCache = null
  writeFileSync(stateFile, JSON.stringify(st))
  fetchMode = 'down'
  const r = await hb.topicsForPanel()
  assert.equal(r.ok, true, '打开面板时的静默加载不算失败')
  assert.equal(r.live, false)
  assert.deepEqual(r.list.map((t) => t.id), FALLBACK_IDS)
  const after = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(after.topicsCache, null, '保底结果不缓存')
})

test('topicList：live 标记区分真拉到和内置保底（heybox_topics 工具语义不变）', async () => {
  fetchMode = 'topics'
  const live = await hb.topicList()
  assert.equal(live.ok, true)
  assert.equal(live.live, true)
  fetchMode = 'down'
  const fb = await hb.topicList()
  assert.equal(fb.ok, true, '工具侧保底仍算 ok（发帖还能用内置分区）')
  assert.equal(fb.live, false)
  assert.ok(fb.message.includes('内置的三个'))
})
