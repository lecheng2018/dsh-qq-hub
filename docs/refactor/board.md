# 模块化重构任务看板与集成日历（M0-5）

> 任务书：M0-5「建立任务看板和集成日历」。每个任务可回答：谁在做、依赖谁、能改哪些文件、由谁验收、如何回滚。  
> 现实约束：当前由单人体推进（一人兼任 Controller / Integration / QA / 各 Module owner），因此串行队列即执行顺序；若后续加入多人，按下表角色还原并行。

## 1. 角色（一人兼任）

| 角色 | 职责 | 本阶段承担 |
|---|---|---|
| Controller | ADR、契约、依赖方向、门禁、范围变更 | ✅ 单人体 |
| Integration | host/hub 接线、开关、兼容层、回滚（串行队列唯一持有者） | ✅ 单人体 |
| Core/Module owner | 各目录纯模块、适配器、测试 | ✅ 单人体 |
| QA/Release | 基线、CI、回放、打包、证据 | ✅ 单人体 |
| Owner | 真实 QQ、生产切换决定 | ⛔ 仓库 owner（lecheng2018），M5 起必须真人放行 |

## 2. 文件所有权（来自总览 §6，重申 + 现状）

| 文件范围 | 负责人 | 并行规则 |
|---|---|---|
| `src/host.js`、`src/host/**`、`src/chat/hub.js`、`src/kernel/legacy-fallback.js` | Integration | 同一时刻只一个接线 PR；管道装配在 `src/host/pipeline.js` |
| 公共契约与 ADR（`docs/refactor/adr/`、`src/kernel/modular-contracts.*`、`src/core/module-contract.*`） | Controller | 冻结后才能并行开发 |
| `src/onebot/**`、`src/chat/inbound.js`、`src/chat/backfill.js` | Inbound | 不改 host 接线 |
| session/turn 新文件 | Session/Turn | 分文件开发 |
| outbox 与投递测试 | Outbox | 不改主链接线 |
| memory/context | Context | 数据迁移独立 PR |
| `src/core/modules.js`、`src/runtime/module-loader.js`、SDK | Module SDK | API 改动需 Controller 复核 |
| package / workflow / 发布文件 | QA/Release | 功能 PR 不改版本和集中 changelog |
| `test/` 任务专属测试 | 各任务 | 新测试用任务专属文件，不并行追改 `test/e2e.test.js` |

## 3. 任务看板

状态：⬜ 未开始 / 🔵 进行中 / ✅ 完成 / ⏸ 暂缓（有 owner、有理由）

