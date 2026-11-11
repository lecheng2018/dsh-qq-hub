// 回归（2026-11-05 复盘 #2/#3/#4/#5）：提取门槛、全量分段提炼、主人换号迁移、召回负反馈。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MEM = readFileSync(join(ROOT, 'src/features/memory.js'), 'utf8')
const MOD = readFileSync(join(ROOT, 'src/modules/memory/index.js'), 'utf8')
const TG = readFileSync(join(ROOT, 'src/modules/token-guardian/index.js'), 'utf8')
const SQL = readFileSync(join(ROOT, 'src/features/memory-sqlite.js'), 'utf8')
const CLIENT = readFileSync(join(ROOT, 'client/client.js'), 'utf8')

test('#2 提取门槛：3 行不再触发，纯寒暄不进模型', () => {
  assert.match(MEM, /isQzone \? 1 : 6/, '行数阈值 3 → 6')
  assert.match(MEM, /都是寒暄，没什么可记/, '纯寒暄快筛直接跳过')
  assert.match(MEM, /substantive\.length === 0/, '快筛条件')
})

test('#3 长对话全量分段提炼，不再把整日记为成功却只处理最后 640 行', () => {
  assert.match(MEM, /for \(const part of chunks\)/, '所有批次都处理')
  assert.doesNotMatch(MEM, /chunks\.slice\(-\d+\)/, '不再静默截去旧批次')
})

test('#4 主人换号迁移：scope/about 一起搬，面板有入口', () => {
  assert.match(MEM, /function reassignOwner\(/, 'memory 有 reassignOwner')
  assert.match(MEM, /reassignOwner,/, '导出')
  assert.match(MOD, /\/memory\/reassign-owner/, '路由')
  assert.match(CLIENT, /主人换号迁移/, '面板入口')
  // P1-12 后不再有 hash 快跳过：save() 走 eqCols 全字段比较，scope/chatId/about 变化必然落库
  assert.match(SQL, /eqCols\(old, it\)\) continue/, 'save 走全字段比较')
  assert.doesNotMatch(SQL, /savedHash\.get\(it\.id\) === h/, '不允许 hash 快跳过（会漏冷字段）')
})

test('#5 召回负反馈：说「记错了」降权最近注入的记忆', () => {
  assert.match(MEM, /function reportMiss\(/, 'memory 有 reportMiss')
  assert.match(MEM, /before \* 0\.8/, '降权 8 折')
  assert.match(MOD, /api\.on\('activity'[^]*?reportMiss/s, '挂进 in 消息')
})

test('#6 估算系数：中文 1 字 ≈ 1.4 token，不再 chars/1.2 低估三成', () => {
  assert.match(TG, /CHARS_TO_TOKEN = 1\.4/)
  assert.doesNotMatch(TG, /\/ 1\.2/, '旧的 chars/1.2 已清除')
})

test('迁移真实落库（SQLite 往返）', async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'mem-mig-'))
  const { createMemoryStore } = await import('../src/features/memory.js')
  const store = createMemoryStore({ dsh: {}, getConfig: () => ({ memory: { enabled: true, recallCount: 4 } }), log: console, personaText: () => '' })
  store.add({ text: '主人不吃香菜', about: '100011', aboutName: '老号', importance: 0.7, source: 'panel', chatId: 'private:100011', scope: 'private:100011' })
  store.add({ text: '小明喜欢养鱼', about: '200022', importance: 0.5, source: 'auto', chatId: 'group:1', scope: 'group:1' })
  const r = store.reassignOwner('100011', '999999')
  assert.equal(r.ok, true)
  const items = store.list('')
  const moved = items.find((m) => m.text === '主人不吃香菜')
  assert.equal(moved.scope, 'private:999999', '作用域搬过去')
  assert.equal(moved.about, '999999', '关于谁也改')
  const untouched = items.find((m) => m.text === '小明喜欢养鱼')
  assert.equal(untouched.scope, 'group:1', '别的记忆不动')
})
