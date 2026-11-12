import { AsyncLocalStorage } from 'node:async_hooks'

// 面板模拟发送捕获；物理 Outbox 在捕获态不得被调用。
export function createCapture() {
  const store = new AsyncLocalStorage()
  return {
    async capture(fn) {
      const sent = []
      const result = await store.run(sent, fn)
      return { result, sent }
    },
    captureOnly(chatId, message, note) {
      const captured = store.getStore()
      if (!captured) return null
      captured.push({ chatId, note, message })
      return { message_id: 'sim-' + captured.length }
    },
    isCaptured: () => Boolean(store.getStore()),
  }
}
