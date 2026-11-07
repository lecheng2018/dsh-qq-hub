# dsh-qq-hub 当前源码功能矩阵

## 范围与证据边界

本文是从当前导出源码静态盘点得到的 **功能基线**，用于 M0 模块化重构核对；它不是生产环境验收、完整安全审计，也不保证每项能力在目标宿主/OneBot/外部网站上可用。

证据按以下口径区分：

- **源码事实**：只表示当前导出里的注册、分支、配置默认值、调用路径或测试断言；不等于目标环境已运行验证。
- **文档记载**：来自仓库内基线、变更记录或代码注释；没有 Git 元数据或实际环境证据时，不作为当前运行事实。
- **测试线索**：括号中引用的测试文件表示源码树中可定位到相关线索，不代表每个断言均覆盖该行行为。M0 最终门禁另有实际结果记录：主测试 1289 tests / 1285 pass / 0 fail / 4 skipped，第二次相同内容 dot reporter 正常退出（0）；扩展 46/46；`npm pack --dry-run` 成功、214 个文件。源码正则断言、fake OneBot、内存假对象与真实网络/线上行为的证明力不同，表中会注明。
- **未验证**：静态盘点与 M0 自动化门禁均不证明宿主授权、OneBot 真实副作用、真实账号、外部网站状态或遗留用户数据迁移；这些属于后续阶段验证范围。

本导出目录没有 `.git`，因此无法独立核对仓库提交。`docs/refactor/baseline.md` 记录当前远端基线为 `main` commit `a5cfcaec0f4aae6775a211f0d331e4d527b545e4`，远端 `refactor/modular-core` 基于该 commit，已有地基提交 `8115132268be5b65de60b677dcde69ddfada54e9`；版本记录为 `1.3.64`、先前本机 Node 记录为 `v24.22.1`。旧契约测试 15/15、契约+loader 40/40、模块/生命周期/隔离 58/58 和 222 个包文件均为历史针对性结果，不能替代或加总为本次 M0 最终门禁。当前导出没有 `src/index.js`。

## 状态分类

| 分类 | 含义 |
| --- | --- |
| 源码已注册 | 在 `src/modules/index.js` 的 `BUILTINS` 中注册，并有模块实现；不表示外部依赖或生产部署已可用。 |
| 默认关闭 | 配置/权限/功能开关默认拒绝或关闭；手动路由、显式 `force` 或模块专用路径仍可能有例外。 |
| 安全门控 | 源码可见权限、白名单、dry-run、身份闸、限额等控制；这里只记录具体门控，不据此断言整个系统安全。 |
| 有副作用 | 可改写 QQ、外部服务、本地文件/数据、宿主会话或配置；每条都应纳入 M0 的授权与回归范围。 |
| 待验证/缺口 | 静态代码无法证明调用方鉴权、外部真实响应、旧数据是否迁移，或已定位测试未覆盖行为。 |

## 基础开关、宿主与模块加载

| 面 | 当前源码基线 | 安全姿态/注意事项 | 测试线索、owner |
| --- | --- | --- | --- |
| 全局运行开关 | `config.enabled` 默认 `false`；`dryRun` 默认 `true`；`setupDone` 默认 `false`。通常 QQ Hub 出站要求启用且非 dry-run。 | `src/chat/hub.js` 的普通文字/语音/文件出口有总开关与 dry-run 检查；`sendSegments(..., { force: true })` 会跳过这两项，也跳过该出口的身份泄露闸。少数直接 `onebot.call()` 的模块不经过这一门。 | `test/outbound-guard.test.js` 是源码断言；`test/e2e.test.js` 使用假宿主/假 OneBot。QA/Integration。 |
| 业务模块 runtime | `src/modules/index.js` 当前登记 23 个内置模块（见下表）；`src/core/modules.js` 执行替换、禁用、启动、卸载和热重载。用户模块可同名替换内置，失败时回退内置；`safeMode` 禁止用户模块；`modules[id].enabled=false` 可关模块。 | 热重载清理工具、路由、监听器、定时器；应继续验证异步在途任务与外部副作用的取消语义。模块默认值不等于总开关已开。 | `test/modules.test.js` 覆盖模块替换、safeMode、关闭、热重载及工具；模拟外部副作用。Module SDK/QA。 |
| 声明式平台加载器 | `src/runtime/module-loader.js` 是平台、GUI、Docker、环境门禁的独立 loader。 | 不应与 `src/core/modules.js` 的业务功能模块 loader 混为一个运行时。 | `test/runtime-loader.test.js`。Module SDK。 |
| 模块能力契约 | `src/core/module-contract.js` 校验新的能力声明/contract。 | 当前 `modules` 业务 runtime 尚未消费这些能力字段（见现有 refactor handoff）；不能把契约存在等同于权限/副作用已由 runtime 执行。 | `test/modular-module-contract.test.js`、`test/modular-contracts.test.js`。Module SDK/QA。 |
| 出站采集/模拟 | `hub.capture()` 捕获经过 Hub 的发送；`src/host/panel/routes-modules.js` 的 simulate 使用该能力。 | 直接 `api.core.onebot.call()` 等不一定进入 capture，模拟并不保证无真实 OneBot 副作用。 | `test/modules.test.js` 的 simulate/OneBot 调用测试；fake OneBot，不是隔离沙箱。Module SDK/Security。 |
| 身份与权限默认 | 主人私聊始终允许；其他私聊、群聊需白名单；主人权限档 `full/social/chat`，群聊最高 `social`。资料/平台权限项默认 `owner`。 | `profilePermits()` 检查 profilePerms 与本轮 owner 身份，不检查全局 enabled 或 dryRun。外站模块自身是否有 dry-run 必须逐项看。 | `test/pure.test.js`、`test/contacts.test.js`、`test/profile-tool-system-chat.test.js`。Security/Privacy。 |
| OneBot 登录 | 连接后读取登录 QQ 号并让 SnowLuma 确认；未核实、核对失败或错号时不分发事件/断开连接。 | 断线补收会读取白名单群/好友历史；管理命令不重放，但主人会收到遗漏提醒。 | `test/onebot-login-buffer.test.js`、`test/backfill.test.js`、`test/gateway-resilience.test.js`，以 mock/逻辑测试为主。Panel/Host/QA。 |

