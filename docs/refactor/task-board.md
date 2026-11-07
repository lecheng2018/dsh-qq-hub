# dsh-qq-hub M0～M6 任务看板

> 本看板依据 `dsh-qq-hub-refactor/` 下的 M0～M6 任务书建立。任务书共 40 个任务 ID：M0（5 个）、M1（5 个）、M2（6 个）、M3（7 个）、M4（7 个）、M5（6 个）、M6（4 个）。
>
> **当前协调人：** `yaozy2020`，仅负责协调、信息汇总和队列维护，不替代任何任务负责人、验收角色或生产 owner。下表只分配角色，不虚构具体实现人员。
>
> **当前工作边界：** 本次看板和日历写入源码导出目录 `work/dsh-qq-hub-current`。该目录无 `.git`，不在此创建提交、分支或 PR；不修改 `host/hub`，不接入生产，不执行真实 QQ/OneBot 操作。任务分支按任务书约定使用 `refactor/<task-id>-<short-name>`，实际分支、PR、commit 和证据由对应角色在有 Git 的集成仓库中补录。

## 1. 状态总览

| 范围 | 数量 | 当前状态 |
|---|---:|---|
| M0 | 5 | **已完成（5/5）**；**G0 已放行** |
| M1 | 5 | **下一阶段，尚未开始**；G0 前置门禁已满足 |
| M2 | 6 | **后续未开始**；等待 G1 |
| M3 | 7 | **后续未开始**；等待 G2；M3-E 对当前基线不适用 |
| M4 | 7 | **后续未开始**；等待 G3，且接线严格串行 |
| M5 | 6 | **后续未开始**；等待 G4 和 owner 逐级批准 |
| M6 | 4 | **后续未开始**；等待 G5 和生产 owner 的 go 决定 |

状态含义：

- **已完成 / 已放行：** 仅代表该任务或门禁的文档证据与约定验收范围完成，不自动代表真实环境、生产或后续阶段验证完成。
- **下一阶段，尚未开始：** 当前满足阶段入口，但尚未开始任务实现、测试或集成。
- **后续未开始：** 只登记依赖、范围和验收口径，不预先宣称实现、测试、灰度或生产验证完成。
- **不适用：** 当前基线没有该功能；不得当作待迁移现有功能。若基线变化须另立 ADR。
- **blocked/未验证：** 后续任务执行时显式记录阻塞原因；失败不能改写成通过。

## 2. 当前基线与 M0 验收证据

| 项目 | 已有证据 | 边界 |
|---|---|---|
| 当前执行基线 | `docs/refactor/baseline.md`：远端 `main` 为 `a5cfcaec0f4aae6775a211f0d331e4d527b545e4`；远端 `refactor/modular-core` 基于该 commit，已有地基提交 `8115132268be5b65de60b677dcde69ddfada54e9`。不可变回滚参照点为 `a5cfcaec0f4aae6775a211f0d331e4d527b545e4`。 | 不声称 tag 或分支保护已配置；本目录为无 `.git` 的导出。legacy 主链仍未被新核心接管。 |
| M0-1 基线 | 远端基线、地基提交、历史差异和回滚参照已记录。 | 不代表生产配置或真实环境已核验。 |
| M0-2 最终门禁 | 主测试 1289 tests / 1285 pass / 0 fail / 4 skipped；第二次相同内容 dot reporter 运行正常退出、退出码 0。扩展 46/46；`npm pack --dry-run` 成功，214 个文件。 | 这是记录的 M0 最终门禁，不是目标 DSH/OneBot/真实账号或生产验收；历史针对性测试统计不与最终总数相加。 |
| M0-3 功能矩阵 | `docs/refactor/feature-matrix.md` 已做当前源码静态盘点，涵盖内置模块、命令、面板、配置/数据和副作用边界，并注明测试与真实环境证据的差异。 | 静态盘点不替代逐功能的目标环境验收；当前源码基线无 pet。 |
| M0-4 契约 v1 | `docs/refactor/adr/0001-modular-contracts.md` 已 Accepted；当前协调人 `yaozy2020` 作出执行基线接受决定。契约兼容修复包括 `version` 可选、`sender` 可选字段校验和断言类型改善。 | 该接受决定不伪装成各工作流成员多人签字；后续字段变更另立 ADR。 |
| M0-5 任务与集成计划 | 本看板仍覆盖任务书全部 40 个 ID；`integration-calendar.md` 记录阶段依赖和唯一接线队列。 | 不虚构当前导出中不存在的任务分支、PR 或 commit 元数据。 |

