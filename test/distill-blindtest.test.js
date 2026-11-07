// 蒸馏效果盲测测试：提示词拼装（仿写/裁判两段）、混排猜分、边界。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBlindTestPrompts, scoreBlindTest } from '../src/features/distill-blindtest.js'

const PROFILE = {
  catchphrases: [{ text: '斩（催办时）', score: 0.9, evidence: ['斩了'] }],
  syntax: [{ text: '短句', score: 0.8 }],
  samples: [{ text: '就这？', score: 0.6 }],
}

test('提示词：仿写段带语感参照与逐条对应要求；裁判段带混排列表与 1/0 输出格式', () => {
  const { mimic, judge } = buildBlindTestPrompts({
    name: '老王',
    realLines: ['这游戏又崩了？', '上号上号'],
    profile: PROFILE,
    samples: ['就这？'],
  })
  assert.match(mimic.system, /保留话题和意思/, '仿写不抄内容')
  assert.match(mimic.system, /"lines":\["仿写1"/, '一一对应')
  assert.match(mimic.text, /语感参照/, '画像进仿写提示词')
  assert.match(mimic.text, /这游戏又崩了？/, '待仿写句进 prompt')
  assert.match(judge.system, /本人原话|仿句/, '裁判任务清晰')
  assert.match(judge.system, /"guesses":\[1或0/, '1/0 格式')
  assert.match(judge.text, /参考（他更多的真实发言）：「就这？」/, '样本参考进裁判 prompt')
  assert.match(judge.text, /这游戏又崩了？/, '混排列表进 prompt')
})

test('提示词：无画像时给兜底参照；空样本不出参考行', () => {
  const { mimic, judge } = buildBlindTestPrompts({ name: '老王', realLines: ['句子A', '句子B'], profile: {}, samples: [] })
  assert.match(mimic.text, /无画像，凭你对他的印象模仿/)
  assert.doesNotMatch(judge.text, /参考（他更多的真实发言）/, '没样本不出现参考段')
})

test('评分：真话下标取裁判猜测、缺省从严记 0、条数对不上不崩', () => {
  // 猜对一半
  const half = scoreBlindTest(['真1', '真2'], { guesses: [1, 0] })
  assert.equal(half.score, 0.5)
  assert.equal(half.hits, 1)
  assert.equal(half.total, 2)
  // 裁判漏答 → 从严记 0
  const missing = scoreBlindTest(['真1', '真2'], { guesses: [1] })
  assert.equal(missing.score, 0.5)
  // 全对 ≈ 裁判全识破（学得差）；全错 = 裁判全被骗（学得好）
  assert.equal(scoreBlindTest(['a', 'b'], { guesses: [1, 1] }).score, 1)
  assert.equal(scoreBlindTest(['a', 'b'], { guesses: [0, 0] }).score, 0)
  // 空输入
  assert.equal(scoreBlindTest([], { guesses: [] }).score, null)
  // 坏回包
  assert.equal(scoreBlindTest(['a'], '我不知道').hits, 0)
})

test('评分：认 ```json 围栏回包', () => {
  const r = scoreBlindTest(['a', 'b'], '```json\n{"guesses":[0,1]}\n```')
  assert.equal(r.score, 0.5)
})
