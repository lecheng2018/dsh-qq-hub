// 长期记忆里不写「在B站看了《xxx》」这种**无主浏览流水**（2026-11-05 复盘）。
// 1.3.55 修正口径：标题可以作为**出处**出现在她的想法/知识条目里（不然两周后谁都不知道
// 这条说的是哪个视频），但只许截 30 字、必须挂在「她的判断」后面，不许单独记流水。
// 各模块是硬编码写记忆的，不经过 extractFacts 的提示词，所以要在源码层面锁住。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('B 站与抖音：想法/知识条目带出处标题，且想法条目是 ephemeral', () => {
  for (const [f, platform] of [['src/bili/duty.js', 'B站'], ['src/douyin/duty.js', '抖音']]) {
    const src = read(f)
    // 出处化：看了《标题》，她的想法：…
    assert.match(src, new RegExp('看了《\\$\\{srcTitle\\}》，她的想法'), f + ' 想法条目要带出处')
    assert.match(src, /（来自《\$\{srcTitle\}》）/, f + ' 知识条目要带出处')
    assert.match(src, /slice\(0, 30\)/, f + ' 标题截 30 字')
    assert.match(src, /ephemeral: true/, f + ' 想法条目 ephemeral（快速淡出）')
    // 不许出现旧的「刷到了点东西」无主形态（注释里复盘提及可以，实际 addEvent 的模板串不许）
    const badLines = src.split('\n').filter((l) => l.includes('addEvent') && l.includes('刷到了点东西'))
    assert.deepEqual(badLines, [], f + ' 还有旧的无主写法')
    // 知识条目正文的截断长度缩到 180（给出处让位）
    assert.ok(src.includes('slice(0, 180)') || src.includes('clip(d.remember, 180)'), f + ' 知识正文 180 字')
    void platform
  }
})

test('知识条目仍打知识/平台标签', () => {
  assert.match(read('src/bili/duty.js'), /tags: \['B站', '知识'\]/)
})

test('她自己的作品（发帖、画图、唱歌、签名、头像）照旧记', () => {
  assert.match(read('src/heybox/site.js'), /我在小黑盒发了一帖/)
  assert.match(read('src/modules/imagegen/index.js'), /按提示词画了一张图/)
  assert.match(read('src/bili/duty.js'), /把B站签名改成了/)
})