### 当前 G0 结论

**G0 已放行。** M0 五项均完成，最终门禁、功能静态矩阵、Accepted 契约 v1 和 40 项队列记录已归档。G0 只放行进入 M1，不代表新核心主链、真实环境、生产灰度或 M1～M6 已完成。分支保护/tag 未在本记录中声称已配置；回滚参照使用不可变 commit `a5cfcaec0f4aae6775a211f0d331e4d527b545e4`。

## 3. 协作与证据规则

- 所有任务的负责人、实现者和验收者均以**角色**记录；不得把 `yaozy2020` 填为实现人或生产 owner。
- 每个任务实际开工前补充：基线 commit、任务分支、PR、允许/禁止文件、契约/ADR、测试、开关、数据迁移和回滚方式。
- 任务分支格式：`refactor/<task-id>-<short-name>`；一个 PR 只做一个任务。当前导出无 `.git`，所以本看板不填写虚构的分支名、PR 号或 commit。
- `src/host.js`、`src/host/**`、`src/chat/hub.js`、`src/kernel/legacy-fallback.js` 的共享接线由 Integration 独占；同一时刻只允许一个接线 PR。
- 公共契约冻结后，任何字段变化先走新 ADR；纯模块通过 fake 和专属测试并行，真实接线留到 M4。
- 每项验收须记录实际命令、退出码、通过/失败/跳过数量、包内容/sha256（如适用）、未验证项和回滚实测；真实凭据、QQ 正文、token 和生产隐私不得进入公开证据。

## 4. 全部任务看板

### M0：基线、功能清单与契约冻结

| ID | 任务 / 负责人角色 / 验收角色 | 状态 | 依赖 | 允许文件与边界 | 验收证据与回滚 |
|---|---|---|---|---|---|
| **M0-1** | 锁定执行基线；负责人：Controller + QA/Release；验收：Controller | **已完成** | 无 | `docs/refactor/` 基线记录；不改源码、不改生产 | 远端 `main`：`a5cfcaec0f4aae6775a211f0d331e4d527b545e4`；`refactor/modular-core` 基于该 commit，地基提交 `8115132268be5b65de60b677dcde69ddfada54e9`。回滚参照为不可变 `a5cfcaec0f4aae6775a211f0d331e4d527b545e4`；不声称 tag/分支保护已配置。 |
| **M0-2** | 全量测试与打包基线；负责人：QA/Release；验收：Controller + QA/Release | **已完成** | M0-1 | `.github/workflows/`、package scripts、测试基础设施；package/workflow 由 Release 统一改 | 主测试 1289 tests / 1285 pass / 0 fail / 4 skipped；第二次相同内容 dot reporter 正常退出（0）；扩展 46/46；`npm pack --dry-run` 成功，214 个文件。失败历史分类及修复闭环见 `baseline.md`。 |
| **M0-3** | “现有功能不可丢失”矩阵；负责人：QA + 各模块 owner；验收：QA | **已完成** | M0-1 | `docs/refactor/feature-matrix.md`、任务专属测试；各模块 owner 只写自己的功能段 | 已完成当前源码静态盘点，覆盖模块、命令、面板、配置/数据和副作用，并标明自动化测试与真实环境证据边界；测试最终数字见 M0-2。当前基线无 pet。 |
| **M0-4** | 冻结核心契约 ADR；负责人：Controller；验收：Controller | **已完成** | M0-3 初版 | `docs/refactor/adr/`、`src/kernel/types.d.ts` 或新的契约声明；消费者不得私改 | ADR-0001 Accepted（契约 v1）；`version` 可选、sender 可选字段校验及断言类型改善已收口。接受决定由协调人 `yaozy2020` 作出，不记录或虚构多人签字；后续字段变更另立 ADR。 |
| **M0-5** | 任务看板、集成日历、文件所有权；负责人：Controller；验收：Controller + Integration | **已完成** | M0-1 | `docs/refactor/task-board.md`、`docs/refactor/integration-calendar.md` 及后续任务记录；本次不改源码 | 本看板覆盖任务书全部 40 个 ID；依赖、角色、允许文件、验收、回滚与 host/hub 唯一串行窗口均有记录。本导出无 `.git`，不虚构任务分支或 PR。 |

