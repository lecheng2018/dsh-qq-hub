import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatApprovalCard,
  parseApprovalCommand,
  createApprovalRegistry
} from '../src/chat/approvals.js'

test('formatApprovalCard: 审批卡内容格式化', () => {
  const card = formatApprovalCard({
    id: 1,
    toolName: 'bash',
    command: 'rm -rf /var/cache/apt',
    reason: '释放磁盘空间',
    locked: false
  })

  assert.match(card, /📋 待审批操作 #1/)
  assert.match(card, /🔧 工具：bash/)
  assert.match(card, /💻 命令：rm -rf \/var\/cache\/apt/)
  assert.match(card, /❓ 原因：释放磁盘空间/)
  assert.match(card, /回复「通过 #1」放行/)
})

test('parseApprovalCommand: 审批指令解析', () => {
  // 放行指令
  assert.deepEqual(parseApprovalCommand('通过 #1'), { action: 'approve', id: 1 })
  assert.deepEqual(parseApprovalCommand('同意 2'), { action: 'approve', id: 2 })
  assert.deepEqual(parseApprovalCommand('放行'), { action: 'approve', id: undefined })
  assert.deepEqual(parseApprovalCommand('pass 3'), { action: 'approve', id: 3 })
  assert.deepEqual(parseApprovalCommand('yes'), { action: 'approve', id: undefined })
  assert.deepEqual(parseApprovalCommand('ok #5'), { action: 'approve', id: 5 })

  // 拦截指令
  assert.deepEqual(parseApprovalCommand('拒绝 #1'), { action: 'deny', id: 1 })
  assert.deepEqual(parseApprovalCommand('取消 2'), { action: 'deny', id: 2 })
  assert.deepEqual(parseApprovalCommand('不行'), { action: 'deny', id: undefined })
  assert.deepEqual(parseApprovalCommand('deny 3'), { action: 'deny', id: 3 })
  assert.deepEqual(parseApprovalCommand('no'), { action: 'deny', id: undefined })

  // 非审批文字
  assert.equal(parseApprovalCommand('好的我知道了'), null)
  assert.equal(parseApprovalCommand('通过率是多少'), null)
})

test('createApprovalRegistry: 完整审批放行与拦截流转', async () => {
  const sent = []
  const ownerQQ = '10001'
  const registry = createApprovalRegistry({
    deliver: async (chatId, text) => {
      sent.push({ chatId, text })
    },
    ownerQQ: () => ownerQQ,
    timeoutMs: 1000
  })

  const reqPromise = registry.request({
    toolName: 'bash',
    reason: '部署项目',
    arguments: { command: 'systemctl restart nginx' }
  }, { chatId: 'private:10001', sessionId: 'sess-1' })

  assert.equal(registry.count(), 1)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /📋 待审批操作 #/)

  // 提取审批卡上的 id
  const idMatch = sent[0].text.match(/#(\d+)/)
  assert.ok(idMatch)
  const id = parseInt(idMatch[1], 10)

  // 模拟主人回复「通过 #id」
  const handled = registry.handleReply(`通过 #${id}`, ownerQQ, 'private:10001')
  assert.equal(handled, true)
  assert.equal(registry.count(), 0)

  const outcome = await reqPromise
  assert.equal(outcome, 'allowed-once')
  assert.match(sent[1].text, /已批准操作/)
})

test('createApprovalRegistry: 非主人发审批指令被忽略', async () => {
  const sent = []
  const ownerQQ = '10001'
  const registry = createApprovalRegistry({
    deliver: async (chatId, text) => {
      sent.push({ chatId, text })
    },
    ownerQQ: () => ownerQQ,
    timeoutMs: 1000
  })

  const reqPromise = registry.request({
    toolName: 'bash',
    reason: '测试'
  }, { chatId: 'private:10001', sessionId: 'sess-1' })

  // 陌生人回复「通过」
  const handled = registry.handleReply('通过', '99999', 'private:99999')
  assert.equal(handled, false)
  assert.equal(registry.count(), 1)

  // 主人回复拒绝
  const ownerHandled = registry.handleReply('拒绝', ownerQQ, 'private:10001')
  assert.equal(ownerHandled, true)

  const outcome = await reqPromise
  assert.equal(outcome, 'rejected')
})

test('createApprovalRegistry: 权限锁锁定时阻止放行并提示解锁', async () => {
  const sent = []
  const ownerQQ = '10001'
  let locked = true
  const registry = createApprovalRegistry({
    deliver: async (chatId, text) => {
      sent.push({ chatId, text })
    },
    ownerQQ: () => ownerQQ,
    securityLock: () => ({ locked }),
    timeoutMs: 1000
  })

  registry.request({
    toolName: 'bash',
    reason: '测试权限锁'
  }, { chatId: 'private:10001', sessionId: 'sess-1' })

  // 主人回复通过，但权限锁锁着
  const handled = registry.handleReply('通过', ownerQQ, 'private:10001')
  assert.equal(handled, true) // 消费了消息
  assert.equal(registry.count(), 1) // 并没有被放行，依然挂起
  assert.match(sent[1].text, /权限锁当前处于锁定状态/)

  // 主人输入口令解锁了权限锁
  locked = false
  const handledAgain = registry.handleReply('通过', ownerQQ, 'private:10001')
  assert.equal(handledAgain, true)
  assert.equal(registry.count(), 0) // 放行成功
})
