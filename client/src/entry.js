import { installInnerFold } from './core/inner-fold.js'
import { WhaleIcon } from './ui/icons.js'
import { QQHubPage } from './shell/page.js'

const inject = ['slots']
const PANEL_ID = 'qq-hub'

function apply(ctx) {
  // 正文里 <inner> 心智独白的折叠：纯显示层（QQ 侧本来就 100% 剥离，这里只是别让主人在会话里
  // 看到一坨标签）。放在面板注册之前——面板依赖缺了也要折，见 core/inner-fold.js。
  ctx.effect(() => installInnerFold(), 'qq-hub: 正文里的 <inner> 独白折成一行')
  const slots = ctx.get('slots')
  if (slots === undefined) return
  // 写法同 DSH 自带的「自动化任务」（order 10）和「插件」（order 0）：排在它们后面
  slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, QQHubPage))
  slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'QQ Hub' }, WhaleIcon))
}

export { apply, inject, QQHubPage, WhaleIcon }