### M1：安全止损、行为锁定与可插拔准备

以下任务均受 G0 前置条件约束；当前全部 **后续未开始**。

| ID | 任务 / 负责人角色 / 验收角色 | 状态 | 依赖 | 允许文件与边界 | 验收证据与回滚 |
|---|---|---|---|---|---|
| **M1-A** | 面板安全边界验证与修复；负责人：Security/Integration；验收：Security + QA | **后续未开始** | G0、M0-2 | 优先新增测试；确需 `src/host.js` 或 `src/host/**` 修复时进入 Integration 队列 | 回环、trusted proxy、Host、DNS rebinding、CSRF 和所有副作用路由的未授权/合法流程证据。回滚：恢复上一版本配置/代码，不放宽宿主权限。 |
| **M1-B** | backfill 行为锁定；负责人：Inbound + Integration；验收：Inbound + QA | **后续未开始** | G0、M0-3、M0-4 | `test/modular-backfill-legacy.test.js`；必要的 host/hub 修复串行处理；不恢复暂停版 aggregator | 迟到命令/审批/过旧消息不产生副作用，实时与历史竞争可解释，重复 history 不重复执行。回滚：恢复已验证 legacy 行为，保留测试，不启用 aggregator。 |
| **M1-C** | unknown 发送与媒体 fallback 锁定；负责人：Outbox + Integration；验收：Outbox + QA | **后续未开始** | G0、M0-4 | `test/modular-delivery-legacy.test.js`；必要 hub 修复排入 Integration | 文本、语音、文件、base64 的发送前失败/明确拒绝/发送后 unknown 分界；unknown 不自动重发或改发。回滚：关闭新策略并恢复已验证工件。 |
| **M1-D** | 文档与真实能力对齐；负责人：Release + Security；验收：Controller + Release | **后续未开始** | G0；任务书无额外依赖 | README、配置面板、能力说明；不顺手实现 TOTP | README、面板宣称与实际接线一致，未提供能力明确标注。回滚：恢复文档版本，不以宣传替代实现。 |
| **M1-E** | 灰度开关安全姿态；负责人：Controller + Integration；验收：Controller + QA/Release | **后续未开始** | G0、M1-A/B/C 结论；按推荐顺序最后复核 | 开关定义、读取时机和回滚记录；`FLAG_INGRESS_AGGREGATOR` 与未完整 takeover 的 memory 默认关 | flag-off 与基线一致，非法/空值 fail-closed，切换不双发，生产未扩大灰度。回滚：恢复已验证默认值并重启，不临时增加组合开关。 |

### M2：核心与 Module SDK 纯模块实现

以下任务在 G1 后以冻结契约和 fake 并行开发，均 **后续未开始**；不接主消息链、不改默认行为。

