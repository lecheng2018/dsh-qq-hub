# 现有功能不可丢失矩阵（M0-3）

> 任务书：M0「建立『现有功能不可丢失』矩阵」。  
> 基线：`refactor/modular-core` @ `8115132268be5b65de60b677dcde69ddfada54e9`（package 1.3.64）。  
> 规则：本矩阵列出全部内置模块、命令、面板入口、配置项、数据目录、定时任务和主动发送来源；后续任何阶段不得让矩阵条目无声消失。`deprecated-candidate` 只是候选项，未经 owner 批准不得删除功能。  
> 生成方式：静态扫描（manifest dump / 路由表 / 发送点 / 定时器）+ 源码核对；测试列指现有回归测试文件。

## 0. 分类定义

- `core`：主聊天链路必需，拆掉即失去基本 QQ↔DSH 能力。
- `optional`：可单独启停的功能模块（`src/modules/*`），禁用后核心聊天不受影响。
- `gui-only`：依赖 DSH 面板/GUI 的入口，无桌面环境时不可用。
- `external-service`：依赖外部平台凭据或服务（B 站、抖音、小黑盒、RSS 源等）。
- `deprecated-candidate`：候选废弃项，**未批准前照常保留**。

## 1. 全局安全默认（必须保持的姿态）

| 项 | 默认 | 位置 | 测试 |
|---|---|---|---|
| 总开关 `enabled` | **false**（一句都不发） | `src/core/config.js` | e2e/pure |
| 试运行 `dryRun` | **true**（只记日志不实发） | `src/core/config.js` | e2e |
| 模块 `enabled` | 未配置时**默认开**（`enabled !== false`） | `src/core/modules.js:174` | modules.test |
| 群聊工具隔离 | social 预设无本地工具（cordis.patch.yml） | `cordis.patch.yml` | — |
| `config.json` 落盘 | 0600 | `src/core/config.js:716` | — |
| 洋葱管道 `FLAG_USE_PIPELINE` | **关**（默认直调 legacy hub） | `src/kernel/legacy-fallback.js` | kernel-* |
| 入口合流 `FLAG_INGRESS_AGGREGATOR` | **关**（暂停版 aggregator 不启用） | `src/kernel/mw-aggregator.js` | kernel-aggregator |
| 记忆接管 `NEW_MEMORY_PIPELINE` | **关**（且需管道先开） | `src/kernel/mw-memory.js` | — |
| 出口影子 `FLAG_EGRESS_SHADOW` | 关（live 模式） | `src/kernel/ctx-store.js` | kernel-egress-cutover |

## 2. 内置模块矩阵（23 个，注册顺序 = 装载顺序）

> 数据位置统一为 `<dataDir>/modules-data/<id>/`（`src/core/modules.js:211`，模块间隔离）。  
> `api` 字段缺省 = 1（`module-contract.js` 归一化）；旧模块未声明 `provides/requires/conflicts/defaultEnabled/requiresGUI`。

