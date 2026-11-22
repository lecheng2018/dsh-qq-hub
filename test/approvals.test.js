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
  // 2026-11-09 现网反馈「审批回复太复杂」→ 单条免编号新文案（真机修复 #19）
  assert.match(card, /回复「同意」放行/)
  assert.match(card, /多条待办时带上编号，例如「同意 #1」/)
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

  // 主人回复「通过 #3」（审计后不再支持无编号自动选中，防止「可以/ok」宽匹配误批）
  const handled = registry.handleReply('通过 #3', ownerQQ, 'private:10001')
  assert.equal(handled, true) // 消费了消息
  assert.equal(registry.count(), 1) // 并没有被放行，依然挂起
  assert.match(sent[1].text, /权限锁当前处于锁定状态/)

  // 主人输入口令解锁了权限锁
  locked = false
  const handledAgain = registry.handleReply('通过 #3', ownerQQ, 'private:10001')
  assert.equal(handledAgain, true)
  assert.equal(registry.count(), 0) // 放行成功
})

// 审计 S09：审批批复必须绑定发卡私聊。
// 过去 handleReply 只校验「回复者是不是主人」，主人在群里回「同意」也会放行
// 高危操作——等于把批准权开放给群消息链路。现在：非 private:<主人> 的会话
// 一律不消费（刻意不回提示，避免向群成员泄露「存在待审批高危操作」）。
test('S09: 主人在群里回复审批指令不放行，私聊回复才生效', async () => {
  const sent = []
  const ownerQQ = '10001'
  const registry = createApprovalRegistry({
    deliver: async (chatId, text) => { sent.push({ chatId, text }) },
    ownerQQ: () => ownerQQ,
    timeoutMs: 1000,
  })

  const reqPromise = registry.request({
    toolName: 'bash',
    reason: '重启服务',
    arguments: { command: 'systemctl restart nginx' },
  }, { chatId: 'private:10001', sessionId: 'sess-1' })

  const id = parseInt(sent[0].text.match(/#(\d+)/)[1], 10)

  // 主人在白名单群里回复 → 不消费、不放行、也不产生任何群内提示（防泄露）
  const inGroup = registry.handleReply(`同意 #${id}`, ownerQQ, 'group:777')
  assert.equal(inGroup, false, '群聊回复不得消费审批指令')
  assert.equal(registry.count(), 1, '审批仍挂起')
  assert.equal(sent.length, 1, '不得在群里回任何提示（会泄露待审批的存在）')

  // 同一条指令在发卡私聊里回复 → 正常放行
  const inPrivate = registry.handleReply(`同意 #${id}`, ownerQQ, 'private:10001')
  assert.equal(inPrivate, true)
  const outcome = await reqPromise
  assert.equal(outcome, 'allowed-once')
})

test('S09: 卡片文案写明「请在私聊里回复」，群里回复无效有据可循', () => {
  const card = formatApprovalCard({ id: 1, toolName: 'bash', command: 'ls' })
  assert.match(card, /私聊里回复/)
  assert.match(card, /在群里回复不会生效/)
})
