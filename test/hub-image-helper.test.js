// 辅助看图模型必须真的接到当前聊天主链路上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const core = readFileSync(join(ROOT, 'src/host/modular-core.js'), 'utf8')
const vision = readFileSync(join(ROOT, 'src/chat/inbound-vision.js'), 'utf8')

test('共享视觉服务直接使用 describeWithHelper，不在核心重复造轮子', () => {
  const importLine = vision.split('\n').find((x) => x.includes("from '../core/llm.js'")) || ''
  assert.ok(importLine.includes('describeWithHelper'), '必须从 llm.js 导入 describeWithHelper，实际：' + importLine)
  assert.match(vision, /describeWithHelper\(dsh,/)
  assert.match(vision, /别当成你亲眼见过/, '转述必须带来源标注')
})

test('当前核心把私聊和群聊内容统一交给共享视觉服务', () => {
  assert.match(core, /const admitContent = \(content, context\) => inboundVision\.admit\(content, context\)/)
  assert.match(core, /const admitted = await admitContent\(content,/)
  assert.match(core, /const admittedSteer = await admitContent\(steerContent,/)
})

test('视觉服务返回的内容块进入当前回合，不走旧 imageTextFor 旁路', () => {
  assert.match(core, /content: admitted/)
  assert.doesNotMatch(core, /function imageTextFor|async function addGroupImages/)
})