| # | id | 版本 | 分类 | QQ 副作用（发送/管理动作） | 数据要点 | 现有测试 | owner 工作流 |
|---|---|---|---|---|---|---|---|
| 1 | stickers | 1.0.0 | optional | 发图片段（表情包）；收集表情 | 表情库 md5 索引 | stickers.test.js、sticker-pick、sticker-owner、group-merge-sticker、faces* | Module owner: stickers |
| 2 | voice | 1.0.0 | optional | 发语音条（record）；失败改发文字 | TTS 模型/引擎配置 | voice-rvc.test.js | Module owner: voice |
| 3 | mood | 1.0.0 | optional | 无直接发送；影响表情/语音频率 | 心情状态 | mood 相关（hub-state-modules） | Module owner: mood |
| 4 | memory | 1.0.0 | core（记忆主库） | 无直接发送；注入上下文 | memories.json、小档案、speakers | memory*.test.js（15+ 文件） | Context |
| 5 | qq-tools | 1.0.0 | core（工具面） | **主动发消息/发文件**（qq_send_message、qq_send_file，仅主人私聊）+ qq_chat_history | 白名单外禁发 | features.test.js、file-segment | Turn/Outbox |
| 6 | group-admin | 1.0.0 | optional | **禁言/解禁/踢人/改头衔**（set_group_*） | 无持久数据 | guard-modules | Module owner: group-admin |
| 7 | imagegen | 1.0.0 | optional | 发图片（base64） | 生图配置/缓存 | imagegen*.test.js | Module owner: imagegen |
| 8 | diary | 1.0.0 | external-service | 发说说（send_qzone_msg，经 features/qzone） | 说说记录 | diary-image、qzone* | Module owner: diary |
| 9 | qzone-social | 1.0.0 | external-service | 点赞/评论（外部 QQ 空间动作） | Cookie/记录 | qzone* | Module owner: qzone-social |
| 10 | speakup | 1.0.0 | optional | **主动私聊主人**（长时间未理时） | 触发状态 | speakup.test.js | Module owner: speakup |
| 11 | purpose | 1.0.0 | optional | **主动找主人搭话**（有日上限） | 素材/观察/目标 | purpose*.test.js、panel-purpose* | Module owner: purpose |
| 12 | bili | 1.1.0 | external-service | 发截图/分享到私聊；**B 站评论/点赞/头像/签名** | Cookie、投喂偏好、巡查状态 | bili*.test.js | Module owner: bili |
| 13 | song | 1.0.0 | optional | 发语音条（翻唱） | 翻唱缓存、临时目录 | song.test.js | Module owner: song |
| 14 | profile | 1.2.0 | optional | 发头像图；**改 QQ 资料**（昵称/签名/头像，按权限） | 权限配置 | profile*.test.js | Module owner: profile |
| 15 | contacts | 1.0.0 | core（权限面） | **改私聊/群白名单**；好友申请通知主人并执行通过/拒绝 | 白名单 | contacts.test.js、known-chats | Module owner: contacts |
| 16 | douyin | 2.0.0 | external-service | 私信/分享到 QQ；**抖音点赞/评论（可 @主人）** | 受控浏览器、Cookie | douyin*.test.js | Module owner: douyin |
| 17 | heybox | 1.0.0 | external-service | 小黑盒点赞/评论/发帖（外部社区） | Cookie | heybox 相关（batch-expand-and-privacy 等） | Module owner: heybox |
| 18 | token-guardian | 1.0.0 | optional | 无直接发送；压缩会话历史 | 统计/持久化 | token-guardian-*.test.js（5 文件） | Module owner: token-guardian |
| 19 | complete-guard | 1.0.0 | optional | 无直接发送；截断检测提醒 | 无 | （含于 kernel 链路测试） | Module owner: complete-guard |
| 20 | memory-privacy | 1.0.0 | core（隔离治理） | 无直接发送；三层作用域隔离 | scope override | memory-privacy-scope、memory-scope、profile-scope | Context |
| 21 | scheduler | 1.0.0 | optional | **定时提醒发送**（/remind + AI 登记） | 任务持久化 | scheduler.test.js | Module owner: scheduler |
| 22 | multi-parser | 1.0.0 | optional | 发图/视频/文件卡片（链接解析） | 缓存/配额 | multi-parser*.test.js | Module owner: multi-parser |
| 23 | rss | 1.0.0 | optional | 无主动推送（她来查池子） | 订阅池 | rss.test.js、rss-panel | Module owner: rss |

**特殊说明**

