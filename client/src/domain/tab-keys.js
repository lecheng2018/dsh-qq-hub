// 面板标签页 → 该页「脏标记」关心的配置根。零依赖，方便单测直接导入
// （nav.js 自己 import 了浏览器端的 react shim，Node 里跑不起来）。
//
// page.js 的 tabDirty() 只认这里列出的键：漏登记的表现是改完不出现「未保存」标记，
// 用户以为存上了，一关面板改动就静默丢失 —— files.maxMB / files.dirs / security.dangerConfirm
// 和连接页的 workspaceDir 就长期这么漏着（2026-11-22 补登记）。
// 新增控件时同步这张表，test/panel-tab-keys.test.js 会盯着。

export const TAB_KEYS = {
  // gateway 是「接哪个 QQ 网关」（snowluma / onebot）本身的开关，改它原来不出现未保存标记。
  connect: ['gateway', 'snowluma', 'botQQ', 'workspaceDir'],
  access: ['ownerQQ', 'ownerName', 'ownerLevel', 'longTasks', 'profilePerms', 'allow'],
  // turnTimeoutMs 原来由裸 input 直接写路径，没登记（改了不出现「未保存」）。
  // 2026-11-24 换成 f.num 之后测试当场逮到，补进这张表。
  group: ['group', 'merge', 'reply', 'files', 'security', 'turnTimeoutMs'],
  // visionHelper：视觉判定用哪个模型（「看图」那一段的模型选择），漏登记同样会静默丢改动。
  model: ['model', 'chatModels', 'visionHelper'],
  voice: ['voice'],
  stickers: ['stickers'],
  // persona 页改的是整棵 persona 树（当前人格 / 按聊天指定 / 开场白……），原来整页都没登记。
  persona: ['persona'],
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
