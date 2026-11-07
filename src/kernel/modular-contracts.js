export const CONTRACT_VERSION = 1

const CHAT_KEY_RE = /^(private|group):([1-9][0-9]*)$/
const TURN_STATES = new Set(['pending', 'merging', 'running', 'succeeded', 'failed', 'cancelled'])
const DELIVERY_STATES = new Set(['queued', 'sending', 'sent', 'failed', 'unknown', 'cancelled'])
const CONTEXT_ERROR_POLICIES = new Set(['isolate', 'fail-closed'])
const SENDER_ROLES = new Set(['owner', 'admin', 'member'])

function assertRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} 必须是对象`)
  }
}

function assertString(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${path} 必须是非空字符串`)
  }
}

function assertOptionalString(value, path) {
  if (value !== undefined) assertString(value, path)
}

function assertTime(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${path} 必须是非负有限时间戳`)
  }
}

function assertVersion(value) {
  if (value !== CONTRACT_VERSION) {
    throw new TypeError(`contractVersion 必须是 ${CONTRACT_VERSION}，收到 ${String(value)}`)
  }
}

function assertSegments(value, path = 'segments') {
  if (!Array.isArray(value)) throw new TypeError(`${path} 必须是数组`)
  for (const [index, segment] of value.entries()) {
    assertRecord(segment, `${path}[${index}]`)
    assertString(segment.type, `${path}[${index}].type`)
    assertRecord(segment.data, `${path}[${index}].data`)
  }
}

function normalizeId(value, path = 'id') {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${path} 必须是正整数`)
    return String(value)
  }
  assertString(value, path)
  if (!/^[1-9][0-9]*$/.test(value)) throw new TypeError(`${path} 必须是不含前导零的数字 ID`)
  return value
}

export function createChatKey(kind, id) {
  if (kind !== 'private' && kind !== 'group') throw new TypeError(`未知聊天域：${String(kind)}`)
  return `${kind}:${normalizeId(id)}`
}

export function parseChatKey(value) {
  assertString(value, 'chatKey')
  const match = CHAT_KEY_RE.exec(value)
  if (!match) throw new TypeError(`chatKey 必须是 private:<数字ID> 或 group:<数字ID>，收到 ${value}`)
  return Object.freeze({ kind: match[1], id: match[2] })
}

export function assertNormalizedInbound(value) {
  assertRecord(value, 'inbound')
  assertVersion(value.contractVersion)
  assertString(value.eventId, 'eventId')
  assertOptionalString(value.messageId, 'messageId')
  parseChatKey(value.chatKey)
  assertRecord(value.sender, 'sender')
  assertString(value.sender.userId, 'sender.userId')
  assertOptionalString(value.sender.nickname, 'sender.nickname')
  assertOptionalString(value.sender.card, 'sender.card')
  if (value.sender.role !== undefined && !SENDER_ROLES.has(value.sender.role)) {
    throw new TypeError('sender.role 必须是 owner、admin 或 member')
  }
  assertTime(value.timestamp, 'timestamp')
  if (value.source !== 'realtime' && value.source !== 'backfill') {
    throw new TypeError('source 必须是 realtime 或 backfill')
  }
  assertSegments(value.segments)
  return value
}

export function assertTurn(value) {
  assertRecord(value, 'turn')
  assertVersion(value.contractVersion)
  assertString(value.turnId, 'turnId')
  parseChatKey(value.chatKey)
  if (!Array.isArray(value.memberEventIds) || value.memberEventIds.length === 0) {
    throw new TypeError('memberEventIds 必须是非空数组')
  }
  for (const [index, id] of value.memberEventIds.entries()) assertString(id, `memberEventIds[${index}]`)
  if (new Set(value.memberEventIds).size !== value.memberEventIds.length) {
    throw new TypeError('memberEventIds 不能有重复事件')
  }
  if (!TURN_STATES.has(value.state)) throw new TypeError(`未知 Turn state：${String(value.state)}`)
  assertTime(value.createdAt, 'createdAt')
  if (value.completedAt !== undefined) assertTime(value.completedAt, 'completedAt')
  assertOptionalString(value.error, 'error')
  return value
}

export function assertDelivery(value) {
  assertRecord(value, 'delivery')
  assertVersion(value.contractVersion)
  assertString(value.deliveryId, 'deliveryId')
  assertOptionalString(value.turnId, 'turnId')
  parseChatKey(value.chatKey)
  assertString(value.sourceModuleId, 'sourceModuleId')
  if (!DELIVERY_STATES.has(value.state)) throw new TypeError(`未知 Delivery state：${String(value.state)}`)
  if (!Number.isInteger(value.attemptCount) || value.attemptCount < 0) {
    throw new TypeError('attemptCount 必须是非负整数')
  }
  assertSegments(value.segments)
  assertOptionalString(value.gatewayMessageId, 'gatewayMessageId')
  return value
}

export function assertContextFragment(value) {
  assertRecord(value, 'contextFragment')
  assertVersion(value.contractVersion)
  assertString(value.moduleId, 'moduleId')
  if (value.scope !== 'global') {
    try {
      parseChatKey(value.scope)
    } catch {
      throw new TypeError('scope 必须是 global 或合法 ChatKey')
    }
  }
  assertOptionalString(value.sessionId, 'sessionId')
  if (typeof value.priority !== 'number' || !Number.isFinite(value.priority)) {
    throw new TypeError('priority 必须是有限数字')
  }
  if (typeof value.cacheStable !== 'boolean') throw new TypeError('cacheStable 必须是布尔值')
  if (!CONTEXT_ERROR_POLICIES.has(value.onError)) throw new TypeError(`未知 onError：${String(value.onError)}`)
  if (typeof value.content !== 'string') throw new TypeError('content 必须是字符串')
  return value
}
