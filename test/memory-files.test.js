import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openMemoryFiles,
  scopeToFilePath,
  MAX_SCOPE_FILE_BYTES,
} from '../src/features/memory-files.js'

let dir

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'memfiles-test-'))
})

test('memory-files: scopeToFilePath 路径映射与安全防卫', () => {
  assert.equal(scopeToFilePath('global'), join('global', 'memory.md'))
  assert.equal(scopeToFilePath('private:10001'), join('private', '10001', 'memory.md'))
  assert.equal(scopeToFilePath('group:20001'), join('group', '20001', 'memory.md'))

  // 严禁路径穿越
  assert.throws(() => scopeToFilePath('private:../etc/passwd'), /非法的作用域 ID/)
  assert.throws(() => scopeToFilePath('group:foo/bar'), /非法的作用域 ID/)
})

test('memory-files: 保存不同 scope 的条目，落盘至不同子目录的 memory.md', () => {
  const memDir = join(dir, 'store1')
  const store = openMemoryFiles(memDir)

  const s = {
    items: [
      { id: 'g1', text: '全局事实', scope: 'global', importance: 0.5 },
      { id: 'p1', text: '私聊秘密', scope: 'private:10001', about: '10001', importance: 0.8 },
      { id: 'grp1', text: '群内八卦', scope: 'group:20001', about: '10001', importance: 0.6 },
    ],
    profiles: {
      '10001@private:10001': { qq: '10001', scope: 'private:10001', name: '主人', text: '爱喝咖啡' },
    },
    insights: {
      'group:20001': [{ id: 'ins1', text: '群友爱开玩笑' }],
    },
    styles: {
      self: ['说话短'],
      'group:20001': ['逗号断句'],
    },
    distill: {
      'group:20001#10001': { syntax: ['短句'] },
    },
    distillTargets: [{ gid: '20001', uid: '10001', name: '主人' }],
    processed: { '2026-11-11': 10 },
  }

  store.save(s)

  // 检查落盘文件路径
  const globalFile = join(memDir, 'global', 'memory.md')
  const privateFile = join(memDir, 'private', '10001', 'memory.md')
  const groupFile = join(memDir, 'group', '20001', 'memory.md')
  const stateFile = join(memDir, 'state.json')

  assert.ok(existsSync(globalFile), 'global/memory.md 应存在')
  assert.ok(existsSync(privateFile), 'private/10001/memory.md 应存在')
  assert.ok(existsSync(groupFile), 'group/20001/memory.md 应存在')
  assert.ok(existsSync(stateFile), 'state.json 应存在')

  // 验证各文件内容严格隔离
  const privMd = readFileSync(privateFile, 'utf8')
  assert.ok(privMd.includes('私聊秘密'))
  assert.ok(privMd.includes('爱喝咖啡'))
  assert.ok(!privMd.includes('全局事实'), '私聊文件不应包含全局事实')
  assert.ok(!privMd.includes('群内八卦'), '私聊文件不应包含群聊八卦')

  const grpMd = readFileSync(groupFile, 'utf8')
  assert.ok(grpMd.includes('群内八卦'))
  assert.ok(grpMd.includes('群友爱开玩笑'))
  assert.ok(!grpMd.includes('私聊秘密'), '群聊文件不应包含私聊秘密')

  store.close()
})

test('memory-files: 写→关→重开，所有数据完整保留并组装一致', () => {
  const memDir = join(dir, 'store2')
  const s1 = openMemoryFiles(memDir)

  s1.save({
    items: [
      { id: 'it_1', text: '喜欢白米饭', scope: 'global', hits: 5, lastHit: 1794350000000 },
      { id: 'it_2', text: '旧喜好', scope: 'global', invalidAt: 1794350000000, supersededBy: 'it_1' },
    ],
    distillTargets: [{ gid: '123', uid: '456', name: '测试' }],
  })
  s1.close()

  // 重新打开
  const s2 = openMemoryFiles(memDir)
  const loaded = s2.load()

  assert.equal(loaded.items.length, 2)
  const it1 = loaded.items.find((m) => m.id === 'it_1')
  assert.equal(it1.text, '喜欢白米饭')
  assert.equal(it1.hits, 5, 'hits 应从 state.json 中无缝组装')
  assert.equal(it1.lastHit, 1794350000000)

  const it2 = loaded.items.find((m) => m.id === 'it_2')
  assert.equal(it2.invalidAt, 1794350000000)
  assert.equal(it2.supersededBy, 'it_1')

  assert.deepEqual(loaded.distillTargets, [{ gid: '123', uid: '456', name: '测试' }])
  s2.close()
})

test('memory-files: 超过单文件上限 (2 MiB) 抛出异常并阻止写入', () => {
  const memDir = join(dir, 'store3')
  const store = openMemoryFiles(memDir)

  // 构造超大文本（>2 MiB）
  const hugeText = 'A'.repeat(MAX_SCOPE_FILE_BYTES + 1024)
  assert.throws(() => {
    store.save({
      items: [{ id: 'huge_1', text: hugeText, scope: 'global' }],
    })
  }, /记忆档案超限/)

  store.close()
})

test('memory-files: 实体槽位 (entity/topic) 与事件时间 (eventAt/chatId) 完整持久化', () => {
  const memDir = join(dir, 'store4')
  const s1 = openMemoryFiles(memDir)

  s1.save({
    items: [
      {
        id: 'slot_1',
        text: '中兴G7615光猫需要进uboot刷底包',
        scope: 'group:111222333',
        chatId: 'group:111222333',
        entity: '中兴G7615',
        topic: '数码硬件',
        eventAt: 1794350000000,
        at: 1794360000000,
      },
    ],
  })
  s1.close()

  // 读回核验
  const s2 = openMemoryFiles(memDir)
  const loaded = s2.load()
  assert.equal(loaded.items.length, 1)
  const item = loaded.items[0]
  assert.equal(item.id, 'slot_1')
  assert.equal(item.entity, '中兴G7615', 'entity 槽位必须持久化保留')
  assert.equal(item.topic, '数码硬件', 'topic 槽位必须持久化保留')
  assert.equal(item.eventAt, 1794350000000, 'eventAt 必须持久化保留')
  assert.equal(item.chatId, 'group:111222333', 'chatId 必须持久化保留')
  s2.close()
})

test('memory-files: 多次 save() 与重载后，Markdown 中的 ## 当前记忆 不会重复累积膨胀（自愈与幂等）', () => {
  const memDir = join(dir, 'store5')
  const store = openMemoryFiles(memDir)

  const state = {
    items: [
      { id: 'it_repeat', text: '多次保存测试', scope: 'global' },
    ],
  }

  // 连续执行 5 次保存
  for (let i = 0; i < 5; i++) {
    store.save(state)
  }
  store.close()

  // 读取生成的 global/memory.md
  const globalFile = join(memDir, 'global', 'memory.md')
  const mdRaw = readFileSync(globalFile, 'utf8')
  const matches = mdRaw.match(/^##\s+当前记忆\s*$/gm)

  assert.ok(matches, '应该包含 ## 当前记忆')
  assert.equal(matches.length, 1, '多次保存后 ## 当前记忆 只能有且仅有 1 行，绝不应累积堆叠')
})

