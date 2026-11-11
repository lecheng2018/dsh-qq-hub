import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, utimesSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { openMemoryFiles, scopeToFilePath, MAX_SCOPE_FILE_BYTES } from '../src/features/memory-files.js'
import { serializeMarkdownArchive } from '../src/features/memory-markdown.js'

const quiet = { warn() {}, error() {} }
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-safety-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'private/1/memory.md')
  mkdirSync(dirname(file), { recursive: true })
  const raw = serializeMarkdownArchive({ meta: { scope: 'private:1' }, entries: [{ id: 'a', text: '秘密', at: 1 }] })
  writeFileSync(file, raw)
  return { dir, file, raw, open: () => openMemoryFiles(dir, { log: quiet }) }
}

for (const damage of ['unclosed', 'duplicate', 'scope']) {
  test(`memory safety: ${damage} 档案隔离且拒绝覆盖，健康 scope 仍可写`, (t) => {
    const { dir, file, raw, open } = fixture(t)
    const broken = damage === 'unclosed' ? raw.replace('<!-- /qqhub:entry -->', '')
      : damage === 'duplicate' ? raw + raw.slice(raw.indexOf('<!-- qqhub:entry'))
        : raw.replace('scope: private:1', 'scope: global')
    writeFileSync(file, broken)
    const store = open()
    assert.equal(store.load().items.length, 0)
    assert.equal(store.health().brokenScopes.length, 1)
    store.save({ items: [{ id: 'safe', text: '群聊', scope: 'group:2' }] })
    assert.throws(() => store.save({ ...store.load(), items: [{ id: 'x', text: '覆盖', scope: 'private:1' }] }), /档案|重载/)
    assert.equal(readFileSync(file, 'utf8'), broken)
    assert.ok(existsSync(join(dir, 'group/2/memory.md')))
    store.close()
  })
}

for (const operation of ['update', 'delete', 'missing']) {
  test(`memory safety: ${operation} 校验原文而非时间戳，先预检再写正文或进度`, (t) => {
    const { dir, file, raw, open } = fixture(t)
    const store = open()
    const state = store.load()
    const stat = statSync(file)
    if (operation === 'missing') rmSync(file)
    else {
      writeFileSync(file, raw + '\n手写备注\n')
      utimesSync(file, stat.atime, stat.mtime)
    }
    state.items = operation === 'delete' ? [] : state.items.map((it) => ({ ...it, text: '更新' }))
    state.items.unshift({ id: 'g', text: '另一 scope 不应先写', scope: 'global' })
    state.processed.today = 100
    assert.throws(() => store.save(state), /外部|重载/)
    assert.equal(existsSync(join(dir, 'global/memory.md')), false)
    assert.equal(existsSync(join(dir, 'state.json')), false)
    assert.deepEqual(store.load().processed, {})
    if (operation !== 'missing') assert.equal(readFileSync(file, 'utf8'), raw + '\n手写备注\n')
    store.close()
  })
}

test('memory safety: 超限正文不推进磁盘或内存进度', (t) => {
  const { dir, open } = fixture(t)
  const store = open()
  const state = store.load()
  state.processed.today = 99
  state.items.push({ id: 'huge', scope: 'global', text: 'A'.repeat(MAX_SCOPE_FILE_BYTES + 1) })
  assert.throws(() => store.save(state), /超限/)
  assert.deepEqual(store.load().processed, {})
  assert.equal(existsSync(join(dir, 'state.json')), false)
  store.close()
})

test('memory safety: 损坏状态从备份恢复并保留坏原件；不可恢复则拒写直到修复重载', (t) => {
  const { dir, open } = fixture(t)
  const stateFile = join(dir, 'state.json')
  let store = open()
  store.save({ ...store.load(), processed: { today: 12 } })
  store.close()
  writeFileSync(stateFile, '{坏状态')
  store = open()
  assert.deepEqual(store.load().processed, { today: 12 })
  assert.ok(readdirSync(dir).some((p) => p.startsWith('state.json.corrupt-')))
  store.close()
  writeFileSync(stateFile, '{坏状态')
  writeFileSync(`${stateFile}.bak`, '{坏备份')
  store = open()
  assert.ok(store.health().stateError)
  assert.throws(() => store.save(store.load()), /状态/)
  store.reload()
  assert.ok(store.health().stateError, '重载不能把隔离后的损坏误当新安装')
  writeFileSync(stateFile, JSON.stringify({ version: 1, processed: { today: 12 } }))
  store.reload()
  assert.equal(store.health().stateError, null)
  assert.deepEqual(store.load().processed, { today: 12 })
  store.close()
})

test('memory safety: 无 scope 条目不得提升为 global', (t) => {
  const { open } = fixture(t)
  const store = open()
  assert.throws(() => store.save({ items: [{ id: 'unknown', text: '秘密' }] }), /scope|作用域/)
  store.close()
})

test('memory safety: reload 清理故障并读入外部正文与状态', (t) => {
  const { dir, file, raw, open } = fixture(t)
  writeFileSync(file, raw.replace('<!-- /qqhub:entry -->', ''))
  const store = open()
  writeFileSync(file, raw)
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ processed: { today: 4 } }))
  store.reload()
  assert.equal(store.health().brokenScopes.length, 0)
  assert.equal(store.load().items[0].text, '秘密')
  assert.deepEqual(store.load().processed, { today: 4 })
  store.close()
})

test('memory safety: 点路径标识不得折叠作用域目录', () => {
  for (const scope of ['private:.', 'group:..', '.', '..']) assert.throws(() => scopeToFilePath(scope), /作用域/)
})

test('memory safety: 删除最后一条记忆仍保留人工备注', (t) => {
  const { file, raw, open } = fixture(t)
  writeFileSync(file, raw + '\n人工备注：此处不能随条目被删除。\n')
  const store = open()
  store.save({ ...store.load(), items: [] })
  assert.match(readFileSync(file, 'utf8'), /人工备注：此处不能随条目被删除/)
  assert.equal(store.load().items.length, 0)
  store.close()
})
