# Aurabot · 住在 QQ 里的大肥鱼

DeepSeek Harness（DSH）插件。DSH 里的 AI 以独立 QQ 号「大肥鱼」的身份住进 QQ：有人格、心情和记忆，能看图、发语音、听语音、发和收表情包、写 QQ 空间日记，还会主动找你聊天。

```
QQ ⇄ SnowLuma（OneBot v11，你自己安装）⇄ Aurabot 插件 ⇄ DSH 会话（Aurabot 自带的 preset + 人格）
```

- **入口**：DSH 左侧栏「自动化任务」下面的「Aurabot」。整页面板用标签分功能：概览、连接、人格、权限、群聊、模型、语音、表情包、空间日记、主动搭话、心情与记忆、翻唱、日志。
- **会话**：每个 QQ 私聊或群各对应一个 DSH 会话，都放在侧栏的「Aurabot · QQ」工作区里，可以点开看她想了什么、调了什么工具，也可以直接插话。
- **安全默认**：总开关关、试运行开。不手动打开，一句都不会发到 QQ。

## 安装

需要：Windows、DeepSeek Harness 桌面版、一个用来当机器人的 QQ 小号。

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:accomplish07zrh-eng/dsh-aurabot-qq
```

装好后重启 DSH，打开左侧栏「自动化任务」下的 **Aurabot**，跟着设置向导走：

1. 填机器人 QQ 号（用小号）和你的 QQ 号
2. 自己下载并解压 [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases)
3. 启动，在面板里同意 SnowLuma 的协议（控制台密码自动生成）
4. 登录机器人号，点「接入机器人号」
5. 先试运行，或直接上线

## 设计要点

| 方面 | 做法 |
|---|---|
| 人格注入 | 插件在 `cordis.patch.yml` 里自带两个 agent preset：`aurabot-private`（主人私聊，完整工具）和 `aurabot-social`（群聊和其他人私聊，没有任何本地工具）。人格通过 `@deepseek-ai/dsh-persona` 放在系统提示词最前，文本来自插件注册的提示词变量 `{{aurabot_persona}}`，切换人格无需重建 preset。 |
| 每轮变化的内容 | 心情、记忆用 `agent.ctx.systemPrompt.context()`，追加在对话末尾，不破坏前缀缓存。 |
| 群聊上下文 | 发言人、群里刚才在聊什么，直接写在交给她的那条消息里。 |
| 工具 | 按会话注册（`agent.ctx.tools.register`），只出现在 Aurabot 的会话里。群管在工具层校验这一轮有主人下令、对象不是主人、她在群里有管理权限；点歌、生图校验「这一轮说话的人全是主人」，不只靠人格约束。 |
| QQ 网关 | SnowLuma 的 OneBot v11：WS 收事件（实时），HTTP 调接口。插件从 SnowLuma 配置文件自动读取端口和令牌。 |
| SnowLuma 管理 | SnowLuma 的 EULA 第 5.4 条不允许「通过自动化脚本部署」，所以插件不下载，也不替你同意协议：协议全文显示在面板里，由你本人勾选同意。插件只启停你自己装好的那一份（后台运行，不弹窗口）；第一次启动时用 `SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD` 设一个自己生成的控制台密码。注入前用 `/api/processes` 核对每个 QQ 进程登录的号，只注入机器人号；`hookAutoLoad` 永远关。 |
| 语音 | TTS 用 edge-tts（装在插件自己的 Python 虚拟环境里），也可以接本地的 CosyVoice、GPT-SoVITS，装不上时用 Windows 自带中文语音兜底。管线里留了 RVC 变声插槽。ASR 先用 QQ 自带的语音转文字（`fetch_ptt_text`），再试 DSH 的 `speechToText`。 |
| 表情包 | 只收真正的表情（`sub_type=1`、mface、带 `emoji_id` 的），再过尺寸、宽高比、体积、MD5 去重、每小时限额几道关。收下后 `add_custom_face`，视觉模型起备注后 `modify_custom_face`。 |
| 空间日记 | `send_qzone_msg`。在专用的后台会话里写，结合当天聊天流水；那一轮不转发到聊天。 |
| 翻唱 | 只预留：`qq_song_cover` 工具、面板标签和变声插槽。 |

## 目录

```
src/host.js            插件入口（宿主半边）+ 面板接口 /aurabot/api/*
src/chat/              消息中枢、群聊策略、回复解析、白名单与权限
src/onebot/client.js   OneBot v11 客户端（HTTP + WS，自动重连）
src/snowluma/          SnowLuma 管理（检测、启停、只注入机器人号）
src/features/          表情包、空间日记、心情、记忆、主动搭话、翻唱（预留）
src/voice/tts.js       文字转语音
src/tools/tools.js     挂给会话的工具
src/persona/           人格卡与规则
client/client.js       网页半边：侧栏入口 + 面板
personas/dafeiyu.md    默认人格「大肥鱼」
cordis.patch.yml       插件与两个 preset 的挂载声明
test/                  单元测试 + 端到端测试（假 DSH 宿主 + 模拟 OneBot）
```

## 测试

```
npm test
```

## 数据位置

`%USERPROFILE%\.dsh\plugins-data\aurabot\`：配置、人格、表情库、日记、记忆、日志。重装插件不会丢。

## 致谢

参考了 [Yuuyuko-uu](https://github.com/Yuuyuko-uu) 的 dsh-qq-bridge、dsh-speak-up、dsh-feiyu-mood、dsh-fish-memory 等插件（MIT）在 DSH 插件机制上踩过的坑，具体是：注销器是函数而不是 `.off()`；`followup` 必须 await；心情别每轮都提。没有复制它们的代码。
