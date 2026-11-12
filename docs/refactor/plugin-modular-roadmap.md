# 插件模块化演进路线

本路线承接 [ADR-0002：共享行为服务](adr/0002-shared-behavior-services.md)，不另建第二套聊天核心，不扩大默认开关，不替代 owner 的上线验收。目标是保留稳定 QQ 聊天主链，让外围能力可独立关闭、替换和恢复，而不是只把大文件切小。

## 1. 当前落点

2026-11-12 核对：本批基于远端 main `a7b7ebf`。workspace、memory-scope、记忆字段与标题修复已在主线；P0 档案安全门（`9732714`、`7bd7bd1`）、#47 热重载与 #48 蒸馏 JSON 纠正也已进入当前主线，不再以 #42 未合并为前提。主线已包含 #43 前端拆分，本批不修改前端。

当前有效解耦与剩余职责：

- `src/features/memory.js` 只负责组合并保持原公开 API；`memory-archive.js` 拥有档案访问、检索与派生数据持久化，不 import LLM/extractor；`memory-learning.js` 承担提炼、画像、历史蒸馏和定时整理；同级 `modules/reflection`、`modules/style` 已分别独立承担相处经验与说话方式学习和注入。distill 继续后续自治。
- `src/modules/memory/index.js` 仍拥有蒸馏目标、历史学习和派生卡接线，并向外暴露大 store。
- 本批将 chatlog 唯一实现迁到 `src/chat/chat-log.js`，由 host 管理保留任务；模块接 `api.core.chatLog`，hub 的三个日志接口只作兼容转发。少数业务工厂保留旧形状注入兼容，尚不宣称全仓零 hub 日志引用。
- `src/core/modules.js` 已有模块生命周期、`api.use/on/context/every/tool/route/dataDir`；`src/modules/index.js` 已装载同级可选模块。不要再造嵌套 loader。

## 2. 什么保留，什么移出

**最小主链**保留：OneBot 接入与标准化、权限和作用域安全、ChatKey/会话映射、回合取消与资源回收、上下文装配、唯一发送出口与投递台账。host 是组合入口，可以装配模块；业务模块不得反向 import host/hub 的实现。

**共享服务**只有一份实现：流水、入站媒体理解、会话、回复解析、outbox。新旧调用路径共用，hub 暂时只做兼容 facade，逐个接口退场。

**可选业务模块**：事实提炼、画像/反思/语感学习、蒸馏、黑话、日记、RSS、平台解析、绘图、翻唱等。关闭任何一个不应关闭聊天、不应删除别人的数据、不应留在途任务回写。

**记忆档案模块**保留最小契约：作用域 CRUD、召回、健康诊断、正文版本与变更事件。Markdown 是事实源；state 是进度与运行状态；画像等生成结果是带来源版本的派生材料。检索索引是可重建缓存。档案可脱离模型服务运行；关闭自动学习后仍能手动记事与召回。关闭整个记忆模块则聊天明确降级为无记忆，不偷偷启用旧库。

隐私隔离是所有读写入口的必守规则，不属于“关掉 memory-privacy 就绕过”的可选功能。privacy 模块只能管理策略与界面，不能成为核心安全函数的反向依赖。

## 3. “插件的插件”的实现方式

采用同级模块的能力协作，而非 memory 再启动自己的子插件系统：

```text
host（唯一装配与生命周期）
  ├─ 共享服务：chat-log / inbound / session / reply / outbox
  └─ 同级模块：memory-archive / extractor / profile / reflection / distill / slang …
                    ↑ api.use + 版本化契约 + 变更事件 ↑
```

- 提供者声明能力，消费者声明必需或可选依赖，沿用已有 module-contract/loader 的语义；新增语义先补契约测试。
- 调用时再 `api.use` 取当前实例，不缓存已停用模块的引用，不跨模块 import 内部源码，不透传整个 store。
- 小接口返回有版本的快照或明确结果。数据所有者独占写权限；事件只通知变更，不绕过作用域检查。
- 可选提供者关闭时，消费者显示不可用并跳过；必需依赖缺失时停止该消费者，不拖垮聊天主链。
- 每模块拥有自己的配置、目标、消费进度和 dispose；同一任务不能被 memory 与扩展同时调度。
- 先在同仓内把边界做实；只有确有独立发布需求的能力才拆包，不为“插件化”先增加包管理和版本矩阵。

## 4. 串行 PR 队列

以下是本路线的局部队列；host/hub 接线仍遵守 [看板](board.md) 的唯一集成窗口。每个 PR 只推进一个边界，数据迁移与主链默认切换不混入普通代码抽取。

### P0：档案安全门（已在 main）

