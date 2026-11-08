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
| M5 | 📄 runbook 就绪（m5-runbook.md），执行项 blocked-on-fnOS/owner | QA + Owner | G4 | — | — | — |
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
