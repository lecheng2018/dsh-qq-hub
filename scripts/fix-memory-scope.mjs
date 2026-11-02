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

// 推不出作用域时的兜底：落到主人私聊。
// 注意：新代码里「无 scope 的条目对任何人都不可见」（scopeVisible 里明确 return false），
// 所以这里不兜底的话，这些老记忆会静默消失 —— 既不是 global，也不是任何人的。
// 按「宁可少给，不可多给」的原则，认不出来源的一律先留在主人私聊，需要时再手动放出去。
const OWNER_QQ = String(process.env.OWNER_QQ || '444555666')
const FALLBACK = 'private:' + OWNER_QQ

const noScope = items.filter((m) => !m.scope)
console.log('无 scope 的老条目：' + noScope.length)

const buckets = {}
let fixable = 0
for (const m of noScope) {
  const sc = scopeFromChatId(m.chatId)
  if (sc) fixable++
  const k = sc || ('(' + FALLBACK + ' ← 推不出，落到主人私聊)' + (m.chatId ? ' chatId=' + m.chatId : ''))
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

console.log('\n按 chatId 能还原：' + fixable + ' 条；推不出、落到 ' + FALLBACK + '：' + (noScope.length - fixable) + ' 条')
if (noScope.length > fixable) {
  console.log('（这些条目在修复后的代码里本来会对所有人不可见，兜底后只留在主人私聊，不会漏到群里）')
}

// ---------------- 人物小档案（profiles）也需要按作用域归档 ----------------
// 之前的漏洞：小档案只按 QQ 号存一份，私聊里聊出来的「兜里只有十块钱」这类私事
// 会被 group:xxx 的会话通过 profileOf(qq) 读到 —— 这就是群里答出私聊猫名的真正原因。
// 现在档案键是 "qq@scope"。下面把老的无作用域档案体检出来，让你决定怎么处理。

const profItems = s.profiles && typeof s.profiles === 'object' ? s.profiles : {}
const oldProfs = Object.entries(profItems).filter(([k, p]) => !p || !p.scope)
console.log('')
console.log('人物小档案：共 ' + Object.keys(profItems).length + ' 份，其中无作用域（老格式）：' + oldProfs.length + ' 份')
for (const [k, p] of oldProfs) {
  const t = String((p && p.text) || '').slice(0, 60)
  console.log('  · qq=' + k + '  ' + t + ((p && p.text && p.text.length > 60) ? '…' : ''))
  console.log('      私聊里攒的档案如果含私事，建议改成 private:<QQ>；只在群里了解的，改成 group:<群号>；')
  console.log('      确实谁都能知道的（比如「主人」是他本人这种），保持 global。')
}
if (oldProfs.length) {
  console.log('')
  console.log('提示：这些老档案现在按 global 处理，仍然哪里都能读到。')
  console.log('      要收紧，可以把对应条目手动改成：')
  for (const [k] of oldProfs) {
    console.log('        "profiles": { "' + k + '@private:<该QQ>": { ... } }')
  }
}


// --write 时把无作用域的老档案迁到 private:<QQ>（最保守：私聊攒的私事先只留在私聊）
if (WRITE && oldProfs.length) {
  for (const [k, p] of oldProfs) {
    const qq = String((p && p.qq) || k).split('@')[0]
    const newKey = qq + '@private:' + qq
    profItems[newKey] = { ...p, qq, scope: 'private:' + qq }
    delete profItems[k]
  }
  console.log('   → 已把 ' + oldProfs.length + ' 份老档案迁到 private:<QQ>（群里不再读得到）')
}

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
  // 推不出来源也要落一个明确的作用域，否则这些记忆等于被静默丢弃
  m.scope = scopeFromChatId(m.chatId) || FALLBACK
  n++
}
s.profiles = profItems
s.rev = (s.rev || 0) + 1
writeFileSync(FILE, JSON.stringify(s, null, 2), 'utf8')
console.log('已归档 ' + n + ' 条（其中来源不明、落到 ' + FALLBACK + ' 的见上方分布）。重启 DSH 后生效。')