- 范围：memory-files/markdown、memory 保存与整理、显式迁移 CLI、记忆面板重载与专属测试；未改主链默认开关和版本。
- 交付：拒绝旧库运行时回退；迁移先验证再激活，目标冲突拒覆盖；坏档案/坏状态可诊断且停止自动写；外部编辑检查；正文成功后写进度；失败不冒充整理成功；消费不删除共享流水。
- 验收：损坏主备、坏 scope、外改、超限、失败重跑、迟到模型结果、真实 HTTP 重载与同源防护纳入回归。面板真实浏览器与生产迁移另列，不以源码测试冒充上线验收。
- 回滚：未迁移实例可回退代码；迁移后不可直接启用旧库，否则可能复活已删内容。恢复需停写并核对完整备份，不能用删目录清状态来回滚。

### P1：共享流水服务（已在 main，PR #52）

- 范围：`src/chat/chat-log.js` 唯一读写实现，host 装配唯一实例；hub 保留 `logChat/chatLogDays/chatLogOf` 三个 facade。memory/distill/slang/diary/qzone/purpose/bili/token-guardian 接独立服务，不更换原 JSONL 文件格式和模型提示词，保留主线蒸馏 JSON 纠正逻辑。
- 所有权：模块只拿冻结的 append/listDays/readDay/readDaySnapshot 窄口；没有 delete、prune 或定时器控制权。memory.tick 不再清日志。host 启动时及每小时清理过期流水，默认保留 30 天，最少 14 天；关闭记忆不停止宿主保留任务。流水写盘错误不得打断 B 站回复。
- 进度：memory 按日、distill 按目标窗口、slang 按日/群分别持久化 `{count,fingerprint}`。指纹覆盖原始非空 JSONL 已消费前缀，追加可继续，缩短/替换拒绝；提交前复核来源。坏 JSONL 报真实文件行号，不能当成空日志推进。来源不一致时先人工核对原文和消费者状态，不删原文或盲清游标。
- 兼容：旧状态只有 processed 行数、没有来源指纹时，保留窗口从头补处理一次，不把无法验证的旧行数当成成功证明。派生消费者也从保留来源补建自己的游标；可能产生一次补算费用，不迁移或删除原始流水。
- 完整消费：记忆每 80 行处理全部批次，已移除 640 行上限，但成功进度仍按日提交；distill 每窗口最多 14 条目标原话，保留原有至少 5 句/40 字证据阈值，证据不足显式跳过并推进，不冒称所有原话都请求模型；slang 对未消费群流水做词频统计后按原候选策略学习。
- 失败与生命周期：distill 成功批次与游标同次持久化，失败保留计数并退避；L2 未成功时先重试，不挤掉待聚合批；L3 按目标成功后标记，同日可重试。slang 分群隔离失败并补学旧日期。两者 dispose 中止在途请求并拒绝迟到回写，流水定时器 stop/start 不泄漏。
- 验收证据：`test/chat-log.test.js`、`chat-log-consumers.test.js`、`memory-chatlog-progress.test.js`、`chat-log-architecture.test.js` 和真实 host e2e；全量结果见本 PR 与看板。没有执行 fnOS 生产迁移或更改运行中 DSH。
- 回滚：回退服务消费接线时保留原日志与新游标，不删除数据或改变保留配置掩盖差异。旧版不识别指纹，降级前须停学习并核对进度；不承诺降级后仍有新游标保护。

### P1a：回复与富媒体业务编排迁出（已在 main，PR #54）

- `src/chat/reply-delivery.js` 负责回复 hook、拆条、群聊合并、引用、语音/表情/图片编排、同 chat 串行与 Outbox 票释放；`src/chat/hub.js` 只保留兼容委托及宿主状态回调。
- 物理发送仍由既有 Shared Outbox 唯一执行；本切片不重写发送、不改模块 SDK，也不宣称 `legacyDeliver` 已从 host 退出。下一步由 host 直接装配该服务，再逐段迁移媒体准备函数。
- 验收覆盖独立服务行为、真实 hub + fake DSH/OneBot 的回复顺序、群聊合并、unknown、防身份泄露、dryRun 和失败释放；不修改前端、记忆数据或运行中的 DSH。

### P1b：审批与提问共享（已在 main，PR #57）

- host 创建唯一 questions/approvals 注册表，同时注入 hub 的回复拦截与 effects 的 DSH 服务桥；不再由 effects 调用 hub 的审批、提问或会话查询方法。
- 会话反查由组合根按当前启用的核心选择：新核心启用但未就绪时明确无映射，不回退旧表；flag-off 仍使用 legacy 当前映射。卡片物理发送仍走 hub 的统一 Outbox 出口。
- 卸载取消全部待答提问和审批；模块 SDK 不变。尚未迁移面板、压缩和主动任务的会话依赖，不能据此删除旧内核。

### P2：共享入站媒体与上下文边界

