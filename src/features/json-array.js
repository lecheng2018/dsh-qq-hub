// 只返回完整对象；truncated=true 时调用方必须重试，不能把批次视为完整成功。
export function parseJsonArray(raw) {
  const text = String(raw ?? '').trim()
  const start = text.indexOf('[')
  if (start < 0) throw new Error('模型未返回有效的记忆 JSON 数组')
  const input = text.slice(start)

  const attempt = (candidate) => {
    const entries = JSON.parse(candidate)
    if (!Array.isArray(entries)) throw new Error('模型未返回记忆 JSON 数组')
    return entries
  }

  try { return { entries: attempt(input), truncated: false } } catch {}
  const end = input.lastIndexOf(']')
  if (end > 0) {
    try { return { entries: attempt(input.slice(0, end + 1)), truncated: false } } catch {}
  }

  let depth = 0
  let inString = false
  let escaped = false
  let lastCompleteObject = -1
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') {
      depth--
      if (char === '}' && depth === 1) lastCompleteObject = index
    }
    if (depth < 0) break
  }
  if (lastCompleteObject < 0) throw new Error('模型返回的记忆 JSON 数组不合法')
  try { return { entries: attempt(`${input.slice(0, lastCompleteObject + 1)}]`), truncated: true } } catch { throw new Error('模型返回的记忆 JSON 数组不合法') }
}
