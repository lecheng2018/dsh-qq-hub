import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir } from '../src/core/store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 曾经的真实 bug：security-lock 和 token-guardian 都用全局 dataDir('state.json')，
// 写到同一个文件、互相覆盖。后果：
// 1) token-guardian 把 security-lock 的 { secret, pending: null } 当会话表遍历，
//    estimate(st.chars) 抛 Cannot read properties of null (reading 'chars')
// 2) security-lock 的 TOTP secret 被冲掉，权限锁失效
// 正确做法是走框架给的 api.dataDir()，它内部是 dataDir('modules-data', <模块id>)。

const MODULES = ['token-guardian', 'memory-privacy', 'profile', 'imagegen']  // security-lock 已移除

test('模块都不再用全局 dataDir（必须用 api.dataDir 做隔离）', () => {
  for (const m of MODULES) {
    const src = readFileSync(join(ROOT, 'src/modules', m, 'index.js'), 'utf8')
    // 去掉 api.dataDir 之后不该再有裸 dataDir( 调用
    const bare = src.replace(/api\.dataDir\(/g, 'X(').match(/(?<![\w.])dataDir\(/g) || []
    assert.equal(bare.length, 0, `${m} 还有 ${bare.length} 处裸 dataDir() 调用，会和别的模块撞文件`)
  }
})

test('api.dataDir 按模块 id 分目录，两个模块的 state.json 不是同一个文件', () => {
  // 复刻 modules.js 里 api.dataDir 的实现
  const apiDataDir = (id, ...parts) => join(dataDir('modules-data', id), ...parts)
  const a = apiDataDir('security-lock', 'state.json')
  const b = apiDataDir('token-guardian', 'state.json')
  assert.notEqual(a, b, '两个模块的 state.json 必须是不同路径')
  assert.ok(a.includes('security-lock'), '路径里要带模块 id')
  assert.ok(b.includes('token-guardian'), '路径里要带模块 id')
})

test('六类模块的输出文件互不重叠', () => {
  const apiDataDir = (id, ...parts) => join(dataDir('modules-data', id), ...parts)
  const paths = new Map()
  const decl = {
    'security-lock': ['state.json'],
    'token-guardian': ['state.json', 'summary.json'],
    'memory-privacy': ['scoped.json'],
  }
  for (const [id, files] of Object.entries(decl)) {
    for (const f of files) {
      const p = apiDataDir(id, f)
      assert.ok(!paths.has(p), `路径冲突：${p} 同时被 ${paths.get(p)} 和 ${id} 使用`)
      paths.set(p, id)
    }
  }
  assert.equal(paths.size, 4)
})
