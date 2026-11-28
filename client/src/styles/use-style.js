import { useEffect } from '../core/react.js'
import themeCss from './theme.css'
import { mountStyleSheet, releaseStyleSheet } from './style-sheet.js'

export const CSS = themeCss

// 样式注入：挂载/回收的细节在 ./style-sheet.js（那里与 React 无关，可被单测直接驱动）。
// 这里只负责把这个副作用挂到组件生命周期上：
// - 挂载时按 id 找样式表，内容不一样就原地替换（升级不刷新页面也能自愈，见 style-sheet.js 注释）；
// - 卸载时释放一次持有；最后一个实例走了才把 <style> 从宿主 head 里摘掉，
//   否则插件停用/切走后样式表会一直糊在 DSH 界面上。
export function useStyle(doc = globalThis.document) {
  useEffect(() => {
    mountStyleSheet(doc, CSS)
    return () => {
      releaseStyleSheet(doc)
    }
  }, [doc])
}
