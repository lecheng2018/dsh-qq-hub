import { createMemoryArchive } from './memory-archive.js'
import { createMemoryLearning } from './memory-learning.js'
export { CLARITY_STEPS, SCOPE_QUOTAS, agoText, buildIndex, clarityOf, contradicts, cutAtSentence, evictScopeItems, isOwnerMemory, memoryLine, parseReflection, quotaForScope, retention, search, shouldForget, similarity, whenText, tokenize } from './memory-core.js'

export function createMemoryStore(options) {
  return createMemoryArchive({
    ...options,
    extend: (archive) => createMemoryLearning(archive),
  })
}