- `security-lock`（TOTP 权限锁）已按主人要求移除（modules/index.js 注释；host.js:247）。TOTP 属「已移除能力」，任何文档不得再宣称提供（M1-D 核对项）。
- **桌宠（pet）不在本基线**：main 在 `4b9bba59` 整体移除桌宠服务（-10,036 行，purpose 载体契约简化为纯 QQ）。该删除发生在重构开工前的 main 演进中，不是本次重构行为；M3-E「桌宠可插拔化」按任务书精神转记为「已从核心剥离（移除），无可迁移对象」。若未来恢复，走新功能任务而非重构任务。
- `_template/`：空模板目录（index.js 0 字节），非功能。

## 3. 主人斜杠命令（commands.js，16 个）

| 命令 | 功能 | 备注 |
|---|---|---|
| /help | 命令帮助 | |
| /silent /active /quiet /chatty /normal | 群插话档位 | 5 档 |
| /status | 健康面板 | |
| /model | 查/切模型 | 面板 models-apply 联动 |
| /sing | 点歌翻唱 | 走 song 模块 |
| /mood | 查心情 | mood 模块 |
| /diary | 说说我 | diary 模块 |
| /remember | 记事 | memory 模块 |
| /reset | 重置当前聊天会话 | |
| /new | 新开会话 | |
| /on /off | 总开关 | |

测试：commands.test.js。管道侧 US-011 命令路由与 legacy 闸门同口径（pipeline.js:130-159 有对照清单）。

模块扩展命令：模块经 `commands()` 注册（如 scheduler /remind），优先于内置表。

## 4. 面板入口（/qq-hub/api，59 条核心路由 + 模块 handle 前缀路由）