| ID | 任务 / 负责人角色 / 验收角色 | 状态 | 依赖 | 允许文件与边界 | 验收证据与回滚 |
|---|---|---|---|---|---|
| **M2-A** | ChatKey 与标准化入站模型；负责人：Inbound；验收：Inbound + QA | **后续未开始** | G1、M0-4 | `src/chat/chat-key.js`、`normalized-inbound.js`、`inbound-contracts.js` 及专属测试；不依赖 DSH/OneBot/host | 私聊/群聊、同 messageId 跨聊天、缺字段/非法类型、message_sent、poke、引用、@、媒体、backfill 全部契约测试。回滚：不接生产路径，移除/回退独立实现即可。 |
| **M2-B** | Session Registry；负责人：Session；验收：Session + QA | **后续未开始** | G1、M0-4 的 ChatKey/session 契约；不等待 M2-A | `src/chat/session-registry.js`、`session-store.js` 及专属测试；fake DSH；不改 hub | single-flight、跨 ChatKey 隔离、失败清理、重启恢复、旧映射只读迁移和 dispose 证据。回滚：保持旧映射和旧路径，撤回未接线的 registry/迁移器。 |
| **M2-C** | Turn Controller 与 Scheduler；负责人：Turn；验收：Turn + QA | **后续未开始** | G1、M0-4 的 inbound/session/turn 契约；用接口和 fake 开发 | `src/chat/turn-controller.js`、`turn-scheduler.js`、`turn-state.js` 及专属测试；不改旧 aggregator | 每聊天串行、跨聊天并行、合流、取消、steer、timer generation、异常唤醒、dispose 和 DSH 取消能力缺口均有测试。回滚：独立文件不接主链，不恢复旧吞并实现。 |
| **M2-D** | Outbox 与 Delivery Ledger；负责人：Outbox；验收：Outbox + QA | **后续未开始** | G1、M0-4 的 ChatKey/Delivery 契约；不等待 M2-A | `src/chat/outbox.js`、`delivery-ledger.js`、`delivery-policy.js` 及专属测试 | FIFO、授权复核、dryRun、取消、真实回执、unknown、重启恢复、重复 deliveryId、媒体和 dispose；sending 崩溃恢复为 unknown，不自动重发。回滚：不接物理出口，保留 ledger 变更的备份/版本。 |
| **M2-E** | Context Assembly；负责人：Context/Memory；验收：Context + QA | **后续未开始** | G1、M0-4 的 ChatKey/sessionId/ContextFragment 契约 | `src/chat/context-assembly.js`、公开 provider 类型及专属测试；不读模块私有数据库 | provider、优先级、scope、sessionId、缓存顺序、错误隔离及群/私聊记忆边界逐块对比 legacy。回滚：保持旧 context 路径，撤回未接线装配器。 |
| **M2-F** | Module SDK 与生命周期；负责人：Module SDK；验收：Module SDK + Controller + QA | **后续未开始** | G1、M0-3、M0-4 | `src/core/modules.js`、`src/runtime/module-loader.js`、`src/core/module-sdk*`、`src/runtime/types.d.ts` 及专属测试；不创建第二套模块系统 | manifest/API、能力冲突/替代实现、生命周期、健康、配置/存储、事件/命令/context/task/outbox、GUI 剪枝和 dispose 测试。回滚：不改默认装配；运行时 reload 未证明 dispose 前采用重启加载。 |

### M3：适配器、功能兼容和模块迁移

以下任务在 G2 后按各自 M2 依赖并行，默认主链保持关闭，均 **后续未开始**。

