// 回归：资讯池（RSS/Atom 订阅 → 池子 → 她按需查）。
//
// 主人 2026-11-04 定的形态：只存池子，不主动推送。
// 推送会占 QQ 每分钟 10 条的配额（我们已经在限流边缘），而且刷屏跟群友感是反的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFeed, decodeEntities, plainText, parseDate } from '../src/rss/feed.js'
import { mergeIntoPool, readPool, queryPool, poolStats, writePool } from '../src/rss/pool.js'
import { checkFeedUrl, isPrivateHost } from '../src/rss/fetch.js'
import { parseDigestPick } from '../src/modules/rss/index.js'
import { createTelemetry } from '../src/core/telemetry.js'

// ── 解析 ──────────────────────────────────────────────────────────────────

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>测试源</title><link>https://example.com/</link>
<item><title>第一条</title><link>https://example.com/1</link>
  <description><![CDATA[<p>摘要里有<b>标签</b></p>]]></description>
  <pubDate>Fri, 01 Nov 2026 00:00:00 +0800</pubDate><guid>g1</guid></item>
<item><title>第二条 &amp; 实体</title><link>https://example.com/2</link>
  <description>纯文本摘要</description><pubDate>Sat, 02 Nov 2026 00:00:00 +0800</pubDate></item>
</channel></rss>`

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom 源</title>
<link href="https://a.example/" rel="alternate"/>
<entry><title>Atom 条目</title><link href="https://a.example/p/1"/>
<summary>Atom 摘要</summary><updated>2026-11-03T10:00:00Z</updated><id>tag:1</id></entry>
</feed>`

test('RSS 2.0：标题/链接/摘要/时间都取到，CDATA 里 HTML 去掉', () => {
  const r = parseFeed(RSS)
  assert.equal(r.ok, true)
  assert.equal(r.title, '测试源')
  assert.equal(r.items.length, 2)
  const first = r.items.find((x) => x.title === '第一条')
  assert.equal(first.url, 'https://example.com/1')
  assert.equal(first.summary, '摘要里有 标签', 'CDATA 里的 HTML 标签要去掉，文字要留')
  assert.ok(first.at > 0, '要能解析 RFC822 时间')
})

test('RSS 2.0：HTML 实体解码', () => {
  const r = parseFeed(RSS)
  assert.ok(r.items.some((x) => x.title === '第二条 & 实体'), '&amp; 要解成 &')
})

test('Atom：link 是 href 属性也要取到', () => {
  const r = parseFeed(ATOM)
  assert.equal(r.ok, true)
  assert.equal(r.title, 'Atom 源')
  assert.equal(r.items[0].title, 'Atom 条目')
  assert.equal(r.items[0].url, 'https://a.example/p/1')
  assert.equal(r.items[0].summary, 'Atom 摘要')
  assert.ok(r.items[0].at > 0)
})

test('RDF（RSS 1.0）也能解析', () => {
  const rdf = '<rdf:RDF><item><title>RDF 条目</title><link>https://c.example/3</link><dc:date>2026-11-01T00:00:00Z</dc:date></item></rdf:RDF>'
  const r = parseFeed(rdf)
  assert.equal(r.ok, true)
  assert.equal(r.items[0].title, 'RDF 条目')
})

test('不是 feed 时给出明确错误，不静默返回空', () => {
  assert.equal(parseFeed('').ok, false)
  const html = parseFeed('<!DOCTYPE html><html><body>x</body></html>')
  assert.equal(html.ok, false)
  assert.match(html.error, /网页/)
  assert.equal(parseFeed('{"a":1}').ok, false)
})

test('条目按时间倒序（有的源是正序的）', () => {
  const r = parseFeed(RSS)
  assert.ok(r.items[0].at >= r.items[1].at, '新的排前面')
})

test('没有标题也没有链接的占位条目丢弃', () => {
  const r = parseFeed('<rss><channel><item><description>广告位</description></item><item><title>真的</title><link>https://x.com/1</link></item></channel></rss>')
  assert.equal(r.items.length, 1)
})

test('实体解码：命名/十进制/十六进制都认', () => {
  assert.equal(decodeEntities('&amp; &lt; &#38; &#x4E2D;'), '& < & 中')
  // &amp;lt; 不能先被解成 <
  assert.equal(decodeEntities('&amp;lt;'), '&lt;')
})

test('时间解析：RFC822 带 +0800 / ISO8601 / 认不出的返回 0', () => {
  assert.ok(parseDate('Fri, 01 Nov 2026 00:00:00 +0800') > 0)
  assert.ok(parseDate('2026-11-03T10:00:00Z') > 0)
  assert.equal(parseDate('不是时间'), 0)
})

test('plainText：多种换行标签归一，不把文字粘在一起', () => {
  assert.equal(plainText('<p>一</p><p>二</p>'), '一 二')
  assert.equal(plainText('<![CDATA[内容]]>'), '内容')
})

// ── 资讯池 ────────────────────────────────────────────────────────────────

const mk = (key, extra = {}) => ({ key, feedId: 'f1', feedTitle: '源一', title: 't-' + key, url: 'https://x/' + key, summary: 's', at: 1000, ...extra })

test('资讯池：按 key 去重，重复并进去不新增', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-pool-'))
  const a = mergeIntoPool(dir, [mk('a'), mk('b')])
  assert.equal(a.added, 2)
  const b = mergeIntoPool(dir, [mk('a'), mk('b'), mk('c')])
  assert.equal(b.added, 1, '只有 c 是新的')
  assert.equal(b.total, 3)
})