## 内置模块清单（23 项）

顺序与 `src/modules/index.js` 当前启动顺序一致。默认项若未单列，均仍受全局设置、模块是否启用、会话权限、外部依赖和运行时状态影响；“默认 enabled”不代表默认会主动出站。

| ID / 名称 | 当前源码能力、数据与主动副作用 | 默认/安全姿态 | 测试线索与待补 | owner |
| --- | --- | --- | --- | --- |
| `stickers` 表情包 | QQ 收藏表情查询、导入、编辑、匹配、收藏/取消收藏与发送；解析 `<face:...>` 标签，维护本地表情元数据和图片。 | 模块设置默认启用；Hub 表情发送有 stickers 开关，实际 QQ 出站仍需核对 Hub 总开关/dry-run。表情读取/修改可能直连 OneBot。 | `test/stickers.test.js`、`test/sticker-pick.test.js`、`test/sticker-owner.test.js`、`test/faces.test.js`；含纯逻辑与 fake 依赖。QA 应补 OneBot 真/假模式差异。 | Media/Voice |
| `voice` 语音 | TTS、ASR 与音频回放；支持本地及 Edge/Windows/CosyVoice/GPT-SoVITS/RVC 等配置路径，面板有试听/安装等操作。 | 模块默认启用；语音出口在 Hub 走 `sendSegments`，失败会回退文字。部分引擎需安装/下载模型或连接外部服务。 | `test/voice-rvc.test.js`、`test/e2e.test.js`（fake host/OneBot）；不能证明本机音频栈或外部服务可用。 | Media/Voice |
| `mood` 心情 | 观察聊天，可选调用模型判心情，并影响语气、上下文或行为策略；涉及模型调用与状态。 | 模块设置默认启用；本身不代表直接发消息，具体主动动作由调用它的功能决定。 | 当前测试树未定位到独立 mood 专项；`test/e2e.test.js`/`test/features.test.js` 是否覆盖目标行为需逐断言确认。补 mood 输入、状态持久化及失败回退测试。 | Core/Chat |
| `memory` 记忆 | 增删改、导入候选/提交、检索与上下文注入、日常整理、人物档案、相处经验、群黑话与群友蒸馏；存储 SQLite，SQLite 不可用时回退 `memories.json`。 | 模块默认启用；记忆写入由 chat scope 和来源控制。后台调用不传可见域时多个 API fail-closed；群聊不返回私聊近期事件。包含自动清理/整合等持久化副作用。 | `test/memory*.test.js`、`test/slang*.test.js`、`test/distill.test.js`、`test/memory-sqlite-store.test.js`、`test/memory-scope.test.js`、`test/memory-leak-regression.test.js` 属于全量主测试目录；M0 汇总结果见基线，不由本矩阵逐项证明目标环境行为。 | Memory/Data、Security/Privacy |
| `qq-tools` 聊天工具 | 读取聊天记录/群信息；主人 full 权限下可发送白名单文件或消息等 DSH 工具能力。 | 发送文件功能默认关，有目录/文件大小限制并只允许主人私聊触发；消息出口依赖 Hub 门控。 | `test/e2e.test.js`、`test/file-segment.test.js`、`test/modules.test.js` 有相关路径线索；待核实 owner、文件访问和真实网关上传。 | Core/Chat、Security/Privacy |
| `group-admin` 群管 | 禁言/解禁、踢人、设专属头衔、发群公告；查询本机在群角色。动作通过 `onebot.call()`。 | 工具要求本轮含主人、群白名单、目标/角色校验，防止对主人禁言/踢出；`dryRun` 时不执行。模块代码未对所有直接 API 调用显式检查 `config.enabled`，全局关闭时的可达性未验证。 | `test/e2e.test.js`、`test/commands.test.js` 有群管/命令情境；需有针对每个 OneBot action 的拦截/真实 dry-run 断言。 | QQ Social、Security/Privacy |
| `imagegen` 生图 | 请求图像生成服务、将图片写入工作区/缓存并可回看或发到聊天。 | 功能默认关闭且 ownerOnly；最终发图依赖 Hub 全局出站门控。模型费用、生成服务、文件写入是额外副作用。 | `test/imagegen*.test.js`、`test/e2e.test.js`；mock 路径为主，服务端真实调用/费用未验证。 | Media/Voice |
| `diary` 空间日记 | 读取当天非 system 聊天片段，模型写说说，可选配图；定时/面板/主人私聊发 QQ 空间，保存 diary 历史并可能写回记忆。另有空间历史同步与删除。 | 日记模块设置默认启用；写说说检查全局 `enabled`、dryRun、面板可见范围和身份闸。定时计划和时段/次数也限制频率。`remove(tid)` 本体直接删除 QQ 空间动态，没有同等总开关/dry-run/actor 检查，调用路由授权须核验。 | `test/qzone.test.js`、`test/qzone-audience.test.js`、`test/diary-image.test.js`、`test/e2e.test.js`；多为 fake OneBot。 | QQ Social、Automation |
| `qzone-social` 空间互动 | 周期扫描好友动态、对动态点赞/评论；对自己说说的新评论回复；记录记忆/状态。 | 模块设置默认启用，但受总开关、模块开关、醒时段、间隔、每日评论上限、身份闸及 dry-run 约束。`run({force})` 路径可能绕普通调度门，调用方权限需验证。 | `test/qzone.test.js`、`test/outbound-guard.test.js`（源码正则断言身份闸，不是实际发帖测试）。 | QQ Social、Automation |
| `speakup` 主动搭话 | 主人一段时间未互动时，在主人私聊主动发起对话，不在群聊主动发言。 | 默认配置启用，但仍受总开关、主人静音、间隔/次数等约束；面板 fire 直接调用主动发送逻辑。 | `test/speakup.test.js`；需要真实调度/时间边界集成验证。 | Automation、Core/Chat |
| `purpose` 目的引擎 | 独立主动引擎：记忆/聊天素材、目的候选、预览、状态、定时 fire/追问；通过 `hub.deliver(private:owner, own:true)` 主动发主人私聊。 | 模块明确默认关闭；`enabled` 与全局开关检查，遵守静音/上限。手动 fire 跳过排程但不应跳过总开关、静音/主人目标。 | `test/purpose.test.js`、`test/purpose-daily-limit.test.js`、`test/panel-purpose*.test.js`；内部假对象/纯逻辑测试。 | Automation、Memory/Data |
| `bili` B 站 | 浏览/选题、评论/回复/点赞、向主人分享内容或截图；可改 B 站资料/头像；使用 Cookie、CSRF 与外部网站。 | `bili.enabled` 默认关；有配额、暂停日、dry-run 与部分身份泄露闸。公开评论/回复需 identity guard；点赞不经过同等公开文本闸；签名/头像修改要求非 dry-run 与凭证。分享走 QQ Hub。 | `test/bili.test.js`、`test/bili-media.test.js`、`test/bili-avatar-source.test.js`、`test/shots.test.js`；`test/outbound-guard.test.js` 仅源码断言接闸。无真实 B 站账号验证。 | External Platform、QQ Social |
| `song` 翻唱/点歌 | 从外部歌源下载音频、读本地音频/模型、分离人声/变声/混音并将语音文件投递 QQ；可能下载数 GB 的 RVC/分离模型，维护队列/缓存/作品历史。 | `song.enabled` 默认关；队列有上限；主人权限/配置控制。音频经 `sendVoiceFile` 走 Hub 总开关/dry-run。安装/模型下载与本地磁盘占用风险高。 | `test/song.test.js`、`test/voice-rvc.test.js`；不得在本次或未授权环境实际下载/安装大模型。 | Media/Voice |
| `profile` QQ 资料 | 读取机器人自身资料、按需拉头像图并用视觉模型识别；发送当前头像；改 QQ 昵称/签名/头像。 | 读取固定机器人账号，仅主人私聊；写工具按资料权限执行并二次核验；dry-run 写操作不落 QQ。头像发送还检查总开关、debug/dryRun、主人和 OneBot 确认。面板 `/avatar/sync-qq` 是另一路由。 | `test/profile.test.js`、`test/profile-scope.test.js`、`test/profile-tool-system-chat.test.js`、`test/e2e.test.js`；`profile.test.js` 含 mock 及 mock OneBot HTTP 发送。真实账号未验。 | QQ Social、Security/Privacy |
| `contacts` 好友申请与白名单 | 保存收到的好友申请；给主人通知；按请求 flag 通过/拒绝申请；增删私聊/群白名单。没有主动加好友实现。 | 申请处理/白名单权限档默认 owner，执行时重查权限；dryRun 时不调用 OneBot、不改白名单；主人不能从私聊白名单移除。好友申请通知自身经 `api.sendText`。 | `test/contacts.test.js`，使用假 api/假 OneBot；未真实处理 QQ 申请。 | QQ Social、Security/Privacy |
| `douyin` 抖音 | 独立 CDP 浏览器、读取/搜索/定时浏览；可点赞、评论、私信；主人确认后分享/艾特，分享可回退向主人 QQ 发内容。 | 模块默认关闭；操作有权限档、日上限/总写上限、新号减半、动作间隔与风控/验证码停手；dry-run 不写外站。主人抖音身份需 `input===confirmedInput` 且 `secUid` 存在才能 @/分享；directDm 是被授权的直接私信能力，目标边界须审计。 | `test/douyin.test.js`、`test/douyin-media.test.js`；fake site/browser，不是实际抖音账号端到端。 | External Platform、Security/Privacy |
| `heybox` 小黑盒 | 读取 feed、帖子、热榜、搜索；写操作包括点赞、评论、发文章、删帖；定时后台 `runSystemTurn` 浏览并可调用工具，维护 Cookie、配额和状态文件。 | `heybox.enabled` 默认关，写权限默认 owner；但系统后台会话被 `profileToolVisible/profilePermits` 视作可信 owner。若开启自动浏览且写权限未关，后台模型可得到外站写工具。`site.js` 写 API 本身没有 dryRun；like/delete 无 identity guard，comment/post 有身份闸；quota 是频率上限，不是授权。外站写不经 Hub 全局开关。 | 没定位到独立 `heybox` 动作集成测试；`test/profile-tool-system-chat.test.js` 测 system 权限 helper，`test/outbound-guard.test.js` 是源码正则，`test/batch-expand-and-privacy.test.js` 只含后台并发锁源码断言。补 fake Heybox API 覆盖写操作、权限/dryRun/模块关闭/autoBrowse。 | External Platform、Security/Privacy、Automation |
| `token-guardian` 上下文治理 | 摘要/压缩 token 历史、单轮并发保护、resetChat 等会话操作。 | 模块声明默认关闭；只影响 DSH 会话/上下文，reset 会清理会话记录或映射，需用户可恢复性边界。 | `test/token-guardian*.test.js`。QA/Integration。 | Core/Chat |
| `complete-guard` 不完整回复守卫 | 检测/记录不完整回复，不修改回复内容。 | 记录日志/状态，不应以此模块名推断它会自动重试或发送。 | 未定位到单独 complete-guard 专项；需补检测边界和“不改回复、不重复发送”的断言。 | Core/Chat、QA/Integration |
| `memory-privacy` 记忆分层 | 定义 `private:<QQ>`、`group:<群>`、`global` 作用域；向主 memory 注册 override；提供作用域查询、删除、隔离设置面板。代码无独立 `scoped.json` 存储。 | 默认启用；未知/无 scope fail-closed；私聊内容面板默认打码；`autoScope=false` 会把新记忆写到 global，应视为高风险显式选择。 | `test/memory-privacy-scope.test.js`、`test/memory-scope.test.js`、`test/batch-expand-and-privacy.test.js`。注意：这些不能证明真实用户旧 `scoped.json` 都已迁入主库。 | Security/Privacy、Memory/Data |
| `scheduler` 定时任务 | 支持 once/delay/daily/workdays/weekly/Cron 等引擎能力，持久化 `tasks.json`；`/remind` 命令和模型工具创建任务，到期通过 QQ 发送提醒卡片。 | 模块默认 enabled；命令只给主人；AI 工具可在非 system 聊天登记，目标为当前会话。到期 `api.sendText` 依赖 Hub 出站门控；模块自身 `enabled` 关闭时不 tick。面板删任务 route 权限依赖宿主。 | `test/scheduler.test.js` 覆盖时间解析/引擎 fake 文件触发，不是 Hub/真实 QQ 全链路。 | Automation、Core/Chat |
| `multi-parser` 多平台解析 | 监听聊天 URL 并抓取 B 站/微博/小红书/知乎/微信/贴吧/番茄/GitHub/抖音/小黑盒等内容；可注入上下文；可将图片、视频、链接、转发卡片或文件发 QQ；写临时媒体文件并清理。 | 总功能默认关闭，platform/chat 分流可关；私聊/群默认允许时，必须先开启。送达层多处直接 OneBot，不保证受 `hub.capture()`、总开关/dry-run、identity guard 保护；视频/文件有限额及模式限制。 | `test/multi-parser.test.js`、`test/multi-parser-scope.test.js`、`test/douyin-media.test.js`、`test/media-cleanup.test.js`；多为 fake 依赖。直接 OneBot 的安全边界需补集成测试。 | External Platform、Media/Voice、Security/Privacy |
| `rss` RSS/Atom 资讯池 | 拉取订阅源、解析并存入 JSONL 池；工具按需查询并记录 readKeys；定时精选会调用模型、选文并发送到配置目标。还可从面板手动拉取/立即精选/检查 URL/清池。 | 资讯池默认关；定时 pull 受 `rss.enabled` 控制；普通定时 digest 同样要求 `rss.enabled` 与 digest 未关闭，并经 `hub.sendText`。**代码与注释存在差异**：`/rss/digest-now` 以 `manual:true` 调用，`digest()` 未检查 `rss.enabled`，且 manual 会绕过 digest.enabled 检查，因此可能在 rss 总开关关闭时仍尝试精选发送；最终仍受 Hub 总开关/dry-run。手动 pull 也绕过 `rss.enabled`。 | `test/rss.test.js` 覆盖解析、池、SSRF URL 检查、精选解析；`test/rss-panel.test.js` 覆盖面板；没有本次执行或真实订阅/QQ 投递验收。补 manual 关闭开关断言并修正文档/实现取舍。 | Automation、External Platform |

