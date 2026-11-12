import { createHash } from 'node:crypto'
import { fingerprintChatLog } from '../chat/chat-log.js'

export function extractionBatchOf(chatId, index, records) {
  const fingerprint = fingerprintChatLog(records)
  const id = createHash('sha256').update(String(chatId)).update('\0').update(String(index)).update('\0').update(fingerprint).digest('hex').slice(0, 24)
  return { id: `extract_${id}`, fingerprint }
}
