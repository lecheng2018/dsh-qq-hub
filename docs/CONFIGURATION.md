# 配置参考

本文解释 QQ Hub 的常用配置字段。优先通过面板修改；需要直接编辑 `config.json` 时，建议先停止 DSH 并备份文件。

配置默认位于：

```text
~/.dsh/plugins-data/dsh-qq-hub/config.json
```

老用户可能仍使用 `~/.dsh/plugins-data/aurabot/config.json`。自定义数据目录由 `DSH_QQ_HUB_DATA_DIR` 指定。

## 基础与权限

| 字段 | 含义与注意事项 |
|---|---|
| `enabled` | 插件总开关。关闭后不处理普通聊天，也不发送普通回复；主人仍可用 `/on` 恢复 |
| `dryRun` | 试运行。处理消息并记录准备发送的内容，但不实际投递 |
| `setupDone` | 首次设置向导是否完成；通常由向导维护 |
| `botQQ` | 机器人小号的 QQ 号，连接后应与网关实际登录号一致 |
| `ownerQQ` | 主人账号。只有该账号能执行主人命令和高权限操作 |
| `ownerName` | 提示词和界面中对主人的称呼 |
| `ownerLevel` | 主人私聊权限：`full` 完整工具、`social` 仅社交工具、`chat` 纯聊天 |
| `workspaceDir` | QQ 会话工作区；留空时使用默认目录 |
| `longTasks` | 主人私聊长任务模式；开启后增加后台任务和定时任务工具 |
| `allow.private` | 额外允许私聊的 QQ 号数组；主人无需重复添加 |
| `allow.groups` | 允许使用的群号数组 |

`full` 权限可以接触 DSH 提供的本地命令和文件工具。不要把不可信账号设为主人，也不要为了临时排障降低群聊权限。

## 网关

| 字段 | 用途 |
|---|---|
| `gateway` | 网关类型：`snowluma` 或 `onebot` |
| `snowluma.dir` | Windows 上 SnowLuma 的安装目录 |
| `snowluma.autoStart` | 是否随 DSH 启动 SnowLuma |
| `snowluma.autoAttach` | 是否按面板操作接入机器人 QQ 进程 |
| `snowluma.httpUrl`、`snowluma.wsUrl` | 已存在服务的 HTTP/WebSocket 地址；留空时按配置自动读取 |
| `snowluma.httpToken`、`snowluma.wsToken` | 对应服务的访问令牌 |

使用已有 OneBot 服务时，主要填写 WebSocket 地址和对应令牌。fnOS/Docker 跨容器或跨设备连接不能使用对方的 `127.0.0.1`。

## 模型

| 字段 | 用途 |
|---|---|
| `model.provider`、`model.model` | 插件全局模型；留空时跟随 DSH 默认 |
| `model.reasoningEffort` | 思考强度；可选 `low`、`medium`、`high` 或留空 |
| `model.vision` | 视觉能力：`auto` 自动、`on` 支持、`off` 不支持 |
| `chatModels.privateDefault` | 所有私聊的默认模型 |
| `chatModels.groupDefault` | 所有群的默认模型 |
| `chatModels.privates` | 按私聊 QQ 号覆盖 |
| `chatModels.groups` | 按群号覆盖 |

优先级为：单个聊天 → 所有同类聊天默认 → 插件全局 → DSH 默认。模型从 DSH 删除后退回下一级。

视觉设置影响图片是否交给当前模型。关闭视觉或模型不支持图片时，插件会使用已配置的辅助识图能力或明确说明无法看图。

## 消息处理

### 连发合并 `merge`

| 字段 | 用途 |
|---|---|
| `enabled` | 是否合并短时间连续输入 |
| `waitSec`、`maxSec` | 私聊等待时间与最长合并窗口，单位为秒 |
| `groupWaitSec`、`groupMaxSec` | 群聊对应设置 |

### 断线补收 `backfill`

| 字段 | 用途 |
|---|---|
| `enabled` | 是否启用补收 |
| `gapMs` | 判定连接出现断档的阈值，单位毫秒 |
| `settleMs` | 连接恢复后等待稳定再拉取的时间 |
| `maxAgeMinutes` | 允许补收的最旧消息年龄 |
| `maxPerConversation` | 每个会话单次最多补收条数 |

