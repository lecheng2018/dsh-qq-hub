#!/usr/bin/env node
// 一次性修复：把历史「无 scope」的记忆按来源重新归档到正确作用域。
//
// 背景：修好记忆隔离之前，私聊里记的事（比如「主人的猫叫粥粥」）存进老库时没有 scope，
// 现在一律按 global 处理，所以群里仍然能被检索到。这个脚本把老条目按它的 chatId 还原作用域。
//
// 用法：
//   node scripts/fix-memory-scope.mjs           # 只体检，不写盘
//   node scripts/fix-memory-scope.mjs --write   # 真的写盘（会先备份）

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const BASE = process.env.AURABOT_DATA_DIR || join(DSH_HOME, 'plugins-data', 'aurabot')
// 记忆库文件名是 memories.json（见 src/features/memory.js 的 dataDir('memories.json')）。
// 留个兜底：老版本可能叫 memory.json，两个都探一下。
const CANDIDATES = [join(BASE, 'memories.json'), join(BASE, 'memory.json')]
const FILE = CANDIDATES.find((f) => existsSync(f)) || CANDIDATES[0]
const WRITE = process.argv.includes('--write')

if (!existsSync(FILE)) {
  console.error('找不到记忆文件，试过：')
  for (const f of CANDIDATES) console.error('  ' + f)
  console.error('如果 DSH 用的不是这个 HOME，请指定：DSH_HOME=/实际路径 node scripts/fix-memory-scope.mjs')
  process.exit(1)
}

const raw = readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '')
const s = JSON.parse(raw)
const items = Array.isArray(s.items) ? s.items : []
console.log('记忆文件：' + FILE)
console.log('总条数：' + items.length)

// chatId 形如 private:123456 / group:789012 / system:xxx
function scopeFromChatId(chatId) {
  const id = String(chatId || '')
  if (id.startsWith('private:') || id.startsWith('group:')) return id
  return null
}

const noScope = items.filter((m) => !m.scope)
console.log('无 scope 的老条目：' + noScope.length)

const buckets = {}
let fixable = 0
for (const m of noScope) {
  const sc = scopeFromChatId(m.chatId)
  if (sc) fixable++
  const k = sc || ('(推不出，保持 global: ' + (m.chatId || '无 chatId') + ')')
  if (!buckets[k]) buckets[k] = []
  buckets[k].push(m)
}

console.log('\n按 chatId 还原后的分布：')
for (const [k, list] of Object.entries(buckets)) {
  console.log('  ' + k + '  ' + list.length + ' 条')
  for (const m of list.slice(0, 5)) {
    const t = String(m.text || '').slice(0, 50)
    console.log('      · ' + t + (m.text && m.text.length > 50 ? '…' : ''))
  }
  if (list.length > 5) console.log('      … 还有 ' + (list.length - 5) + ' 条')
}

console.log('\n可自动归档：' + fixable + ' 条；推不出作用域（保持 global）：' + (noScope.length - fixable) + ' 条')

if (!WRITE) {
  console.log('\n这是体检模式，没有改任何东西。确认无误后加 --write 执行。')
  process.exit(0)
}

const bak = FILE + '.bak-' + Date.now()
copyFileSync(FILE, bak)
console.log('\n已备份到：' + bak)

let n = 0
for (const m of items) {
  if (m.scope) continue
  const sc = scopeFromChatId(m.chatId)
  if (!sc) continue
  m.scope = sc
  n++
}
s.rev = (s.rev || 0) + 1
writeFileSync(FILE, JSON.stringify(s, null, 2), 'utf8')
console.log('已归档 ' + n + ' 条。重启 DSH 后生效。')
