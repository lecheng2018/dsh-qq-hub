import { WhaleIcon } from './ui/icons.js'
import { QQHubPage } from './shell/page.js'

const inject = ['slots']
const PANEL_ID = 'qq-hub'

function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  // 写法同 DSH 自带的「自动化任务」（order 10）和「插件」（order 0）：排在它们后面
  slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, QQHubPage))
  slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'QQ Hub' }, WhaleIcon))
}

export { apply, inject, QQHubPage, WhaleIcon }
