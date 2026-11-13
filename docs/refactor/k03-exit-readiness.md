# K-03 旧内核退出准备与执行记录

> K-03A～C 已完成装配收口；K-03D 已在 owner 明确要求后实施源码删除。真机验收、发布和现网升级仍受门禁约束。

## 1. 当前结论与不可跳过条件

生产入口只有一条事件处理链、一个会话注册表和一个物理发送出口；旧实现已退出源码。删除后的候选包仍必须完成以下真实环境验收，不能用 CI 代替：

- M5-1～M5-6 的真实环境证据回填完成；OneBot unknown 项不能再挂账。
- 真实 DSH + fake OneBot、真实 OneBot dryRun、小流量实发和回滚演练通过。
- 至少 72 小时观察完成，无未解释的双发、丢消息、旧实例创建、旧监听或旧文件写入。
- 现网 Markdown 迁移与回滚备份另行验收；不能把“源码里有迁移器”当成现网数据已迁移。
- owner 已于 2026-11-13 批准删除旧实现和旧 SQLite；该项不自动覆盖真机发布。

本次没有执行生产记忆迁移、测试包发布或运行中 DSH 切换。

## 2. 代码阻塞清单

| 阻塞 | 当前证据 | 退出前置条件 |
|---|---|---|
| 无条件创建 legacy hub | K-03C 已移除生产 `createHub`；当前 facade 位于 `src/host/current-hub.js` | 主链与共享服务不再创建旧实例；旧文件正式删除仍由 K-03D 执行 |
| 富媒体旧委托 | K-03A 已删除 `legacyDeliver`；当前实现位于 `src/chat/reply-delivery.js`、`src/chat/outbound.js` | 回复编排、TTS、表情、图片、引用、戳一戳归当前服务，物理发送只经 Shared Outbox；其余职责仍按 §3 对账 |
| 会话双路与回退 | K-03B 已移除旧查询/重置/事件/模型同步回退；QQ 会话归当前 SessionRegistry，系统后台回合归 `src/chat/system-turns.js` | 同步/重置/事件只执行一次；旧 `sessions.json` 仅作一次性只读迁移输入，不在启动时自动合并 |
| 模块持有整只 hub | K-03C 已换成 `current-hub.js` 与冻结发送桥 | 模块只拿当前服务的窄 facade；无 hub 内部状态或旧方法旁路 |
| 旧事件入口仍在 | K-03C 的 `dispatchEvent` 只调用当前核心 | 新核心初始化失败时停止相关 QQ 业务并告警，不回退旧入口 |
| 管道与灰度位仍在 | K-03C 已删除生产 pipeline 装配与 flag 读取；旧文件暂留待 K-03D 清理 | `kernel/mw-*` 中当前仍在用的服务必须单独保留，不能按目录误删 |
| 旧 SQLite 仍在发布包 | `src/features/memory-sqlite.js`；生产运行无 import，迁移器直接使用 `node:sqlite` | 静态迁移夹具保留，删除旧实现及不应继续运行的旧测试；包内不得出现旧事实后端 |
| 旧 facade/兼容状态仍在 | `src/chat/hub.js` 暴露 deliver、session、发送、统计、媒体与工具方法 | 每个消费者有当前归属后才能删除 facade，不以 import 数为零代替行为验收 |

## 3. 分批执行顺序（每批独立 PR、独立回滚）

### K-03A：富媒体与发送职责收口

1. 以现有 `reply-delivery` 和 Shared Outbox 为唯一实现，收编 `hub.deliver` 依赖的媒体准备与发送函数。
2. 对文本、图片、语音、表情、文件、引用/@、戳一戳、群聊合并建立输入/输出对照；检查顺序、幂等、取消与 unknown。
3. 面板、命令、模块主动发送、QQ 空间动作和文件上传逐点对账，禁止旁路新物理出口。
4. 本批已删除 `legacyDeliver` 委托：新核心直接使用当前 `reply-delivery` 和 Shared Outbox，不再调用 `hub.deliver`；其余退出步骤仍按门禁执行。

验收：真实 host + fake OneBot 新旧对照；dryRun 零实发；`deliveries.json` 每次物理发送仅一笔。

### K-03B：会话与主动任务唯一化

1. `chatOfSession/resetChat/resetSessions/onSessionEvent/syncAllModels` 只读/写当前 SessionRegistry。
2. 审批、提问、token-guardian、purpose、压缩、面板和主动任务全部改接当前注册表与回合服务。
3. 旧 `sessions.json` 只作一次性只读迁移输入；冲突列出并人工确认，不静默合并、不删除宿主历史会话。
4. 移除双同步、合并 sessions 和 legacy 回退，不把旧表继续当灾备运行。