| 域 | 路由 | 副作用级别 |
|---|---|---|
| config（routes-config.js，6） | /state /workspaces/list /workspaces/delete /save /sessions/reset /panel/chats | **高**：保存配置、删工作区、重置会话 |
| gateway（routes-gateway.js，17） | /snowluma/start /stop /attach /login-check /agreements /consent /reset-password /password /set-password /processes、/commands /update/check /changelog /setup/done、/onebot/reconnect /onebot/test /test-send | **高**：改连接、重启网关、真实发送自测 |
| misc（routes-misc.js，15） | /logs /local/* /bridge/token /bridge/token/reset /bridge/examples /open、/models /models/apply /model/ping、/avatar /avatar/upload /avatar/reset /avatar/sync-qq | **高**：token 重置、模型应用、头像变更 |
| modules（routes-modules.js，10） | /modules /modules/reload /create /fork /prompt /open /simulate /tools /tool /panel | **高**：模块热重载/创建 |
| persona（routes-persona.js，6） | /personas /persona/get /save /delete /use /polish | **高**：人格改写 |
| purpose（routes-purpose.js，5） | /panel/purpose/status /preview /run /config | 中：主动搭话触发 |

**安全现状（M1-A 输入）**：以上路由无任何鉴权/CSRF/Host 校验/回环限制（仅 /open/* 走 bridge Bearer token，`src/core/bridge.js:160`）。防护是否由 DSH webServer 外层提供，需在 fnOS/DSH 实测确认；插件内补齐方案见 M1-A。

## 5. 定时任务与后台循环

| 位置 | 周期 | 作用 | 测试 |
|---|---|---|---|
| modules.js:428 模块 watcher | 3s | 用户模块目录热重载 | modules.test |
| modules.js:241 api.every/定时任务 | 各模块自定 | 模块后台任务框架 | modules/生命周期 |
| token-guardian:287/290 | tick + 30s | token 统计与压缩 | token-guardian-* |
| onebot/client.js:142 | 30s | 半开连接探测（90s 无包强制重连） | gateway-resilience |
| activity-state.js:49 | 内部节拍 | 活跃状态衰减 | — |
| song/studio.js:612 | 队列内 | 翻唱队列 | song |
| purpose 面板轮询 | 15s | 面板 UI（客户端） | — |
| scheduler 模块 | 到期触发 | 提醒任务 | scheduler.test |
| backfill gapTracker | 事件驱动 + 60s 落盘 | 断线补收 | backfill.test |
| bili/douyin/heybox duty | 各自配置周期 | 外部平台巡查 | 各域测试 |

## 6. 主动发送来源清单（物理发送点对账）

**统一收口**（经 hub.sendText/sendSegments → send_group_msg/send_private_msg）：

- 回复链：reply.js 分条投递（气泡延迟/分条）
- 命令回复（hub.js:1371/1376，force）
- 群配额器兜底（group-quota，限流等待后重试）
- 模块主动：speakup、purpose、scheduler、rss（查询结果由模型转述）、bili 巡查分享（duty.js:261/282）、douyin 分享（duty.js:222）、multi-parser 卡片、imagegen、profile、contacts 好友申请通知
- 面板动作：/test-send（routes-gateway.js:84）、/modules/simulate（routes-modules.js:61）
- backfill 迟到命令警告（gateway.js:80）
- 危险命令确认 deliver（host.js:315、hub.js:113/119 审批/提问 deliver）
- 慢工具提示（hub.js:489）

**旁路（不经 sendSegments/sendText）**：

- `hub.js:706` send_poke（戳回去）
- `features/qzone.js:74` send_qzone_msg（QQ 空间说说，外部服务动作）
- `modules/group-admin` set_group_ban / set_group_kick / set_group_special_title（群管理动作）
- `hub.js:773` upload_group_file / upload_private_file（发文件）
- onebot HTTP 层：SnowLuma 进程管理（网关自身操作，非 QQ 消息）

> M4-4 收口时按本清单逐一对账；当前 none 未经登记的新增发送点。

## 7. 行为基线（重构不得改变的用户可见行为）

| 行为 | 基线描述 | 现有测试 |
|---|---|---|
| 私聊 | 主人私聊全工具（full），陌生人按白名单/access 判定 | e2e、features |
| 群聊 | 白名单 + 插话档位 + 合流（merge 2.5s/8s，群 5s/15s）+ @判定 | group-*、mentions、kernel-aggregator |
| 媒体 | 图片转块（不支持看图时文字转述）、语音条、文件（30MB base64 上限、目录白名单、默认关） | vision*、voice-rvc、file-segment、hub-image-helper |
| 引用/转发 | 引用上下文注入、合并转发展开（≤40 条） | e2e、hub-image-helper |
| 审批 | tools/pre-execute 高危审批两阶段流 | approvals、danger-* |
| 交互提问 | ask_user_question 状态机、迟到回复不误投 | questions |
| 人格 | 全局 + 按聊天专用卡；{{qq_hub_persona}} 变量 | persona-*（7 文件） |
| 记忆 | 三层作用域 fail-closed、私聊隔离、提炼、小档案 | memory-*（15+） |
| backfill | 断档>2min 触发、settle 10s、命令/审批/动态码拒绝执行、去重 | backfill.test |
| scheduler | 一次性/每日/工作日/每周/Cron | scheduler.test |
| 桌宠 | **已移除**（main 4b9bba59），非本重构删除 | — |
| dryRun | 全发送面拦截（模拟 capture） | pure、e2e |

## 8. 数据目录归属

| 位置 | 内容 |
|---|---|
| `<dataDir>/config.json` | 全部配置（0600） |
| `<dataDir>/modules-data/<id>/` | 各模块数据（隔离） |
| `<dataDir>/modules/` | 用户自写模块 |
| `<workspaceDir>/` | DSH 工作区（会话/文件） |
| `<dataDir>/upstream-seen.json` | backfill 断档游标 |
| `<dataDir>/sessions.json`（chat 层） | 每聊天最近交互时间 |

## 9. Owner 指派与缺口

- 本次执行为单人体（Controller/Integration/QA/各 Module owner 角色一人兼任，见 board.md）。
- **无人认领条目**：无（23 模块 + 6 域面板 + 16 命令均已归入上表工作流）。
- `deprecated-candidate`：暂无（security-lock 已移除属历史决定；无新候选）。
