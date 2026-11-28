// 配置基础结构、默认值常量与深合并工具。

import { DEFAULT_GROUP_POLICY } from '../chat/group-policy.js'

// 配置结构版本：改了字段语义/默认值要 +1，方便按版本迁移老配置，避免无版本标记时的幂等覆写问题。
export const CONFIG_VERSION = 1

/** profilePerms 语义版本。1 = douyinDm 从「回别人私信」改成「主动发私信」，老配置一次性回落默认。 */
export const PROFILE_PERMS_VERSION = 1

/** 在某次更新里新增、会替她公开发东西的功能。以后再加这类功能，把配置键名加到这里。 */
export const OPT_IN_ON_UPDATE = ['qzoneSocial', 'bili', 'douyin']

/** group.maxPerHour 的语义版本。2 = 「每小时说话总条数」（令牌桶速率）；1/缺省 = 「每小时插话次数」。 */
export const GROUP_BUDGET_VERSION = 2

// 默认值一旦被外面改到，所有新装的用户都会跟着错，所以冻住。
// 注意要做「深」冻结，否则嵌套对象（model、visionHelper 等）仍然可改。
export const deepFreeze = (o) => {
  if (!o || typeof o !== 'object' || Object.isFrozen(o)) return o
  for (const v of Object.values(o)) deepFreeze(v)
  return Object.freeze(o)
}

export const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

export function deepMerge(base, over) {
  if (!isObj(over)) return structuredClone(base)
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    // 原型污染防护：__proto__ / constructor / prototype 绝不参与合并（面板与配置文件都是不可信输入）
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v)
    else if (v !== undefined) out[k] = v
  }
  return out
}

