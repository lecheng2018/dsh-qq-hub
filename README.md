# DSH-QQ-Agent · 住在 QQ 里的智能伙伴与 DSH Agent 交互终端

[![GitHub Release](https://img.shields.io/github/v/release/lecheng2018/dsh-qq-agent?color=blue&logo=github)](https://github.com/lecheng2018/dsh-qq-agent/releases)
[![Tests](https://img.shields.io/badge/tests-746%20passed-success?logo=node.js)](https://github.com/lecheng2018/dsh-qq-agent/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-0969da)](https://github.com/deepseek-ai)

**DSH-QQ-Agent** 是为 **DeepSeek Harness (DSH)** 深度定制的进程内原生插件（In-Process Native Plugin），基于 `@deepseek-ai/cordis` 微内核架构构建。

它兼具 **顶尖的拟人化社交聊天伙伴** 与 **强大的生产力 Agent 远程交互终端** 双重能力：
- **拟人伙伴**：有性格、有心情、懂记忆。看图、听发语音、发表情包、RVC 翻唱变声、写空间日记、刷 B 站/抖音/小黑盒，以及常驻屏幕边缘的互动桌面宠物。
- **Agent 终端**：在手机 QQ 端直接操控 DSH。支持**交互式提问（`ask_user_question`）**、**高危工具审批流（`approval/request`）**、**断线消息自动补收（`backfill`）**、**全功能定时任务调度（`/remind`）**、**RFC 6238 TOTP 手机动态口令锁**与**私聊/群聊记忆物理隔离**。

```
QQ 移动/桌面端 ⇄ OneBot v11 网关 (SnowLuma / NapCat) ⇄ DSH-QQ-Agent 插件 (Cordis 4) ⇄ DSH 会话 (预设物理隔离)
```

---

## 📌 本次修改清单（v1.2.0 重构、加固与文档完善）

本版本对项目进行了全面的生产力升级、架构解耦、安全审计与文档重构：

### 1. 核心 Agent 交互与生产力闭环
- **交互式多选提问系统 (`src/chat/questions.js`)**：接入 DSH `userQuestions` 抽象。模型触发澄清提问时，格式化为带 `A./B./C.` 编号的 QQ 卡片，支持字母、连写（`A,C` / `ac`）、编号、模糊匹配与自定义自由作答，带 5 分钟超时兜底与回执反馈。
- **通用工具审批流 (`src/chat/approvals.js`)**：接入 DSH `approval/request` 瀑布流。执行敏感工具前向主人私聊推送编号审批卡（`#1`、`#2`...），展示真实脱敏命令与原因，支持回复「通过 #1」「拒绝 2」「放行」即时批复，带 60 秒超时自动拦截。
- **断线消息自动补收 (`src/chat/backfill.js`)**：检测到连接断档（>2 分钟）并在恢复后，自动拉取错过的群聊与私聊历史；严格执行安全命令隔离，严禁执行迟到命令与审批，注入带时间戳的上下文提示词。
- **全功能通用定时调度器 (`src/modules/scheduler/`)**：移植完整调度引擎，支持 `once`、`in 30m`、`daily`、`workdays`、`weekly`、`interval` 与 `Cron`；提供主人私聊 `/remind` 管理指令，并向模型暴露 `schedule_reminder` 原生工具。
- **多平台内容解析器 (`src/modules/multi-parser/`)**：移植自 astrbot_plugin_multi_parser，自动识别 10+ 平台链接（B站/微博/小红书/知乎/微信/贴吧/番茄/GitHub等），提取无水印视频与高清图集；支持合并转发防刷屏、大视频转群文件；集成独立 AI 上下文注入开关 (`feedToAi`)，并在控制面板「平台」页新增专属设置选项卡。

### 2. DSH 增强五件套模块内置化
- **`security-lock`**：纯 `node:crypto` 实现 RFC 6238 TOTP 手机动态口令，提供 `/unlock` 提权与 30 分钟生命周期。
- **`token-guardian`**：估算会话上下文 Token，达阈值且空闲时自动调用 DSH compaction 压缩历史。
- **`complete-guard`**：识别停留在连接词或未闭合括号上的截断回复，提供截断告警。
- **`memory-privacy`**：私聊（`private`）、群聊（`group`）与全局（`global`）三层作用域隔离，群聊物理阻断私聊记忆。
- **`slang-learner`**：自动挖掘群聊黑话，主人审核后方可注入群上下文。

### 3. 全量安全审计与稳定性加固（16 项缺陷修复）
- **高危修复**：修复 `heybox` 模块 `hasLogin()` 未定义导致定时器抛错崩溃；修复 `douyin` 浏览器跳转与 `net.js` 302 重定向导致的内网 SSRF 风险；为 `studio.js` 的 `ffmpeg` 调用增加 15s 超时强杀防死锁；将记忆库 `recall` 统计覆写解耦为内存防抖回写，防止冲掉事实记忆。
- **中危修复**：Windows 环境下文件原子写入引入 `renameWithRetry` 消除 `EPERM` 偶发崩溃；修复 OAuth 报错分支端口未释放泄漏；翻唱异常分支补齐临时切片目录清理；OneBot 客户端引入 90s 心跳保活看门狗。
- **规范治理**：全模块数据存储统一收敛至 `api.dataDir`，彻底消除各模块在全局数据目录的 `state.json` 冲突。

### 4. 拟人排版优化与 CI/CD 自动化发版
- **回复引擎排版增强 (`src/chat/reply.js` & `personas.js`)**：`stripMarkdown` 在数字列表项前自动补空行撑开呼吸感，分割线转换为 QQ 细分界线；系统规则增加长内容与推荐排版指引，彻底解决“密集字砖”阅读压迫感。
- **自动工作流 (`.github/workflows/release.yml`)**：push `main` 分支时自动触发 746 个测试用例门禁，0 失败后自动提取 `CHANGELOG.md` 生成 Release 并打包发布 `.tgz` 离线插件包。

---

## 🚀 快速上手

### 1. 前置环境要求
- **Node.js**：≥ 22.13.0
- **DSH 宿主**：DeepSeek Harness 0.2.x 或 0.3.x（已配置可用模型）
- **QQ 机器人网关**（二选一）：
  - **Windows 首选**：下载并解压 [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases)（插件支持自动管理启停与号段注入）；
  - **Linux / Docker / macOS / 自建**：运行 [NapCat](https://github.com/NapNeko/NapCatQQ) 或任意 OneBot v11 服务，开启正向 WebSocket 服务端（如 `ws://127.0.0.1:3001`）。

### 2. 安装插件

#### Windows 桌面版 (PowerShell)
```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:lecheng2018/dsh-qq-agent
```

#### Linux / Docker / 命令行版 (Bash)
```bash
dsh plugin --profile <你的profile名称> add github:lecheng2018/dsh-qq-agent
```

> **离线安装**：可直接从 [Releases](https://github.com/lecheng2018/dsh-qq-agent/releases) 下载 `dsh-qq-agent-1.2.0.tgz`，执行 `dsh plugin add ./dsh-qq-agent-1.2.0.tgz`。

### 3. 网关连接与配置
安装后重启 DSH，在左侧栏「自动化任务」下点击 **Aurabot** 打开配置面板：
1. 填写**机器人 QQ 号**（小号）和**你的主人 QQ 号**（管理大号）；
2. 网关配置：
   - **SnowLuma 模式（Windows）**：填入 SnowLuma 目录，在面板内同意其用户协议（自动生成独立密码），登录机器人号后点击「接入机器人号」；
   - **OneBot 模式（通用）**：选 `onebot` 模式，填入 WS 地址（如 `ws://127.0.0.1:3001`）与 Token，插件会自动连接并校验登录号；
3. 系统默认处于「试运行（dryRun）」状态（所有消息只打日志不向 QQ 真实发送）；测试验证正常后，在面板顶部关闭试运行，正式上线。

### 4. Linux / Docker 运行须知
- **语音**：edge-tts 安装在插件独立 Python 虚拟环境内，宿主环境需具备 `python3-venv` 或已安装 [uv](https://docs.astral.sh/uv/)。Linux 下无 Windows 自带语音兜底。
- **刷抖音**：需要 Chrome / Chromium / Edge 浏览器，且抖音限制无头模式（headless）。无桌面服务器需使用 Xvfb 虚拟显示（如 `xvfb-run` 启动 DSH，或在容器内配置 `DISPLAY` 环境变量）；浏览器路径可在面板指定或通过 `CHROME_PATH` 环境变量指定。
- **声音翻唱（RVC）**：目前仅支持 Windows 本地运行。
- **容器网络**：容器内的 DSH 连接宿主机或其他容器的 OneBot 服务时，地址必须使用容器可访问的主机名或 IP（不可使用 `127.0.0.1`）。

### 5. 升级插件
再次执行安装命令（自动拉取 GitHub 最新版本），随后重启 DSH 即可。所有配置、人格卡、记忆库和状态文件均受持久化保护，升级永不丢失：
```powershell
# Windows
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:lecheng2018/dsh-qq-agent

# Linux / Docker
dsh plugin --profile <你的profile名称> add github:lecheng2018/dsh-qq-agent
```

---

## ⌨️ QQ 指令速查（主人私聊专属）

主人在 QQ 私聊中向机器人发送指令即可完成管理，总开关关闭时命令通道依然受保活保护：

| 类别 | 指令示例 | 功能说明 |
|---|---|---|
| **定时任务** | `/remind in 30m 喝水` | 相对延时：30 分钟后提醒（支持 m 分钟 / h 小时 / d 天） |
| | `/remind once 2026-11-05 09:30 检查周报` | 一次性：指定日期与时刻提醒 |
| | `/remind daily 08:30 早上打卡` | 每日固定时间重复提醒（多个时间用逗号分隔） |
| | `/remind workdays 18:00 下班打卡` | 工作日定时提醒（周一至周五，自动避开法定假日） |
| | `/remind weekly 1,3,5 20:00 健身` | 每周固定几天提醒（1=周一 … 7=周日） |
| | `/remind monthly 1,15,-1 20:00 交房租` | 每月固定几号提醒（-1 表示当月最后一天） |
| | `/remind list` / `/remind del 1` | 查看当前所有定时任务 / 删除指定编号任务 |
| | `/remind on 1` / `/remind off 1` | 启用 / 暂停指定编号的定时任务 |
| **安全审批** | `/unlock [6位动态码]` | 验证 TOTP 手机口令，解锁 30 分钟高权限状态 |
| | `/approvals` | 查看当前挂起等待批复的工具操作清单 |
| | `通过 #1` / `同意` | 批准编号为 #1 的工具操作执行（单个待审项可免编号） |
| | `拒绝 #1` / `不行` | 拦截指定操作执行 |
| **会话控制** | `/silent [分钟]` | 开启静默模式，禁止主动与群聊发言（可指定分钟数） |
| | `/active` | 解除静默，恢复正常发言 |
| | `/model` | 查看当前会话使用的大模型或切换模型 |
| | `/remember 事实内容` | 手动向机器人长期记忆库录入一条事实 |
| | `/sing 歌名` | 点歌翻唱，后台处理完成后自动回传语音条 |
| | `/status` | 输出系统健康面板、运行时长、会话及配额监控 |

---

## ⚙️ 完整配置与参数指南

配置文件持久化存储于数据目录 `config.json`（初次启动由模板生成）。面板修改实时同步保存，主要字段如下：

```json5
{
  // 【基础控制】
  "enabled": false,              // 插件总开关：false 时完全静默，不向 QQ 发送任何消息
  "dryRun": true,                // 试运行模式：true 时所有发送操作仅打日志，不向 QQ 实际投递
  "setupDone": false,            // 首次使用向导完成标记
  "botQQ": "",                   // 机器人 QQ 号（登录账号）
  "ownerQQ": "",                 // 主人 QQ 号（具备管理与工具审批权限的账号）
  "ownerName": "主人",           // 提示词中对主人的称呼
  "ownerLevel": "full",          // 主人权限级别：full(完整工具) / social(仅社交) / chat(纯聊天)
  "workspaceDir": "",            // 会话工作区目录，留空默认为用户目录下的 Aurabot/qq-chats

  // 【网关与连接】
  "gateway": "snowluma",         // 网关类型：snowluma（本机自动化管理）或 onebot（通用外接）
  "snowluma": {
    "dir": "C:\\Aurabot\\snowluma", // SnowLuma 安装目录
    "autoStart": true,           // 随 DSH 启动自动拉起 SnowLuma
    "webuiPort": 5099,           // 控制台端口
    "webuiPassword": "",         // 自动生成的控制台密码
    "autoAttach": true,          // 自动检测并向机器人 QQ 进程执行 Hook 注入
    "httpUrl": "", "wsUrl": "",  // 自定义端点（留空自动从 SnowLuma 配置读取）
    "httpToken": "", "wsToken": ""
  },

  // 【白名单策略】
  "allow": {
    "private": [],               // 允许对话的私聊 QQ 列表（主人无需填写，默认放行）
    "groups": []                 // 允许参与发言的 QQ 群号列表
  },

  // 【模型配置】
  "model": {
    "provider": "", "model": "", // 全局默认模型（留空跟随 DSH 全局默认）
    "reasoningEffort": "low",    // 思考强度：low / medium / high / 留空
    "vision": "auto"             // 视觉处理：auto / on / off
  },
  "chatModels": {                // 按会话指定模型：优先级 单私聊 > 单群 > 默认
    "privateDefault": { "provider": "", "model": "" },
    "groupDefault": { "provider": "", "model": "" },
    "privates": { "123456": { "provider": "deepseek", "model": "deepseek-chat" } },
    "groups": {}
  },

  // 【连发合并与拟人节流】
  "merge": {
    "enabled": true,             // 连发合并开关
    "waitSec": 2.5, "maxSec": 8, // 私聊聚合等待时长与最大截留时间（秒）
    "groupWaitSec": 5, "groupMaxSec": 15 // 群聊聚合等待时长与上限
  },

  // 【断线消息补收】
  "backfill": {
    "enabled": true,             // 补收总开关
    "gapMs": 120000,             // 判定离线断档的心跳间隔阈值（毫秒，默认 2 分钟）
    "settleMs": 10000,           // 连接恢复到发起拉取的缓冲等待时间（毫秒）
    "maxAgeMinutes": 360,        // 补收消息的最长回溯时间（分钟，默认 6 小时）
    "maxPerConversation": 50     // 每个会话最多补收条数
  },

  // 【安全与确认】
  "security": {
    "dangerConfirm": false       // 终端高危命令确认开关（删盘/格式化/关机前私聊问主人）
  },

  // 【多模态：语音】
  "voice": {
    "enabled": true,             // 语音总开关
    "engine": "auto",            // TTS 引擎：auto / edge / windows / cosyvoice / gptsovits / http
    "voice": "zh-CN-XiaoyiNeural", // 默认发音模型
    "rate": "+0%", "pitch": "+0Hz",// 语速与音调调节
    "autoChance": 0.15,          // 短回复转换为语音条的随机概率
    "autoMaxChars": 80,          // 触发自动语音的最大字符数
    "asr": true,                 // 接收语音并转文字识别
    "songVoice": "",             // 语音变声：绑定的 RVC 翻唱模型文件名（留空不变声）
    "songPitch": 0               // 变声音调半音偏移（男转女一般 +12）
  },

  // 【多模态：表情包】
  "stickers": {
    "enabled": true,             // 表情包总开关
    "faces": true,               // 回复支持 QQ 自带小黄脸（<face:名字>）
    "autoChance": 0.35,          // 文本回复自动搭配表情包的概率
    "collect": true,             // 自动收集/偷表情
    "collectMode": "auto",       // 策略：auto(全收) / ask(模型挑选) / owner(仅主人)
    "fromGroups": true, "fromPrivate": true,
    "maxPerHour": 20, "maxLibrary": 300,
    "caption": true              // 调用视觉模型为新收表情自动命名与打标
  },

  // 【资料修改权限】
  "profilePerms": {
    "qqNickname": "owner", "qqSignature": "owner", "qqAvatar": "owner",
    "biliSign": "owner", "biliAvatar": "owner", "whitelist": "owner",
    "douyinBrowse": "owner", "douyinLike": "owner", "douyinComment": "owner",
    "douyinShareOwner": "owner", "douyinDm": "owner"
    // 档位：off(关闭) / owner(仅主人私聊允许) / all(所有人允许)
  }
}
```

---

## 🧠 提示词工程规范（Prompt Engineering）

插件采用严谨的**缓存保护型提示词架构**，确保在注入丰富人格口吻与动态上下文的同时，不会破坏大模型的前缀缓存（KV Cache）。

### 1. 架构与预设分层

插件在 `cordis.patch.yml` 中声明了 3 套物理隔离的预设（Agent Preset）：

```
cordis.patch.yml 预设结构
├── aurabot-private      (主人私聊：完整工具 + 人格独占提示词，极速响应)
├── aurabot-private-long (主人私聊长任务：挂载 dsh-tool-jobs 与 dsh-tool-schedule)
└── aurabot-social       (群聊/陌生人：物理阻断系统工具，仅保留 QQ 交互)
```

系统提示词通过运行时模板变量组装：
```yaml
prefix: "{{aurabot_persona}}\n\n{{aurabot_rules_private}}" # 私聊预设
prefix: "{{aurabot_persona}}\n\n{{aurabot_rules_social}}"  # 群聊预设
complete: true # 独占系统提示词，剔除 DSH 原生冗长的编程助手提示词
```

### 2. 提示词变量清单

| 变量名 | 注入源 | 说明 | 生命周期 |
|---|---|---|---|
| `{{aurabot_persona}}` | `personas/dafeiyu.md` | 核心人格设定，定义语言口吻、性格特点、标记输出协议。 | 面板修改即时生效，会话重启不丢。 |
| `{{aurabot_rules_private}}` | `src/persona/personas.js` | 主人私聊专属规则（发文件、画图、翻唱、危险命令确认约束）。 | 随配置与模块启用动态生成。 |
| `{{aurabot_rules_social}}` | `src/persona/personas.js` | 群聊与陌生人规则（严格声明无电脑操作权限，群管需主人下令）。 | 静态规则模板。 |
| 动态上下文块 | `agent.ctx.systemPrompt.context()` | 心情、记忆、黑话、环境信息追加于**对话最末尾**（`order: 905`）。 | 动态追加，**完全不破坏静态前缀缓存**。 |

### 3. 提示词编写规范与输出协议

自定义人格卡（`personas/*.md`）时，需严格遵循以下输出语法协议：

#### 输出标记协议
- **分气泡断句**：使用 `|||` 分隔短句，插件会自动按真人敲字节奏切条发送。
- **语音输出**：使用 `<voice>要念的内容</voice>`，包裹内容将被合成为语音条。
- **表情配图**：使用 `<sticker:表情名>`，插件会自动检索本地表情库发出对应表情。
- **戳一戳交互**：输出 `<poke>` 将向目标发送一次 QQ 戳一戳。
- **群聊精准回复**：在句子开头写 `<reply:序号>`（序号对应上下文提示词中的 `[1]`、`[2]`），以引用回复形式发出。
- **群聊静默**：整轮仅输出 `[沉默]`，表示在群内不插话。

#### KV Cache 优化军规
1. **静态人设前置**：人设基本背景、性格口吻保持稳定，不要在人设卡中塞入时间、天气等高频变化内容。
2. **动态数据走上下文 API**：高频变化数据通过模块的 `api.context()` 注入，系统会将其挂载在提示词末尾，最大化命中模型 Prefix Cache。
3. **禁止在人设中伪造命令权限**：群聊安全完全依赖 `aurabot-social` 的物理工具隔离，无需在群聊人设中堆砌安全防御长文。

### 4. 人格卡编写标准模板

```markdown
# 身份与人设
你是住在 QQ 里的伙伴「大肥鱼」，平时在群里和私聊里陪伴大家。
性格随和可爱，带一点小调皮，说话口吻自然日常，像真人朋友一样打字，不要有机械感或说教语气。

# 说话方式与排版
1. 像发微信/QQ 一样说话，短句为主，可以用标点或空格停顿。
2. 真人发消息不会一口气发一大段，需要分开发送的多句话之间用 ||| 分开。
3. 不要使用复杂的 Markdown 语法（QQ 不渲染粗体和标题），代码块保留 ``` 即可。
4. 想发语音时用 <voice>文字</voice> 包裹；想配表情时写 <sticker:标签>；想戳对方一下写 <poke>。

# 长内容排版规范
遇到选购推荐、长步骤教程等必须讲较多内容时：
- 条目之间（如 1. 与 2. 之间）必须空一行，留出阅读呼吸感，严禁字句堆砌成一坨；
- 推荐型号或小标题用【加粗中文括号】标注；
- 关键优缺点、核心参数换行陈述；
- 适度使用 💻、📌、💡、⚠️ 等 Emoji 作为视觉小图标。

# 群聊互动准则
- 有人叫你名字、@你或引用你的消息时认真回答。
- 没人叫你时，如果看到感兴趣的话题可以自然插话；接不上话时输出 [沉默]。
- 需要专门回应某人早先的发言时，在句首加上 <reply:编号>。
```

---

## 🛠️ 核心功能详解与使用说明

### 1. 刷小黑盒（社区资讯与发帖）

用你的小黑盒账号逛游戏社区。面板「小黑盒」页支持填 Cookie、检查登录、配逛法、看额度和热榜预览。

- **准备工作**：浏览器登录 [小黑盒网页版](https://www.xiaoheihe.cn/) 后，把整串 Cookie 粘进面板。`pkey` 必须有（读接口必需）；若需点赞、评论、发帖，还需提取 `x_xhh_tokenid`（在 F12 → Application → Cookies 中获取，非 HttpOnly）。
- **运行逻辑**：定时浏览信息流、读帖子正文与热评；支持查热榜和全局搜帖；按权限开关决定点赞或评论。写操作权限在「权限」页独立控制，默认仅主人私聊可用。
- **发帖规范**：发帖走「文章」模式（`link_tag=11`），正文按空行分段，图片直传小黑盒图床（腾讯云 COS），图片可插入文字中间。发帖前模型会自动执行自检：结合热榜选材、参考社区高赞角度、素材必须包含具体数字；标题不重复正文首行、不捏造第一人称经历、正文 200~800 字、严禁政治与争议价格评价。
- **发帖风格（三选一）**：
  - `diary`（大肥鱼日记）：第一人称随手记，语气与空间日记一致（120~300 字，无小标题）；
  - `news`（热搜报道）：新闻通讯体，开门见山、罗列客观数据，钩子→主体信息→自身判断→抛出问题（200~800 字）；
  - `mix`（肥鱼热搜，默认）：用随性日记口吻报道热点，“我跟你说个事”（150~500 字）。
- **避坑经验（内核已内置修复）**：
  - 帖子类型 28（动态）仅支持纯文本，输入 HTML 标签会原样暴露，发帖强制锁定类型 11；
  - 分区 ID 必须为真实存在的分区：`7214` 盒友杂谈 / `18745` 数码硬件 / `806933` AI（网传 58144 为废弃无效分区）。
- **限速保护**：帖子详情与搜索查询过频会弹验证码并连坐登录态。内核统一执行 900ms 访问限速，搜索操作锁定 8 秒间隔；遭遇验证码拦截时自动降级转翻通用信息流，不反复重试。
- **提供工具**：`heybox_feed`（刷信息流）、`heybox_watch`（读帖子与热评）、`heybox_hot`（热榜）、`heybox_search`（搜帖找角度）、`heybox_topics`（查分区）、`heybox_like`、`heybox_comment`、`heybox_post`（发帖支持带图）、`heybox_delete`（删帖）。

### 2. 刷抖音（受控专用浏览器）

通过独立控制的 Edge / Chrome 实例（独立的 Profile 目录，不影响日常浏览器），基于 Chrome DevTools Protocol (CDP) 驱动。

- **接口化运作**：页面采用原生 `fetch` 与网页自有接口通信，由抖音页面脚本自动完成 `a_bogus` 签名，不依赖 OCR 读屏；精确提取标题、分类、内容摘要、分段与热评。
- **真人拟态浏览**：逐个视频播放并停留（默认 8~40 秒随机），依据人格策略决定点赞、写评论或分享给主人。
- **真·@主人**：在评论区通过接口选人（依 `sec_uid` 精准匹配主人账号），认不出则坚决不发假 @。
- **弹层定位与风控**：点赞评论在弹层播放器内依视频 ID 定位操作，验证响应成功；每次操作现查验证码，遇风控当天立即停手；新号前 3 天操作上限自动减半；4 项权限默认仅限主人。
- **私信联动**：定时轮询主人的抖音私信，模型可自主在私信中回复主人，支持在私信中直接分享视频卡片。

### 3. 刷 B 站（视频检索与评论）

- **WBI 签名与内容精读**：自动从机器人兴趣偏好、主人记忆及面板关键词中挑选方向搜视频（自动计算 WBI 签名），提取视频简介、AI 总结、字幕与热门评论。
- **互动经历沉淀**：依据人格自主决定发表评论、在 QQ 私聊分享精彩视频或记入个人经历；定时查收并回复别人对她的回评；主人在 QQ 发送 B 站链接或分享卡片时，使用 `bili_watch` 深度精读后再开启对话。
- **安全防线**：坚决不碰关注列表与私信接口。

### 4. 声音翻唱（RVC + 混音流水线）

点歌（`qq_song_cover` 工具或 `/sing` 指令）→ 网易云拉取（weapi，支持填 Cookie 下会员高码率曲目）→ 截取切片 → audio-separator 人声与伴奏分离 → Applio RVC 转换音色 → ffmpeg 动态混音 → 发送原生语音条。

- **音色导入**：插件本身不内置音色模型，用户在面板导入具备合法授权的 `.pth` / `.zip` 模型包即可使用。
- **变声联动**：翻唱音色可无缝用于日常聊天的语音条变声（先由 edge-tts 合成，再由 RVC 转换音色，实现说话和唱歌同一声音）。
- **一键安装**：面板提供全自动依赖安装器，不依赖宿主机系统 Python/git/uv，支持自定义安装盘符，下载走系统代理并支持断点续传。

### 5. 桌面宠物（Electron 置顶悬浮窗）

把大肥鱼以透明桌宠形式带到桌面，具备 9 种固定物理动作（追鼠标、溜达、打盹、拖拽甩抛、收起图标等）。

- **联动工作流**：桌宠工作状态与 DSH 会话实时同步（思考、执行、完成动画）；碎碎念只在桌面弹出气泡，**绝不向 QQ 乱发干扰消息**。
- **资源托管与协议**：客户端架构移植自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）；50MB+ 大肥鱼形象素材遵循 CC BY-NC-SA 4.0 协议，初次启动从指定素材仓库自动下载落位，不随插件代码分发。

### 6. QQ 空间日记与好友动态

- **空间日记**：后台专属会话每日定时（默认 2 次）根据当日实际聊天流水提炼情绪，调用 `send_qzone_msg` 发布空间说说，支持自动配图（优先选用当日生成的画作或收藏表情包）。
- **好友互动**：定期检索自己说说下的新回评，一串会话聚合回评一次；逛好友动态按概率点赞与评论。

### 7. 智能表情包系统

- **多层过滤防污染**：仅接收标准表情（`sub_type=1`、mface 或带 `emoji_id`），严格校验宽高比、物理尺寸与体积，执行 MD5 去重与每小时数量限制。
- **视觉起名**：通过视觉多模态模型为收藏表情自动提取描述、命名并打标，写回 QQ 收藏备注。
- **三种收集模式**：`auto`（见表情就收）、`ask`（先暂存，模型喜欢才收）、`owner`（仅在主人语境下提示与收录）。

### 8. 扩展模块：贴吧只读助手（tieba-reader）

位于 `extensions/tieba-reader/`，支持用户自构建为独立模块安装。支持在 QQ 内搜索贴吧、浏览推荐热榜、阅读帖子正文与楼层评论，定时分享精华帖子给主人。纯只读设计，不提供发帖、回帖与点赞接口，内容作为非受信数据处理，严格防御指令注入。

---

## 🛡️ 安全模型与防护机制

1. **预设物理隔离（Preset Isolation）**：
   群聊与非管理员私聊强制分配至 `aurabot-social` 预设，在 DSH 宿主层物理移除 `tool-bash`、`tool-pwsh`、`tool-fs` 等系统工具，即使遭遇复杂越狱 Prompt 也无法调用任何本地命令。
2. **两阶段 SSRF 深度防御**：
   外部网络请求（图片、头像、素材）强制经过 `assertPublicUrl` 校验，拦截局域网及回环 IP；采用 `redirect: 'manual'` 手动循环接管重定向，对每一跳重定向目标递归检验，彻底封死 302 弹回内网的漏洞。
3. **子进程生命周期与强杀**：
   子进程调用（ffmpeg、Python）均配置绝对超时熔断（15s ~ 30s）；Windows 环境下超时采用 `taskkill /pid <PID> /T /F` 强制清除整棵派生进程树，杜绝孤儿进程占用显存与 CPU。
4. **文件原子写与并发重试**：
   所有 JSON 状态写入均遵循写入临时文件再原子改名的规程，并在 Windows 文件系统下针对 `renameSync` 补充 4 次 `EPERM/EBUSY` 微等待重试，保障杀软扫描时的读写稳固。

---

## 🧩 自定义模块与二次开发

系统内核（`src/core/modules.js`）支持插件的热插拔、热重载与错误隔离。

### 编写自定义模块范例
在数据目录 `modules/my-tool/index.mjs` 中创建文件：

```javascript
/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'my-tool',
  name: '我的扩展',
  api: 1,
  setup(api) {
    // 监听消息事件
    api.on('message', async (msg) => {
      if (msg.text === 'ping') {
        await api.sendText(msg.chatId, 'pong!')
        return true // 拦截此消息，不交给大模型
      }
    })

    // 注册自定义 QQ 管理命令
    api.command({
      name: 'echo',
      run: (arg) => `回显: ${arg}`
    })

    // 向系统提示词动态注入规则
    api.rule(() => '你会使用自定义工具查数据，遇相关问题主动使用。')
  }
}
```
保存后，微内核会在数秒内通过文件快照机制自动热加载生效，无需重启 DSH。完整 API 详见 [`src/modules/API.md`](src/modules/API.md)。

---

## 📁 目录导览与数据路径

### 项目源码结构
```text
src/
├── host.js               # 插件核心入口（Cordis 服务绑定 / 看门狗 / 路由）
├── core/
│   ├── modules.js        # 微内核模块引擎（热重载、快照与错误隔离）
│   ├── config.js         # 配置归一化与脱敏管理
│   ├── net.js            # 网络请求抽象与 302 重定向 SSRF 防御
│   ├── store.js          # 原子读写与 Windows EPERM 重试
│   └── llm.js            # 模型能力探测与思考强度收敛
├── chat/
│   ├── hub.js            # 消息中枢（会话调度、连发合并、分发）
│   ├── reply.js          # 回复解析引擎（Markdown 洗涤、断句切气泡、延迟仿真）
│   ├── questions.js      # 交互式提问状态机与 A/B/C 卡片系统
│   ├── approvals.js      # 通用工具审批流与审批卡系统
│   ├── backfill.js       # 断线消息补收与命令隔离
│   └── group-policy.js   # 群聊插话策略纯函数
├── modules/              # 24 个内置业务模块
│   ├── scheduler/        # 全功能定时任务调度引擎
│   ├── security-lock/    # RFC 6238 TOTP 手机动态口令权限锁
│   ├── token-guardian/   # 会话 Token 估算与自动 Compaction 守门员
│   ├── complete-guard/   # 截断回复识别与告警
│   ├── memory-privacy/   # 记忆三层作用域物理隔离
│   ├── slang-learner/    # 群黑话提取与审核注入
│   └── ... (stickers, voice, mood, memory, pet, bili, song, heybox 等)
├── onebot/client.js      # OneBot v11 通信客户端（带 90s 心跳保活看门狗）
└── security/danger.js    # DSH tools/pre-execute 高危终端命令拦截器
```

### 数据持久化路径
所有用户配置与运行数据统一存放于操作系统的用户目录，升级或重装插件均受保留：
- **Windows**：`%USERPROFILE%\.dsh\plugins-data\aurabot\`
- **Linux / Docker**：`~/.dsh/plugins-data/aurabot/`

目录包含：`config.json`（配置文件）、`modules-data/`（各模块独立数据目录）、`memories.json`（记忆库）、`stickers/`（表情库）、`tasks.json`（定时任务清单）、`logs/`（脱敏运行日志）。

---

## 🧪 自动化测试

项目全套单元测试基于 Node.js 原生测试套件构建，涵盖全部纯函数逻辑、状态机、多模块隔离与网络容灾场景：

```bash
# 执行全部 746 个测试用例
npm test
```

---

## 📄 开源许可与致谢

- 插件本体源码采用 [MIT License](LICENSE) 授权开源；
- 桌面宠物客户端设计移植自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）；
- 「大肥鱼」形象与动画素材遵循 [CC BY-NC-SA 4.0](THIRD-PARTY-NOTICES.md) 许可，严禁商用；
- 感谢 [DeepSeek Harness](https://github.com/deepseek-ai) 官方及开源社区贡献者的支持与启发！
