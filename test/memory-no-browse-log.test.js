// 长期记忆里不写「在B站看了《xxx》」这种**无主浏览流水**（2026-11-05 复盘）。
// 1.3.55 修正口径：标题可以作为**出处**出现在她的想法/知识条目里（不然两周后谁都不知道
// 这条说的是哪个视频），但只许截 30 字、必须挂在「她的判断」后面，不许单独记流水。
// 各模块是硬编码写记忆的，不经过 extractFacts 的提示词，所以要在源码层面锁住。
// 抖音的口径随实现搬到商店模块（modules/douyin/douyin.test.mjs）自己锁；这里留还在插件内的模块。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('她自己的作品（发帖、画图、唱歌、签名、头像）照旧记', () => {
  // 小黑盒发帖记录经历已搬到商店模块（modules/heybox/lib/site.mjs）。
  assert.match(read('src/modules/imagegen/index.js'), /按提示词画了一张图/)
})