- P2a 近期媒体缓存：host 持有唯一 recentMedia 实例并注入 hub，新核心通过 `rememberSegments` 直接登记；模块读取仍走 hub 兼容口。30 分钟有效期、每聊天 6 张、重启恢复与卸载清理不变，ASR、vision、引用和上下文不在该子切片。
- P2b 入站语音：host 持有唯一 inbound-audio，新旧核心共用本地 ASR → 网关转写 → DSH SenseVoice 降级链；模块化水合最多处理 3 条且不修改冻结输入。voice 模块的 DSH 识别保留 hub 窄转发；vision、引用和上下文不在该子切片。
- P2c 引用读取：host 持有唯一 quoted-messages，统一 get_msg、历史补图与 200 条缓存，缓存键包含会话和消息 ID；新旧核心保留各自提示文案与附件装配。补图不丢原正文，读取失败返回可展示的失败结果；vision 与上下文不在该子切片。
- P2d 入站图片：host 持有唯一 inbound-images，旧 hub 共用 segmentBytes 下载与严格类型校验，modular 共用 URL 转 base64 和 DSH 附件登记；保留两条现有下载及接受语义，不顺带改变网络策略。附件不可用时去掉裸图片块并明确降级；辅助视觉模型与上下文装配不在该子切片。
- P2e 辅助视觉：host 持有唯一 inbound-vision，legacy 共用转述文案与调用，modular 在附件登记前补齐主模型明确不能看图时的辅助转述；未配置时诚实说明，视觉 auto/on 不走辅助路径。上下文装配与人设/preset/workspace 统一不在该子切片。
- P2f 聊天工作区：workspaceDirForChat 统一默认共用、显式 workspacePerChat 隔离与 system 主目录规则；DSH 适配器传入 chatKey，modular 建会话不再忽略按聊天隔离配置。人设、preset 与模块上下文已按现有真实 host 回归完成对照。
- 范围：按 ADR-0002 的 Inbound/Context 路线，抽取既有 ASR、vision、引用和 recentMedia 行为，不在 modular-core 再实现一份。voice/sticker 的业务策略仍可选，物理发送仍走唯一 outbox。
- 验收：同一事件经新旧调用路径，正文/附件块/转写/引用/人设/preset/workspace 一致；能力关闭时诚实降级，取消或超时不污染会话；副作用不双发。
- 回滚：只回退调用接线，唯一实现与旧 facade 保留；不同时修改会话默认路径。

### P3：拆出记忆学习管线

- P3a 提炼批次幂等：每个 80 行块以聊天、块位置和输入指纹确定批次 ID；`done` 跳过、`failed` 重试、`running/pending` 待核对，全部成功后才推进日进度。状态保存在既有 state.json，部分事实提交异常不得当普通模型失败盲重试。extractor 独立、完整生命周期与其他派生学习不在该子切片。
- P3b extractor 独立：模型请求、JSON 解析和提交计数迁到 memory-extractor；新增、补充、过时替代仍通过 memory 的 commit 边界进入唯一档案。模块不接触档案文件，部分提交异常保留 factsCommitted。extractLines/consolidate 调度、archive 契约收窄和其他模型入口生命周期不在该子切片。
- P3c extractLines 与批次状态机独立：extractor 负责分块、状态转换、反思调用；memory 仅提供 load/save 状态适配和 reflect，成功/失败/待核对语义不变。consolidate 的日程、遗忘与人物档案调度仍在 memory，archive 契约和其他模型入口生命周期不在该子切片。
- P3d consolidate 独立：extractor 负责整理日程、来源游标、部分失败、遗忘和人物档案调度；memory 提供健康检查、load/save、learnSelfStyle/buildProfile 等适配器，公开入口窄转发。archive 契约和其他模型入口生命周期不在该子切片。
- P3e 模型生命周期统一：importCandidates、learnDistillFromHistory、buildProfile、reflect、learnSelfStyle 无外部信号时创建代际任务；askModel 竞争式超时退出且保留调用方原始 signal，忽略 abort 的流不阻塞 dispose。archive 契约和派生模块自治不在该子切片。
- P3f archive 契约收窄：memory-archive 独立拥有 CRUD、召回、作用域索引和派生数据持久化，不 import LLM/extractor；memory-learning 组合模型入口、提炼与整理；memory.js 保留原 createMemoryStore 和纯函数出口。模块热重载声明同步覆盖新文件。
- 范围：extractFacts/extractLines/consolidate 调度、模型学习和 archive 已分别归属；存储与召回不 import LLM，scope 纯函数继续共用。派生模块自治不在 P3。
- 必须同时解决：批次 checkpoint、幂等提交与事实/进度一致性均已落地，archive 可无学习层运行。
- 生命周期：已识别模型入口均受代际任务与竞争式超时约束；reload/dispose 可中止在途任务，迟到结果不能写。派生模块自治与 fnOS 连续启停验收仍需后续完成。
- 验收：archive 在无 LLM/extractor 依赖时完成真实 CRUD/作用域召回；全量记忆回归覆盖批次中断/恢复、输入替换、重复请求和磁盘失败。
- 回滚：关闭新消费者并保留 archive/游标；必须保证旧调度不同时开启。涉及状态格式升级时单独提供可逆步骤。

