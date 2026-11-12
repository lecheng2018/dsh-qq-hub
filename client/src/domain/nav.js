import { h } from '../core/react.js'

const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'connect', label: '连接' },
  { id: 'persona', label: '人格' },
  { id: 'access', label: '权限' },
  { id: 'group', label: '聊天', flag: 'group' },
  { id: 'model', label: '模型' },
  { id: 'voice', label: '语音', flag: 'voice.enabled' },
  { id: 'stickers', label: '表情包', flag: 'stickers.enabled' },
  { id: 'imagegen', label: '生图', flag: 'imageGen.enabled' },
  { id: 'diary', label: '空间日记', flag: 'diary.enabled' },
  { id: 'speakup', label: '主动搭话', flag: 'speakUp.enabled' },
  { id: 'mood', label: '心情与记忆', flag: 'mood.enabled' },
  { id: 'bili', label: 'B站', flag: 'bili.enabled' },
  { id: 'douyin', label: '抖音', flag: 'douyin.enabled' },
  { id: 'heybox', label: '小黑盒', flag: 'heybox.enabled' },
  { id: 'multiParser', label: '内容解析', flag: 'multiParser.enabled' },
  { id: 'rss', label: '资讯池' },
  { id: 'local', label: '本地接口' },
  { id: 'modules', label: '扩展' },
  { id: 'logs', label: '日志' },
]
// 内置标签页属于哪个模块：模块都没在跑就不显示这一页
const TAB_MODS = { voice: ['voice'], stickers: ['stickers'], imagegen: ['imagegen'], diary: ['diary', 'qzone-social'], speakup: ['speakup', 'purpose'], mood: ['mood', 'memory'], bili: ['bili'], douyin: ['douyin'], heybox: ['heybox'], multiParser: ['multi-parser'] }
const modOn = (st, id) => (st.modules || []).some((m) => m.id === id && m.running)

// 两层导航：上面一排是分组，下面一排是这组里的页面；每组记住上次看的那页，Alt+K 查找功能
// （分组导航的思路来自社区贡献的「导航布局」扩展，这里改成面板自己实现）
const NAV_GROUPS = [
  { id: 'home', label: '概览', icon: 'M3 10.5 12 3l9 7.5M5.5 9v11.5h13V9M10 20.5v-6h4v6', tabs: ['overview'] },
  { id: 'self', label: '人设', icon: 'M12 12.5a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5zM4.5 20.5c.9-3.6 3.9-5.5 7.5-5.5s6.6 1.9 7.5 5.5', tabs: ['persona', 'group', 'speakup', 'mood'] },
  { id: 'express', label: '表达', icon: 'M20.5 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.4A8 8 0 1 1 20.5 11.5zM9 13.2s1.1 1.5 3 1.5 3-1.5 3-1.5M9.5 9.6h.01M14.5 9.6h.01', tabs: ['voice', 'stickers', 'imagegen'] },
  { id: 'platform', label: '平台', icon: 'M3.5 6.5h17v11h-17zM10.5 9.8v4.4l3.8-2.2z', tabs: ['diary', 'bili', 'douyin', 'heybox', 'multiParser'] },
  { id: 'system', label: '系统', icon: 'M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1M15 5v4M9 10v4M17 15v4', tabs: ['connect', 'model', 'access', 'local', 'modules', 'logs'] },
]
// 自己写的模块：名字像逛平台的放「平台」，其余放「系统」（排在「日志」前面）
const PLATFORM_EXT = /逛|刷|B站|抖音|小红书|闲鱼|淘宝|微博|知乎|贴吧|快手|触站|小黑盒/
const navGroupOf = (t) => NAV_GROUPS.find((g) => g.tabs.includes(t.id)) || (t.ext && PLATFORM_EXT.test(t.label) ? NAV_GROUPS[3] : NAV_GROUPS[4])
const navOrder = (g, t) => { const i = g.tabs.indexOf(t.id); return i >= 0 ? i : g.tabs.length - (g.tabs.includes('logs') ? 1.5 : 0) }
const NAV_ALIAS = {
  overview: '首页 状态', connect: 'qq 网关 snowluma onebot 登录 工作区', persona: '人设 性格 设定 头像', access: '主人 白名单 权限 群管 改资料',
  group: '群聊 插话 合并', model: 'ai 大模型 视觉 思考强度', voice: '语音 tts 说话 音色 edge', stickers: '表情 小黄脸 gif 商城表情',
  imagegen: '画图 图片', diary: '空间 说说 日记', speakup: '搭话 主动', mood: '心情 记忆',
  bili: 'b站 bilibili 视频', douyin: '抖音 短视频 私信', heybox: '小黑盒 游戏 社区 资讯', multiParser: '内容解析 多平台 链接 解析 视频 图文 小红书 微博 知乎 贴吧 b站 抖音 微信', local: '本地 接口 sd sovits', modules: '扩展 模块 插件', logs: '日志 报错',
}

export const TAB_KEYS = {
  connect: ['snowluma', 'botQQ'],
  access: ['ownerQQ', 'ownerName', 'ownerLevel', 'longTasks', 'profilePerms', 'allow'],
  group: ['group', 'merge', 'reply'],
  model: ['model', 'chatModels'],
  voice: ['voice'],
  stickers: ['stickers'],
  imagegen: ['imageGen'],
  diary: ['diary', 'qzoneSocial'],
  speakup: ['speakUp'],
  mood: ['mood', 'memory'],
  bili: ['bili'],
  douyin: ['douyin'],
  heybox: ['heybox'],
  multiParser: ['multiParser'],
  rss: ['rss'],
  local: ['local']
}

export {
  TABS, TAB_MODS, modOn, NAV_GROUPS, PLATFORM_EXT, navGroupOf, navOrder, NAV_ALIAS
}
