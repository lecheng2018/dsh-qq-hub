// 长期记忆里不写「在B站看了《xxx》」这种浏览流水（2026-11-05 复盘）。
// 各模块是硬编码写记忆的，不经过 extractFacts 的提示词，所以要在源码层面锁住。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('B 站与抖音：记忆里不再出现具体视频标题', () => {
  for (const f of ['src/bili/duty.js', 'src/douyin/duty.js']) {
    const src = read(f)
    const lines = src.split('\n').filter((l) => l.includes('addEvent'))
    assert.ok(lines.length > 0, f + ' 里应该有写经历的地方')
    for (const l of lines) assert.doesNotMatch(l, /《\$\{/, f + ' 还写着视频标题：' + l.trim())
  }
})

test('刷到的内容只留她的想法；没有想法就不记', () => {
  const bili = read('src/bili/duty.js')
  assert.match(bili, /if \(feeling\) memory\?\.addEvent\?\.\(\{ text: `在B站刷到了点东西，她的想法/)
  const dy = read('src/douyin/duty.js')
  assert.match(dy, /if \(feeling\) memory\?\.addEvent\?\.\(\{ text: `在抖音刷到了点东西，她的想法/)
})

test('她自己写下的结论算知识，打知识标签', () => {
  assert.match(read('src/bili/duty.js'), /tags: \['B站', '知识'\]/)
})

test('她自己的作品（发帖、画图、唱歌、签名、头像）照旧记', () => {
  assert.match(read('src/heybox/site.js'), /我在小黑盒发了一帖/)
  assert.match(read('src/modules/imagegen/index.js'), /按提示词画了一张图/)
  assert.match(read('src/modules/song/index.js'), /唱了《\$\{title\}》/)
  assert.match(read('src/bili/duty.js'), /把B站签名改成了/)
})
