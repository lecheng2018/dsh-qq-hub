// token-guardian 的压缩正确性（2026-11-05 排查后修复）：
//   P0-1 连续压缩丢摘要：recentTranscript 只拼 chatlog，第二次压缩会把第一份摘要摘掉的那段彻底丢掉。
//   P0-2 摘要 7 天过期后失忆：过期只影响 api.context 注入，chatlog 里没有任何东西能重建它。
//   P0-3 compact 没有并发锁：30 秒轮询 + 面板手动按钮，同一聊天可能双压缩双摘要。
// 修法：压缩输入带上旧摘要、摘要写回 chatlog（who='bot'，带【更早聊天的摘要】标记）、per-chatId 锁。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const TG = src('src/modules/token-guardian/index.js')

test('P0-1 压缩输入带上上一份摘要，原文吃剩下的预算', () => {
  assert.match(TG, /const prev = summaries\[chatId\]/, '先取旧摘要')
  assert.match(TG, /【更早聊天的摘要（/, '摘要头进输入')
  assert.match(TG, /Math\.max\(2000, maxChars - head\.length\)/, '原文用剩余预算，总输入不涨')
})

test('P0-2 摘要写回 chatlog（who=bot），老摘要不会被二次提炼', () => {
  assert.match(TG, /api\.core\.chatLog\.append\(chatId, 'bot', `【更早聊天的摘要/, '压缩成功后写回共享流水')
  assert.ok(TG.indexOf('if (!resetOk)') < TG.indexOf('api.core.chatLog.append'), '只在会话真的换了之后才写')
  const extractor = src('src/features/memory-extractor.js')
  assert.match(extractor, /\/\^【更早聊天的摘要\/\.test\(String\(line\.text \|\| ''\)\)\) continue/, '每日整理跳过摘要行')
})

test('P0-3 per-chatId 并发锁：同一个聊天不会双压缩，不同聊天互不挡', () => {
  assert.match(TG, /const compactBusy = new Set\(\)/)
  assert.match(TG, /compactBusy\.has\(chatId\)/, '重复请求直接拒绝')
  assert.match(TG, /finally \{[\s\S]*?compactBusy\.delete\(chatId\)/, '失败也要放锁')
  // 外层 compact 包内层 doCompact：入口统一走锁
  assert.match(TG, /return await doCompact\(sessionKey, chat, meta\)/)
})

test('P2 no-reset 用短冷却（约 10 分钟），成功与打满模型的失败才吃完整冷却', () => {
  assert.match(TG, /Date\.now\(\) - \(Number\(cfg\.cooldownMinutes\) \* 60_000 - 10 \* 60_000\)/, '把 lastCompactAt 往前拨，等效 10 分钟')
})

test('P2 空闲判定感知 in-flight：她正忙时不压', () => {
  assert.match(TG, /hub\.isBusy\?\.\(chatId\)/)
  // 1.3.57 状态重构后 isBusy 委托给 activity-state（卡住保护只有一处实现）
  assert.match(src('src/chat/hub.js'), /isBusy: \(chatId\) => activity\.isBusy\(chatId\)/, 'hub 要把 isBusy 导出给模块')
  assert.match(src('src/chat/activity-state.js'), /BUSY_MAX_MS/, '卡住保护在 activity-state')
})

test('P2 摘要指令带合并约束（对齐 checkpoint 口径）', () => {
  assert.match(TG, /保留仍然成立的事实、丢掉已经过时的/)
  assert.match(TG, /最后一条用户发言按原意保留/)
  assert.match(TG, /整段连贯的文字，不要 Markdown 列表/)
})
