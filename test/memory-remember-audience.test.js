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

// 两种模型输出形态的对照（验收标准写进提示词，防止将来提示词再退回）
//
// 这里原来只有一句 `assert.ok(true)` —— 零信息量的假断言，永远不会红，
// 等于这个用例不存在。现在改成真的对着提示词文本断言「它是否还在要求那两件事」：
//   好 remember = 具体细节 + 和她已知事情的连接
//   废 remember = 纯情绪（「太戳我了」）/ 内容简介（「该视频介绍了…」）
test('好 remember vs 废 remember 的形态学：提示词必须同时要细节和连接', () => {
  for (const [name, src] of [['bili', bili], ['douyin', dy]]) {
    // 好形态的两半：要「具体细节」，要「和她已知事情的连接」。
    // 注意两家措辞本来就不同：bili 写「一个具体的细节」，douyin 写「具体细节」（少一个「的」）。
    // 这里断言的是**语义要求还在**，不是逐字一致 —— 用 /具体细节/ 覆盖两种写法。
    assert.match(src, /具体(?:的)?细节/, name + '：必须要求具体细节（否则模型只会写情绪）')
    assert.match(src, /和我已知事情的连接|已知事情的连接/, name + '：必须要求连接她已知的事')
    // 废形态的反面示例必须在场（只写「要好」不够，模型需要看到反例）
    assert.match(src, /别写成视频内容简介/, name + '：要有「内容简介≠记忆」的反例')
    assert.match(src, /也别只有情绪/, name + '：要有「纯情绪不行」的反例')
    // 反面示例要举出「太戳我了」这个具体样本，否则模型不知道什么叫「只有情绪」
    assert.match(src, /太戳我了/, name + '：反例要给出具体样本')
  }
})
