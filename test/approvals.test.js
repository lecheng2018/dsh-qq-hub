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
    reason: '释放磁盘空间'
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

// ---------------- 审计跟进（2026-11-22 实机）：日志语义 ----------------
// 过去作用域校验排在 parseApprovalCommand 之前，于是主人在群里说的**任何**话都会打一条
// 「拒绝非发卡私聊的审批指令」。实机 8 条该日志里只有 1 条是真的审批指令（13:54 的「确认」），
// 其余是「你是什么模型？」「上面有个打广告的」「这不撤回」这些普通聊天 —— 排查审批问题时
// 全是假信号。修法是把解析与 pending 判定提到作用域校验之前，只有「真指令 + 真有待审批」
// 才轮到那条日志。

/** 收 debug 日志的假 log。 */
function logSink() {
  const lines = []
  return { lines, log: { debug: (m) => lines.push(String(m)), info() {}, warn() {}, error() {} } }
}

test('日志语义：主人在群里的普通聊天不再被记成「拒绝审批指令」', () => {
  const { lines, log } = logSink()
  const registry = createApprovalRegistry({ deliver: async () => {}, ownerQQ: () => '10001', timeoutMs: 1000, log })

  const ordinary = ['你是什么模型？', '上面有个打广告的', '这不撤回', '', ' ', '在吗', '好的']
  for (const text of ordinary) {
    const handled = registry.handleReply(text, '10001', 'group:777')
    assert.equal(handled, false, `普通聊天「${text}」不得被消费`)
  }
  assert.deepEqual(lines, [], `普通聊天不得产生任何审批日志，实际：${JSON.stringify(lines)}`)
})

test('日志语义：没有待审批在等时，审批词也不打日志', () => {
  const { lines, log } = logSink()
  const registry = createApprovalRegistry({ deliver: async () => {}, ownerQQ: () => '10001', timeoutMs: 1000, log })

  // registry.count() === 0：没有任何待审批项
  const handled = registry.handleReply('同意', '10001', 'group:777')
  assert.equal(handled, false, '没有待审批时不消费')
  assert.deepEqual(lines, [], `空 pending 不应打日志，实际：${JSON.stringify(lines)}`)
})

test('日志语义：真审批指令 + 有待审批 + 非发卡私聊 → 才打那条日志，且带上下文', async () => {
  const { lines, log } = logSink()
  const registry = createApprovalRegistry({
    deliver: async () => {}, ownerQQ: () => '10001', timeoutMs: 50, log,
  })
  const req = registry.request({
    toolName: 'bash', reason: '测试', arguments: { command: 'systemctl restart nginx' },
  }, { chatId: 'private:10001', sessionId: 'sess-1' })
  req.catch(() => {}) // 超时会 reject，别留未处理拒绝

  const handled = registry.handleReply('同意', '10001', 'group:777')
  assert.equal(handled, false, '群聊回复仍不放行（S09 安全边界不变）')
  assert.equal(registry.count(), 1, '审批仍挂起')
  assert.equal(lines.length, 1, `只应打一条日志，实际 ${lines.length}：${JSON.stringify(lines)}`)
  assert.match(lines[0], /拒绝非发卡私聊的审批指令/)
  assert.match(lines[0], /group:777/, '日志要带会话，便于排查')
  assert.match(lines[0], /待审批 1 条/, '日志要说明当时确实有挂起项')
  assert.match(lines[0], /approve/, '日志要说明被判定成什么动作')
})

test('日志语义：非主人发言一律静默（fail-closed 且不打日志）', () => {
  const { lines, log } = logSink()
  const registry = createApprovalRegistry({ deliver: async () => {}, ownerQQ: () => '10001', timeoutMs: 1000, log })
  for (const [text, uid, chat] of [['同意', '20002', 'group:777'], ['同意', '20002', 'private:10001'], ['同意', '', 'private:10001']]) {
    assert.equal(registry.handleReply(text, uid, chat), false)
  }
  assert.deepEqual(lines, [], '非主人发言不得产生审批日志')
})
