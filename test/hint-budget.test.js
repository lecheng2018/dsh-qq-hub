// 记忆注入预算（2026-11-05）：以前写死 4 条 300 字、超出直接 slice 加省略号，
// 一条 165 字的记忆被从中间切断，她读到的就是半句话。改成按条收 + 按句边界截。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'src/features/memory-archive.js'), 'utf8')
const EXTRACTOR = readFileSync(join(ROOT, 'src/features/memory-extractor.js'), 'utf8')
const CFG = readFileSync(join(ROOT, 'src/core/config.js'), 'utf8')

test('单条记忆超长的截法：在句读处收，不从半句中间断', async () => {
  const { cutAtSentence } = await import('../src/features/memory.js')
  const long = '小明不吃香菜，上次点菜挑了十分钟。他还说过外卖备注一定要写清楚，不然店家会放葱花。再往后就记不清了，反正是这么个事。'
  const cut = cutAtSentence(long, 40)
  assert.ok(cut.length <= 41, '不许超出上限太多：' + cut.length)
  assert.match(cut, /[。，]$/, '要在句读处收尾：' + cut)
  assert.equal(cutAtSentence('短句', 40), '短句', '不超长原样返回')
  assert.match(cutAtSentence('没有任何句读的一长串字符'.repeat(6), 30), /…$/, '实在没句读才省略号')
})

test('注入预算按条收，不按字腰斩', () => {
  assert.match(SRC, /hintCount/, '条数可配')
  assert.match(SRC, /hintMaxChars/, '字数可配')
  assert.match(SRC, /lines\.join\('\\n'\)/, '一条一行，不再用分号压成一大坨')
  assert.doesNotMatch(SRC, /body\.slice\(0, 300\)/, '旧的 300 字腰斩必须删掉')
  assert.doesNotMatch(SRC, /memoryLine\(h\.it\)\)\.join\('；'\)/, '记忆正文不再用「；」压成一大坨')
  assert.match(SRC, /if \(lines\.length && used \+ line\.length \+ 1 > maxChars\) break/, '放不下就少放一条，不切半句')
})

test('配置默认值与夹值', async () => {
  const { normalize } = await import('../src/core/config.js')
  const a = normalize({})
  assert.equal(a.memory.hintCount, 8)
  assert.equal(a.memory.hintMaxChars, 600)
  const b = normalize({ memory: { hintCount: 99, hintMaxChars: 5 } })
  assert.equal(b.memory.hintCount, 20)
  assert.equal(b.memory.hintMaxChars, 120)
  assert.match(CFG, /hintCount: 8/, '默认值写在 config.js 里，面板能看到')
})

test('提炼提示词：知识要记、要说清是谁说的、不要字段标签', () => {
  assert.match(EXTRACTOR, /从看过的内容里学到的可复用知识/, '学到的知识要记')
  assert.match(EXTRACTOR, /不记「今天看了什么」这种浏览流水/, '浏览流水不记')
  assert.match(EXTRACTOR, /要说清是谁说的、关于谁/, '记住是谁说的')
  assert.doesNotMatch(EXTRACTOR, /每条记忆必须写成一行，格式固定/, '不许再教它按字段格式写记忆')
  assert.doesNotMatch(EXTRACTOR, /对象\.方面：gist=/, '不许把 gist/detail/why 当正例')
})