| 任务 | 状态 | 负责人 | 依赖 | 允许文件 | 验收 | 回滚 |
|---|---|---|---|---|---|---|
| M0-1 锁定执行基线 | ✅（地基提交 8115132 已记录 baseline.md） | Controller+Release | — | docs/refactor/baseline.md | 基线/差异/版本/回滚点齐 | 删未发布记录分支 |
| M0-2 测试与打包基线 | ✅ 全量两次一致（1287 用例 0 fail / 182s）；扩展 46/46；pack 214 文件 | QA | M0-1 | package scripts、.github/workflows、测试基建 | 同 commit 两次一致；tgz 清单 | 还原 workflow |
| M0-2a 基线失败分类修复（.pathname 环境类等） | ✅ 62e1315 | QA | M0-2 | test/*.test.js 路径解析（不删不改断言） | Windows/POSIX 一致 | git revert |
| M0-2b 其余基线失败分类登记 | ✅ 62e1315 / ae49305（含卡住根因：media.js 定时器泄漏，生产缺陷已修） | QA + 域 owner | M0-2 | 测试或对应域文件 | 失败→修复或书面接受 | 各自 PR revert |
| M0-3 功能矩阵 | ✅ feature-matrix.md 初版 | QA + 各 owner | M0-1 | docs/refactor/feature-matrix.md | 无无人认领条目 | 删文档 |
| M0-4 契约 ADR 冻结 | ✅ ADR-0001 Accepted（会签记录见 ADR §7） | Controller | M0-3 初版 | docs/refactor/adr/0001 | 全会签 + Accepted | ADR 回退 Proposed（附说明） |
| M0-5 看板与日历 | ✅ 本文档 | Controller | M0-1 | docs/refactor/board.md | 每任务五问可答 | 删文档 |
| G0 放行 | ✅（证据见 baseline.md M0-2 节） | Controller | 全部 M0 | — | G0 检查单 | — |
| M1-A 面板安全边界 | ✅ 7f2519a（guard + 接线 + 7/7 测试；防护位于插件层，反代形态登记未覆盖） | Security/Integration | M0-2 | test/modular-panel-guard + host/panel/guard + 接线（串行队列第 1 项） | 未授权请求零副作用 | PR revert |
| M1-B backfill 行为锁定 | ✅ 61a8d44（11/11 测试；tooOld 无消费者已修复进接线，串行队列第 2 项） | Inbound + Integration | M0-3/4 | test/modular-backfill-legacy + gateway.js | 迟到副作用为零 | PR revert |
| M1-C unknown 发送锁定 | ✅ d528631（11/11 测试；client 分类 + sendFile/sendVoice 回退条件，串行队列第 3 项） | Outbox + Integration | M0-4 | test/modular-delivery-legacy + client.js/hub.js | 无 echo/messageId 幂等冒充 | PR revert |
| M1-D 文档对齐 | ✅（TOTP 已移除无宣称；审批/提问/dryRun/模块隔离宣称属实；README 补 M1-A 防护第 8 条） | Release+Security | 无 | README、docs | 宣称=实现 | 文档还原 |
| M1-E 开关姿态 | ✅ 5896d27（flags.md + 6/6 测试；缺省全关，本阶段 0 灰度扩大） | Controller+Integration | — | docs/refactor/flags.md + 必要测试 | flag-off=基线 | — |
| G1 放行 | ✅（M1 全绿两轮） | Controller | M1-A~E | — | G1 检查单 | — |
| M2-A~F 纯模块 | ✅（58 用例：ChatKey/Session/Turn/Outbox/Assembly/SDK，7240890..62bd896） | 各 Core 工作流（单人体） | G1 | 各自新文件 + modules.js 消费点 | G2 检查单 | PR revert |
| M3 适配器+回放 | ✅（四适配器 9 用例 + 506 例确定性回放 d6dd808；合成分支链，非新旧用户可见对照——见 review §2） | 各工作流（单人体） | G2 | adapters 新文件 | 差异零未解释 | PR revert |
| M4-0~6 垂直切片 | ✅（FLAG_MODULAR_CORE 默认关，10 用例 ec3aafe；2026-11-08 复核修复 R1-R3：入站 ACL/preset 等价、统一出站 enabled/dryRun/身份闸/真实台账 fail-closed、turn-end 成功语义、followup rejection 清理） | Integration | G3 | host/modular-core.js + host.js 分支（串行队列） | flag-off 逐字不变 | 关开关+重启 |
| M5 | ◐ 内测进行中（2026-11-08 两轮：9 断言 8✅，#9 OneBot unknown 待 SnowLuma 可控环境；真机 10 缺陷全部修复进源码+回归；环境坑/遗留已登记 m5-runbook）| QA + Owner | G4 | — | — | — |
| M6 | 📄 退出计划就绪（m6-exit-plan.md），切换/清理 blocked-on-G5+owner go | Integration+Release | G5 | — | — | — |

## 4. Integration 串行队列（host/hub 独占窗口）

1. M1-A host 修复（若面板防护需进 `src/host/**`）
2. M1-B backfill 接线修复（若 tooOld 语义需进 gateway/hub）
3. M1-C legacy 发送修复（若投递状态需进 hub）
4. （G2 后）M4-0 → M4-6 依次排队，见 M4 任务书

规则：队列中同时只有一项在改 `src/host.js` / `src/host/**` / `src/chat/hub.js`；每项合入前 rebase + 全量测试；单人体执行时按本顺序串行即为守约。

## 5. 必须串行的操作清单（重申）

1. host 装配顺序；2. hub 主消息/回合/发送行为；3. feature flag 新增或语义变化；4. 配置 schema 或持久化格式；5. 默认路径切换、legacy 删除、生产发布。

## 6. 集成日历（相对节奏）

```text
本次会话（单人体连续执行）：
  M0-2a/2b 收口 → M0-4 会签 → G0 复核
    → M1-A/B/C 测试先行（并行三域测试文件）
    → 串行队列：M1-A host 修复 → M1-B 接线 → M1-C 发送修复
    → M1-D 文档、M1-E 开关姿态 → G1 复核 → 交接 handoff.md 更新
```

无日历日期（单人连续执行，无多时区协调需求）；若引入多人，按 PR 时间戳排队，后合入者 rebase + 重跑全量。

## 7. 共享服务与外围模块后续队列（2026-11-12）

下列为 [插件模块化演进路线](plugin-modular-roadmap.md) 的增量队列，不改变上面的历史 M0–M6 状态，也不代表 M6 已获放行。沿用 ADR-0002 的唯一共享实现原则；Integration 仍独占 host/hub 接线窗口。

| 任务 | 状态 | 负责人 | 依赖 | 允许文件 | 验收 | 回滚 |
|---|---|---|---|---|---|---|
| P0 记忆档案安全门 | 已在 main（9732714 / 7bd7bd1）；生产迁移未执行 | Context + QA | 前置存储重构已在主线 | memory 存储/整理、迁移 CLI、面板重载、专属测试与文档 | 损坏/外改/失败进度/重载回归已覆盖；真机/浏览器与生产迁移另验 | 按路线 P0 的数据恢复边界，不直接回退旧库 |
| P1 共享流水服务 | 已在 main（PR #52 / c17c2ed） | Integration + Context | P0 + #53 夹具修复 | chat-log 服务、hub facade、host 装配、日志消费者及专属测试 | 独立游标、完整批次、失败续跑、取消与 host e2e 通过；全量结果见下 | 保留原日志与游标；旧版不识别指纹，降级前停学习核对 |
| P1a 回复与富媒体编排迁出 | 已在 main（PR #54 / 60bbbc5） | Integration + Outbox | P1 + 既有 Shared Outbox | reply-delivery、hub facade、投递顺序与回复回归 | 拆条/合并/引用/媒体行为不变，同会话票和失败释放由独立服务测试覆盖 | hub 恢复委托前实现；不改物理出口 |
| P1b 审批与提问共享 | 已在 main（PR #57 / 43f8781） | Integration | P1a + 当前 SessionRegistry | host/effects、hub 注入、注册表生命周期及专属测试 | 同一注册表服务新旧入口，非 QQ 会话交还原服务，卸载清理等待项 | 还原组合根接线，不启用第二套注册表 |
| P2 入站媒体与上下文共享 | 🔵 进行中（媒体、语音、引用、图片已共享，辅助视觉本批） | Inbound + Integration | P1；ADR-0002 出站前置门禁 | inbound/context 服务及消费接线 | 新旧输入等价，取消不污染，无双发 | 旧 facade 调用同一实现 |
| P3 记忆学习管线独立 | 待开始 | Context + Module SDK | P1、档案契约冻结 | archive 契约、extractor、生命周期与分批测试 | 无模型可 CRUD/召回，批次幂等、正文与进度一致；记忆当前仍按日 checkpoint | 关新消费者，防止双调度 |
| P4 派生学习模块自治 | 待开始，按子域拆 PR | 各 Module owner | P3 | profile/reflection/style/distill/slang 各自目录及兼容路由 | 独立停启、来源失效、作用域安全 | 关闭消费者，不把派生结果灌回事实名下 |
| P5 兼容层退出 | 待 owner 门禁 | Integration + Release | ADR-0002 全等价验收 | facade 清理、矩阵与运维文档 | 真机对照、观察窗口和回滚演练 | 独立切换与恢复方案 |

P1 最终本地验证（Node 22.16.0，2026-11-12；基于含 #53 的 main）：

- `npm test`：1864 项，1860 通过、4 跳过、0 失败。真实 host 的每日整理保留流水与重跑不重复提炼用例通过。
- 原主线两项夹具断言失配由独立 PR #53 修复；未改变前端或回复业务行为。
- `npm run test:extensions`：46/46 通过；`npm run lint`：0 error、285 warning；`npm run pack:check`：285 文件，含共享流水服务及迁移脚本，dry-run 成功。
- 未改版本、集中 changelog、前端、生产记忆数据或运行中的 DSH。K-03 删除旧内核继续受 G5/owner/真机/观察期约束。

详细每项范围、失败条件和未完成边界以路线文档为准；功能 PR 不改版本和集中 changelog。