## 核心聊天、命令与访问控制

| 面 | 当前源码行为 | 安全/例外 | 测试线索/owner |
| --- | --- | --- | --- |
| OneBot 入站 | `src/host/gateway.js` 验证机器人账号后分发消息、poke 和模块原始事件；补收中断期间白名单会话历史。事件包含好友申请、撤回等。 | `backfill.enabled` 默认/配置门控；补收群和私聊白名单。危险确认回复在入站分发前截留。接收未核验期间事件排队后放行，错号时丢弃。 | `test/onebot-login-buffer.test.js`、`test/backfill.test.js`、`test/gateway-resilience.test.js`。Panel/Host。 |
| 聊天对象与等级 | 主人私聊始终可进；其他私聊/群需 `allow.private` / `allow.groups`。主人可 `full/social/chat`；非主人私聊及群聊均为 social，群不超过 social。 | `safeMode`、会话级 owner、模块工具本身可能进一步拒绝。白名单增删由 `contacts` 提供。 | `test/pure.test.js`、`test/modules.test.js`。Core/Chat。 |
| 核心命令 | 主人专用命令：`help`、`silent`、`active`、`quiet`、`chatty`、`normal`、`model`、`sing`、`status`、`mood`、`diary`、`remember`、`reset`、`new`、`on`、`off` 及中文别名。scheduler 另注册 `/remind`、`/提醒`、`/定时`。 | 核心命令即使总开关关闭仍处理；命令回复有 `force:true` 发送路径，可绕过总开关/dry-run 和 Hub 此处身份闸。不可把“插件总开关关闭”理解为命令层完全无操作。 | `test/commands.test.js`、`test/kernel-command-router.test.js`、`test/e2e.test.js`。Core/Chat。 |
| 合并、接管、记忆钩子 | `src/chat/hub.js` 管理群消息合并/策略、模块接管、工具审批/提问、记忆 hooks、回复拆条及多媒体发送。 | `runSystemTurn()` 本身只运行后台轮次，不自动发 QQ；必须追踪后续是否显式调用 `deliver/sendText` 或模块直连 OneBot。 | `test/e2e.test.js`、`test/modules.test.js`、`test/kernel-dispatcher.test.js`。Core/Chat。 |
| 普通 QQ 出站 | Hub 提供文字、语音、文件、图片/表情等发送；群消息有配额；身份闸可阻止主人/他人 QQ 号泄露。 | `sendSegments` 普通路径要求全局 enabled 且非 dryRun；`force` 则绕过这些检查。`sendFile` 额外要求 files.enabled、路径白名单及大小限制。`send_poke` 单独检查 enabled/dryRun。 | `test/group-quota.test.js`、`test/outbound-guard.test.js`、`test/file-segment.test.js`、`test/e2e.test.js`。Core/Chat、Security/Privacy。 |

