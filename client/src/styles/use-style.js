import { useEffect } from '../core/react.js'
import themeCss from './theme.css'

export const CSS = themeCss

// 样式注入：不能只看「页面上有没有 qq-hub-css」——DSH 侧栏壳页在插件升级后可能一直开着，
// 里面还挂着旧版的样式表，新 client.js 一看 id 已存在就跳过，结果新加的样式类
// （如扩展页的 .ab-modgroup*，真机 1.4.6：分组头渲染成裸按钮）全部裸奔。
// 对比内容：一样就复用，不一样就原地替换——升级不刷新页面也能自愈。
export function useStyle() {
  useEffect(() => {
    const existing = document.getElementById('qq-hub-css')
    if (existing) {
      if (existing.textContent === CSS) return
      existing.textContent = CSS
      return
    }
    const s = document.createElement('style')
    s.id = 'qq-hub-css'
    s.textContent = CSS
    document.head.appendChild(s)
  }, [])
}
