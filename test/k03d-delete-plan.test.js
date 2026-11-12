import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const legacyOnly = [
  'src/chat/hub.js',
  'src/host/pipeline.js',
  'src/kernel/legacy-fallback.js',
  'src/features/memory-sqlite.js',
  'src/kernel/compose.js',
  'src/kernel/context.js',
  'src/kernel/ctx-store.js',
  'src/kernel/dispatcher.js',
  'src/kernel/mw-acl.js',
  'src/kernel/mw-aggregator.js',
  'src/kernel/mw-command-router.js',
  'src/kernel/mw-dedup.js',
  'src/kernel/mw-egress.js',
  'src/kernel/mw-egress-cutover.js',
  'src/kernel/mw-memory.js',
  'src/kernel/mw-persona.js',
]
const currentRequired = [
  'src/host/current-hub.js',
  'src/kernel/mw-ratelimit.js',
  'src/kernel/mw-tracing.js',
  'src/kernel/modular-contracts.js',
  'src/chat/system-turns.js',
  'src/chat/turn-participants.js',
]

function productionImports(entry) {
  const seen = new Set()
  const visit = (file) => {
    const absolute = resolve(ROOT, file)
    if (seen.has(absolute)) return
    seen.add(absolute)
    const source = readFileSync(absolute, 'utf8')
    const imports = []
    for (const match of source.matchAll(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/gm)) imports.push(match[1])
    for (const match of source.matchAll(/^\s*export\s+[^'"]+\s+from\s+['"]([^'"]+)['"]/gm)) imports.push(match[1])
    for (const specifier of imports) {
      if (!specifier.startsWith('.')) continue
      const next = resolve(dirname(absolute), specifier)
      if (!next.endsWith('.js')) continue
      visit(next)
    }
  }
  visit(entry)
  return new Set([...seen].map((file) => file.slice(ROOT.length + 1).replaceAll('\\', '/')))
}

test('K-03D 删除候选不在生产依赖图中，当前共享依赖不得误删', () => {
  const graph = productionImports('src/host.js')
  for (const file of legacyOnly) assert.equal(graph.has(file), false, `${file} 仍被生产入口引用，不能直接删除`)
  for (const file of currentRequired) assert.equal(graph.has(file), true, `${file} 是当前生产依赖，禁止随旧实现误删`)
})
