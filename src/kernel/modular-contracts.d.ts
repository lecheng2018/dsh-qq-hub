export declare const CONTRACT_VERSION: 1

export type ChatKind = 'private' | 'group'
export type ChatKey = `${ChatKind}:${string}`
export type InboundSource = 'realtime' | 'backfill'
export type TurnState = 'pending' | 'merging' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type DeliveryState = 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled'

export interface MessageSegment {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface NormalizedInbound {
  readonly contractVersion: 1
  readonly eventId: string
  readonly messageId?: string
  readonly chatKey: ChatKey
  readonly sender: {
    readonly userId: string
    readonly nickname?: string
    readonly card?: string
    readonly role?: 'owner' | 'admin' | 'member'
  }
  readonly timestamp: number
  readonly source: InboundSource
  readonly segments: ReadonlyArray<MessageSegment>
}

export interface Turn {
  readonly contractVersion: 1
  readonly turnId: string
  readonly chatKey: ChatKey
  readonly memberEventIds: ReadonlyArray<string>
  readonly state: TurnState
  readonly createdAt: number
  readonly completedAt?: number
  readonly error?: string
}

export interface Delivery {
  readonly contractVersion: 1
  readonly deliveryId: string
  readonly turnId?: string
  readonly chatKey: ChatKey
  readonly sourceModuleId: string
  readonly state: DeliveryState
  readonly attemptCount: number
  readonly segments: ReadonlyArray<MessageSegment>
  readonly gatewayMessageId?: string
}

export interface ContextFragment {
  readonly contractVersion: 1
  readonly moduleId: string
  readonly scope: ChatKey | 'global'
  readonly sessionId?: string
  readonly priority: number
  readonly cacheStable: boolean
  readonly onError: 'isolate' | 'fail-closed'
  readonly content: string
}

export declare function createChatKey(kind: ChatKind, id: string | number): ChatKey
export declare function parseChatKey(value: string): Readonly<{ kind: ChatKind; id: string }>
export declare function assertNormalizedInbound(value: unknown): NormalizedInbound
export declare function assertTurn(value: unknown): Turn
export declare function assertDelivery(value: unknown): Delivery
export declare function assertContextFragment(value: unknown): ContextFragment