| ID | 任务 / 负责人角色 / 验收角色 | 状态 | 依赖 | 允许文件与边界 | 验收证据与回滚 |
|---|---|---|---|---|---|
| **M3-A** | Legacy Inbound Adapter；负责人：Inbound；验收：Inbound + QA | **后续未开始** | G2、M2-A | 入站适配器、专属 fixtures/tests；不改 host 主链 | 复用 `parseMessageEvent`，覆盖私聊/群聊、poke、message_sent、引用、@、图片/语音/文件/转发、非法/缺字段、backfill；raw legacy 只在适配层。回滚：适配器未被主链引用，直接回退。 |
| **M3-B** | DSH Session Adapter 与迁移器；负责人：Session；验收：Session + QA/Release | **后续未开始** | G2、M2-B | DSH 适配器、备份/只读迁移和版本化文件；不自动反向迁移新数据 | 重复迁移幂等、损坏记录 fail-closed、部分失败、并发、重启、回滚；补充迁移前后计数、schema、备份和抽样回读（脱敏）。回滚：使用迁移前备份恢复，不删除旧映射。 |
| **M3-C** | OneBot Outbox Adapter；负责人：Outbox；验收：Outbox + QA | **后续未开始** | G2、M2-D | dispatcher/清洗/分条/dryRun/身份保护适配器及测试；不切换 host 默认物理出口 | live/shadow 不双发，主回复/模块回复共用回执，无 ALS/晚到旁路，真实 messageId 和 unknown 可追踪。回滚：保持适配器未引用，恢复旧出口。 |
| **M3-D** | Legacy Context Adapter；负责人：Context；验收：Context + QA | **后续未开始** | G2、M2-E | systemPrompt、hooks.prompt、provider 映射及专属 fixture/test；记录惰性求值缺口 | 新旧上下文内容、顺序、缓存字段、scope 和 sessionId 等价或有接受结论；不得被 memory 覆盖其他 provider。回滚：不接新装配，保留旧 context。 |
| **M3-E** | Pet 可插拔化（仅在未来另行引入时）；负责人/验收角色由新 ADR 指定 | **不适用：当前基线无 pet；若未来重新引入，另立 ADR** | 当前无迁移依赖；重引入范围由新 ADR 定义 | 当前不迁移、不新增 `src/modules/pet/**` 或对应 client/config/data | 当前基线没有 pet 功能或存量 pet 数据要求；本任务不作为待迁移现有功能，也不阻塞 G3。未来另立 ADR 后再确定实现、验收与回滚。 |
| **M3-F** | 其余模块分批迁移；负责人：各模块 owner；验收：各模块 owner + Module SDK + QA | **后续未开始** | G2、M2-F；使用 outbox/context 的模块分别依赖 M2-D/E | 各模块自己的目录、配置、测试；共享 SDK 需求提交 Module SDK，不改他人内部 | 每模块启用/禁用/异常/dispose/数据兼容/公开 API 边界；先只读模块，再 scheduler/voice/social 等副作用模块。回滚：按模块停用并恢复该模块数据/配置版本。 |
| **M3-G** | 回放与兼容测试集；负责人：QA；验收：QA + 各工作流 owner | **后续未开始** | G2、M0-3、各契约测试 | QA 维护共享 fixtures；新增任务专属文件；不采集不必要真实隐私 | 至少 500 个合成或授权脱敏用例，覆盖收发、媒体、命令、审批、合流、取消、backfill、重启、unknown、模块启停和组合；差异逐项有接受/修复结论。回滚：仅回退测试数据/生成器，不影响运行时。 |

### M4：主链接线与垂直切片

M4-0～M4-6 是唯一的 Integration 串行队列，全部 **后续未开始**。任一项失败，保持 default-off，不推进下一项。

| ID | 任务 / 负责人角色 / 验收角色 | 状态 | 依赖 | 允许文件与边界 | 验收证据与回滚 |
|---|---|---|---|---|---|
| **M4-0** | 新核心组装根；负责人：Integration；验收：Integration + QA | **后续未开始** | G3 | host、总开关、组装测试和必要兼容导出；只使用单一 `FLAG_MODULAR_CORE`，默认关 | flag-off 基线等价、flag-on 装配顺序、启动失败 fail-closed、dispose 顺序、重启生效。回滚：关闭开关并重启，或回退代码，不改旧数据。 |
| **M4-1** | 私聊纯文本垂直切片；负责人：Integration + Core owners；验收：Integration + QA | **后续未开始** | M4-0、M3-A/B/C/D | 统一接线只能在 Integration 当前 PR；新链路不绕过 outbox | fake OneBot/fake DSH 端到端、并发首消息只建一个 session、恢复、context、dryRun、真实 DeliveryResult。回滚：flag-off 后旧私聊链完整可用。 |
| **M4-2** | 群聊、命令与回合控制；负责人：Integration；验收：Integration + QA | **后续未开始** | M4-1 | 继续由 Integration 独占 host/hub 接线；不减少场景规避失败 | 群/私聊隔离、白名单、@/引用、命令幂等、合流、steer、取消、提问、审批、权限复核和迟到边界。回滚：关闭新核心，恢复上一垂直切片。 |
| **M4-3** | 媒体、真实回执和失败路径；负责人：Integration + Outbox；验收：Integration + Outbox + QA | **后续未开始** | M4-2 | 图片/语音/文件/贴纸/转发及 Delivery Ledger 接线；不把 queued 当 sent | 媒体矩阵、真实 messageId、unknown、重试、每聊天顺序和发送后超时不双发。回滚：关闭新核心；unknown 审计保留，不自动重放。 |
| **M4-4** | backfill、后台任务与主动消息收口；负责人：Integration；验收：Integration + QA | **后续未开始** | M4-3、M3-F 对应模块 | backfill、scheduler、B 站 duty、面板动作、主动消息全部进入统一契约；禁止物理发送旁路 | 实时/backfill 竞争、过旧消息、无 ALS、晚到任务、后台异常、权限变化；逐一对账发送来源和 outbox 调用关系。回滚：关闭新核心，保持旧来源可用。 |
| **M4-5** | 可插拔模块统一接线；负责人：Integration + Module SDK；验收：Integration + Module SDK + QA | **后续未开始** | M4-4、M3-F；M3-E 当前不适用，未来若另立 ADR 再评估 | host 只按 manifest 装配；optional 模块经 SDK 启停；核心不承载业务逻辑 | 当前基线适用模块的启用/禁用/失败/dispose、同能力替代实现和 fnOS GUI 剪枝。当前不要求恢复或接入 pet；未来引入须先有新 ADR。回滚：按模块停用并回到上一切片，不改核心配置为业务分支。 |
| **M4-6** | 全量 fake 集成与回滚；负责人：Integration + QA；验收：QA + Controller | **后续未开始** | M4-1～M4-5 | 集成队列最后一项；运行全量测试、500 例回放、三态对比和 flag-on→flag-off | 无重复发送/串会话/越权/静默丢消息，数据兼容和回滚无需手工改库。回滚：保持 flag-off，使用已验证旧路径。 |

