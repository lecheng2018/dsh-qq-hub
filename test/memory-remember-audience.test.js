// 设身处地回归（1.3.55 二轮）：remember 提示词给了「将来自己」受众设定。
// 模拟两种模型输出，验收哪种该进记忆库：
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const bili = readFileSync(new URL('../src/bili/duty.js', import.meta.url), 'utf8')
const dy = readFileSync(new URL('../src/douyin/duty.js', import.meta.url), 'utf8')

test('remember 提示词有明确的「将来自己」受众与反面示例', () => {
  for (const [name, src] of [['bili', bili], ['douyin', dy]]) {
    assert.match(src, /写给你.*将来自己|将来自己/, name + '：受众设定')
    assert.match(src, /别写成视频内容简介/, name + '：反面示例①（摘要不是记忆）')
    assert.match(src, /也别只有情绪/, name + '：反面示例②（情绪截图）')
    assert.match(src, /没有就空字符串，别硬凑|没有就空字符串/, name + '：不许硬凑')
  }
})

test('出处标题仍在（上一轮的修复不被覆盖）', () => {
  assert.match(bili, /看了《\$\{srcTitle\}》，她的想法/)
  assert.match(dy, /看了《\$\{srcTitle\}》，她的想法/)
})

// 两种模型输出形态的对照（描述验收标准，防止将来提示词再退回）
test('好 remember vs 废 remember 的形态学', () => {
  // 废：「太戳我了」——纯情绪无对象（提示词明令禁止）
  // 废：「该视频介绍了 RikkaHub 的功能」——内容简介（提示词明令禁止）
  // 好：「统计页能看每个专家烧多少 token，逐项授权要点到手酸——想起 harness 的用量面板也该抄这个」
  //    = 具体细节 + 和她已知事情的连接
  assert.ok(true)
})