## 面板、配置与持久化

### 面板页面与高风险操作

导航由 `client/client.js` 注册；动态模块可注册自有 panel 页面。以下按 UI 页面和服务端路由源码归纳，不代表本次验证了 HTTP 鉴权、反 CSRF、反滥用或网络暴露范围。

| 页面/路由面 | 能力 | 高风险点/待核验 | owner |
| --- | --- | --- | --- |
| 概览、连接 | 状态、OneBot/SnowLuma 连接、安装/初始化与帮助信息。 | 连接/附着/登录检查会访问或改变网关状态。 | Panel/Host |
| 人格 | 人格卡 CRUD、切换、润色。 | polish 会调用模型但不自动保存；切换可能重置/重建会话。 | Panel/Host、Core/Chat |
| 权限、聊天 | owner/profile 权限、白名单、会话、群策略等。 | 权限变化需与已创建工具在执行时二次核验；检查所有 module route 是否共享同一鉴权中间件。 | Security/Privacy、Panel/Host |
| 模型、语音 | 模型路由、语音服务、试听/安装。 | 可能产生模型费用、下载模型、写本地文件或触发外部服务。 | Panel/Host、Media/Voice |
| 表情包、生图 | 表情库管理；生图设置和操作。 | QQ 收藏变更/文件读写/外部生成器调用；send 是否被总开关覆盖需按路由逐条查。 | Panel/Host、Media/Voice |
| 空间日记、主动搭话、心情与记忆 | 日记运行/历史/删除、主动 fire、目的引擎 fire/preview、记忆浏览/删除/隔离。 | `/qzone/delete` 对应的 `qzone.remove()` 直接调删除 API；memory clear 是破坏性删除；主动 fire 可能发出消息。面板授权边界未由本次静态读完整证明。 | Automation、Memory/Data、Security/Privacy |
| 翻唱、B站、抖音、小黑盒 | 外站浏览/操作、凭证/账号状态、队列、配额和测试。 | 各自外站写 API 是否遵守全局 dryRun 不统一；Heybox 后台权限及所有写接口需重点核对。 | External Platform、Security/Privacy |
| 内容解析、资讯池 | 解析测试、源 URL 检查、池查询/拉取/精选/清空。 | 访问用户给出的 URL、可能触发 SSRF；RSS check/pull/digest 与 clear 都是服务端路由，须确认只有授权面板可调用。 | External Platform、Security/Privacy |
| 本地接口 | DSH bridge token、open API、模型路由、日志、头像上传/重置与同步 QQ 头像。 | `/avatar/sync-qq` 是真实 OneBot 头像修改；bridge HTTP 的 token/目标白名单要按部署配置核实；日志/接口测试可能泄露凭证。 | Panel/Host、Security/Privacy |
| 扩展、日志 | 模块管理、reload/create/fork、simulate/tools/tool/panel、日志查看。 | simulate 只捕获 Hub 出口，不自动隔离模块直连 OneBot；tool/API 调用可能产生外部副作用。创建/重载模块属于代码执行面。 | Module SDK、Security/Privacy |