验收：模型同步/重置/归档各一次；面板列表一致；旧实例不收到 session 事件。

本批已完成：host 不再保存旧会话回退或执行双同步；QQ 主动回合复用当前 SessionRegistry，系统后台回合由当前核心的独立服务执行。旧 `sessions.json` 不自动迁移、不写回；冲突仍须按迁移流程人工确认。

### K-03C：hub facade 收窄与 legacy 装配退出

1. 将 `faceName/wasSent/noteTurnSenders/bumpStats/poke/recentMedia` 等仍被 host 或模块使用的方法逐项归入当前服务。
2. `core.hub` 换成只转发当前服务的冻结窄口；每个模块只获得实际所需能力。
3. 删除 `dispatchEvent` 的 legacy/pipeline 分支、`assemblePipeline`、`createLegacyHubFallback` 与旧灰度位。
4. 新核心初始化失败时明确停止 QQ 业务并告警，禁止自动启用旧 hub、旧库或第二份状态。

验收：依赖红线测试证明模块不能反向 import host/hub；新核心失败时无旧实例创建和发送。

本批代码已完成：权限参与者、媒体、统计和文件发送归当前服务；生产不再创建旧 hub 或读取旧灰度开关。

### K-03D：删除旧实现与转换测试（源码已实施）

1. `src/chat/hub.js`、pipeline、fallback、旧 SQLite 及 12 个旧管道装配件已删除。
2. 当前限流、tracing、会话、工作区、回复、Outbox 与独立媒体服务保留，并有文件存在性和生产依赖图红线。
3. 有效旧用户行为测试已改挂当前核心；仅测旧实现的专项测试同步退出。迁移器及静态旧库夹具继续运行。
4. 旧 flag 文档分支已删除；README、flags、feature-matrix、部署与回滚说明改为当前核心。
5. 转换时发现旧鱼群安全闸尚未接入当前核心，已补齐密度判定、pair 冷却、主人豁免和鱼叫人规则后才删除旧 hub。

验收以最新全量测试、打包清单和隔离解包 host smoke 为准；真实 fnOS 验收不属于本源码 PR。

### K-03E：真实环境与发布门禁

按顺序执行并回填 M5 runbook：

1. 固定 commit 的 tgz、sha256、内容清单和隔离 profile 安装。
2. 真实 DSH + fake OneBot 的私聊、群聊、补收、模块启停和失败不fallback。
3. 真实 OneBot dryRun 全矩阵，确认零实发及唯一写者。
4. owner 逐级批准后小流量实发，私聊→测试群，核对媒体、文件、引用、权限、热重载。
5. 至少 72 小时观察；记录旧实现零创建、零监听、零写入及全部发送台账。
6. 回滚演练后，owner 单独批准旧实现离开发布包。

## 4. 必须保留的证据

- 全量测试、扩展测试、lint、打包检查和真实 host 双路径对照。
- 功能矩阵每条都有当前归属，无“先删后补”的空接口。
- 连续启停、模型挂起、状态损坏、外部编辑、进程中止、迟到结果和投递 unknown 的恢复记录。
- 安装包文件清单、生产 import 清单、旧实例创建计数、监听器/计时器基线、旧文件写入检查。
- 真实 OneBot dryRun 与小流量证据；不能用 fake 结果替代。

## 5. 回滚与数据边界

- `v1.4.0-test.20261112.1` 是删除前回滚工件，保留 tgz、sha256 和发布记录；回滚用固定旧包，不保留 `FLAG_MODULAR_CORE=false` 等隐藏旧入口。
- 删除旧实现前冻结完整数据目录和配置备份，记录插件版本、文件校验和恢复步骤。
- 回滚代码不自动回滚数据。Markdown 已激活后不得直接启用旧 SQLite/JSON 写者；恢复旧包前停写并核对完整备份与迁移标记。
- 现网记忆迁移、旧会话迁移和不可逆配置升级不得与旧实现删除绑在同一 PR。
- 任一验收失败：停止当前批次，保留旧发布工件，修好重验，不用删数据或清状态掩盖差异。

## 6. owner 最终放行单

- [ ] §2 代码阻塞全部关闭，K-03A～D 均已合并且验证。
- [ ] M5-1～M5-6 证据完整，无 OneBot unknown 挂账。
- [ ] 现网记忆和会话迁移已验收，备份可读、恢复路径已演练。
- [ ] dryRun、实发、72 小时观察和回滚演练通过。
- [x] owner 明确批准删除旧实现、旧开关和发布内容。
- [ ] 删除后包已重新安装验证，失败时不启用旧实现。

全部勾选后才允许发布与现网升级；owner 的源码删除批准不再被解释为真机发布批准。
