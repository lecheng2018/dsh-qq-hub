# DSH QQ Hub

把 QQ 私聊和群聊接入 DeepSeek Harness（DSH）。插件运行在 DSH 所在设备上，支持 fnOS NAS、Windows、Linux 和 Docker 部署。

[![Release](https://img.shields.io/github/v/release/lecheng2018/dsh-qq-hub?color=blue)](https://github.com/lecheng2018/dsh-qq-hub/releases)
[![Tests](https://img.shields.io/badge/tests-passing-success)](https://github.com/lecheng2018/dsh-qq-hub/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

当前版本：**v1.3.65-test.20261110.7（预发布）**。版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 能做什么

- **QQ 聊天**：支持主人私聊、白名单私聊和白名单群聊；群里可被 @、引用或唤醒词触发。
- **图片、语音和文件**：看图、语音转文字、发送语音/表情/文件，读取引用和合并转发。
- **人格与记忆**：可更换人格；按聊天隔离记忆，支持长期记忆和主动搭话。
- **远程协助**：主人可在 QQ 私聊中使用 DSH 的模型和已授权工具，接收提问卡片并审批高风险操作。
- **定时与主动任务**：支持提醒、定时分享、QQ 空间日记和动态互动。
- **可选内容模块**：B 站、抖音、小黑盒、RSS、贴吧阅读、生图和翻唱等可按需启停。
- **自行扩展**：可在数据目录添加模块，无需修改插件源码；支持热重载和面板模拟测试。

默认不会向所有私聊和群开放。机器人账号、主人账号、可用私聊和群都需要明确配置。

## 安装前准备

需要：

1. 已安装并能正常使用 DSH，已配置可用模型。
2. 一个作为机器人使用的 QQ 小号。
3. 一个兼容 OneBot v11 的 QQ 网关：
   - 已有 NapCat、LLOneBot、Lagrange 等服务时，直接使用其正向 WebSocket 地址。
   - Windows 也可使用 [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases)，由插件辅助启动和接入。

OneBot 是插件与 QQ 网关之间的通信协议。它本身不是 QQ 登录服务，仍需单独安装和登录网关。

## 安装

### 在线安装

Windows 桌面版：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:lecheng2018/dsh-qq-hub
```

fnOS、Linux 或 Docker 命令行：

```bash
dsh plugin --profile <你的-profile-名称> add github:lecheng2018/dsh-qq-hub
```

### 离线安装

从 [Releases](https://github.com/lecheng2018/dsh-qq-hub/releases) 下载所需版本的 `.tgz`，然后执行：

```bash
dsh plugin --profile <你的-profile-名称> add ./dsh-qq-hub-<版本号>.tgz
```

也可以在 DSH 的插件安装界面中选择该文件。安装后重启 DSH。

## 第一次配置

打开 DSH 左侧「自动化任务」中的 **QQ Hub**，按设置向导完成：

1. 填写机器人 QQ 小号和你自己的主人 QQ 号。
2. 选择网关：
   - **已有 OneBot 服务**：填写正向 WebSocket 地址；如果网关启用了访问令牌，也填写对应令牌。
   - **Windows SnowLuma**：填写安装目录，启动服务，阅读并同意其协议，再接入已登录机器人小号的 QQ 进程。
3. 添加允许使用的私聊和群。主人私聊不需要重复添加。
4. 检查网关是否已连接，以及插件核对出的登录号是否为机器人小号。
5. 先保持 **试运行** 开启，用主人账号发一句「在吗」。

试运行时，插件会处理消息并记录准备发送的内容，但不会真的发到 QQ。确认回复、权限和日志正常后，打开总开关并关闭试运行。

### fnOS / Docker 网络注意事项

- 如果 DSH 和 QQ 网关不在同一容器或同一设备，不要使用 `127.0.0.1`。
- 应填写网关所在设备或容器实际可访问的地址，并确认端口和容器端口映射已开放。
- 使用域名访问 QQ Hub 面板时，需要把域名加入 `config.json` 的 `security.panel.allowedHosts`；直接通过设备 IP 访问不需要这一项。

## 日常使用

### 在 QQ 中管理

以下命令只接受主人发送。即使总开关关闭，也可以用 `/on` 恢复。

| 命令 | 用途 |
|---|---|
| `/help` | 查看当前可用命令，包括扩展命令 |
| `/status` | 查看连接、收发和运行状态 |
| `/on`、`/off` | 打开、关闭插件总开关 |
| `/silent [分钟]` | 当前聊天暂停发言，可设自动恢复时间 |
| `/active` | 恢复当前聊天 |
| `/quiet`、`/chatty`、`/normal` | 调整当前群的插话档位 |
| `/model` | 查看模型；`/model 序号` 切换，`/model 默认` 跟随 DSH |
| `/remember 内容` | 在当前聊天的作用域中记住一件事 |
| `/reset` | 清空当前对话上下文，不删除长期记忆 |
| `/new` | 清除当前聊天的记忆，不动对话历史 |
| `/diary` | 立即写一篇 QQ 空间日记 |
| `/remind …` | 创建或管理提醒；用 `/help` 查看具体格式 |
| `/approvals` | 查看等待审批的高风险操作 |

### 在面板中管理

- **连接**：网关、工作区和连接诊断。
- **权限**：私聊/群白名单、主人权限和各模块操作权限。
- **人格**：编辑、切换或按聊天指定人格。
- **模型**：选择全局或按聊天使用的模型。
- **群聊**：插话概率、唤醒词、发送配额和单群设置。
- **扩展**：启停、复制、新建或模拟测试模块。
- **日志**：查看连接、投递和错误信息。

其他功能按名称进入对应页面即可。内容浏览、评论、发帖和翻唱等外部能力应先在对应模块中完成登录、依赖安装和权限设置。

## 常用配置

大多数设置在面板中修改后会立即保存。下面只列日常使用中最需要理解的项；字段路径和排障说明见 [配置参考](docs/CONFIGURATION.md)。

| 配置 | 用途 |
|---|---|
| `enabled`、`dryRun` | 总开关与试运行；排障时先确认这两项 |
| `ownerQQ`、`ownerLevel` | 主人账号及其私聊权限；完整权限包含本地工具，应谨慎授予 |
| `allow.private`、`allow.groups` | 允许对话的私聊和群白名单 |
| `workspaceDir` | QQ 会话工作区，也是默认允许发送文件的目录 |
| `model`、`chatModels` | 全局模型及按私聊/群覆盖；可按聊天选择视觉和思考强度 |
| `merge` | 私聊和群聊的连发合并等待时间 |
| `backfill` | 断线恢复后补收消息的范围、等待和数量上限 |
| `files` | 文件发送开关、大小上限和额外允许目录 |
| `voice`、`stickers` | 语音、表情和自动收藏行为 |
| `security` | 高风险命令确认、账号泄露检查和面板访问控制 |

### 模型选择顺序

按聊天指定的模型优先于全局模型：单个私聊或群 → 所有私聊/群默认 → 全局设置 → DSH 默认。指定的模型已从 DSH 删除时会退回下一级。

### 面板使用域名访问

插件会检查请求的 Host 和来源。直接通过设备 IP 访问通常无需额外配置；使用 fnOS DDNS 或其他域名时，把域名加入：

```json
{
  "security": {
    "panel": {
      "allowedHosts": ["nas.example.com"]
    }
  }
}
```

如果前面还有反向代理，应在代理层另外配置访问控制，不要只依赖公网暴露的插件面板。

## 模块依赖与限制

模块可以在「扩展」页单独停用。以下能力不是安装插件后就无条件可用：

| 模块 | 需要准备 | 主要限制 |
|---|---|---|
| 语音识别与语音条 | 网关转写、本地 ASR 或可用的 TTS 服务 | 失败时应退回文字并说明原因 |
| 生图 | 可用的图片生成接口或已配置的本地接口 | 构图和尺寸能力取决于服务端 |
| B 站 | 按需填写登录 Cookie；看画面还需 ffmpeg 和视觉模型 | 评论、改资料等写操作有独立权限和额度 |
| 抖音 | 可用浏览器及扫码登录；NAS 无桌面时需显示环境 | 验证码、身份验证和平台风控会暂停写操作 |
| 小黑盒 | 账号 Cookie；写操作还需相应令牌 | 浏览、评论、发帖分别受权限和频率限制 |
| RSS | 订阅源地址 | 默认只进入内容池，主动推送需另行开启 |
| 贴吧阅读 | 可运行浏览器；也可使用其自带安装流程 | 只读，不提供发帖、回帖和点赞 |
| 翻唱与变声 | 自行准备有权使用的音色模型及处理环境 | 目前主要支持 Windows；模型和处理依赖体积较大 |

外部平台可能随时调整接口、验证码和风控策略。模块失败时不要反复重试写操作，先看日志和账号状态。

## 权限与安全

### 主人私聊权限很高

主人私聊默认可以使用完整工具，包括 DSH 提供的本地命令和文件能力。请只把可信账号设为主人，并妥善保护 DSH 面板。

- 群聊和非主人私聊不加载本地命令、文件系统等电脑操作工具。
- 发文件仅限 QQ 工作区和面板额外允许的目录，并有单文件大小限制。
- 高风险命令确认默认关闭，可在安全设置中开启；开启后，相关命令需要主人在 QQ 中确认。
- 出站内容会检查受保护的账号信息。私聊允许普通文档编号和端口等裸数字；群聊规则更严格。
- 网关令牌、Cookie 等凭据不会通过面板明文回显；日志会进行脱敏。

### 外部账号和模块

- QQ 机器人请使用小号。第三方网关和自动化操作存在账号限制或封禁风险。
- B 站、抖音、小黑盒等模块可能执行浏览、评论或发帖。请分别检查其权限和每日额度。
- 自行编写的模块与插件同进程运行，能使用你授予的接口。不要加载来源不可信的模块。
- 预发布版用于验证新功能，不建议未经测试直接替换稳定使用的生产实例。

## 自定义模块：最小示例

在数据目录创建 `modules/hello/index.mjs`：

```javascript
export default {
  id: 'hello',
  name: '问候示例',
  api: 1,
  setup(api) {
    api.on('message', async (msg) => {
      if (msg.text !== 'ping') return false
      await api.sendText(msg.chatId, 'pong')
      return true
    })

    api.command({
      name: 'hello',
      desc: '回复一句问候',
      run: (arg) => `你好${arg ? `，${arg}` : ''}`,
    })

    api.rule(() => '你可以在用户说 ping 时用 hello 模块回复 pong。')
  },
}
```

保存后，模块会在数秒内加载。它提供三项能力：

- 收到 `ping` 时回复 `pong`，并阻止该消息继续进入模型。
- 主人发送 `/hello 大家` 时得到扩展命令回复。
- 通过 `api.rule()` 向模型说明模块能力。

需要模型调用工具、读取配置、注册面板接口或定时任务时，查阅 [模块 API 文档](src/modules/API.md)。修改前可在「扩展」页使用模拟测试；真实发送仍受白名单、总开关和试运行约束。

## 数据与升级

默认数据目录：

```text
~/.dsh/plugins-data/dsh-qq-hub/
```

Windows 通常位于：

```text
%USERPROFILE%\.dsh\plugins-data\dsh-qq-hub\
```

老版本沿用已有的 `~/.dsh/plugins-data/aurabot/`。也可以通过 `DSH_QQ_HUB_DATA_DIR` 指定目录。

配置、人格、记忆、模块数据和日志都保存在数据目录，不在插件安装目录。升级前仍建议备份数据目录。覆盖安装后重启 DSH；不要直接修改 `node_modules` 来保存长期改动，因为下次升级会覆盖它。

## 常见问题

### 完全收不到回复

依次检查：总开关、试运行、网关连接、私聊/群白名单和日志。群聊可先 @ 机器人测试。

### 网关地址正确但连不上

确认 WebSocket 服务已启动、令牌一致、端口可访问。在 fnOS/Docker 中重点检查 `127.0.0.1` 是否误指向 DSH 自己。

### 回复被身份检查拦下

查看日志中的脱敏拦截原因和投递台账。群聊中不要发送主人或其他受保护账号；普通文档编号在私聊中不会被当成账号拦截。

### 文件没有收到

检查是否实际调用文件上传，而不是只出现 `[file]` 文本；同时检查文件是否位于允许目录、是否超过大小限制，以及网关能否访问该路径。远程网关看不到 DSH 本机路径时，小文件会按配置尝试 base64 上传。

### 模块改坏了

在「扩展」页停用该模块，或开启安全模式。内置模块的自定义副本损坏时会回退到内置实现。

### 语音、浏览或翻唱功能不可用

这些功能有额外依赖。语音需要可用的语音识别/合成服务；网页模块需要可用浏览器；翻唱目前主要支持 Windows 本地环境。具体错误以模块页面和日志为准。

更多操作说明见 [用户使用手册](docs/USER-MANUAL.md)。

## 开发与验证

项目使用 Node.js 原生测试框架，无需额外测试框架。

```bash
npm ci --prefix extensions/tieba-reader
npm run test:all
npm run pack:check
```

### 文档入口

- 用户：[使用手册](docs/USER-MANUAL.md)、[配置参考](docs/CONFIGURATION.md)
- 模块作者：[模块 API](src/modules/API.md)
- 维护者：[功能与测试矩阵](docs/refactor/feature-matrix.md)、[新核心验证台账](docs/refactor/new-core-parity-ledger.md)、[重构文档目录](docs/refactor/handoff.md)
- 发布历史：[CHANGELOG.md](CHANGELOG.md)

问题反馈请附上插件版本、部署环境、复现步骤和脱敏日志。

## 许可与致谢

- 代码使用 [MIT License](LICENSE)。
- 项目早期基于 [dsh-aurabot-qq](https://github.com/aureth-labs/dsh-aurabot-qq) 演进。
- 多平台内容解析设计参考 [astrbot_plugin_multi_parser](https://github.com/Qfxaile/astrbot_plugin_multi_parser)。
- 素材和第三方组件的许可说明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
