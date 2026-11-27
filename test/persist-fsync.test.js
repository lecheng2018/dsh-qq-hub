// 回归（P1-6）：writeJson rename 前 fsync —— kill -9 后已确认写入的数据不回退成旧内容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const STORE = readFileSync(join(ROOT, 'src/core/store.js'), 'utf8')

test('writeJson 先 fsync 再 rename', () => {
  const fsyncIdx = STORE.indexOf('fsyncSync(fd)')
  const renameIdx = STORE.indexOf('renameWithRetry(tmp, file)')
  assert.ok(fsyncIdx > 0, '要有 fsyncSync(fd)')
  assert.ok(renameIdx > fsyncIdx, 'rename 要在 fsync 之后')
})
