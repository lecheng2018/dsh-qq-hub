// 面板标签页 → 该页「脏标记」关心的配置根。零依赖，方便单测直接导入
// （nav.js 自己 import 了浏览器端的 react shim，Node 里跑不起来）。
//
// page.js 的 tabDirty() 只认这里列出的键：漏登记的表现是改完不出现「未保存」标记，
// 用户以为存上了，一关面板改动就静默丢失 —— files.maxMB / files.dirs / security.dangerConfirm
// 和连接页的 workspaceDir 就长期这么漏着（2026-11-22 补登记）。
// 新增控件时同步这张表，test/panel-tab-keys.test.js 会盯着。

export const TAB_KEYS = {
  connect: ['snowluma', 'botQQ', 'workspaceDir'],
  access: ['ownerQQ', 'ownerName', 'ownerLevel', 'longTasks', 'profilePerms', 'allow'],
  group: ['group', 'merge', 'reply', 'files', 'security'],
  model: ['model', 'chatModels'],
  voice: ['voice'],
  stickers: ['stickers'],
  imagegen: ['imageGen'],
  diary: ['diary', 'qzoneSocial'],
  speakup: ['speakUp'],
  memory: ['memory'],
  bili: ['bili'],
  douyin: ['douyin'],
  heybox: ['heybox'],
  multiParser: ['multiParser'],
  browser: ['browser'],
  local: ['local']
}