### 配置与数据

| 数据/迁移对象 | 源码现状 | 证据边界/owner |
| --- | --- | --- |
| `config.json` | `src/core/config.js` 定义 `CONFIG_VERSION=1`；包含配置规范化、旧字段兼容、秘密脱敏、保存权限 `0600`、保留空密码，以及更新时对 `qzoneSocial`、`bili`、`douyin` 的 opt-in 处理。多项社交/外站总开关默认关。 | 代码事实；历史配置升级路径需要给每个旧 schema 做 fixture 回归。Core/Panel、Release/Migration。 |
| 数据目录 | `src/core/store.js` 优先 `DSH_QQ_HUB_DATA_DIR`，其次 `AURABOT_DATA_DIR`；否则使用 `~/.dsh/plugins-data/dsh-qq-hub`，新目录不存在时兼容旧 `~/.dsh/plugins-data/aurabot`。模块可使用各自 `dataDir()`。 | `test/scope-migration-script.test.js` 覆盖迁移脚本与目录选择的一致性。Release/Migration。 |
| 记忆库 | SQLite 主存储，缺少 SQLite 能力时回退 `memories.json`；人物档案、事件、profiles、slang、distill 等共用记忆主库。 | `test/memory-sqlite-store.test.js`、`test/memory*.test.js`。真实旧 SQLite/JSON 用户数据升级需单独备份恢复演练。Memory/Data。 |
| 无 scope 老记忆修复 | `scripts/fix-memory-scope.mjs` 默认仅体检，`--write` 会先备份；按 `chatId` 迁入 private/group，推不出来源时要求 owner QQ 并落主人私聊。 | `test/scope-migration-script.test.js` 明确测试脚本备份与归档行为；这是 unscoped `memories.json` 修复，不是 `scoped.json` 搬迁。Release/Migration、Security/Privacy。 |
| 旧 `memory-privacy/scoped.json` | `memory-privacy` 当前模块代码已没有平行存储读写，面板指向主库。`CHANGELOG.md`、panel 注释记载曾把存量迁入主库并备份/停用。 | 当前导出未发现对应的 `scoped.json` 到主库迁移执行脚本/线上样本；`scope-migration-script.test.js` 不是这个迁移的测试。存量是否完整迁完属于**文档记载、未独立验证**，上线前应核对备份/迁移审计。Memory/Data、Release/Migration。 |
| 聊天/模块数据 | sessions 映射、聊天流水、scheduler tasks、diary history、Heybox state/quota、RSS pool/status、媒体临时目录等分别持久化。 | `test/module-data-isolation.test.js` 校验模块数据路径隔离；需要制定可备份、清理、保留及热重载恢复策略。Memory/Data、Release/Migration。 |