### M5：fnOS/DSH 隔离验证与生产灰度

M5 只能使用固定 commit/tgz，按 owner 批准顺序推进；当前全部 **后续未开始**，本次不触及真实环境。

| ID | 任务 / 负责人角色 / 验收角色 | 状态 | 依赖 | 允许文件与边界 | 验收证据与回滚 |
|---|---|---|---|---|---|
| **M5-1** | 工件与安装验证；负责人：Release；验收：Release + QA | **后续未开始** | G4 | 固定 commit 的 tgz、sha256、内容清单和隔离 DSH profile；不读/复制生产凭据 | 安装、重启、模块清单、配置生成、default-off、dataDir 权限、Node/DSH/Cordis 版本；回滚：卸载隔离工件并恢复隔离 profile 备份。 |
| **M5-2** | 真实 DSH + fake OneBot；负责人：QA + Integration；验收：QA + Integration | **后续未开始** | M5-1 | 隔离 profile；真实 DSH session/preset/model/tool/workspace 的验证，网关仍为 fake | 私聊/群聊、并发首消息、allowlist、人格/记忆作用域、取消、持久化、模块启停；不把日志当作取消/恢复证据。回滚：停止隔离工件并恢复隔离 profile。 |
| **M5-3** | 真实 OneBot dryRun；负责人：Owner + QA；验收：Owner + QA | **后续未开始** | M5-2、owner 批准维护窗口 | 真实 SnowLuma/NapCat 只做 dryRun；唯一写者和连接恢复检查 | 正确账号、心跳、重连、入站、backfill、dryRun 全出口拦截、旧桥健康且零真实出站。回滚：关闭新核心/停隔离插件，恢复已批准旧路径。 |
| **M5-4** | 小流量实发；负责人：Owner 放行、QA 记录；验收：Owner + QA | **后续未开始** | M5-3、每级 owner 独立批准 | owner 私聊→一个测试群→其他既有群；每一步独立批准，不并行扩大 | 文本/图片/引用/命令/审批/群消息/合流/断线/重启/模块启停无重复、串话、越权；可立即回滚。回滚：立即停新路径并切回已批准工件。 |
| **M5-5** | 72 小时稳定观察；负责人：QA + Owner；验收：QA + Owner | **后续未开始** | M5-4 达到批准灰度范围 | 冻结工件、配置和模块集合；记录连接、错误、模型、发送状态、unknown、health、资源与回滚 | 连续观察无 P0/P1，配置或工件变化即重新评估；异常停止扩量并 dryRun/回滚，保留证据。回滚：停止扩量，按影响范围切换旧路径。 |
| **M5-6** | 回滚演练；负责人：Release + Owner；验收：Release + Owner + QA | **后续未开始** | M5-4，且在 G5 前完成；按集成日历排在观察后 | 实际新核心→legacy、必要时插件版本回退；不自动反向迁移新数据 | 回滚后唯一连接、会话可见性、模块状态、真实发送、旧数据读取/新数据处理和恢复时间均有实测。回滚：使用上一完整发布工件及已验证数据恢复方案。 |

