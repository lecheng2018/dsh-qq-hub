import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createThreadLedger,
  ThreadLedgerCapacityError,
} from '../src/chat/thread-ledger.js'

test('容量淘汰：满容量且记录均为已归档 dormant 时，继续 push 优雅淘汰最旧的 dormant 线索', () => {
  const ledger = createThreadLedger({
    maxThreads: 3,
    onDormant: () => true, // 归档成功，pendingArchive 为 false
  })

  const t1 = ledger.push({ chatKey: 'private:1001', type: 'promise', summary: '线索1', createdAt: 1000 })
  const t2 = ledger.push({ chatKey: 'private:1001', type: 'question_pending', summary: '线索2', createdAt: 2000 })
  const t3 = ledger.push({ chatKey: 'private:1001', type: 'temporary_leave', summary: '线索3', createdAt: 3000 })

  // 推进两轮未顺承，使 3 条线索均进入 dormant 状态且完成归档
  ledger.advance('private:1001', { didContinue: false, now: 3100 })
  ledger.advance('private:1001', { didContinue: false, now: 3200 })

  assert.equal(ledger.get(t1.id).status, 'dormant')
  assert.equal(ledger.get(t1.id).pendingArchive, false)
  assert.equal(ledger.get(t2.id).status, 'dormant')
  assert.equal(ledger.get(t2.id).pendingArchive, false)
  assert.equal(ledger.get(t3.id).status, 'dormant')
  assert.equal(ledger.get(t3.id).pendingArchive, false)
  assert.equal(ledger.stats().threads, 3)

  // 此时容量已满（3/3），继续 push 新线索不应报错，而是淘汰最旧的 t1 (createdAt: 1000)
  const t4 = ledger.push({ chatKey: 'private:1001', type: 'topic_postponed', summary: '线索4', createdAt: 4000 })

  assert.equal(ledger.stats().threads, 3)
  assert.equal(ledger.get(t1.id), null, '最旧的 dormant 线索 t1 应已被淘汰')
  assert.ok(ledger.get(t2.id), 't2 仍存在')
  assert.ok(ledger.get(t3.id), 't3 仍存在')
  assert.ok(ledger.get(t4.id), 't4 写入成功')
  assert.equal(ledger.get(t4.id).status, 'active')

  // 再 push 一条，应淘汰次旧的 t2 (createdAt: 2000)
  const t5 = ledger.push({ chatKey: 'private:1001', type: 'promise', summary: '线索5', createdAt: 5000 })
  assert.equal(ledger.stats().threads, 3)
  assert.equal(ledger.get(t2.id), null, '次旧的 dormant 线索 t2 应已被淘汰')
  assert.ok(ledger.get(t3.id), 't3 仍存在')
  assert.ok(ledger.get(t4.id), 't4 仍存在')
  assert.ok(ledger.get(t5.id), 't5 写入成功')
})

test('容量淘汰：全部条目均为 active / extended 时抛出容量异常', () => {
  const ledger = createThreadLedger({ maxThreads: 3 })

  ledger.push({ chatKey: 'private:1001', type: 'promise', summary: '线索1', createdAt: 1000 })
  ledger.push({ chatKey: 'private:1001', type: 'question_pending', summary: '线索2', createdAt: 2000 })
  ledger.push({ chatKey: 'private:1001', type: 'temporary_leave', summary: '线索3', createdAt: 3000 })

  // 此时 3 条均为 active，容量已满，新增应抛出 ThreadLedgerCapacityError
  assert.throws(
    () => ledger.push({ chatKey: 'private:1001', type: 'topic_postponed', summary: '线索4', createdAt: 4000 }),
    (err) => {
      assert.ok(err instanceof ThreadLedgerCapacityError)
      assert.equal(err.name, 'ThreadLedgerCapacityError')
      assert.equal(err.code, 'THREAD_LEDGER_CAPACITY_FULL')
      assert.equal(err.maxThreads, 3)
      return true
    },
  )

  // 推进一轮未顺承，3 条线索变为 extended 状态
  ledger.advance('private:1001', { didContinue: false, now: 3500 })
  const stats = ledger.stats()
  assert.equal(stats.extended, 3)
  assert.equal(stats.active, 0)

  // 均为 extended 时新增同样抛出 ThreadLedgerCapacityError
  assert.throws(
    () => ledger.push({ chatKey: 'private:1001', type: 'topic_postponed', summary: '线索4', createdAt: 4000 }),
    ThreadLedgerCapacityError,
  )

  // 混合 active 和 extended
  const ledger2 = createThreadLedger({ maxThreads: 2 })
  ledger2.push({ chatKey: 'private:1001', type: 'promise', summary: '线索A', createdAt: 1000 })
  ledger2.advance('private:1001', { didContinue: false, now: 1500 }) // 线索A 变成 extended
  ledger2.push({ chatKey: 'private:1001', type: 'question_pending', summary: '线索B', createdAt: 2000 }) // 线索B 是 active

  // 满容量且一条 extended 一条 active，不能淘汰任何一条
  assert.throws(
    () => ledger2.push({ chatKey: 'private:1001', type: 'temporary_leave', summary: '线索C', createdAt: 3000 }),
    ThreadLedgerCapacityError,
  )
})

