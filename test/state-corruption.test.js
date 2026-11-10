import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

import { createSessionFileStore } from '../src/chat/session-store.js'
import { createSessionRegistry } from '../src/chat/session-registry.js'
import { createDeliveryLedger } from '../src/chat/delivery-ledger.js'
import { createOutbox } from '../src/chat/outbox.js'

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('session store：主 JSON 截断时从 .bak 恢复并修复主文件，只告警一次', () => {
  const dir = tempDir('state-corruption-session-')
  const file = join(dir, 'sessions.json')
  const backup = { version: 1, chats: { 'group:77': { sessionId: 'session-safe' } } }
  const warnings = []
  try {
    writeFileSync(file, '{"version":1,"chats":')
    writeFileSync(`${file}.bak`, JSON.stringify(backup))
    const store = createSessionFileStore({ file, onError: (error) => warnings.push(error.message) })

    assert.deepEqual(store.load(), backup.chats)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), backup)
    assert.equal(warnings.length, 1)
    assert.deepEqual(store.load(), backup.chats)
    assert.equal(warnings.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('delivery ledger：损坏主文件从 .bak 恢复，sending 仍转 unknown 且不重放', () => {
  const dir = tempDir('state-corruption-ledger-')
  const file = join(dir, 'deliveries.json')
  const backup = {
    version: 1,
    deliveries: [
      { deliveryId: 'sending-safe', chatKey: 'private:1', state: 'sending', attemptCount: 1, segments: [] },
      { deliveryId: 'queued-safe', chatKey: 'private:1', state: 'queued', attemptCount: 0, segments: [] },
    ],
  }
  const warnings = []
  try {
    writeFileSync(file, '{ truncated')
    writeFileSync(`${file}.bak`, JSON.stringify(backup))
    const ledger = createDeliveryLedger({ file, onError: (error) => warnings.push(error.message) })

    assert.equal(ledger.get('sending-safe').state, 'unknown')
    assert.match(ledger.get('sending-safe').unknownReason, /crash-recovery/)
    assert.equal(ledger.get('queued-safe').state, 'unknown', '备份可能落后，不能断言还没有发送')
    assert.match(ledger.get('queued-safe').unknownReason, /backup|备份/)
    assert.equal(ledger.queuedFor('private:1').length, 0)
    assert.equal(ledger.stats().crashedSending, 1)
    assert.ok(warnings.length >= 1)
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(new Map(persisted.deliveries.map((record) => [record.deliveryId, record.state])), new Map([
      ['sending-safe', 'unknown'],
      ['queued-safe', 'unknown'],
    ]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sticker index：损坏主 JSON 从 .bak 恢复、修复主文件并明确告警', async () => {
  const dir = tempDir('state-corruption-stickers-')
  const previousDataDir = process.env.DSH_QQ_HUB_DATA_DIR
  const previousLegacyDataDir = process.env.AURABOT_DATA_DIR
  const warnings = []
  const originalWarn = console.warn
  const file = join(dir, 'stickers', 'index.json')
  const backup = { items: [{ md5: 'safe-md5', file: 'safe.png', name: '备份表情', tags: [] }] }
  try {
    process.env.DSH_QQ_HUB_DATA_DIR = dir
    delete process.env.AURABOT_DATA_DIR
    console.warn = (...args) => warnings.push(args.join(' '))
    mkdirSync(join(dir, 'stickers'), { recursive: true })
    writeFileSync(file, '{"items":[', { flag: 'w' })
    writeFileSync(`${file}.bak`, JSON.stringify(backup))
    const { loadLibrary } = await import('../src/features/stickers.js')

    assert.deepEqual(loadLibrary(), backup)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), backup)
    assert.ok(warnings.length >= 1)
    assert.match(warnings[0], /表情|恢复|损坏|backup|bak/i)
    const warningCount = warnings.length
    assert.deepEqual(loadLibrary(), backup)
    assert.equal(warnings.length, warningCount)
  } finally {
    console.warn = originalWarn
    if (previousDataDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previousDataDir
    if (previousLegacyDataDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previousLegacyDataDir
    rmSync(dir, { recursive: true, force: true })
  }
})

function archivedContent(dir, file) {
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${basename(file)}.corrupt-`))
    .map((name) => readFileSync(join(dir, name), 'utf8'))
}

test('session store：无有效备份时空映射启动，告警并留存损坏主文件', async () => {
  const dir = tempDir('state-corruption-session-empty-')
  const file = join(dir, 'sessions.json')
  const warnings = []
  try {
    writeFileSync(file, '{broken-session')
    writeFileSync(`${file}.bak`, '{broken-backup')
    const store = createSessionFileStore({ file, onError: (error) => warnings.push(error.message) })
    const registry = createSessionRegistry({
      store,
      createSession: async () => ({ sessionId: 'new-session' }),
      onError: (error) => warnings.push(error.message),
    })
    assert.deepEqual(registry.snapshot(), {})
    assert.ok(warnings.length >= 1)
    assert.ok(archivedContent(dir, file).includes('{broken-session'))
    assert.ok(archivedContent(dir, `${file}.bak`).includes('{broken-backup'))
    await registry.sessionFor('private:1')
    assert.equal(store.load()['private:1'].sessionId, 'new-session')
    assert.ok(archivedContent(dir, file).includes('{broken-session'))
    await registry.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger：实际写入的备份包含关键 sending 状态，主文件损坏后不重放', () => {
  const dir = tempDir('state-corruption-ledger-mirror-')
  const file = join(dir, 'deliveries.json')
  const warnings = []
  try {
    const ledger = createDeliveryLedger({ file, onError: (error) => warnings.push(error.message) })
    ledger.enqueue({ deliveryId: 'physical-send', chatKey: 'private:1', segments: [{ type: 'text', data: { text: 'hello' } }] })
    ledger.mark('physical-send', 'sending')
    assert.equal(JSON.parse(readFileSync(`${file}.bak`, 'utf8')).deliveries[0].state, 'sending')
    writeFileSync(file, '{broken-after-sending')
    const restarted = createDeliveryLedger({ file, onError: (error) => warnings.push(error.message) })
    assert.equal(restarted.get('physical-send').state, 'unknown')
    assert.equal(restarted.queuedFor('private:1').length, 0)
    assert.throws(() => restarted.enqueue({ deliveryId: 'physical-send', chatKey: 'private:1', segments: [] }), /重复/)
    assert.ok(archivedContent(dir, file).includes('{broken-after-sending'))
    assert.ok(warnings.length >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger：备份不可写时关键落盘 fail-closed，outbox 不触发物理发送', async () => {
  const dir = tempDir('state-corruption-ledger-closed-')
  const file = join(dir, 'deliveries.json')
  let sends = 0
  const errors = []
  try {
    writeFileSync(file, JSON.stringify({ version: 1, deliveries: [] }))
    mkdirSync(`${file}.bak`)
    const ledger = createDeliveryLedger({ file, onError: (error) => errors.push(error.message) })
    const outbox = createOutbox({ ledger, send: async () => { sends++; return { messageId: 'should-not-send' } } })
    await assert.rejects(() => outbox.request({ chatKey: 'private:1', deliveryId: 'blocked', segments: [{ type: 'text', data: { text: 'x' } }] }), /fail-closed/)
    assert.equal(sends, 0)
    assert.equal(ledger.get('blocked'), null)
    assert.ok(errors.length >= 1)
    outbox.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sticker index：损坏且备份也损坏时保全两份原件，空库启动只告警一次', async () => {
  const dir = tempDir('state-corruption-stickers-empty-')
  const previousDataDir = process.env.DSH_QQ_HUB_DATA_DIR
  const warnings = []
  const originalWarn = console.warn
  const file = join(dir, 'stickers', 'index.json')
  try {
    process.env.DSH_QQ_HUB_DATA_DIR = dir
    console.warn = (...args) => warnings.push(args.join(' '))
    mkdirSync(join(dir, 'stickers'), { recursive: true })
    writeFileSync(file, '{bad-index')
    writeFileSync(`${file}.bak`, '{bad-index-backup')
    const { loadLibrary } = await import('../src/features/stickers.js')
    assert.deepEqual(loadLibrary(), { items: [] })
    assert.ok(warnings.length >= 1)
    assert.ok(archivedContent(join(dir, 'stickers'), file).includes('{bad-index'))
    assert.ok(archivedContent(join(dir, 'stickers'), `${file}.bak`).includes('{bad-index-backup'))
    const warningCount = warnings.length
    assert.deepEqual(loadLibrary(), { items: [] })
    assert.equal(warnings.length, warningCount)
  } finally {
    console.warn = originalWarn
    if (previousDataDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previousDataDir
    rmSync(dir, { recursive: true, force: true })
  }
})


test('ledger：备份恢复中途崩溃后，旧 queued 不得误判为从未发送', () => {
  const dir = tempDir('state-corruption-ledger-crash-')
  const file = join(dir, 'deliveries.json')
  const moduleUrl = new URL('../src/chat/delivery-ledger.js', import.meta.url).href
  try {
    writeFileSync(file, '{broken')
    writeFileSync(`${file}.bak`, JSON.stringify({ version: 1, deliveries: [
      { deliveryId: 'old-queued', chatKey: 'private:1', state: 'queued', attemptCount: 0, segments: [] },
    ] }))
    const code = `
      import fs from 'node:fs'
      import { syncBuiltinESMExports } from 'node:module'
      const file = process.argv[1]
      const rename = fs.renameSync
      fs.renameSync = (...args) => { rename(...args); if (args[1] === file) process.exit(0) }
      syncBuiltinESMExports()
      const { createDeliveryLedger } = await import(${JSON.stringify(moduleUrl)})
      createDeliveryLedger({ file, onError: () => {} })
      process.exit(2)
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, file], { encoding: 'utf8', timeout: 5000 })
    assert.equal(child.status, 0, child.stderr)
    const restarted = createDeliveryLedger({ file, onError: () => {} })
    assert.equal(restarted.get('old-queued').state, 'unknown')
    assert.match(restarted.get('old-queued').unknownReason, /backup|备份/)
    assert.equal(restarted.queuedFor('private:1').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger：旧备份的 failed/cancelled 也不能断言之后没有重试过', () => {
  const dir = tempDir('state-corruption-ledger-stale-')
  const file = join(dir, 'deliveries.json')
  try {
    writeFileSync(file, '{broken')
    writeFileSync(`${file}.bak`, JSON.stringify({ version: 1, deliveries: [
      { deliveryId: 'old-failed', chatKey: 'private:1', state: 'failed', segments: [] },
      { deliveryId: 'old-cancelled', chatKey: 'private:1', state: 'cancelled', segments: [] },
      { deliveryId: 'old-sent', chatKey: 'private:1', state: 'sent', segments: [] },
    ] }))
    const ledger = createDeliveryLedger({ file, onError: () => {} })
    assert.equal(ledger.get('old-failed').state, 'unknown')
    assert.equal(ledger.get('old-cancelled').state, 'unknown')
    assert.equal(ledger.get('old-sent').state, 'sent')
    assert.equal(ledger.queuedFor('private:1').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('结构错误的 JSON 不视为有效主文件，备份必须满足对应状态结构', async () => {
  const dir = tempDir('state-corruption-schema-')
  const previousDataDir = process.env.DSH_QQ_HUB_DATA_DIR
  const warnings = []
  try {
    const sessionFile = join(dir, 'sessions.json')
    writeFileSync(sessionFile, JSON.stringify({ version: 1, chats: [] }))
    writeFileSync(`${sessionFile}.bak`, JSON.stringify({ version: 1, chats: { 'group:1': { sessionId: 'valid' } } }))
    const session = createSessionFileStore({ file: sessionFile, onError: (error) => warnings.push(error.message) })
    assert.equal(session.load()['group:1'].sessionId, 'valid')

    const ledgerFile = join(dir, 'deliveries.json')
    writeFileSync(ledgerFile, JSON.stringify({ version: 1, deliveries: {} }))
    writeFileSync(`${ledgerFile}.bak`, JSON.stringify({ version: 1, deliveries: [
      { deliveryId: 'done', chatKey: 'private:1', state: 'sent', segments: [] },
    ] }))
    const ledger = createDeliveryLedger({ file: ledgerFile, onError: (error) => warnings.push(error.message) })
    assert.equal(ledger.get('done').state, 'sent')
    assert.equal(JSON.parse(readFileSync(ledgerFile, 'utf8')).deliveries[0].deliveryId, 'done')

    process.env.DSH_QQ_HUB_DATA_DIR = dir
    mkdirSync(join(dir, 'stickers'), { recursive: true })
    const stickerFile = join(dir, 'stickers', 'index.json')
    writeFileSync(stickerFile, JSON.stringify({ items: [null] }))
    writeFileSync(`${stickerFile}.bak`, JSON.stringify({ items: [{ md5: 'valid', file: 'valid.png' }] }))
    const { loadLibrary } = await import('../src/features/stickers.js')
    assert.equal(loadLibrary((error) => warnings.push(error.message)).items[0].md5, 'valid')
    assert.equal(warnings.length, 3)
  } finally {
    if (previousDataDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previousDataDir
    rmSync(dir, { recursive: true, force: true })
  }
})

test('session 与 sticker 的正常写入会生成可恢复的 .bak', async () => {
  const dir = tempDir('state-corruption-saved-backups-')
  const previousDataDir = process.env.DSH_QQ_HUB_DATA_DIR
  try {
    const file = join(dir, 'sessions.json')
    const warnings = []
    const session = createSessionFileStore({ file, onError: (error) => warnings.push(error.message) })
    session.save({ 'private:1': { sessionId: 'saved' } })
    assert.equal(JSON.parse(readFileSync(`${file}.bak`, 'utf8')).chats['private:1'].sessionId, 'saved')
    writeFileSync(file, '{bad-session')
    assert.equal(session.load()['private:1'].sessionId, 'saved')

    process.env.DSH_QQ_HUB_DATA_DIR = dir
    const { createStickerStore } = await import('../src/features/stickers.js')
    const store = createStickerStore({
      dsh: {}, getConfig: () => ({ dryRun: true, stickers: { maxLibrary: 20 } }), onebot: {},
      log: { warn: (message) => warnings.push(message), info() {}, debug() {} },
    })
    const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex')
    const result = await store.addFromBuffer(png, { name: '本地', toQQ: false })
    assert.equal(result.ok, true)
    const index = join(dir, 'stickers', 'index.json')
    assert.equal(JSON.parse(readFileSync(`${index}.bak`, 'utf8')).items[0].md5, result.item.md5)
    writeFileSync(index, '{bad-index')
    assert.equal(store.library().items[0].md5, result.item.md5)
    assert.equal(warnings.length, 2)
  } finally {
    if (previousDataDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previousDataDir
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger 无可用备份时保留损坏原件，告警并保持空库不自动发送', () => {
  const dir = tempDir('state-corruption-ledger-empty-')
  const file = join(dir, 'deliveries.json')
  const warnings = []
  try {
    writeFileSync(file, '{lost-ledger')
    writeFileSync(`${file}.bak`, '{lost-ledger-backup')
    const ledger = createDeliveryLedger({ file, onError: (error) => warnings.push(error.message) })
    assert.equal(ledger.stats().total, 0)
    assert.equal(ledger.unknowns().length, 0)
    assert.equal(ledger.queuedFor('private:1').length, 0)
    assert.ok(archivedContent(dir, file).includes('{lost-ledger'))
    assert.ok(archivedContent(dir, `${file}.bak`).includes('{lost-ledger-backup'))
    assert.match(warnings.join(' '), /历史状态可能缺失/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('ledger：sending 阶段备份落盘失败回滚状态，网关零调用', async () => {
  const dir = tempDir('state-corruption-ledger-sending-')
  const file = join(dir, 'deliveries.json')
  const warnings = []
  let sends = 0
  try {
    const ledger = createDeliveryLedger({ file, onError: (error) => warnings.push(error.message) })
    const outbox = createOutbox({
      ledger,
      authorize: async () => {
        renameSync(`${file}.bak`, `${file}.held`)
        mkdirSync(`${file}.bak`)
        return true
      },
      send: async () => { sends++; return { messageId: 'should-not-send' } },
    })
    const result = await outbox.request({ deliveryId: 'sending-blocked', chatKey: 'private:1', segments: [{ type: 'text', data: { text: 'x' } }] })
    assert.equal(result.state, 'failed')
    assert.match(result.reason, /fail-closed/)
    assert.equal(sends, 0)
    assert.equal(ledger.get('sending-blocked').state, 'queued')
    assert.equal(ledger.get('sending-blocked').attemptCount, 0)
    assert.ok(warnings.length >= 1)
    outbox.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger：无法隔离损坏原件时可以读取备份，但后续写入 fail-closed 不覆盖原件', () => {
  const dir = tempDir('state-corruption-no-archive-')
  const file = join(dir, 'deliveries.json')
  const moduleUrl = new URL('../src/chat/delivery-ledger.js', import.meta.url).href
  try {
    writeFileSync(file, '{cannot-move')
    writeFileSync(`${file}.bak`, JSON.stringify({ version: 1, deliveries: [] }))
    const code = `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { syncBuiltinESMExports } from 'node:module'
      const file = process.argv[1]
      const rename = fs.renameSync
      let blocked = 0
      fs.renameSync = (...args) => {
        if (args[0] === file && String(args[1]).startsWith(file + '.corrupt-')) {
          blocked++
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }
        return rename(...args)
      }
      syncBuiltinESMExports()
      const { createDeliveryLedger } = await import(${JSON.stringify(moduleUrl)})
      const warnings = []
      const ledger = createDeliveryLedger({ file, onError: (error) => warnings.push(error.message) })
      assert.equal(ledger.stats().total, 0)
      assert.throws(() => ledger.enqueue({ deliveryId: 'blocked', chatKey: 'private:1', segments: [] }), /fail-closed/)
      assert.ok(blocked >= 2)
      assert.ok(warnings.some((message) => /无法保留原件/.test(message)))
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, file], { encoding: 'utf8', timeout: 5000 })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(readFileSync(file, 'utf8'), '{cannot-move')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('ledger：隔离损坏文件后立即崩溃，再启动仍须提示历史状态丢失', () => {
  const dir = tempDir('state-corruption-ledger-quarantine-crash-')
  const file = join(dir, 'deliveries.json')
  const moduleUrl = new URL('../src/chat/delivery-ledger.js', import.meta.url).href
  try {
    writeFileSync(file, '{crash-after-quarantine')
    const code = `
      import fs from 'node:fs'
      import { syncBuiltinESMExports } from 'node:module'
      const file = process.argv[1]
      const rename = fs.renameSync
      fs.renameSync = (...args) => {
        rename(...args)
        if (args[0] === file && String(args[1]).startsWith(file + '.corrupt-')) process.exit(0)
      }
      syncBuiltinESMExports()
      const { createDeliveryLedger } = await import(${JSON.stringify(moduleUrl)})
      createDeliveryLedger({ file, onError: () => {} })
      process.exit(2)
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, file], { encoding: 'utf8', timeout: 5000 })
    assert.equal(child.status, 0, child.stderr)
    const warnings = []
    const restarted = createDeliveryLedger({ file, onError: (error) => warnings.push(error.message) })
    assert.equal(restarted.stats().total, 0)
    assert.ok(archivedContent(dir, file).includes('{crash-after-quarantine'))
    assert.match(warnings.join(' '), /损坏|历史状态可能缺失/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
