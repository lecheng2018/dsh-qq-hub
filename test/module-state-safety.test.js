import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { distillModule } from '../src/modules/distill/index.js'
import { slangModule } from '../src/modules/slang/index.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'module-state-safety-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const api = {
    use: () => ({ distillList: () => [], slang: () => [] }),
    dataDir: (name) => join(dir, name),
    dsh: {},
    config: () => ({ enabled: true, model: {}, persona: { current: '', groups: {} }, memory: {} }),
    core: {
      hub: { groupNames: new Map() },
      chatLog: { listDays: () => [], readDay: () => [] },
      http: { body: async () => ({}), query: () => ({}) },
    },
    log: { info() {}, warn() {}, debug() {} },
    context: () => {}, on: () => {}, every: () => {}, emit: () => {}, route: () => {}, setConfig: () => {},
  }
  return { dir, api }
}

for (const [name, module, filename, valid] of [
  ['distill', distillModule, 'pipeline.json', { 'group:123#456': { newCount: 3, batches: [], batchesSinceL2: 0, samples: [] } }],
  ['slang', slangModule, 'book.json', { groups: { 123: [{ id: 'x', word: '石化', meaning: '僵硬', at: 1 }] }, learned: {}, sources: {} }],
]) {
  test(`${name} 主状态损坏时从有效备份恢复并修复主文件`, (t) => {
    const { dir, api } = fixture(t)
    const file = join(dir, filename)
    writeFileSync(file, '{broken', 'utf8')
    writeFileSync(`${file}.bak`, JSON.stringify(valid), 'utf8')
    const service = module.setup(api)
    service.dispose()
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), valid)
  })

  test(`${name} 主备均损坏时拒绝启动，保留原件且不生成空状态`, (t) => {
    const { dir, api } = fixture(t)
    const file = join(dir, filename)
    writeFileSync(file, '{primary', 'utf8')
    writeFileSync(`${file}.bak`, '{backup', 'utf8')
    assert.throws(() => module.setup(api), /无可用备份|状态.*不可用|无法读取/)
    const archived = readdirSync(dir).filter((name) => name.includes('.corrupt-'))
    assert.equal(archived.length, 2)
    assert.equal(archived.map((name) => readFileSync(join(dir, name), 'utf8')).sort().join('\n'), '{backup\n{primary')
  })
}