### M6：默认切换、legacy 删除与后续演进

以下任务须在 G5 和生产 owner go 决定后按发布队列推进，当前全部 **后续未开始**。

| ID | 任务 / 负责人角色 / 验收角色 | 状态 | 依赖 | 允许文件与边界 | 验收证据与回滚 |
|---|---|---|---|---|---|
| **M6-1** | 新核心设为默认；负责人：Integration + Release；验收：Integration + Release + Owner | **后续未开始** | G5、生产 owner go | 单独 PR 修改默认路径；保留一个发布周期的已验证紧急 flag-off | 全新安装和既有升级、旧配置/数据、optional 默认策略、flag-off 均验证并有发布说明。回滚：使用已实测 flag-off 或上一发布工件。 |
| **M6-2** | 删除 legacy 与废弃开关；负责人：Integration；验收：Integration + QA + Controller | **后续未开始** | M6-1 稳定且回滚策略复评 | 先停止引用→确认无调用→删实现→删开关/文档；不得删功能矩阵仍引用的能力 | 全量测试、500 例、打包、隔离安装、真实核心冒烟；`hub.js` 不再是状态 owner，源码无未登记物理发送。回滚：上一完整发布工件和数据恢复方案。 |
| **M6-3** | 模块独立发布边界；负责人：Controller + Module owners；验收：Controller + Module SDK + QA | **后续未开始** | M6-1；与 M6-2 不在同一 PR | 决定内置/独立可选包，不为形式模块化增加无收益仓库/进程；统一 SDK/apiVersion/provides/依赖冲突 | 示例模块无需改核心即可安装、启停、替代和回滚。回滚：保留内置模块或撤回未必要的拆包边界，不影响核心。 |
| **M6-4** | v2 文档与当前基线功能确认；负责人：Release + 全模块 owner；验收：Release + Controller + Owner | **后续未开始** | M6-1、M6-2、M6-3 的发布范围确定 | 架构、模块开发、配置、迁移、故障排查、功能清单、版本说明和 v2 候选；仅核对当前基线功能 | 逐项核对真实安装/配置/模块行为、当前功能保留位置、弃用批准、发布工件和回滚边界；当前基线无 pet，M6-4 不要求恢复 pet。回滚：沿用上一完整发布文档/工件，保留已批准功能归属。 |

## 5. 后续阶段验证边界

1. **M0 已闭环：** 本节不再列 M0 待办。当前最终门禁和工件证据见 `baseline.md`；M0 功能矩阵、契约和 40 项任务队列已归档。
2. **治理配置：** 本记录未声称分支保护或 tag 已配置；当前回滚参照是不可变 commit `a5cfcaec0f4aae6775a211f0d331e4d527b545e4`。是否设置保护规则由仓库管理员另行确认，不伪造现状。
3. **M1 起的任务：** 执行时逐项补实际 owner、基线 commit、任务分支/PR（若有）、允许文件、命令与退出码、通过/失败/跳过数、回滚与未验证项；本源码导出无 `.git`，不在此虚构远端 PR 元数据。
4. **真实环境：** 面板/副作用授权、OneBot/DSH、真实账号、外站、生产配置、迁移和回滚演练尚未完成；按阶段队列和 owner 批准后验证。`feature-matrix.md` 中 M1+ 边界是后续核对输入，不是 M0 未完成项。
5. **Pet：** 当前基线无 pet，M3-E 不适用；M4-5 不要求恢复/接入 pet，M6-4 不要求恢复 pet。若未来重新引入，另立 ADR。

当前 **M0 已完成、G0 已放行，M1 为下一阶段且尚未开始**。legacy 默认路径保持现状，新核心/灰度仍 default-off；G0 不等于允许 M4 主链接线或任何生产操作。
