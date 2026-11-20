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
  // 核心只有一处把内容交给共享视觉服务（inboundVision.admit），群/私聊两条路都走它。
  // 中间多了一层「图片进历史的预算」闸（feat/image-history-budget）：超额度时先裁图再交给
  // 共享服务 —— 断言因此从「一行箭头函数」改成「包装函数里仍然只调一次 admit」，
  // 语义不变：核心不自己实现登记/降级，只决定「这一轮带几张图进去」。
  assert.match(core, /const admitContent = async \(content, context = \{\}\) =>/)
  assert.equal((core.match(/inboundVision\.admit\(/g) || []).length, 1, '核心只允许一处调用共享视觉服务')
  assert.match(core, /inboundVision\.admit\(trimmed, context\)/)
  assert.match(core, /trimToImageBudget\(/)
  assert.match(core, /const admitted = await admitContent\(content,/)
  assert.match(core, /const admittedSteer = await admitContent\(steerContent,/)
  // 两条路都要带 sessionId：图片额度是按会话累加的，缺了就等于没管
  assert.match(core, /const admitted = await admitContent\(content,[\s\S]{0,240}sessionId,/)
  assert.match(core, /const admittedSteer = await admitContent\(steerContent,[\s\S]{0,240}sessionId,/)
})

test('视觉服务返回的内容块进入当前回合，不走旧 imageTextFor 旁路', () => {
  assert.match(core, /content: admitted/)
  assert.doesNotMatch(core, /function imageTextFor|async function addGroupImages/)
})
