// 标签页池：每个模块一个固定标签页，长期复用（登录态、已加载的页面都留着）。
//
// 为什么要按模块分：两个模块同时抢同一个页面会互相把对方导航走。
// 为什么长期复用：重新开 tab 要重跑一遍页面加载，慢且更容易触发反爬。

import { getJson } from './cdp.js'

/** 列出所有能控制的页面。 */
export async function listPages(port) {
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`, 5000)
  return (targets || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
}

/** 新开一个标签页。 */
export async function openPage(port, url = 'about:blank') {
  // Chrome 111+ 的 /json/new 只认 PUT；老版本 GET 也行。先 PUT，失败再退回 GET。
  const target = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`
  let t = null
  for (const method of ['PUT', 'GET']) {
    const r = await fetch(target, { method, signal: AbortSignal.timeout(8000) }).catch(() => null)
    if (r?.ok) {
      t = await r.json().catch(() => null)
      if (t?.webSocketDebuggerUrl) break
    }
  }
  if (!t?.webSocketDebuggerUrl) throw new Error('浏览器没能新开标签页')
  return t
}

/** 关掉一个标签页（失败不抛：可能已经被页面自己关了）。 */
export async function closePage(port, targetId) {
  if (!targetId) return
  await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`, { signal: AbortSignal.timeout(3000) }).catch(() => {})
}

/**
 * 标签页池。按 moduleId 记住它的 tab；浏览器重启后池自然失效（targetId 不复存在）。
 * @param {{ port: number, log?: object }} o
 */
export function createTabPool({ port, log }) {
  const owned = new Map() // moduleId → { targetId, wsUrl }

  /** 拿模块的 tab：有就复用，没有就新建。 */
  async function acquire(moduleId, { url = 'about:blank' } = {}) {
    const cur = owned.get(moduleId)
    if (cur) {
      // 确认它还活着：调试口的列表里还能找到
      const alive = await listPages(port).catch(() => [])
      if (alive.some((t) => t.id === cur.targetId)) return cur
      log?.debug?.(`模块 ${moduleId} 的标签页没了，重开一个`)
      owned.delete(moduleId)
    }
    const t = await openPage(port, url)
    const rec = { targetId: t.id, wsUrl: t.webSocketDebuggerUrl }
    owned.set(moduleId, rec)
    return rec
  }

  /** 模块卸载时关掉自己的 tab。 */
  async function release(moduleId) {
    const rec = owned.get(moduleId)
    owned.delete(moduleId)
    if (rec) await closePage(port, rec.targetId)
  }

  function size() { return owned.size }

  async function closeAll() {
    const ids = [...owned.values()].map((r) => r.targetId)
    owned.clear()
    for (const id of ids) await closePage(port, id)
  }

  return { acquire, release, closeAll, size, owned }
}