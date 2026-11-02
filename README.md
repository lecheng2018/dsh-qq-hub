# Aurabot · 住在 QQ 里的智能伙伴与 DSH Agent 交互终端

[![GitHub Release](https://img.shields.io/github/v/release/lecheng2018/dsh-aurabot-qq?color=blue&logo=github)](https://github.com/lecheng2018/dsh-aurabot-qq/releases)
[![Tests](https://img.shields.io/badge/tests-746%20passed-success?logo=node.js)](https://github.com/lecheng2018/dsh-aurabot-qq/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-0969da)](https://github.com/deepseek-ai)

**Aurabot** 是为 **DeepSeek Harness (DSH)** 深度定制的进程内原生插件（In-Process Native Plugin），基于 `@deepseek-ai/cordis` 微内核架构构建。

它具备**拟人化社交伙伴**与**生产力 Agent 远程终端**双重能力：
- **拟人伙伴**：有性格、有心情、懂记忆。看图、听发语音、发表情包、RVC 翻唱变声、写空间日记、刷 B 站/抖音/小黑盒，以及常驻屏幕的互动桌面宠物。
- **Agent 终端**：手机端直接操控 DSH。支持**交互式提问（`ask_user_question`）**、**高危工具审批流（`approval/request`）**、**断线消息自动补收（`backfill`）**、**全功能定时任务（`/remind`）**、**TOTP 手机动态口令锁**与**私聊/群聊记忆物理隔离**。

```
QQ 移动/桌面端 ⇄ OneBot v11 网关 (SnowLuma / NapCat) ⇄ Aurabot 插件 ⇄ DSH 会话 (预设物理隔离)
```

---

## 📝 本次修改清单（v1.2.0 重构与加固）

本版本对项目进行了体系化的生产力升级、安全审计与代码加固，关键改动如下：

### 1. 核心 Agent 交互与生产力闭环
- **交互式多选提问系统 (`src/chat/questions.js`)**：接入 DSH `userQuestions` 能力。模型触发澄清提问时，自动渲染为带 `A./B./C.` 编号的 QQ 卡片，支持字母、连写、编号、模糊及自定义作答，带 5 分钟超时兜底与回执反馈。
- **通用工具审批流 (`src/chat/approvals.js`)**：接入 DSH `approval/request` 瀑布流。执行敏感工具时向主人私聊推送编号审批卡（`#1`、`#2`...），展示脱敏命令与原因，支持私聊「通过/拒绝」，联动权限锁。
- **断线消息自动补收 (`src/chat/backfill.js`)**：检测到连接断档（>2 分钟）且恢复后，自动拉取错过的群聊与私聊历史；严格隔离补收消息，严禁执行迟到命令与审批，注入时间戳提示词。
- **全功能通用定时调度器 (`src/modules/scheduler/`)**：移植完整调度引擎，支持 `once`、`in 30m`、`daily`、`workdays`、`weekly`、`interval` 与 `Cron`；提供主人私聊 `/remind` 管理指令，并向模型暴露 `schedule_reminder` 原生工具。

### 2. DSH 增强五件套模块内置化
- **`security-lock`**：纯 `node:crypto` 实现 RFC 6238 TOTP 手机动态口令，提供 `/unlock` 提权与 30 分钟生命周期。
- **`token-guardian`**：估算会话上下文 Token，达阈值且空闲时自动调用 DSH compaction 压缩历史。
- **`complete-guard`**：识别停留在连接词或未闭合括号上的截断回复，提供截断告警。
- **`memory-privacy`**：私聊（`private`）、群聊（`group`）与全局（`global`）三层作用域隔离，群聊物理阻断私聊记忆。
- **`slang-learner`**：自动挖掘群聊黑话，主人审核后方可注入群上下文。

### 3. 全量安全审计与稳定性加固（16 项缺陷修复）
- **高危修复**：修复 `heybox` 模块 `hasLogin()` 未定义导致的定时器中断；修复 `douyin` 浏览器跳转与 `net.js` 302 重定向导致的内网 SSRF 风险；为 `studio.js` 的 `ffmpeg` 调用增加 15s 超时强杀防死锁；将记忆库 `recall` 统计覆写解耦为内存防抖回写，防止冲掉事实记忆。
- **中危修复**：Windows 环境下文件原子写入引入 `renameWithRetry` 消除 `EPERM` 偶发崩溃；修复 OAuth 报错分支端口未释放泄漏；翻唱异常分支补齐数百兆临时切片目录清理；OneBot 客户端引入 90s 心跳保活看门狗。
- **规范治理**：全模块统一收敛至 `api.dataDir`，彻底消除各模块在全局数据目录的 `state.json` 命名冲突。

### 4. CI/CD 与工程化建设
- **自动工作流 (`.github/workflows/release.yml`)**：push `main` 分支时自动触发 746 个测试用例门禁，0 失败后自动提取 `CHANGELOG.md` 生成 Release 并打包发布 `.tgz` 离线插件包。

---

## 🚀 快速上手

### 1. 环境准备
- **Node.js**：≥ 22.13.0
- **DSH 宿主**：DeepSeek Harness 0.2.x 或 0.3.x（已配置可用模型）
- **QQ 机器人网关**（二选一）：
  - **Windows 首选**：下载并解压 [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases)（插件支持自动管理启停与号段注入）；
  - **Linux / Docker / macOS / 自建**：运行 [NapCat](https://github.com/NapNeko/NapCatQQ) 或任意 OneBot v11 服务，开启正向 WebSocket（如 `ws://127.0.0.1:3001`）。

### 2. 安装插件

#### Windows 桌面版 (PowerShell)
```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:lecheng2018/dsh-aurabot-qq
```

#### Linux / Docker / 命令行版 (Bash)
```bash
dsh plugin --profile <你的profile> add github:lecheng2018/dsh-aurabot-qq
```

*离线安装：从 [Releases](https://github.com/lecheng2018/dsh-aurabot-qq/releases) 下载 `dsh-aurabot-qq-1.2.0.tgz`，执行 `dsh plugin add ./dsh-aurabot-qq-1.2.0.tgz`。*

### 3. 连接与上线
1. 启动并重启 DSH，在左侧栏「自动化任务」下点击 **Aurabot** 打开控制面板；
2. 填写**机器人 QQ 号**（小号）和**主人 QQ 号**（你的大号）；
3. 网关配置：
   - 若用 **SnowLuma**：选择解压目录，在面板内勾选同意协议（自动生成独立密码），点击「接入机器人号」；
   - 若用 **其他 OneBot**：选 `onebot` 模式，填入 WS 地址（如 `ws://127.0.0.1:3001`）与 Token，插件将自动完成通信握手与登录校验；
4. 初始默认开启「试运行（dryRun）」，验证收发日志无误后在面板顶部关闭试运行，正式上线。

---

## 🎮 核心功能全景

### 1. 生产力 Agent 协作
- **多选交互提问**：模型执行任务遇到分支时调用 `ask_user_question`，QQ 即刻收到格式化卡片，直接回复选项字母、数字编号或自定义内容即可驱动任务继续推进。
- **高危工具审批**：执行系统命令或修改敏感资源前触发审批，私聊展示 `#编号`、真实命令参数及原因，回复「通过 #编号」放行。
- **断线无感补收**：电脑合盖休眠或网络中断恢复后，自动对账补收，防止漏看群内 @ 或重要指令，同时严密阻断离线指令的意外执行。
- **定时提醒管家**：支持自然语言与标准指令添加提醒，到点精准推送，支持复杂周期与 Cron 规则。

### 2. 拟人社交与群聊交互
- **群聊消息聚合缓冲 (`groupBuf`)**：群内多条消息连续到达时，合并为结构化段落交由模型整体阅读，避免碎片化抢话。
- **打字延时仿真 (`bubbleDelay`)**：模拟真人键盘敲击速率（约 9 字/秒），多条气泡平滑顺序发送。
- **语法标记与 Markdown 洗涤**：自动洗掉 QQ 不支持的复杂 Markdown；支持模型输出 `|||`（分条）、`<voice>`（语音条）、`<sticker>`（发表情）、`<poke>`（戳一戳）、`<reply:id>`（精准引用）。
- **群聊安全刹车**：短时间发言频率受限，触发阈值自动歇息，仅允许主人 @ 唤醒。

### 3. 多模态与外围联动
- **语音全能套件**：TTS 默认 edge-tts，支持接入本地 CosyVoice、GPT-SoVITS 及 HTTP 服务；ASR 支持 QQ 原生与 DSH 语音转写；支持用翻唱音色变声。
- **智能表情包**：严格校验尺寸、格式与 MD5 去重，支持全自动偷表情、主人私聊专属偷表情与模型自主视觉起名。
- **RVC 声音翻唱**：内置网易云拉取、切片、人声分离与 RVC 音色变换管线（仅限 Windows 本地运行）。
- **社区与媒体**：
  - **QQ 空间**：自动生成空间日记并配图，好友动态点赞与评论互动；
  - **B 站**：WBI 签名鉴权，按偏好搜视频、读简介与弹幕字幕、写评论，支持抽取关键帧给视觉模型；
  - **抖音**：通过 CDP 协议由独立浏览器实例控制，接口化获取视频文案、摘要与热评，支持点赞、评论与私信互动；
  - **小黑盒**：通过配置 `pkey` 与 `x_xhh_tokenid` 浏览游戏资讯，支持文章模式发帖（分区 7214/18745/806933），具备 900ms 限速保护与风格切换（`diary` / `news` / `mix`）。
- **桌面宠物**：基于 Electron 的透明置顶桌宠，具备 9 种确定性动作与物理引擎，工作状态随 DSH 会话实时联动。

---

## 🧠 提示词工程规范（Prompt Engineering）

插件采用严谨的**缓存保护型提示词注入架构**，确保在注入丰富人格与动态上下文的同时，不会击穿大模型的 KV Cache 前缀缓存。

### 1. 架构与预设分层

插件在 `cordis.patch.yml` 中声明了 3 套物理隔离的预设（Agent Preset）：

```
cordis.patch.yml 预设配置
├── aurabot-private      (主人私聊：完整工具 + 人格独占提示词，极速响应)
├── aurabot-private-long (主人私聊长任务：挂载 dsh-tool-jobs 与 dsh-tool-schedule)
└── aurabot-social       (群聊/陌生人：物理阻断系统工具，仅保留 QQ 交互)
```

系统提示词采用模板变量机制在运行时组装：
```yaml
prefix: "{{aurabot_persona}}\n\n{{aurabot_rules_private}}" # 私聊预设
prefix: "{{aurabot_persona}}\n\n{{aurabot_rules_social}}"  # 群聊预设
complete: true # 独占系统提示词，剔除 DSH 冗余编程助手长文
```

### 2. 提示词变量清单

| 变量名 | 注入源 | 说明 | 生命周期 |
|---|---|---|---|
| `{{aurabot_persona}}` | `personas/dafeiyu.md` | 核心人格设定，定义语言口吻、性格特点、标记输出约定。 | 面板修改即时生效，会话重启不丢。 |
| `{{aurabot_rules_private}}` | `src/persona/personas.js` | 主人私聊专属规则（发文件、画图、翻唱、危险命令确认约束）。 | 随配置与模块启用动态生成。 |
| `{{aurabot_rules_social}}` | `src/persona/personas.js` | 群聊与陌生人规则（严格声明无电脑操作权限，群管需主人下令）。 | 静态规则模板。 |
| 动态上下文块 | `agent.ctx.systemPrompt.context()` | 心情、记忆、黑话、环境信息追加于**对话最末尾**（`order: 905`）。 | 动态追加，**完全不破坏静态前缀缓存**。 |

### 3. 提示词编写规范与语法约定

在自定义人格卡（`personas/*.md`）或修改提示词时，必须遵循以下输出协议规范：

#### 输出标记协议
- **分气泡断句**：使用 `|||` 分隔短句，插件会自动按真人敲字节奏切条发送。
- **语音输出**：使用 `<voice>要念的内容</voice>`，包裹内容将被合成为语音条。
- **表情配图**：使用 `<sticker:表情名>`，插件会自动检索本地表情库发出对应表情。
- **戳一戳交互**：输出 `<poke>` 将向目标发送一次 QQ 戳一戳。
- **群聊精准回复**：在句子开头写 `<reply:序号>`（序号对应上下文提示词中的 `[1]`、`[2]`），以引用回复形式发出。
- **群聊静默**：整轮仅输出 `[沉默]`，表示在群内不插话。

#### KV Cache 优化军规
1. **静态人设前置**：人设基本背景、性格口吻保持稳定，不要在人设卡里塞入时间、实时天气等高频变化内容。
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

# 群聊互动准则
- 有人叫你名字、@你或引用你的消息时认真回答。
- 没人叫你时，如果看到感兴趣的话题可以自然插话；接不上话时输出 [沉默]。
- 需要专门回应某人早先的发言时，在句首加上 <reply:编号>。
```

---

## ⌨️ QQ 指令速查（主人私聊专属）

主人在 QQ 私聊中直接向机器人发送指令即可完成管理，总开关关闭时命令通道依然受保活保护：

| 类别 | 指令示例 | 功能说明 |
|---|---|---|
| **定时任务** | `/remind in 30m 喝水` | 相对延时：30 分钟后提醒 |
| | `/remind once 2026-11-05 09:30 检查备份` | 一次性：指定日期与时刻提醒 |
| | `/remind daily 08:30 早上打卡` | 每日固定时间重复提醒 |
| | `/remind workdays 18:00 下班打卡` | 工作日定时提醒（自动避让法定假日） |
| | `/remind weekly 1,3,5 20:00 健身` | 每周固定几天提醒（1=周一） |
| | `/remind list` / `/remind del 1` | 列出当前所有定时任务 / 删除指定任务 |
| | `/remind on 1` / `/remind off 1` | 启用 / 暂停指定定时任务 |
| **安全审批** | `/unlock [6位动态码]` | 验证 TOTP 手机口令，解锁 30 分钟高权限状态 |
| | `/approvals` | 查看当前挂起等待批复的工具操作清单 |
| | `通过 #1` / `同意` | 批准编号为 #1 的工具操作执行（单个待审可免编号） |
| | `拒绝 #1` / `不行` | 拦截指定操作执行 |
| **会话与状态** | `/silent [分钟]` | 开启静默模式，禁止主动与群聊发言（可指定时长） |
| | `/active` | 解除静默，恢复正常发言 |
| | `/status` | 输出系统健康面板、运行时长、会话及配额监控 |
| | `/model` | 查看当前会话使用的大模型或切换模型 |
| | `/remember 事实内容` | 手动向机器人长期记忆库录入一条事实 |
| | `/sing 歌名` | 点歌翻唱，后台处理完成后自动回传语音条 |

---

## ⚙️ 完整配置指南

配置文件存储于数据目录 `config.json`，核心配置项说明如下：

```json5
{
  // 【基础控制】
  "enabled": false,              // 总开关：false 时完全静默，不向 QQ 发送任何消息
  "dryRun": true,                // 试运行：true 时所有发送操作仅记日志不真实投递
  "botQQ": "",                   // 机器人 QQ 号（登录号）
  "ownerQQ": "",                 // 主人 QQ 号（管理员账号）
  "ownerName": "主人",           // 提示词中对主人的称呼
  "workspaceDir": "",            // 会话工作区目录，留空默认为用户目录下 Aurabot/qq-chats

  // 【网关与连接】
  "gateway": "snowluma",         // 网关模式：snowluma（本机自动化管理）或 onebot（外接标准服务）
  "snowluma": {
    "dir": "C:\\Aurabot\\snowluma", // SnowLuma 安装目录
    "autoStart": true,           // 随 DSH 启动自动拉起网关进程
    "autoAttach": true,          // 自动检测并向机器人 QQ 进程执行注入
    "httpUrl": "",               // 自定义 HTTP 端点，留空自动获取
    "wsUrl": "",                 // 自定义 WebSocket 端点，留空自动获取
    "httpToken": "", "wsToken": ""
  },

  // 【白名单与访问控制】
  "allow": {
    "private": [],               // 允许对话的私聊 QQ 列表（主人默认放行）
    "groups": []                 // 允许参与发言的 QQ 群号列表
  },

  // 【模型配置】
  "model": {
    "provider": "", "model": "", // 全局默认模型（留空跟随 DSH 全局默认）
    "reasoningEffort": "low",    // 思考强度：low / medium / high / 留空
    "vision": "auto"             // 视觉处理策略：auto / on / off
  },
  "chatModels": {                // 按会话覆盖模型：优先级 单私聊 > 单群 > 默认
    "privateDefault": { "provider": "", "model": "" },
    "groupDefault": { "provider": "", "model": "" },
    "privates": { "123456": { "provider": "deepseek", "model": "deepseek-chat" } },
    "groups": {}
  },

  // 【拟人化节流】
  "merge": {
    "enabled": true,             // 连发合并开关
    "waitSec": 2.5, "maxSec": 8, // 私聊停顿等待时长与最大聚合时间（秒）
    "groupWaitSec": 5, "groupMaxSec": 15 // 群聊聚合等待时长与上限
  },

  // 【安全与确认】
  "security": {
    "dangerConfirm": false       // 危险终端命令拦截开关（删盘/关机等需主人私聊回复确认）
  },

  // 【断线补收】
  "backfill": {
    "enabled": true,             // 断线消息补收总开关
    "gapMs": 120000,             // 判定离线断档的心跳间隔阈值（毫秒）
    "settleMs": 10000,           // 连接恢复到发起拉取的缓冲稳定时间（毫秒）
    "maxAgeMinutes": 360         // 补收消息的最长回溯时间（分钟）
  },

  // 【多模态媒体】
  "voice": {
    "enabled": true,             // 语音能力总开关
    "engine": "auto",            // TTS 引擎：auto / edge / windows / cosyvoice / gptsovits / http
    "voice": "zh-CN-XiaoyiNeural", // 默认发音声学模型
    "autoChance": 0.15,          // 短回复转换为语音条的随机概率
    "songVoice": "",             // 语音变声：绑定的 RVC 翻唱模型文件名
    "songPitch": 0               // 变声音调半音偏移
  },
  "stickers": {
    "enabled": true,             // 表情包总开关
    "autoChance": 0.35,          // 文本回复自动匹配表情图的概率
    "collect": true,             // 自动收集/偷表情
    "collectMode": "auto",       // 收集策略：auto(全收) / ask(模型筛选) / owner(仅主人)
    "maxLibrary": 300            // 本地表情库存储上限
  }
}
```

---

## 🛡️ 安全模型与防护机制

1. **预设物理隔离（Preset Isolation）**：
   群聊与陌生人私聊强制进入 `aurabot-social` 预设，该预设在 DSH 层面物理剔除了 `dsh-tool-bash`、`dsh-tool-pwsh`、`dsh-tool-fs` 等系统控制工具，彻底杜绝提示词注入导致的任意代码执行（RCE）。
2. **两阶段 SSRF 深度防御**：
   所有外部拉取（图片、头像、表情）经过 `assertPublicUrl` 强制校验，禁止访问局域网 IP 与回环地址；重定向处理采用 `redirect: 'manual'`，对每一跳重定向目标递归检验，封堵 302 穿透漏洞。
3. **子进程健壮性保证**：
   外部进程调用（ffmpeg、Python）均配置绝对超时熔断；在 Windows 平台采用 `taskkill /T /F` 强制清除整棵派生进程树，杜绝僵尸进程。
4. **存储原子改名与并发重试**：
   所有状态及配置文件持久化均遵循临时文件写入 + 原子替换机制，并在 Windows 文件系统下针对 `renameSync` 补充 4 次 `EPERM/EBUSY` 微等待重试，保障极端杀软扫描场景下的系统稳定性。

---

## 🧩 扩展与模块二次开发

插件核心由**微内核调度架构（`src/core/modules.js`）**驱动，所有本事均作为模块拔插运行。

### 自定义模块开发范例
在数据目录 `modules/hello/index.mjs` 下创建文件：

```javascript
/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'hello',
  name: '打招呼示例',
  api: 1,
  setup(api) {
    // 监听特定消息
    api.on('message', async (msg) => {
      if (msg.text === 'ping') {
        await api.sendText(msg.chatId, 'pong!')
        return true // 返回 true 表示此消息已被接管，不再触发大模型调用
      }
    })

    // 注册自定义 QQ 命令
    api.command({
      name: 'hello',
      run: (arg, msg) => `你好，${msg.nickname}！你输入了：${arg}`
    })

    // 向大模型注入当前模块的上下文规则
    api.rule(() => '你拥有天气查询扩展，如果用户询问天气，请友好回答。')
  }
}
```
保存后，插件无需重启将在数秒内通过快照机制自动热加载生效。开发规范详见 [`src/modules/API.md`](src/modules/API.md)。

---

## 📁 目录导览与数据目录

### 项目文件目录
```text
src/
├── host.js               # 插件主入口、Cordis 服务接入、生命周期绑定
├── core/                 # 微内核层：模块引擎、配置、网络、原子存储
├── chat/                 # 消息调度层：中枢、回复解析、提问状态机、审批流、补收
├── modules/              # 24 个内置业务模块（定时、权限锁、隐私、黑话、多模态等）
├── onebot/client.js      # OneBot v11 通信客户端（带 90s 保活心跳）
├── security/danger.js    # 终端高危命令前置拦截器
└── voice/ & song/        # 语音及翻唱转换流水线
```

### 数据持久化路径
所有用户数据与配置均独立存放，重装或升级插件不会发生覆盖或丢失：
- **Windows**：`%USERPROFILE%\.dsh\plugins-data\aurabot\`
- **Linux / Docker**：`~/.dsh/plugins-data/aurabot/`

---

## 🧪 测试与发布验证

项目包含严密的自动化测试套件，全面覆盖纯函数解析、模块隔离、状态机及端到端场景：

```bash
# 运行全量 746 个测试用例
npm test
```

本地修改代码推送到 `main` 分支后，GitHub Actions 会自动运行全量测试，并在测试 100% 通过后打包构建标准 DSH 插件产物挂载至 GitHub Releases。

---

## 📄 开源许可与致谢

- 本插件源码基于 [MIT License](LICENSE) 授权开源。
- 桌面宠物客户端设计移植自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）。
- 「大肥鱼」形象与动画素材遵循 [CC BY-NC-SA 4.0](THIRD-PARTY-NOTICES.md) 许可，严禁商用。
- 感谢 [DeepSeek Harness](https://github.com/deepseek-ai) 官方及开源社区贡献者的支持与启发！
