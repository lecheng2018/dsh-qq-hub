// 回归（P1-4）：面板里编辑人设正文后，正在用它的会话要重置。
// 静态前缀 {{qq_hub_persona}} 建会话时固化，光改文件旧会话拿不到新正文；
// 不重置的话新旧两段人设在历史里打架（与 P0-5 切人设同根因）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// host.js 分层拆分后：人格路由在 panel/routes-persona.js，/save 在 panel/routes-config.js
const HOST = readFileSync(join(ROOT, 'src/host/panel/routes-persona.js'), 'utf8')
const SAVE = readFileSync(join(ROOT, 'src/host/panel/routes-config.js'), 'utf8')
const HUB = readFileSync(join(ROOT, 'src/host/modular-core.js'), 'utf8')

test('/persona/save 后重置所有正在用该人设的会话', () => {
  assert.match(HOST, /entry\.personaId === p\.id/, '按 personaId 找会话')
  assert.match(HOST, /hub\.resetChat\(chatId\)/, '重置会话')
  assert.match(HOST, /reset > 0 [^]*个正在用的会话已重置|个正在用的会话已重置/, '返回消息说明重置了几个')
})

test('当前核心导出 sessions()、resetChat 与统一的人设变更重置入口（host 能拿到）', () => {
  assert.match(HUB, /const sessions = \(\) => Object\.fromEntries/, 'sessions 导出')
  assert.match(HUB, /    resetChat,/, 'resetChat 导出')
  assert.match(HUB, /    resetChatsForPersonaChange,/, '人设变更重置入口必须导出（面板两条路由共用）')
})

test('/persona/use 切换人设后立刻重置用旧全局人设的会话', () => {
  assert.match(HOST, /route\('\/persona\/use'[^]*?resetChatsForPersonaChange/s, 'use 路由里要重置会话')
  const seg = HOST.slice(HOST.indexOf("route('/persona/use'"), HOST.indexOf("route('/persona/polish'"))
  assert.match(seg, /hub\.resetChatsForPersonaChange/, 'use 路由内触发重置')
  // 必须先留旧配置快照再改配置：重置判定要拿「旧预期人设 vs 新预期人设」，
  // 拿改过的 current 去比会话里的 personaId 会两边都错（2026-11-15 真机「切卡没反应」）。
  assert.match(seg, /const before = getConfig\(\)/, '改配置前先快照')
  assert.ok(seg.indexOf('const before = getConfig()') < seg.indexOf('setConfig('), '快照必须在 setConfig 之前')
})

test('/save 改人设配置（分流表/全局）后重置受影响会话', () => {
  const seg = SAVE.slice(SAVE.indexOf("route('/save'"), SAVE.indexOf("route('/save'", SAVE.indexOf("route('/save'") + 10))
  assert.match(seg, /personaChanged/, '比对 persona 前后差异')
  // 判定口径已统一到核心侧：按「旧配置预期人设 vs 新配置预期人设」逐聊天算，
  // 不再用 entry.personaId（建会话那一刻的快照，改默认值不会动 → 必然漏判）。
  assert.match(seg, /resetChatsForPersonaChange/, '交给核心统一判定并重置')
  assert.match(seg, /before/, '把改动前的配置传进去')
})

test('当前会话恢复对没记 personaId 的老会话补基线不误重置（同时补正文指纹）', () => {
  assert.match(HUB, /const personaId = entry\.personaId \|\| currentPersona\(chatKey\)/, '空 personaId 使用当前人设作为恢复基线')
  // 老映射没有 personaHash：id 和现在这张卡一致时，把当前指纹当基线、**不 churn**
  // （升级不该把全部会话一次性重建），但标 assumed；自检里如实说这版正文无法确认。
  // id 和现在不一致时指纹留空，守卫按 id 差异重建。
  assert.match(HUB, /personaHash: entry\.personaHash \|\| \(sameId \? want\.hash : ''\)/, '缺指纹的老映射按 id 是否一致决定基线')
  assert.match(HUB, /personaHashAssumed: !entry\.personaHash && sameId/, '基线是猜的要标 assumed，自检不能当已知')
})