补收消息会带有迟到说明，不会把旧消息伪装成刚收到。命令、审批回复等仍受补收安全规则限制。

### 文件发送 `files`

| 字段 | 用途 |
|---|---|
| `enabled` | 是否提供文件发送工具 |
| `maxMB` | 单文件大小上限，默认 50 MB |
| `dirs` | 除 QQ 工作区外，额外允许发送的目录数组 |

只有主人私聊能触发文件工具，可以发给白名单内的人或群。远程网关无法读取 DSH 本机路径时，小文件可尝试 base64 上传；发送结果不确定时不会自动重发。

## 语音与表情

### `voice`

- `enabled`：语音总开关。
- `engine`：语音合成方式，例如 `auto`、`edge`、`windows`、`cosyvoice`、`gptsovits`、`http`。
- `asr`：是否把收到的语音转成文字。
- `autoChance`、`autoMaxChars`：短文本自动转语音的概率和长度上限。
- `songVoice`、`songPitch`：是否使用翻唱音色变声及半音偏移。

### `stickers`

- `enabled`：表情功能总开关。
- `faces`：是否使用 QQ 自带小黄脸。
- `autoChance`：回复自动附带表情的概率。
- `collect`：是否收集收到的表情。
- `collectMode`：`auto` 自动收集、`ask` 由模型选择、`owner` 仅主人语境。

普通照片不应因为开启了表情收藏就被当作表情入库。

## 群聊

`group` 保存群聊策略，`group.overrides` 可按群号覆盖。常用项包括：

- `wakeWords`：唤醒词。
- `interjectChance`：无人直接呼叫时的插话概率。
- `cooldownSec`、`maxPerHour`：插话冷却和每小时上限。
- `burstMax`、`burstWindowSec`：短时间发言刹车。
- `quota.enabled`、`quota.perMinute`：群发送配额。

将插话概率设为 0 可关闭普通插话；被 @、被引用或命中唤醒词仍按必回规则处理。

## 安全与面板

| 字段 | 用途 |
|---|---|
| `security.dangerConfirm` | 高风险命令是否需要主人确认，默认关闭 |
| `security.identityGuard.enabled` | 是否检查出站内容中的受保护账号 |
| `security.identityGuard.mode` | `block` 拦截或 `warn` 仅告警 |
| `security.panel.allowedHosts` | 允许访问面板的额外域名数组 |

域名示例：

```json
{
  "security": {
    "panel": {
      "allowedHosts": ["nas.example.com"]
    }
  }
}
```

直接通过设备 IP 或 localhost 访问通常不需要添加。使用反向代理时，还应在代理层配置身份认证和来源限制。

## 各功能模块

B 站、抖音、小黑盒、RSS、生图、翻唱等设置位于各自顶层字段，也可在面板对应页面修改。模块是否加载还受「扩展」页开关影响。

通用原则：

- 先完成登录和依赖准备，再开启自动浏览或主动发送。
- 评论、发帖、改资料等写操作另有权限和额度，不因打开浏览开关就自动获得全部权限。
- 外部平台出现验证码、身份验证或风控时，先处理账号状态，不要连续重试。
- 自定义模块放在数据目录 `modules/`，升级插件不会覆盖这些文件。

## 环境变量与回滚

- `DSH_HOME`：覆盖 DSH 数据根目录。
- `DSH_QQ_HUB_DATA_DIR`：覆盖本插件数据目录。
- `FLAG_MODULAR_CORE=false`：显式回退到 legacy 消息处理路径；修改后需要重启 DSH。

其他重构实验开关只用于维护者验证，不建议普通部署随意开启。当前状态见 [新核心验证台账](refactor/new-core-parity-ledger.md)。

## 主要数据文件

| 文件或目录 | 内容 |
|---|---|
| `config.json` | 面板与功能配置 |
| `modular-sessions.json` | 新核心的聊天与 DSH 会话映射 |
| `deliveries.json` | 投递状态、原因和网关回执 |
| `memories.json`、`memories.db` | 长期记忆存储 |
| `stickers/` | 表情库 |
| `modules/`、`modules-data/` | 自定义模块及其数据 |
| `logs/` | 脱敏运行日志 |

台账中超过 7 天的 sent/cancelled 记录只保留前 200 字正文和元数据；unknown/failed 不裁切，便于后续审计。
