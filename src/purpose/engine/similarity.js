// 文本相似度：中文双字 + 英文词袋的 Jaccard，去重判断。
import { tokenSet } from './shared.js';

export function textSimilarity(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export function isDuplicateText(text, history = [], threshold = 0.55) {
  const target = String(text ?? '').trim();
  if (!target) return true;
  for (const h of history) {
    if (!h) continue;
    if (textSimilarity(target, h.purpose || '') >= threshold) return true;
    if (textSimilarity(target, h.planned || '') >= threshold) return true;
    if (h.text && textSimilarity(target, h.text) >= threshold) return true;
  }
  return false;
}

