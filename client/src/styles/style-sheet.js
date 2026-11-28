// 面板样式表的挂载与回收（与 React 无关，方便单测直接驱动）。
//
// 背景：DSH 侧栏壳页在插件升级后可能一直开着，里面还挂着旧版的 `<style id="qq-hub-css">`，
// 新 client.js 一看 id 已存在就跳过，结果新加的样式类（如扩展页的 .ab-modgroup*，真机 1.4.6：
// 分组头渲染成裸按钮）全部裸奔。所以这里按内容比对：一样就复用，不一样就原地替换。
//
// 另一半是卸载：面板是多标签页里的一张卡，切走/热更都会卸载组件。旧写法从不摘样式表，
// 插件停用后 `qq-hub-css` 一直留在宿主 <head> 上，继续影响 DSH 自己的界面（同类泄漏）。
// 用引用计数管住：还有别的实例在用就留着，最后一个走了才摘。

/** 样式元素 id（宿主里只该有一份）。 */
export const STYLE_ID = 'qq-hub-css'

/** 当前有多少个面板实例在用这张样式表。 */
let holders = 0

/**
 * 挂载样式表：没有就插一份，有但内容过期就原地改写（升级不刷新页面也能自愈）。
 *
 * @param {Document} doc 目标文档
 * @param {string} css 样式文本
 * @returns {Element} 页面上的那一份样式元素
 */
export function mountStyleSheet(doc, css) {
  holders += 1
  const existing = doc.getElementById(STYLE_ID)
  if (existing) {
    if (existing.textContent !== css) existing.textContent = css
    return existing
  }
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = css
  doc.head.append(style)
  return style
}

/**
 * 卸载一个持有者：最后一个卸载时才真的把样式表摘掉。
 *
 * @param {Document} doc 目标文档
 * @returns {boolean} 这次是否真的摘掉了样式元素
 */
export function releaseStyleSheet(doc) {
  holders = Math.max(0, holders - 1)
  if (holders > 0) return false
  const stale = doc.getElementById(STYLE_ID)
  if (!stale) return false
  if (typeof stale.remove === 'function') stale.remove()
  else if (stale.parentNode && typeof stale.parentNode.removeChild === 'function') stale.parentNode.removeChild(stale)
  return true
}

/** 当前持有者数量（测试与排障用）。 */
export function styleHolderCount() {
  return holders
}
