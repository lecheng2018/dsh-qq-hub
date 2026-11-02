# Aurabot · 住在 QQ 里的智能伙伴与 Agent 交互终端

[![GitHub Release](https://img.shields.io/github/v/release/lecheng2018/dsh-aurabot-qq?color=blue&logo=github)](https://github.com/lecheng2018/dsh-aurabot-qq/releases)
[![Tests](https://img.shields.io/badge/tests-746%20passed-success?logo=node.js)](https://github.com/lecheng2018/dsh-aurabot-qq/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-0969da)](https://github.com/deepseek-ai)

**Aurabot** 是一个专为 **DeepSeek Harness（DSH）** 打造的**原生进程内插件（In-Process Native Plugin）**。

它兼具 **顶尖的拟人化社交聊天体验** 与 **强大的生产力 Agent 远程派活/交互控制能力**：
- **在日常交流中**：她是有性格、有心情、懂记忆的可爱伙伴。支持看图、发语音、听语音、收藏与发送表情包、用自己的声音翻唱、写空间日记、刷 B 站、逛小黑盒，还拥有一只能够常驻屏幕边缘的小桌宠；
- **在生产运维中**：她是你在手机端的 DSH Agent 控制台。支持 **多选提问卡片交互（`ask_user_question`）**、**高危工具审批卡（`approval/request`）**、**断线消息自动补收（`backfill`）**、**全功能定时任务调度（`/remind`）**、**RFC 6238 TOTP 手机动态口令权限锁**、**上下文预算守门员** 与 **私聊/群聊记忆物理隔离**。

```
QQ 手机/电脑端 ⇄ SnowLuma / NapCat (OneBot v11) ⇄ Aurabot 插件 (Cordis 4) ⇄ DSH 会话 (预设物理隔离)
```

---

## 🌟 核心特性全景

### 🛠️ 生产力与 Agent 交互（v1.2.0 重磅升级）

| 能力 | 说明 |
|---|---|
| **交互式提问卡片 (`ask_user_question`)** | 原生接入 DSH `ctx.userQuestions`。模型需要决策时，自动排版为带 `A. / B. / C.` 字母编号的卡片发往 QQ，保留计划与说明；支持回复字母（`A`、`A,C`、`ac`）、数字编号、选项文本或自定义回答，5 分钟超时兜底与即时确认回执，彻底解决问答弹不出痛点。 |
| **通用工具审批流 (`approval/request`)** | 原生接入 DSH 官方审批瀑布流。执行敏感工具时，自动生成带自增编号（`#1`、`#2`...）的审批卡推送至主人私聊，展示真实命令与脱敏参数；主人回复「通过 #1」「拒绝 2」「放行」即时批复；60 秒超时自动拦截。 |
| **断线消息自动补收 (`backfill`)** | 维护持久化心跳断档检测（电脑休眠合盖、网关微抖 >2 分钟）；连接恢复后自动拉取错过的历史消息并注入带时间戳的上下文。**严格安全隔离**：补收到的命令、动态码、审批一律拦截不执行并私聊提示主人，严防重放攻击。 |
| **全功能通用定时调度 (`scheduler`)** | 完整调度引擎：支持 `once`（指定日期时间）、`in 30m`（相对延时）、`daily`（每日时刻）、`workdays`（工作日避开周末）、`weekly`（每周几几点）、`interval` 及标准 5 段 `Cron`；支持主人私聊 `/remind` 指令，并向模型暴露 `schedule_reminder` 工具，随口一句话即可由 AI 自主登记提醒。 |
| **权限锁与动态口令 (`security-lock`)** | 纯 `node:crypto` 实现 RFC 6238 TOTP（兼容 Google/微软验证器）；主人私聊发 `/unlock` 验码提权，30 分钟有效期后自动回落，锁定时强制拦截敏感工具审批。 |
| **上下文预算守门员 (`token-guardian`)** | 监控会话 Token 用量，达阈值且空闲时自动调用 DSH compaction 压缩历史上下文，固定摘要常驻，防止会话滚雪球撑爆上下文。 |
| **记忆三层作用域隔离 (`memory-privacy`)** | `private:QQ` / `group:群号` / `global` 严格物理隔离，群聊与陌生人绝对无法获取主人私聊中的事实记忆。 |
| **截断回复识别 (`complete-guard`)** | 智能识别停在连接词、未闭合括号、悬挂序号上的回复，兼容 DSH `max-tokens` 截断告警。 |
| **群黑话学习本 (`slang-learner`)** | 自动提取群聊新词与梗词候选，主人审核通过后才按群注入上下文。 |

---

### 💬 顶级拟人化交互与社交体验

- **群聊批处理聚合（`groupBuf`）**：群里大家一句接一句说得慢时，插件自动缓冲聚合（Debounce），看完整段对话再回，绝不抢话、绝不一条一回。
- **真人打字延迟仿真（`bubbleDelay`）**：按文本长短模拟真人打字节奏（约 9 字/秒，带随机抖动），多气泡平滑逐条发出；自动保护 ```` ```` 代码块与长文本不被切碎。
- **Markdown 自动洗涤（`stripMarkdown`）**：QQ 原生不渲染 Markdown，自动剥离生硬的标题 `#`、加粗 `**`、列表 `-` 等符号，呈现自然微信/QQ 排版风格。
- **多模态与回复标记语法**：
  - `|||`：强制断句分气泡；
  - `<voice>文字</voice>`：将该段转为真实 QQ 语音条发出；
  - `<sticker:名字>`：从本地表情库匹配真实表情发出；
  - `<poke>`：向对方发送原生 QQ 戳一戳；
  - `<reply:编号>`：在群聊中以引用回复形式精准接某条消息。
- **按会话独立选模型**：主人在面板「模型」页可为每个私聊、每个群独立指定模型与思考强度（优先级：单个私聊 > 单个群 > 私聊默认 > 群默认 > 全局模型）。
- **自然声音翻唱（RVC + 混音）**：点歌 → 网易云拉取 → audio-separator 人声分离 → Applio RVC 转换音色 → 混音发出语音条；翻唱音色可直接联动至日常聊天语音变声。
- **桌面宠物（Electron 透明悬浮窗）**：把大肥鱼请到桌面上，9 种物理动作、跟随 DSH 干活状态做动画，碎碎念只弹桌面气泡不打扰 QQ。
- **空间日记与社区互动**：自动写 QQ 空间日记并互动、逛小黑盒读帖/热榜/发帖、逛 B 站看视频写评论、抖音私信与视频点赞分享。

---

## 🚀 安装指南

### 前置准备
1. 已安装 **DeepSeek Harness (DSH)** 桌面版或命令行版（0.2.x ~ 0.3.x）；
2. 一个用于机器人的 QQ 号，以及一个 OneBot v11 网关：
   - **Windows**：推荐使用 [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases)（插件内置自动化启停与注入管理）；
   - **Linux / Docker / macOS**：使用 [NapCat](https://github.com/NapNeko/NapCatQQ)、LLOneBot、Lagrange 等任意 OneBot v11 实现，开启 WebSocket 服务端即可。

### 1. 安装插件

#### Windows 桌面版 (PowerShell)
```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:lecheng2018/dsh-aurabot-qq
```

#### Linux / macOS / Docker (Bash)
```bash
dsh plugin --profile <你的profile名称> add github:lecheng2018/dsh-aurabot-qq
```

> **离线安装**：也可直接从 [GitHub Releases](https://github.com/lecheng2018/dsh-aurabot-qq/releases) 下载 `dsh-aurabot-qq-x.x.x.tgz`，执行 `dsh plugin add ./dsh-aurabot-qq-x.x.x.tgz`。

### 2. 初始配置向导

安装后重启 DSH，打开左侧栏「自动化任务」下的 **Aurabot** 控制面板：
1. 填入机器人 QQ 号与你的主人 QQ 号；
2. 选择 QQ 网关连接方式：
   - **SnowLuma（Windows）**：填入安装目录，插件会自动生成控制台密码、按号注入；
   - **接已有 OneBot**：填入正向 WebSocket 地址（如 `ws://127.0.0.1:3001`）及 Token；
3. 先在「试运行」模式下测试（只记日志不真发），确认一切正常后关闭「试运行」，正式上线！

---

## 🔄 升级指南

只需重新运行安装命令拉取最新发布包，然后重启 DSH 即可。所有配置、人格卡、记忆和状态文件均保存在插件数据目录，升级永不丢失：

```powershell
# Windows
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:lecheng2018/dsh-aurabot-qq

# Linux / Docker
dsh plugin --profile <你的profile名称> add github:lecheng2018/dsh-aurabot-qq
```

---

## 🔒 预设体系与安全设计

插件自带 3 个预设（Agent Preset），在物理层确保权限边界清晰：

```
cordis.patch.yml
  ├── aurabot-private      (主人私聊：完整工具 + 人格独占提示词，极速响应)
  ├── aurabot-private-long (主人私聊长任务：额外挂载 dsh-tool-jobs 与 dsh-tool-schedule)
  └── aurabot-social       (群聊/陌生人：物理剔除 Bash/FS/网络等系统工具，仅保留 QQ 交互)
```

- **提示词前缀缓存保护**：人格与规则通过提示词模板变量注入；动态记忆、群黑话、环境信息追加在对话末尾，**不破坏大模型 KV Cache**；
- **群聊安全刹车**：短时间发言过多自动暂停（`burstMax`），只有主人 `@` 能唤醒；
- **敏感信息自动脱敏**：日志与审批流对 AppSecret、网络 Token、UNC 路径、敏感凭据自动打码。

---

## 📋 QQ 常用管理指令（主人私聊专属）

在 QQ 里直接向机器人发送斜杠命令，无需打开电脑面板即可实时控制：

| 指令 | 说明 |
|---|---|
| `/remind ...` | 定时任务管理：`/remind in 30m 喝水`、`/remind daily 08:30 打卡`、`/remind list`、`/remind del 1` |
| `/unlock [动态码]` | 权限锁验证：获取一次性码或输入手机 TOTP 动态口令解锁 30 分钟完整权限 |
| `/approvals` | 查看当前待审批的工具操作清单 |
| `通过 #1` / `拒绝 #1` | 批复指定的待审批操作编号（仅单个时可省略编号） |
| `/silent [分钟]` | 开启静默（可指定分钟数，默认一直静默） |
| `/active` | 恢复正常发言，解除静默 |
| `/model` | 查看或切换当前聊天会话使用的大模型 |
| `/sing 歌名` | 点歌翻唱，处理完成后自动发语音条 |
| `/remember 内容` | 手动为她添加一条长期记忆 |
| `/status` | 查看机器人当前运行状态、会话、网络与配额面板 |

---

## 📂 项目结构概览

```text
dsh-aurabot-qq/
├── cordis.patch.yml          # DSH 插件及 3 个 Agent Preset 挂载清单
├── client/client.js          # DSH 侧边栏 React 整页面板（前端）
├── src/
│   ├── host.js               # 插件核心入口（Cordis 服务绑定 / 看门狗 / 路由）
│   ├── core/
│   │   ├── modules.js        # 微内核模块引擎（支持热重载、快照与错误隔离）
│   │   ├── config.js         # 配置管理与脱敏
│   │   ├── net.js            # 网络请求抽象与 302 重定向 SSRF 防护
│   │   ├── store.js          # 原子读写与 Windows EPERM 容错重命名
│   │   └── llm.js            # 大模型能力探测与思考强度收敛
│   ├── chat/
│   │   ├── hub.js            # 消息调度中枢（会话映射、连发合并、发送分发）
│   │   ├── reply.js          # 回复解析引擎（Markdown 洗涤、断句切气泡、延迟仿真）
│   │   ├── questions.js      # 交互式提问状态机与 A/B/C 卡片系统
│   │   ├── approvals.js      # 通用工具审批流与审批卡系统
│   │   ├── backfill.js       # 断线消息自动补收与命令隔离
│   │   └── group-policy.js   # 群聊插话策略纯函数
│   ├── modules/              # 24 个独立功能模块
│   │   ├── scheduler/        # 全功能通用定时任务调度引擎
│   │   ├── security-lock/    # RFC 6238 TOTP 手机动态口令权限锁
│   │   ├── token-guardian/   # 上下文 Token 监控与自动 Compaction 守门员
│   │   ├── complete-guard/   # 截断回复识别与告警
│   │   ├── memory-privacy/   # 记忆私聊/群聊三层作用域物理隔离
│   │   ├── slang-learner/    # 群黑话收集与审核注入
│   │   └── ... (stickers, voice, mood, memory, pet, bili, song 等)
│   ├── onebot/client.js      # OneBot v11 客户端（WS 实时收事件 + 90s 心跳看门狗）
│   └── security/danger.js    # DSH tools/pre-execute 危险终端命令拦截器
├── .github/workflows/
│   └── release.yml           # CI/CD 自动测试门禁、打包 .tgz 与 GitHub Release 发版
└── test/                     # 746 个原生 Node.js 测试用例（100% 通过）
```

---

## 🧪 自动化测试

项目坚持严谨的测试文化，全套单元测试与集成测试基于 Node.js 原生测试运行器，毫秒级执行：

```bash
# 执行全部 746 个测试用例
npm test
```

---

## 💾 数据持久化位置

插件数据统一存储于操作系统的用户目录中，重启、更新或重装插件均不会丢失：
- **Windows**：`%USERPROFILE%\.dsh\plugins-data\aurabot\`
- **Linux / Docker / macOS**：`~/.dsh/plugins-data/aurabot/`

包含：`config.json`（配置）、`modules-data/`（各模块独立数据目录）、`memories.json`（记忆库）、`stickers/`（表情库）、`tasks.json`（定时任务）、`logs/`（脱敏日志）。

---

## 📄 开源许可与致谢

- 本项目基于 [MIT License](LICENSE) 开源；
- 桌面宠物客户端及物理模型基于 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）；
- 「大肥鱼」形象素材版权属于原作者，遵循 [CC BY-NC-SA 4.0](THIRD-PARTY-NOTICES.md) 协议；
- 感谢 [DeepSeek Harness](https://github.com/deepseek-ai) 社区及所有为此项目贡献代码与创意的开发者！