## 主动发送与外部副作用清单

下表覆盖已盘点的主动 QQ 出口、外站写操作和本地持久化。外部副作用“直接 API”表示不能只凭 Hub 的开关或 simulate 保护来推断安全。

| 副作用/来源 | 调用路径与触发 | 门控现状 | M0 核对项 / owner |
| --- | --- | --- | --- |
| 普通 QQ 对话与命令回复 | `hub.deliver()` → `sendText/sendSegments`；命令路由含显式 force 回复。 | 普通路径受全局开关、dry-run、identity guard；force 可绕过三者中的总开关、dry-run 和该处 identity guard。群发受 quota。 | 对所有 force 使用点建立允许清单和测试；验证关总开关时普通回复、命令、错误通知分别行为。Core/Chat、Security/Privacy。 |
| 语音、图片、表情、poke、文件 | Hub `sendVoice/sendVoiceFile/sendImage/sendSticker/sendFile/pokeBack`。 | 语音/图片/表情多数走 `sendSegments`；文件另有 files.enabled、路径/大小限制；poke 单独 gate。 | 按出口做 enabled×dryRun×force 矩阵，不能只测文字。Core/Chat、Media/Voice。 |
| 主动搭话/目的引擎 | `speakup.tick/fire`、`purpose.tick/fire` → owner private `hub.deliver`。 | 检查功能开关、静音、间隔/限额、主人目标；最后仍由 Hub 决定能否实际投递。 | 真实时钟调度和重启/重复发送 idempotency。Automation。 |
| 定时提醒 | scheduler 到期 `api.sendText(target, card)`；命令主人专用，AI tool 以当前会话为目标。 | `scheduler.enabled`；实际消息经过 Hub 出站门控。支持群目标，需验证群会话创建提醒的产品预期。 | 重启后不重发、发送失败是否重试/标已完成、群目标权限。Automation、QA。 |
| QQ 好友申请提示 | contacts 收 OneBot request 后写 `friend-requests.json`，并向主人发 `api.sendText` 通知。 | 去重；通知受 `profilePerms.qqFriendRequest !== off`；申请通过/拒绝要求 profile 权限及 dry-run。 | 确认日志/落盘包含申请内容的隐私保留策略。QQ Social、Security/Privacy。 |
| QQ 群管理 | `group-admin` 直接 OneBot `set_group_ban/kick/special_title/_send_group_notice`。 | 本轮主人、群白名单、角色能力、对象校验、dry-run；不是 Hub send，无法自动套用普通出站 gate。 | `enabled=false`、模块禁用、旧工具/并发改权时的执行时校验；各动作 fake OneBot 测试。QQ Social、Security/Privacy。 |
| 空间说说/日记/删除 | `qzone.post` → `send_qzone_msg`；`qzone.remove` → `delete_qzone_msg`；定时 tick / 手动 route。 | 发布检查总开关、dryRun、受限 audience、身份闸；删除函数自身无对等 gate；历史同步读取空间列表并修改本地状态。 | `/qzone/delete` HTTP 授权与删除确认；所有入口统一总开关/dry-run；实际 audience 验证。QQ Social、Panel/Host。 |
| 空间互动 | 好友动态点赞、评论，自己说说评论回复；外部 OneBot 写操作。 | 有账号身份闸/dryRun/开关/频率/每日评论数；点赞与评论的具体闸不同；`force` 调用方需审查。 | 每一种写动作分别覆盖 dry-run 与上限，禁止误把点赞作为已过评论文本闸。QQ Social。 |
| B 站操作 | 评论、回复、点赞、改签名/头像、给主人 QQ 分享内容。 | B站开关、权限、凭证/CSRF、配额、dry-run；公开评论/回复身份闸；主人分享走 Hub。 | 避免浏览/凭证与公开写权限混为一项；外站账户实际返回、重复动作幂等。External Platform。 |
| 抖音操作 | CDP 浏览器读写、点赞评论、私信、@/分享；分享可能回退给主人 QQ。 | 默认关；平台权限、确认主人身份、dry-run、日写限额/间隔/风控停手；直接私信目标授权需单独审计。 | fake Browser 测试之外的账号、目标白名单、风控和隐私验证。External Platform、Security/Privacy。 |
| 小黑盒操作 | feed/watch/search；like/comment/post/delete；定时后台模型轮次。 | 小黑盒自身默认关；写 API 直接请求外站，无自身 dry-run；owner profile 权限及 quota，system 轮视为 owner。comment/post 有 identity guard，like/delete 没有。 | 高优先级：系统后台是否允许自动写、权限配置如何生效、需不需要独立写确认和统一 dry-run；补完整 API fake 集成。External Platform、Security/Privacy。 |
| RSS 获取与发送 | 订阅 URL 网络拉取到本地池；RSS tool 读池；daily digest 调 Hub 给 owner/配置目标发消息。 | SSRF 检查覆盖私网、回环、云元数据；自动拉取受 RSS 开关；manual pull 绕过该模块开关；manual digest 存在前述代码/注释差异，Hub 总开关/dry-run仍生效。 | 修正文档与实际逻辑；测试 HTTP 路由授权、重定向/DNS 重绑定及发送目标验证。External Platform、Security/Privacy。 |
| 多平台 URL 解析送达 | 解析外部链接、下载视频/图片、临时文件；OneBot 发送媒体/合并转发/群文件或链接。 | 模块默认关闭、platform/chat 开关、文件/视频阈值；delivery 中 direct OneBot 调用不一定被 Hub capture/global enabled/dryRun 拦住。 | 明确一条统一出口策略；验证临时文件始终清理、失败/超限不留下孤儿、直接调用不绕过模拟。External Platform、Media/Voice、Security。 |
| 危险命令确认 | `dangerConfirm` 默认 false；启用后执行危险 bash/pwsh 前给 owner 发确认卡，等待确认/取消/超时。 | 仅确认后允许，锁定/非 owner/超时拒绝；确认卡是 QQ 出站。安全性基于源码，不是命令沙箱证明。 | 验证命令模式匹配的边界、确认 token 重放、身份变化与发卡失败；不得将“确认”误当隔离执行。Security/Privacy。 |
| 工具审批与用户提问 | `approvals` 向 owner 发审批卡，默认 60s 超时拒绝；`questions` 给当前聊天发交互卡并等答案/超时。 | 单独的主动 QQ 发送与等待流程；问题默认 5 分钟。应核对总开关、session 归属及并发/消息伪造。 | `test/approvals.test.js`、`test/questions.test.js`；需对真实出站门控做集成验证。Security/Privacy、Core/Chat。 |
| 模块桥接与 Open API | 同进程 bridge、DSH 工具、HTTP `/open/*`；支持 send/think/call。 | HTTP 默认关闭、Bearer token、send/think 目标白名单/owner-only；`call` 可直接进入模块导出，可能扩大副作用面。 | 列出每个可调用方法的能力/目标约束；token 轮换、审计、网络监听面和工具模拟边界。Panel/Host、Security/Privacy。 |
| 控制面板操作 | 重启 gateway、SnowLuma 登录/重置、OneBot reconnect/test、setup/done、`/test-send`、模型同步、头像同步、模块管理。 | `/test-send` 明确检查全局 enabled 且非 dry-run；头像同步为真实 QQ 资料修改。其它路由按各自实现，不能假定统一保护。 | 为每个写路由添加 actor/权限/CSRF/显式 dry-run 语义与审计；面板部署鉴权目前未端到端核对。Panel/Host。 |
| 本地文件/配置/模型副作用 | config 保存、工作区、上传/生成图片、记忆/日记/队列/RSS/模块数据、音频缓存、外部模型下载与安装。 | 有些写操作受 owner/模块开关；并非都受全局 dry-run；潜在敏感 Cookie/令牌需脱敏。 | 明确备份、权限、空间上限、清理、卸载保留策略。Memory/Data、Media/Voice、Release/Migration。 |