### P4：派生画像、反思、蒸馏彻底自治

- P4a 画像来源与失效：自动画像记录 origin、scope、sourceFactIds、sourceRev；事实新增/修改/删除/替代和 reload 将非 manual 画像标为 stale 并停止注入，重建清除 stale。模型在途期间 rev 变化拒绝旧输入画像写入。手动画像明确标为 manual；无 origin 的旧画像在变更时按派生数据处理，人工重新保存后转为 manual。独立模块停启不在该子切片。
- P4b reflection 独立模块：同级 `modules/reflection` 依赖 memory-store，负责模型回顾、独立 dispose 和唯一相处经验 context provider；memory 不再重复注入。自动经验保存 transcript SHA-256 与来源 rev，reload 后 stale 且停止注入，手工经验保留。关闭模块只停自动回顾与经验上下文，事实 CRUD/召回和手工经验管理不变。
- P4c style 独立模块：reflection 通过 `style/observed` 事件交出同一次模型调用的风格观察，style 决定保存与注入，不重复请求模型；自我风格学习由 memory 运行时委托当前 style 实例。来源元数据与字符串数组分开保存，reload 失效，手工风格保留，独立 dispose 零回写。
- 范围：profile/reflection/style 按各自输入、产物和调度拆 PR，不一次全拆。distill/slang 已是模块，下一步把残留在 memory 的目标、历史路由、派生卡责任逐一移交；兼容旧 URL，但只留一套数据所有者。
- 派生数据记录依赖的 scope、事实 ID 与版本；正文修改、删除、重载后使画像/语感失效或重建，防止“正文已删、画像仍泄漏”。按作用域独立生成与读取。人物画像、reflection 和 style 已落地，distill 的同等机制待后续切片完成。
- 验收：停用派生模块后基础召回不变；停用 memory 后有明确降级；删除一条私聊事实不会在群画像中残留；重新启用不重复注册任务、路由或 context provider。
- 回滚：停用相应消费者，保留有来源的产物和旧数据备份，不把派生结果重新灌为事实。

### P5：兼容层退出与发布

- 沿 ADR-0002 继续验证 Session/Reply、交互路由与群策略；每项证明新旧用户可见行为等价后，才减少 hub facade。删除 hub 的前提是职责全部有唯一归属，而非 import 数量变成零。
- 范围：兼容入口清理、依赖红线测试、功能矩阵与运维说明。默认切换、legacy 删除和发版必须另获 owner 放行。
- 验收：真实 host + fake DSH/OneBot 双路径对照、fnOS 真机检查、私聊→测试群→72 小时观察与回滚演练；不能用纯模块通过数量替代。
- 回滚：切换前保留逃生路径和数据兼容方案；不可逆数据迁移不得与默认切换绑在一个 PR。

## 5. 本轮尚未解决的边界

P0/P1 不等于原记忆重构任务书全量完成。以下仍是后续门禁，不应标成已交付：

- 记忆日进度与提炼批次 checkpoint 不是跨作用域大事务；部分正文已提交但状态未确认时进入待核对，成功块重试跳过，仍不能宣称任意故障下恰好执行一次。
- distill/slang 的旧 readJson 状态损坏回退策略尚未改造成档案级 fail-closed；不把记忆 state.json 已有的保护泛化为所有消费者都已安全。
- archive、提炼与派生模型入口已统一取消和回收；fnOS 上连续启停与真实宿主资源基线仍需后续验收。
- 人物画像、reflection 与 style 的来源失效、独立停启和重载后重建已落地；distill 的同等机制仍未完成。
- 档案保存是单文件原子写，不是跨作用域事务；来源提交前复核也不是对外部编辑的跨进程锁，保留期内手改流水须停消费者并人工恢复。
- 迁移器按停写、单进程运行设计；已有新旧库冲突须人工核对，不能自动选“条目更多”的一边。生产迁移未授权、未执行；本批未更改运行中的 DSH。
- 旧 hub、pipeline/kernel 未删除。K-02 后续先继续富媒体唯一 outbox、当前会话审批/提问和模块 hub facade 收窄；K-03 仍受 G5、owner、真机和观察期门禁约束。

执行顺序：P1 验证合入后，按唯一 Integration 窗口推进 P2/K-02，再分 PR 推进 P3、P4；以数据所有权、可独立关闭和失败隔离衡量模块化，不用一个大 PR 同时包揽存储、模型、界面、迁移和主链切换。
