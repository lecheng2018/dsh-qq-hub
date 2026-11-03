import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// scripts/fix-memory-scope.mjs 是线上排障要手动跑的迁移脚本。
// 这里只守一条底线：它找数据目录的规则必须和运行时 src/core/store.js 的 dataDir() 一致，
// 否则命名空间迁移之后，用户照着文档跑会「找不到记忆文件」，迁移等于没跑。

const SCRIPT = join(process.cwd(), 'scripts', 'fix-memory-scope.mjs')

function fresh() {
  const h = mkdtempSync(join(tmpdir(), 'scope-mig-'))
  mkdirSync(join(h, '.dsh', 'plugins-data'), { recursive: true })
  return h
}

function seedMemories(dir, items) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'memories.json'), JSON.stringify({ items }), 'utf8')
}

function run(home, args = [], extraEnv = {}) {
  const env = { ...process.env, HOME: home, PATH: process.env.PATH }
  delete env.DSH_QQ_HUB_DATA_DIR
  delete env.AURABOT_DATA_DIR
  delete env.DSH_HOME
  Object.assign(env, extraEnv)
  return execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' })
}

const ONE = [{ text: '一条记忆', chatId: 'private:2471784685', source: 'event' }]

test('迁移脚本：新命名空间 dsh-qq-hub 目录下能找到记忆文件', () => {
  const home = fresh()
  seedMemories(join(home, '.dsh', 'plugins-data', 'dsh-qq-hub'), ONE)
  const out = run(home)
  assert.match(out, /记忆文件：.*dsh-qq-hub.*memories\.json/)
  assert.match(out, /总条数：1/)
})

test('迁移脚本：只有老 aurabot 目录时沿用老目录（老用户不用改脚本）', () => {
  const home = fresh()
  seedMemories(join(home, '.dsh', 'plugins-data', 'aurabot'), ONE)
  const out = run(home)
  assert.match(out, /记忆文件：.*aurabot.*memories\.json/)
})

test('迁移脚本：新旧目录都在时优先新目录（与 store.js 判定一致）', () => {
  const home = fresh()
  seedMemories(join(home, '.dsh', 'plugins-data', 'dsh-qq-hub'), [{ text: '新目录的记忆', chatId: 'private:1', source: 'event' }])
  seedMemories(join(home, '.dsh', 'plugins-data', 'aurabot'), [{ text: '老目录的记忆', chatId: 'private:1', source: 'event' }])
  const out = run(home)
  assert.match(out, /记忆文件：.*dsh-qq-hub/)
  assert.match(out, /新目录的记忆/)
})

test('迁移脚本：DSH_QQ_HUB_DATA_DIR 能直接指定数据目录', () => {
  const home = fresh()
  const envDir = mkdtempSync(join(tmpdir(), 'scope-env-'))
  seedMemories(envDir, ONE)
  const out = run(home, [], { DSH_QQ_HUB_DATA_DIR: envDir })
  assert.match(out, /记忆文件：.*scope-env/)
})

test('迁移脚本：--write 按 chatId 归档，来源不明的落主人私聊并留备份', () => {
  const home = fresh()
  const dir = join(home, '.dsh', 'plugins-data', 'dsh-qq-hub')
  seedMemories(dir, [
    { text: '群里的', chatId: 'group:999', source: 'event' },
    { text: '私聊的', chatId: 'private:2471784685', source: 'event' },
    { text: '来源不明', source: 'event' },
  ])
  run(home, ['--write'])
  const saved = JSON.parse(readFileSync(join(dir, 'memories.json'), 'utf8'))
  const byText = Object.fromEntries(saved.items.map((m) => [m.text, m.scope]))
  assert.equal(byText['群里的'], 'group:999')
  assert.equal(byText['私聊的'], 'private:2471784685')
  assert.equal(byText['来源不明'], 'private:2471784685', '来源不明必须兜底到主人私聊，留空等于对所有人不可见')
  assert.ok(readdirSync(dir).some((f) => f.includes('.bak-')), '写盘前必须先备份')
})
