import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDistillStore } from '../src/features/distill-store.js'

function fixture(t, legacy = []) {
  const dir = mkdtempSync(join(tmpdir(), 'distill-store-'))
  const file = join(dir, 'store.json')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, file, legacy }
}

test('只读迁移旧目标与画像，后续读写和重开都归模块 store', (t) => {
  const { file, legacy } = fixture(t, [{ gid: '123', uid: '456', name: '小张', profile: { style: ['短句'], evidenceCount: 14 } }])
  const store = createDistillStore({ file, legacy })
  assert.equal(store.list()[0].profile.style[0], '短句')
  assert.equal(readFileSync(file, 'utf8').includes('短句'), true)

  assert.equal(store.addTarget({ gid: '123', uid: '456', name: '小张' }).ok, false)
  assert.equal(store.addTarget({ gid: '123', uid: '789', name: '小李' }).ok, true)
  const saved = store.put('123', '456', { style: ['短句', '爱叠字'], samples: ['行吧'] }, 16, { sourceFingerprint: 'a'.repeat(64) })
  assert.equal(saved.evidenceCount, 16)
  assert.equal(saved.sourceRev, 2)
  assert.equal(saved.sourceFingerprint, 'a'.repeat(64))

  const reopened = createDistillStore({ file })
  assert.deepEqual(reopened.of('123', '456').samples, ['行吧'])
  assert.equal(reopened.of('123', '456').sourceRev, 2)
  assert.equal(reopened.removeTarget('123', '456').ok, true)
  assert.equal(reopened.of('123', '456'), null)
  assert.equal(reopened.list().length, 1)
})

test('损坏 store 拒绝启动且不以空数据覆盖', (t) => {
  const { file } = fixture(t)
  writeFileSync(file, '{broken', 'utf8')
  assert.throws(() => createDistillStore({ file }), / distill store|蒸馏.*store|JSON/)
  assert.equal(readFileSync(file, 'utf8'), '{broken')
})