test('容量淘汰：优先淘汰 resolved，无 resolved 时才淘汰已归档 dormant', () => {
  const ledger = createThreadLedger({
    maxThreads: 3,
    onDormant: () => true,
  })

  const t1 = ledger.push({ chatKey: 'private:1001', type: 'promise', summary: '线索1', createdAt: 1000 })
  const t2 = ledger.push({ chatKey: 'private:1001', type: 'question_pending', summary: '线索2', createdAt: 2000 })

  // t1 和 t2 变为 dormant
  ledger.advance('private:1001', { didContinue: false, now: 2100 })
  ledger.advance('private:1001', { didContinue: false, now: 2200 })

  // t3 建立后显式 resolve
  const t3 = ledger.push({ chatKey: 'private:1001', type: 'temporary_leave', summary: '线索3', createdAt: 3000 })
  ledger.resolve(t3.id, { now: 3100, by: 'test' })

  assert.equal(ledger.get(t1.id).status, 'dormant')
  assert.equal(ledger.get(t2.id).status, 'dormant')
  assert.equal(ledger.get(t3.id).status, 'resolved')

  // 此时容量为 3，push t4：虽然 t1 createdAt 更早 (1000 < 3000)，但应优先淘汰 resolved 的 t3
  const t4 = ledger.push({ chatKey: 'private:1001', type: 'topic_postponed', summary: '线索4', createdAt: 4000 })

  assert.equal(ledger.get(t3.id), null, 'resolved 的 t3 必须优先被淘汰')
  assert.ok(ledger.get(t1.id), 'dormant t1 仍然保留')
  assert.ok(ledger.get(t2.id), 'dormant t2 仍然保留')
  assert.ok(ledger.get(t4.id), 't4 写入成功')

  // 再次 push t5：此时无 resolved，应淘汰最旧的已归档 dormant t1
  const t5 = ledger.push({ chatKey: 'private:1001', type: 'promise', summary: '线索5', createdAt: 5000 })
  assert.equal(ledger.get(t1.id), null, '无 resolved 时最旧已归档 dormant t1 被淘汰')
  assert.ok(ledger.get(t2.id), 't2 仍然保留')
  assert.ok(ledger.get(t4.id), 't4 仍然保留')
  assert.ok(ledger.get(t5.id), 't5 写入成功')
})

test('容量淘汰：未完成归档（pendingArchive === true）的 dormant 线索不被淘汰', () => {
  // 不传入 onDormant / archive 钩子，转入 dormant 时 pendingArchive 会置为 true
  const ledger = createThreadLedger({ maxThreads: 2 })

  ledger.push({ chatKey: 'private:1001', type: 'promise', summary: '未归档1', createdAt: 1000 })
  ledger.push({ chatKey: 'private:1001', type: 'question_pending', summary: '未归档2', createdAt: 2000 })

  ledger.advance('private:1001', { didContinue: false, now: 2100 })
  ledger.advance('private:1001', { didContinue: false, now: 2200 })

  const stats = ledger.stats()
  assert.equal(stats.dormant, 2)
  assert.equal(stats.pendingArchive, 2)

  // 此时虽然均为 dormant，但尚未完成归档，绝不能被淘汰，必须抛出容量异常
  assert.throws(
    () => ledger.push({ chatKey: 'private:1001', type: 'temporary_leave', summary: '新线索', createdAt: 3000 }),
    ThreadLedgerCapacityError,
  )

  // 通过 retryArchive 完成归档后，变为可淘汰
  const flushed = ledger.retryArchive(() => true)
  assert.equal(flushed.length, 2)
  assert.equal(ledger.stats().pendingArchive, 0)

  // 再次 push，应当成功淘汰最旧的一条
  const t3 = ledger.push({ chatKey: 'private:1001', type: 'temporary_leave', summary: '新线索', createdAt: 3000 })
  assert.ok(t3)
  assert.equal(ledger.stats().threads, 2)
})