## M1+ 未验证边界与后续建议核对项

1. **先统一副作用策略**：为外部写 API、直接 OneBot、普通 Hub 发送定义统一的 disabled/dry-run/force/capability 契约。`hub.capture()` 不能当作对直接 `onebot.call()` 的沙箱。至少让群管、空间删除、多平台解析送达、Heybox 外站写都进入可测试的统一门。
2. **Heybox 后台写权限**：后台 system chat 当前可以获取 owner 档工具；配置开启自动浏览时，默认 owner 写权限使模型可能调用外站写 API；外站 API 本体没有 dryRun。需明确“自动浏览可否写”、单独默认关闭写权限或要求显式确认，并补 fake API 测试后再纳入已验证基线。
3. **RSS 手动路由对齐**：`/rss/digest-now` 传 `manual:true`，而 `digest()` 没有检查 `rss.enabled`；manual 还绕过 `digest.enabled` 检查。源码注释说“不跳过总开关”与实际模块开关逻辑不一致。确认产品预期，修实现/注释，并覆盖开启/关闭组合。
4. **路由鉴权审计**：本次读到若干模块路由直接触发 OneBot、外站或持久化（例如 `/qzone/delete`、RSS pull/digest/clear、scheduler del、module tool/simulate、avatar sync）。需要在实际 host HTTP 装配点证明它们的 actor 授权、CSRF 防护和部署暴露边界；仅有面板按钮隐藏不是服务端授权证明。
5. **记忆数据迁移证明**：`fix-memory-scope.mjs` 与其测试解决的是无 scope `memories.json` 归档；不证明历史 `scoped.json` 已完整并入主库。核对历史用户备份/迁移日志/条数校验，明确备份何时可删除、失败如何恢复。
6. **行为测试而非测试文件存在**：M0 最终自动化门禁结果见本文件开头和 `baseline.md`；它不等同于表中每个行为都有专项断言。后续仍应为各类副作用建立 fake OneBot/HTTP/CDP 端到端矩阵，覆盖 dry-run、总开关关闭、权限撤回、模块热卸载、失败重试、目标变化、重复触发与实际副作用计数。Heybox/complete-guard/mood 的专属行为覆盖当前未能确认或偏弱。
7. **目标环境验收**：真实 OneBot、SnowLuma 版本、外站 Cookie/验证码、CDP、语音/图像服务、Linux/Windows 工具路径、路由公网暴露均未在本次 M0 中执行 OneBot 连接、外站请求、QQ 发送、目标宿主/生产环境操作；这些保留为后续验证边界。

## 本次核验记录

- 本矩阵的功能项来自源码静态盘点；M0 最终门禁另行执行并记录为：主测试 1289 tests / 1285 pass / 0 fail / 4 skipped，第二次相同内容 dot reporter 正常退出（退出码 0）；扩展 46/46；`npm pack --dry-run` 成功、214 个文件。
- 上述汇总测试结果不表示矩阵中每项行为均由专项断言覆盖，也不表示真实网络链路已验证。未在本次 M0 中执行 OneBot 连接、外站请求、QQ 发送、目标宿主/生产环境操作；这些保留为后续验证边界。
- `pet` 不在当前 `BUILTINS` 中；M3-E 因当前基线无 pet 标为不适用。若未来重新引入，另立 ADR；`_template` 是模板，不是运行中的内置模块，故不列为当前功能。