export const DEFAULTS_RAW = {
  configVersion: CONFIG_VERSION,
  enabled: false, // 总开关：关着一句都不发
  dryRun: true, // 试运行：只记日志不真发
  setupDone: false, // 首次使用向导走完了没有
  botQQ: '', // 机器人 QQ 号（向导里填）
  ownerQQ: '', // 主人 QQ 号（向导里填）
  ownerName: '主人',
  ownerLevel: 'full', // full | social | chat
  profilePermsVersion: PROFILE_PERMS_VERSION,
  profilePerms: { qqNickname: 'owner', qqSignature: 'owner', qqAvatar: 'owner', biliSign: 'owner', biliAvatar: 'owner', qqFriendRequest: 'owner', whitelist: 'owner', douyinBrowse: 'owner', douyinLike: 'owner', douyinComment: 'owner', douyinShareOwner: 'owner', douyinDm: 'owner' }, // 改资料类操作（含抖音浏览 / 点赞 / 评论 / 分享）的权限：off 关 / owner 仅主人私聊 / all 所有人。抖音项默认仅主人，总开关默认关
  longTasks: false, // 长任务模式：主人私聊（完整权限）额外挂 dsh-tool-jobs + dsh-tool-schedule，会多一点工具定义、稍慢
  turnTimeoutMs: 600000, // 单回合等待上限；超时释放调度槽，迟到回复不投递
  allow: { private: [], groups: [] }, // 主人永远能私聊，不用写进白名单
  // 用什么接 QQ：snowluma = 插件帮你管 SnowLuma（Windows）；onebot = 接你已有的 OneBot v11 机器人（NapCat、LLOneBot、Lagrange、Docker 里的 SnowLuma……），
  // 这时只按下面 snowluma.httpUrl / wsUrl / token 去连，不启动、不注入任何东西
  gateway: 'snowluma',
  workspaceDir: '',
  // QQ 会话放在哪个文件夹（DSH 里的「QQ Hub」工作区）；留空 = 默认（用户目录下 QQ Hub/qq-chats；
  // 从老版本升级、老目录 Aurabot/qq-chats 还在的会自动改名过来，见 chat/workspace.js）
  workspacePerChat: false, // 每个聊天单独建工作区（会多出很多工作区，默认关；跨聊天隔离靠会话作用域，不靠目录）
  // 发文件（#52）：默认开但限制很多——她只能把 QQ 工作区（workspaceDir）和 dirs 里列的目录中的文件当文件发出去；
  // 单个文件有大小上限；只有主人私聊里能触发（可以发给白名单里的人和群）。日志里会记下发了什么。
  // 收文件：别人发来的文件会下载到 QQ 工作区的 qq-inbox，inboundMaxMB 是单个文件的上限。
  // 上下行分开是两个数：出站只把路径丢给网关（几乎不占内存），入站要整包读进 Buffer，
  // 一条消息最多 3 个文件，所以入站口径必须比出站紧。
  files: { enabled: true, maxMB: 50, inboundMaxMB: 50, dirs: [] },
  // 危险命令确认（可选保护，默认关）：她在私聊里执行删根目录/格式化/关机/下载后直接执行等
  // 终端命令前，先发 QQ 私聊问主人，回复「确认」才执行；超时或「取消」就拦下。
  security: {
    dangerConfirm: false,
    // 身份泄露闸（移植自 surfcore）：出站前扫主人的 QQ 号 / 别的群号
    identityGuard: { enabled: true, mode: 'block' },
    // 面板入站防护（M1-A）：Host 白名单的额外放行名单（回环名与 IP 字面量默认放行）。
    // 用 DDNS 域名访问面板的在这里登记，如 ['nas.example.com']
    panel: { allowedHosts: [] },
  },
  snowluma: {
    dir: 'C:\\Aurabot\\snowluma', // 主人自己下载解压到这里（EULA 不允许自动部署）
    autoStart: true, // 随 DSH 启动它（只启动主人已安装并同意过协议的副本）
    webuiPort: 5099,
    webuiPassword: '', // 插件自动生成并保存（第一次启动 SnowLuma 时）；用来调 /api/processes 只给机器人号注入
    passwordAuto: false,
    autoAttach: true, // 自动给机器人号所在的 QQ 进程注入（绝不碰别的号）
    httpUrl: '', // 留空 = 从 SnowLuma 配置里自动读
    wsUrl: '',
    httpToken: '',
    wsToken: '',
  },
  model: { provider: '', model: '', reasoningEffort: 'low', vision: 'auto' }, // 留空 = 跟随 DSH 默认；vision: auto/on/off
  // 辅助看图模型（可选）：主模型看不了图时，临时把图片交给这个模型「看一眼」，
  // 把看到的内容转成文字交给主模型。主模型自己就能看图时不走这条路。
  // provider/model 留空 = 没配；只比较「同一个模型」还是「不同模型」，不做任何能力猜测。
  visionHelper: { enabled: false, provider: '', model: '', maxImages: 4, maxChars: 600, keepOriginal: true },
  // 会话轮换：一个聊天用太久就自动归档重开。
  // 为什么需要：服务端按**会话**累计上下文（真机 413 plugin_request_too_large：请求约 5.8 MiB、
  // 插件内存上限 64 MiB），纯文字长谈也会慢慢顶到上限；DSH 的上下文压缩管的是 token 窗口，
  // 管不到服务端那种按字节的会话额度。阈值同时看「回合数」和「会话年龄」，任一到了就换
  //（填 0 = 该项不启用；只留一项就是单条件轮换）。
  // 会话轮换（人设灰度的兜底）：人设是建会话时固化的，轮换是唯一「不用主人动手也会换卡」的时机。
  // 300 轮 / 168h 等于关掉了这个兜底（真机：卡改了半小时，49 个群会话还停在旧正文）。
  // 现在 60 轮 / 24h。老配置里那对「300/168」按未迁移处理，一次性换成新默认（见 config-migrations）。
  sessionRotation: { enabled: true, maxTurns: 60, maxAgeHours: 24, migrated: true },
  // 孤儿会话巡检：QQ 工作区里既不在聊天映射、也不在后台系统会话池的历史会话
  //（典型来源：服务重启后内存里的 system:<key> 映射丢了，旧的后台会话失联）
  // 会定期静默归档，免得侧栏越攒越多。闲置门槛（idleHours）是安全垫：刚建的会话不动。
  orphanSweep: { enabled: true, idleHours: 6, intervalHours: 6, maxPerPass: 20 },
  // 图片进历史的预算（每个会话）：服务端对「会话累计上下文 + 图片」有硬上限
  //（真机 413 plugin_request_too_large：请求约 5.8 MiB / 插件内存上限 64 MiB）。
  // 图片块一旦进历史，之后每一轮都会重新发一遍，所以额度必须**按会话**累加着算，
  // 而不是每轮重置。额度用完后的新图只留一句占位文字，不再进上下文。
  imageBudget: { enabled: true, maxImages: 24, maxMiB: 12 },
  // 共享浏览器（抖音/小红书/红果/贴吧这些要开网页的模块共用一套）。
  // 一个浏览器进程、每模块一个标签页、任务串行：可用内存本来就小，多开必炸。
  // chromePath 留空 = 先用插件自带的（install:browser 装的那份），再找系统里的 Edge/Chrome/Chromium。
  browser: {
    enabled: true,
    chromePath: '', // 留空 = 自动找
    headless: false, // 默认有头（抖音/小红书会拦无头）；没桌面时靠自带 Xvfb 撑
    chrome: true, // 装的时候优先官方 Chrome（视频编解码更全）；false = 直接用 Debian chromium
    maxConcurrent: 2, // 同时最多几个模块在用浏览器
    idleMinutes: 10, // 没人用这么久就关掉浏览器（0 = 不自动关）
    minFreeMB: 600, // 可用内存低于这个值就不启动（0 = 不检查）
    vncLan: false, // 远程看画面是否开给局域网（默认只绑本机；要跨机器看得自己开，且有密码）
  },
  // 按聊天选模型（主人在面板「模型」页设）：私聊 QQ 号 > 群号 > 所有私聊 / 所有群默认 > 上面的全局模型；没写的一级退到下一级
  chatModels: { privateDefault: { provider: '', model: '', reasoningEffort: '' }, groupDefault: { provider: '', model: '', reasoningEffort: '' }, privates: {}, groups: {} },
  merge: { enabled: true, waitSec: 2.5, maxSec: 8, groupWaitSec: 5, groupMaxSec: 15 },
  // 分条：她自己断的句（|||）优先，字数只当兜底。群里句子短、私聊可以长一点。
  reply: { groupMaxChars: 40, privateMaxChars: 120, maxBubbles: 6, keepReports: true }, // 分条只走规则：她写的 ||| 优先，字数只当兜底
  imageGen: {
    enabled: false,
    provider: 'openai', // openai / custom；codex = 实验性订阅接法（需单独登录）
    baseUrl: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    shape: 'her', // 工具可选构图；her 时未指定就沿用 size
    stylePrompt: '', // 每次生图自动加在前面的风格描述
    ownerOnly: true, // 只有主人能让她画
    seeOwn: true, // 「让她画完自己看一眼」：开着才把画好的图交给她看
    galleryShown: 20, // 面板「她的画作」显示最近几张（1~50；只影响显示，不删文件）
    // 自定义接法：url 里可以用 {prompt} {model} {size} {width} {height}；params 是参数名/值（值里也能用这些占位符）
    custom: { method: 'GET', url: '', bodyType: 'json', responsePath: '', params: [] },
    // 实验性订阅接法；登录令牌独立保存在数据目录，不进入配置。
    codex: { model: 'gpt-image-2', quality: 'auto', background: 'auto' },
  },
  // 人设：current 是全局默认；personaMap 按聊天覆盖（形状和 chatModels 一致，优先级也一样）
  //   某个群/私聊单独指定 > 群默认/私聊默认 > current
  persona: {
    current: 'dafeiyu',
    privateDefault: '', // 留空 = 用 current
    groupDefault: '',
    privates: {}, // { '10000001': 'persona-id' } pii-scan:ignore
    groups: {}, // { '333444555': 'persona-id' } pii-scan:ignore
  },
  // 主人私聊里问起群里的事：把最近 24 小时的群聊流水补进这一轮（默认关，开启前先把群加进白名单）
  group: {
    ...DEFAULT_GROUP_POLICY, overrides: {},
    ownerBrief: { enabled: false, lines: 12, groups: [] },
    // 鱼群保护（移植自 surfcore）：同群同类 bot 太多时本轮不参与。名列表留空 = 用模块默认值
    fishGuard: { enabled: true },
    // 群发送配额：QQ 群每分钟最多 10 条，超了消息会真丢（等窗口/重试）
    quota: { enabled: true, perMinute: 10, reserve: 1 },
  },
  // 按群头衔不回：勾选的群里，专属头衔正好是 title 的成员（一般是别的机器人）说话、戳她都不理。没勾群就不起作用
  voice: {
    enabled: true,
    // auto = 先 edge-tts，不行用 Windows 语音；edge / windows / cosyvoice / gptsovits / http /
    // doubao / qwentts / mimo = 指定引擎（失败都会退回 edge-tts 或 Windows 语音）
    engine: 'auto',
    cosyvoice: { url: 'http://127.0.0.1:50000', mode: 'sft', spkId: '中文女', instruct: '', sampleRate: 22050 },
    gptsovits: { url: 'http://127.0.0.1:9880', refAudio: '', promptText: '', promptLang: 'zh', textLang: 'zh' },
    // 通用 HTTP TTS：GET 地址模板（{text} 替换成要念的话）；POST 时配请求头/请求体，
    // 可接火山豆包 / 阿里 / 讯飞这类要鉴权的云 TTS（JSON 里的 base64 音频自动解出）
    http: { urlTemplate: '', method: 'GET', headers: '', body: '' },
    // 豆包语音 2.0（火山引擎，语义移植上游社区模块 voice）：X-Api-Key 鉴权，流式 NDJSON 返回 base64 WAV 分片
    doubao: { apiKey: '', resourceId: 'seed-icl-2.0', speaker: 'S_1CmxEOek2', speechRate: 0, contextTexts: '', autoEmotion: true, timeout: 60 },
    // 阿里百炼 qwen-tts（DashScope SpeechSynthesizer；语义移植上游 qwen-tts 模块）
    qwentts: {
      apiKey: '', baseUrl: 'https://dashscope.aliyuncs.com', audioOrigin: '', model: 'qwen-audio-3.1-tts-flash', voice: 'Cherry',
      speechRate: 1.0, sampleRate: 24000, seed: 20261, maxCharsPerSegment: 300, timeoutMs: 30000,
      instruction: '用日常聊天说话的语气，像在手机上随口跟朋友讲话，语速略快，不要播音腔。中文。',
    },
    // 小米 MiMo TTS（OpenAI 兼容 chat/completions；语义移植上游 aura-mimo 模块）：
    // voiceclone 模型用参考音频（本机路径）克隆音色，voicedesign 模型用音色描述
    mimo: { apiKey: '', apiBase: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-tts-voiceclone', stylePrompt: '', seedText: '', refAudio: '', timeout: 180 },
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+0%',
    pitch: '+0Hz',
    autoChance: 0.15, // 短回复自动变语音的概率
    autoMaxChars: 80,
    asr: true, // 听语音
  },
  stickers: {
    enabled: true,
    faces: true, // 回复里能夹 QQ 自带的小黄脸（<face:名字>）
    autoChance: 0.35, // 文字回复自动配一张表情的概率
    collect: true, // 偷表情
    // 怎么偷：auto = 看到就收（默认，保持原行为）；ask = 她挑（先记着，喜欢才凭编号收）；owner = 只听主人的（只有主人语境下才提示/允许收）
    collectMode: 'auto',
    fromGroups: true,
    fromPrivate: true,
    maxPerHour: 20,
    maxLibrary: 300, // 表情库最多存多少张（QQ 收藏表情有上限），超了就清掉最少用的
    caption: true, // 用视觉模型起备注
    maxSide: 1920, // 收表情时单边像素上限
    maxBytes: 5 * 1024 * 1024, // 静态表情体积上限
    maxGifBytes: 10 * 1024 * 1024, // GIF 动图体积上限
    cooldownSec: 0, // 自动配表情冷却（0 = 不冷却）；显式发不受影响
    sendMaxPerHour: 0, // 自动配表情每小时上限（0 = 不限）
    webpToJpeg: false, // WebP 发送前转 JPEG（兼容优先，会丢动画）
    overrides: {}, // 按群覆盖：{ 群号: { enabled, autoChance, collect, ... } }
  },
  diary: {
    enabled: true,
    timesPerDay: 2,
    windowStart: '10:00',
    windowEnd: '23:30',
    minGapMinutes: 180,
    attachImage: true, // 写日记时配一张图（优先今天她画的，其次今天收的表情包）
    minChars: 60,
    maxChars: 140,
    // 审计 S07：默认「仅自己可见」。日记素材可能来自多个会话（见 includeChats），
    // 出厂就公开等于把私聊内容默认推到好友圈。
    visibility: 'self', // all | friends | selected | self | excluded，和 QQ 空间自身的可见范围一致
    audienceQQs: '', // selected / excluded 时可见（或不可见）的好友 QQ 号，换行或逗号分隔
    // 审计 S07：哪些会话的聊天内容允许进入日记素材。空数组 = 不引用任何聊天，
    // 日记只写她自己的事（今天画了什么、在想什么）。
    // 过去无条件把「所有非 system 会话」的当天流水混成一份摘要交给模型，
    // 于是私聊内容会被改写成第一人称说说发到空间。
    includeChats: [],
  },
  // 本地接口：数据目录 local/ 里的脚本接管这几项（文件要在、开关要开）
  local: { tts: false, image: false, asr: false },
  bili: {
    enabled: false,
    sessdata: '', // B 站 Cookie 里的 SESSDATA（登录凭证）
    biliJct: '', // B 站 Cookie 里的 bili_jct（发评论要用）。两个都不填也能看视频，只是不能评论
    cookie: '', // 由上面两个拼出来给接口用；老配置的整串会自动拆到上面两个里
    autoBrowse: true, // 定时自己去刷
    intervalHours: 4, // 多久刷一轮
    maxRunsPerDay: 3,
    perRun: 3, // 一轮看几个视频
    keywords: [], // 额外想让她搜的方向（另外还会参考她的兴趣和记忆里你喜欢的东西）
    minViews: 5000, // 播放量门槛
    maxAgeDays: 60, // 只看最近多少天发的
    comment: true, // 自己发评论
    maxCommentsPerDay: 3,
    reply: true, // 回别人回她的评论
    maxRepliesPerDay: 6,
    shareToOwner: true, // 看到好玩的私聊分享给主人
    like: false, // 顺手点赞
    vision: false, // 可选：ffmpeg 抽帧交给视觉模型
    visionFrames: 6,
    ffmpegPath: '', // 留空从 PATH 查找
    shotChance: 0.35, // 刷完发截图给主人；0 = 不自动发
    shotLibrary: 300,
    // 单独给 B 站选一个模型（需要商店 B 站模块 1.2.0+）：刷 B 站的后台回合 + 看画面都用它。
    // 留空 = 跟随全局模型（老行为）。provider/model 两个都填才算数，见 modules/bili 的 biliModelOf。
    model: { provider: '', model: '', reasoningEffort: '' },
  },
  // 刷抖音：专用浏览器（独立登录资料，不碰你平时的浏览器），经 CDP 控制。浏览 / 点赞 / 评论 / 分享各项权限在 profilePerms.douyin*。
  douyin: {
    enabled: false, // 总开关：默认关，先在面板里扫码登录再打开
    autoBrowse: true, // 定时自己去刷
    intervalHours: 4,
    maxRunsPerDay: 3,
    perRun: 5, // 一轮看几个视频
    maxWatchPerDay: 30, // 每天最多看几个（手动让她刷也算；主人亲口让她找视频时不受这个限制）
    dwellMin: 8, // 每个视频停留的秒数（随机取一个）
    dwellMax: 40,
    browserPath: '', // 留空 = 自动找 Edge（找不到再找 Chrome / Chromium）；也可填完整路径
    shareBias: 'proactive', // stingy | normal | proactive：刷到好看的视频，分享给主人的积极程度
    ownerDm: true, // 主人在抖音上私信她时回（只认核对过的主人抖音号）
    dmPollMinutes: 3, // 隔几分钟看一次主人的抖音私信
    shareTo: 'douyin', // douyin = 在抖音里私信分享给主人（要先核对主人抖音号，没核对 / 发不出去就改发 QQ）| qq = QQ 私聊发链接 | both = 两边都发
    owner: { input: '', secUid: '', uid: '', nickname: '', confirmedInput: '' }, // 主人的抖音号：面板填抖音号 / 主页链接，「核对」后才写入 secUid（真·@主人只认它）
    caps: { like: 30, comment: 3, share: 5, atOwner: 3 }, // 每天上限（登录后前 newAccountDays 天减半）；atOwner = 评论里真·@主人
    gate: {
      maxWritesPerDay: 40, // 点赞 + 评论合计上限
      minWriteGapSec: 20, // 两次点赞 / 评论之间至少隔这么多秒
      newAccountDays: 3, // 首次登录起这么多天内，上限都减半
    },
  },
  // 刷小黑盒：用主人的账号逛游戏社区（读多写少）。点赞 / 评论 / 发帖各项权限在 profilePerms.heybox*。
  heybox: {
    enabled: false, // 总开关：默认关，先在面板里填 Cookie 再打开
    cookie: '', // 整串 Cookie（pkey 必须有；要写操作还得有 x_xhh_tokenid）
    autoBrowse: true, // 定时自己去逛（只读）
    intervalHours: 4, // 多久逛一圈
    maxRunsPerDay: 6, // 每天最多逛几轮
    perRun: 3, // 一圈看几条
    likeDaily: 10, // 每天最多点赞
    commentDaily: 3, // 每天最多评论
    maxPostsPerDay: 3, // 每天最多发帖（硬上限，多了容易被限）
    defaultTopic: 7214, // 发帖默认分区：7214 盒友杂谈 / 18745 数码硬件 / 806933 AI
    postStyle: 'mix', // 发帖风格：diary 大肥鱼日记 / news 热搜文 / mix 肥鱼热搜
  },
  qzoneSocial: {
    enabled: true,
    replyOwn: true, // 回复自己说说下别人的新评论
    commentFriends: true, // 逛好友动态，偶尔评论
    friendChance: 0.3, // 看到一条好友说说时互动（点赞 + 可能评论）的概率
    ownerChance: 0.7, // 主人的说说互动概率
    like: true, // 互动时顺手点赞
    maxPerDay: 8, // 每天最多评论几条（点赞不算）
    intervalMin: 30, // 多久逛一次空间
  },
  speakUp: {
    enabled: true, // 只在和主人的私聊里主动找你，群里不会
    idleMinutes: 40,
    minIntervalMinutes: 60,
    maxIntervalMinutes: 180,
    maxPerDay: 4,
    nudge: true, // 她问了你一句、你一直没回时，偶尔轻轻追一句
    awakeFrom: 8,
    awakeTo: 23,
    // 早安 / 晚安：到点必发一次（不参与随机间隔抽签），每天每种只发一次
    greeting: { enabled: true, morning: '08:00', night: '23:00' },
  },
  memory: { enabled: true, recallCount: 6, hintCount: 8, hintMaxChars: 600, dailyConsolidate: true, consolidateTimes: ['04:00', '16:00'], embeddings: { enabled: false, url: '', apiKey: '', model: 'BAAI/bge-m3', dim: 1024, timeoutMs: 8000, batch: 16, maxChars: 200 } }, // 每天这几个时间把临时记忆（聊天流水）整理进长期记忆、相处经验和说话方式；过了一天的流水整理完清空。embeddings：向量通道（1.4.4），默认关 —— 填一个 OpenAI 兼容的 /embeddings 端点（如 SiliconFlow BAAI/bge-m3）并 enabled: true 才启用语义召回
  // 多平台内容解析器（移植自 astrbot_plugin_multi_parser）
  multiParser: {
    enabled: false,              // 模块总开关，默认关
    inGroups: true,              // 群聊里要不要提供解析（关掉就只在私聊解析，群里连链接都不碰）
    inPrivate: true,             // 私聊里要不要提供解析
    disabledGroups: [],          // 这些群单独关掉（即使 inGroups 开着）
    feedToAi: true,              // 🌟 AI 注入开关（把标题、作者、正文摘要喂给当前大模型会话让它读懂并接话）
    sendMedia: true,             // 媒体发送开关（是否向 QQ 发送解析后的视频或图文）
    forwardMode: 'threshold',    // threshold / always / never
    imageThreshold: 2,           // 超过几张图自动转合并转发卡片
    maxVideoMB: 100,             // 视频直接发送上限 (MB)
    videoOverLimit: 'direct_link', // direct_link / group_file / notice
    platforms: {
      bilibili: true,
      douyin: true,
      redbook: true,
      weibo: true,
      zhihu: true,
      wechat: true,
      tieba: true,
      fanqie: true,
      github: true,
      xiaoheihe: true,
    },
    cookies: {
      bilibili: '',   // B站 Cookie，留空自动复用 bili.cookie
      weibo: '',      // 微博 Cookie (SUB 等)
      redbook: '',    // 小红书 Cookie (a1, web_session 等)
      zhihu: '',      // 知乎 Cookie (z_c0 等)
      tieba: '',      // 百度贴吧 Cookie (BDUSS 等)
      douyin: '',     // 抖音 Cookie
      xiaoheihe: '',  // 小黑盒 Cookie，留空自动复用 heybox.cookie
    },
  },
  tabs: {}, // 面板记住的小偏好
  // 模块：内置的和数据目录 modules/ 里自己写的。{ 模块id: { enabled, useBuiltin } }，没写的算开着
  // useBuiltin：自己写了同名模块，但想先用回内置的
  modules: {
    // 模块市场（分发半套）：默认 OFF；indexUrls 按序 failover；installed 记账
    market: { enabled: false, indexUrls: [], httpProxy: '', installed: {} },
  },
  safeMode: false, // 安全模式：自己写的模块一个都不加载（排查问题用）
  ext: {}, // 自己写的模块的设置：{ 模块id: {...} }
  // 联动：让别的程序、DSH 里别的会话和插件也能用她
  bridge: {
    dshTools: false, // DSH 里别的会话（比如你平时写代码的会话）能用工具让她发 QQ、查记忆
    http: false, // 开放 HTTP 接口（要带密钥）
    token: '', // 第一次打开时自动生成
    allowTargets: 'whitelist', // 外部能发给谁：whitelist = 白名单里的人和群；owner = 只能发给主人
  },
}

export const DEFAULTS = deepFreeze(DEFAULTS_RAW)