test('资讯池：超过上限丢最老的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-pool2-'))
  const many = Array.from({ length: 10 }, (_, i) => mk('k' + i))
  const r = mergeIntoPool(dir, many, { maxItems: 5 })
  assert.equal(r.total, 5, '只留 5 条')
  const left = readPool(dir).map((x) => x.key)
  assert.ok(!left.includes('k0'), '最老的 k0 被丢掉')
  assert.ok(left.includes('k9'), '最新的留下')
})

test('资讯池：坏行跳过，不影响整体读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-pool3-'))
  writePool(dir, [mk('good')], { maxItems: 10 })
  appendFileSync(join(dir, 'pool.jsonl'), '{这不是 json}\n')
  const items = readPool(dir)
  assert.equal(items.length, 1, '坏行要跳过')
  assert.equal(items[0].key, 'good')
})

test('查询：关键词、按源、只未读、新的在前、limit 生效', () => {
  const items = [
    mk('a', { title: '关于 AI 的文章', at: 3000 }),
    mk('b', { title: '别的', at: 2000 }),
    mk('c', { title: 'AI 又来', feedId: 'f2', at: 4000 }),
  ]
  assert.equal(queryPool(items, { keyword: 'ai' }).length, 2)
  assert.equal(queryPool(items, { feedId: 'f1' }).length, 2)
  assert.equal(queryPool(items, { limit: 1 }).length, 1)
  assert.equal(queryPool(items, { limit: 10 })[0].key, 'c', '最新（at 4000）在前')
  assert.equal(queryPool(items, { unreadOnly: true, readKeys: new Set(['a', 'c']) }).length, 1)
})

test('统计：按源计数 + 最新时间', () => {
  const s = poolStats([mk('a', { at: 100 }), mk('b', { at: 200 }), mk('c', { feedId: 'f2', at: 300 })])
  assert.equal(s.total, 3)
  assert.equal(s.newest, 300)
  assert.equal(s.feeds.length, 2)
})

// ── 安全 ──────────────────────────────────────────────────────────────────

test('SSRF：内网/回环/云元数据地址一律拒绝', () => {
  for (const u of [
    'http://127.0.0.1/f', 'http://localhost/f', 'http://10.1.2.3/f',
    'http://192.168.1.1/f', 'http://172.16.0.1/f', 'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/f', 'http://[fe80::1]/f', 'http://0.0.0.0/f',
  ]) {
    assert.equal(checkFeedUrl(u).ok, false, u + ' 应该拒绝')
  }
})

test('SSRF：只允许 http(s)，公网地址放行', () => {
  assert.equal(checkFeedUrl('file:///etc/passwd').ok, false)
  assert.equal(checkFeedUrl('ftp://a.com/f').ok, false)
  assert.equal(checkFeedUrl('https://www.ruanyifeng.com/blog/atom.xml').ok, true)
  assert.equal(checkFeedUrl('https://news.ycombinator.com/rss').ok, true)
})

test('SSRF：私网判定覆盖 IPv4-mapped 与 .local', () => {
  assert.equal(isPrivateHost('::ffff:127.0.0.1'), true)
  assert.equal(isPrivateHost('printer.local'), true)
  assert.equal(isPrivateHost('fc00::1'), true)
  assert.equal(isPrivateHost('example.com'), false)
})
// ── 每日精选 ──────────────────────────────────────────────────────────────

test('精选解析：正常 JSON 数组按序号取', () => {
  const r = parseDigestPick('[{"i":1,"say":"那个芯片挺猛的"},{"i":3,"say":"周刊又在讲 AI"}]', 5, 3)
  assert.equal(r.length, 2)
  assert.equal(r[0].index, 0)
  assert.equal(r[1].say, '周刊又在讲 AI')
})

test('精选解析：模型裹了代码块或前后废话也能认出来', () => {
  assert.equal(parseDigestPick('```json\n[{"i":2,"say":"好使"}]\n```', 5, 3).length, 1)
  assert.equal(parseDigestPick('好的，我挑这几条：\n[{"i":1,"say":"看到了"}]\n希望有用', 5, 3).length, 1)
})

test('精选解析：序号越界/重复/超 count 都处理掉（别把错条目发到群里）', () => {
  assert.equal(parseDigestPick('[{"i":99,"say":"越界"}]', 3, 3).length, 0, '越界要丢')
  assert.equal(parseDigestPick('[{"i":1,"say":"A"},{"i":1,"say":"B"}]', 5, 3).length, 1, '重复只留一条')
  assert.equal(parseDigestPick('[{"i":1,"say":"a"},{"i":2,"say":"b"},{"i":3,"say":"c"},{"i":4,"say":"d"}]', 5, 2).length, 2, '超 want 截断')
})

test('精选解析：模型没给 JSON 时返回空（让调用方走兜底）', () => {
  assert.equal(parseDigestPick('我挑不出来', 5, 3).length, 0)
  assert.equal(parseDigestPick('', 5, 3).length, 0)
})

// ── 遥测回放（重启后真实用量要能恢复）────────────────────────────────────

test('遥测回放：重启后从文件恢复每个聊天的真实上下文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-replay-'))
  const rows = [
    { v: 1, at: 1000, chatId: 'group:A', input: 1000, cacheRead: 383000, cacheWrite: 0, output: 10 },
    { v: 1, at: 2000, chatId: 'group:A', input: 1000, cacheRead: 443000, cacheWrite: 0, output: 20 },
  ]
  writeFileSync(join(dir, 'telemetry.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const t = createTelemetry({ dir: () => dir })
  assert.ok(t.contextOf('group:A'), '重启后要能查到')
  assert.equal(t.contextOf('group:A').tokens, 444000, '取 at 最大的那条，不是先遇到的')
})
