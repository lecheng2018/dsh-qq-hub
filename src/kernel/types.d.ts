// RFC-0001 §3.1 核心契约的类型声明。
// 本仓库是 ESM JavaScript，此文件仅供编辑器/类型检查消费，不引入任何 TS 编译工具链。
// 实现见 compose.js 与 context.js；运行时只读保障由 Object.freeze 完成，
// 这里的 DeepReadonly 只是静态层面的防篡改声明。

/**
 * 递归深度只读工具类型，杜绝中间件内部篡改底层报文
 */
export type DeepReadonly<T> = T extends (infer R)[]
  ? ReadonlyArray<DeepReadonly<R>>
  : T extends Function
  ? T
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T

/**
 * 消息结构基元（遵循 CQ/OneBot 消息段标准化设计）
 */
export interface MessageSegment {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}

/**
 * 入站事件发送者元数据
 */
export interface InboundSender {
  readonly userId: string
  readonly nickname?: string
  readonly card?: string
  readonly role?: 'owner' | 'admin' | 'member'
}

/**
 * 物理入站信封契约：绝对不可变
 */
export interface InboundEnvelope<TRaw = unknown> {
  readonly id: string
  readonly protocol: 'onebot:v11' | 'onebot:v12' | 'qq-official'
  readonly type: 'message' | 'notice' | 'request' | 'meta'
  readonly subType?: string
  readonly timestamp: number
  readonly selfId: string
  readonly sender: InboundSender
  readonly messageId?: string
  readonly segments: ReadonlyArray<MessageSegment>
  readonly rawText: string
  readonly channelId?: string
  readonly groupId?: string
  readonly rawPayload: DeepReadonly<TRaw>
}

/**
 * 出站操作优先级
 */
export type ReplyPriority = 'HIGH' | 'NORMAL' | 'LOW'

/**
 * 结构化出站载荷
 */
export interface ReplyPayload {
  readonly id: string
  readonly targetType: 'group' | 'channel' | 'private'
  readonly targetId: string
  readonly segments: MessageSegment[]
  readonly quoteMessageId?: string
  readonly priority: ReplyPriority
  readonly delayMs?: number
  readonly createdAt: number
}

/**
 * 出站回复缓冲池抽象
 */
export interface OutputReplyQueue {
  readonly queue: ReadonlyArray<ReplyPayload>
  enqueue(payload: Omit<ReplyPayload, 'id' | 'createdAt'>): void
  clear(): void
  isEmpty(): boolean
}

/**
 * 基础设施级执行元数据
 */
export interface ContextMeta {
  readonly traceId: string
  readonly spanId: string
  readonly receivedAt: number
  readonly driverId: string
  [key: string]: unknown
}

/**
 * 上下文状态抽象容器（支持基于 Symbol 或 Key 的隔离存储）
 */
export interface ContextState {
  get<T>(key: symbol | string): T | undefined
  set<T>(key: symbol | string, value: T): this
  has(key: symbol | string): boolean
  delete(key: symbol | string): boolean
  toMap(): ReadonlyMap<symbol | string, unknown>
}

/**
 * 洋葱核心 Context 接口契约
 */
export interface Context<TState = unknown> {
  readonly meta: ContextMeta
  readonly inbound: InboundEnvelope
  readonly reply: OutputReplyQueue
  readonly state: ContextState
  readonly signal: AbortSignal

  /**
   * 中断当前执行流，并标记原因。
   * 被 abort 的 Context 不会继续推进后续未执行的中间件。
   */
  abort(reason?: string): void
}

/**
 * 洋葱模型中间件函数契约
 */
export type Next = () => Promise<void>

export interface Middleware<C extends Context = Context> {
  (ctx: C, next: Next): Promise<void>
}
