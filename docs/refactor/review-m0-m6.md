# M0–M6 交付复核报告（按任务书逐门禁对照）

> 复核时间：2026-11-09；复核基线：分支 `refactor/distill-groupmates` @ `fe29a7c`（含昨晚 M0–M6 全部提交）。  
> 复核方式：任务书 G0–G6 放行条件逐条对照仓库现状（文件/测试/grep 实证），不引用自我声明。  
> 结论先行：**G0/G1 达成；G2 基本达成；G3/G4 部分达成（有实缺口，未放行）；G5/G6 未进入（门禁纪律正确）**。

## G0（基线/清单/契约冻结）——✅ 达成

| 任务书条件 | 证据 |
|---|---|
| 基线可重复，CI 和打包检查存在 | package.json `test:all`/`pack:check`；`.github/workflows/verify.yml`；同 commit 多轮全量一致（1420 用例级别，历史见 baseline.md） |
| 功能矩阵完整，所有模块有 owner | feature-matrix.md §2（23 内置模块）+ §9（无无人认领） |
| 核心契约和模块 manifest 已冻结 | ADR-0001 **Accepted**（含会签记录 §7）；`test/modular-contracts` + `test/modular-module-contract` 绿 |
| 尚未改变任何生产行为 | 全部默认开关关；M4 旗默认关（见 G4） |
| 文件所有权和串行集成队列生效 | board.md §2/§4 |

备注：M0-1 的「生产版本与回滚 tag」项——回滚 tag 未打（未发布属预期，打 tag 归 Release 执行时）。

## G1（安全止损与行为锁定）——✅ 达成（一处死分支陈旧提示，无活体宣称）

| 任务书条件 | 证据 |
|---|---|
| 高风险项有复现/修复/书面结论 | M1-A 面板零防护→guard 补齐（7 用例）；M1-B tooOld 无消费者→修复（11 用例）；M1-C 盲目重发→unknown 语义落地（11 用例）；基线卡住根因=media.js 定时器泄漏→修复；AUDIT_REPORT 历史 19 项：M-06 已在代码中，其余声明归外围域迁移时处理（见缺口 #6） |
| 主功能矩阵有自动化测试或手工步骤 | feature-matrix.md 每条目带测试列 |
| unknown 测试不再用「请求失败即可重发」旧假设 | modular-delivery-legacy 11 用例（preSend 分类/unknown 不重发/不伪造回执） |
| backfill 不执行迟到命令/审批/过旧唤醒 | modular-backfill-legacy 11 用例 |
| README/面板宣称与真实接线一致 | M1-D 核对：TOTP/security-lock 无活体宣称（11 处命中全为注释/历史记录）；README 补面板防护第 8 条 |
| 灰度默认姿态安全 | flags.md + modular-flags 6 用例；全部缺省关 |

复核新发现（本次登记）：`src/security/danger.js:115-123` 存在**死分支**（`securityLock` 注入已随 security-lock 移除而消失，`lock && lock.locked` 永假），分支内残留「/unlock 6 位口令」的陈旧用户话术。运行时不可达、无活体宣称，属历史遗留——**登记为 M6-2 legacy 清理项**，不阻塞 G1。

## G2（核心与 Module SDK 纯模块）——✅ 基本达成

六组模块全部独立可测（不 import DSH/OneBot/host）：ChatKey+NormalizedInbound（11T）、SessionRegistry（9T）、TurnController/Scheduler（13T）、Outbox+Ledger（12T）、ContextAssembly（7T）、Module SDK（8T）——合计 58 用例 + 既有模块套件零回归。

| 任务书条件 | 判定 |
|---|---|
| 六组独立可测、未接生产路径 | ✅（M4 接线属 G4 阶段） |
| 共享状态 owner/dispose | ✅（Registry/Turn/Outbox 显式 dispose 有测试） |
| 公共 API 有版本与兼容策略 | ✅（CONTRACT_VERSION + module-contract api 兼容） |
| 同能力替代实现/禁用/异常隔离有测试 | ✅（prefer 替代实现/冲突/GUI 剪枝零执行/启动失败） |
| **部分达成项** | M2-F「在现有 modules.js 消费能力声明」：SDK 消费面就绪（planModules 进 boot），但 24 个内置模块中仅 memory/distill/slang 声明 provides——**其余模块的能力声明归 M3-F 迁移（见 G3 缺口 #1）** |

## G3（适配器、模块迁移、回放）——⚠️ 部分达成，**未放行**

已达成：四适配器（legacy-inbound/dsh-session+迁移器/onebot-outbox/legacy-context）9 用例；**511 例确定性回放**全链零失败；数据迁移器（幂等/损坏失败关闭/不写回旧文件）。

| 缺口 | 任务书依据 | 状态 |
|---|---|---|
| **#1 M3-F 模块迁移未做**：22 个内置模块未迁移到 SDK 面（无 provides/requires/独立启停语义声明）；仅 memory 声明 memory-store，distill/slang 为新增模块 | M3-F「每模块单独 PR 迁移到 SDK；每模块必须测试启用兼容/禁用零副作用/异常隔离/dispose」 | ⬜ 大工作量，未开始 |
| **#2 M3-G 新旧语义 diff 未记录**：511 例回放验证的是新核心合成链路的不变式，没有「同用例分别跑旧路径与新路径、记录语义差异清单」的对照 | M3-G「记录新旧路径语义差异」「所有差异有接受或修复结论」 | ⬜ 部分达成 |
| #3 M3-E 桌宠可插拔化 | 上游 main 已整体移除桌宠（4b9bba59，非本重构行为）；feature-matrix 已如实记 N/A | ✅（按实际情况豁免） |

**判定：G3 未放行**——M3-F 是放行硬条件。

## G4（主链接线与垂直切片）——⚠️ 部分达成，**未放行**

已达成（M4-0/1 + M4-2/4 部分）：FLAG_MODULAR_CORE 总开关（默认关、fail-closed、解析与四开关同口径）；私聊垂直切片全链（一个 session、回复唯一 outbox、真实回执）；命令闸；群/私白名单 fail-closed；**backfill 收口**（补收事件走同一入站契约，gateway.getModularCore 分支）；启动失败 fail-closed；dispose。10 用例。

| 缺口 | 任务书依据 | 状态 |
|---|---|---|
| **#4 「唯一 outbox」在旗开态不满足**：模块主动发送（api.sendText/sendSegments/sendFile → core.hub.sendText → legacy onebot 直发）**不经 outbox**。新核心回合回复与命令回复已收口，模块发送面未收口 | M4-4「backfill、后台任务、面板动作和模块主动消息进入同一入站/出站契约」+ 验收「源码中不存在未登记的物理发送旁路」 | ⬜ M4-5 范围，未做 |
| **#5 旗开态交互提问/审批回复识别缺失**：questions.approvals 的回复匹配在 hub.onMessage 内部；旗开时实时事件进新核心，**「确认/取消」「提问答复」类消息会被当普通聊天处理**（危险命令确认在 gateway 层拦截不受影响） | M4-2「接入群策略、@/引用、命令、合流、steer、取消、提问和审批」 | ⬜ 需要接入或声明降级 |
| **#6 M4-6 未完整执行**：flag-on→off 回滚未显式测试；「500 例回放 + 三态对比」未在旗开全链上执行（M3-G 的 511 例是合成回放，非新旧用户可见行为对比） | M4-6「执行全量测试、500 例回放、三态对比和 flag-on→flag-off 回滚」 | ⬜ |
| #7 M4-2 群策略（interjectChance 档位）、steer 到 DSH 的真实传播 | M4-2 范围 | ⬜（steer 管道已建，DSH 真实传播标 M5-2 验证） |

**判定：G4 未放行**——#4/#5 是行为正确性缺口（旗开态会双写者/丢审批流），#6 是验证缺口。

## G5 / G6 ——⬜ 未进入（纪律正确）

M5（fnOS 隔离验证）与 M6（默认切换/legacy 清理）**没有被执行**——这是遵守任务书串行门禁的正确行为（G4 未放行不得进 M5；G5 需真实环境证据 + owner go 才能切默认）。已交付的是可执行工件：m5-runbook.md（安装/验证/灰度逐项 checklist）与 m6-exit-plan.md（切换程序/清理顺序/文档清单）。**在 G4 缺口 #4/#5/#6 修复并复验之前，禁止执行 m5-runbook 与 m6-exit-plan。**

## 缺口汇总与建议顺序

| # | 缺口 | 归属 | 建议动作 |
|---|---|---|---|
| 4 | 模块发送面收口到 outbox（旗开态唯一写者） | M4-5 | **优先**——行为正确性；把 api.sendText/sendSegments 在旗开态改走 outbox.request（legacy 直发保留在 flag-off 路径） |
| 5 | 旗开态提问/审批回复识别 | M4-2 | **优先**——旗开灰度前置条件；新核心 dispatch 前挂 questions/approvals 回复识别（同 dangerGuard 在 gateway 层的模式） |
| 6 | M4-6 三态对比 + flag 回滚显式测试 | M4-6 | #4/#5 完成后执行 |
| 1 | M3-F：22 内置模块 SDK 迁移（分批 PR） | M3-F | 大工作量；可先批「只读模块」（rss/complete-guard…）再批有副作用模块 |
| 2 | M3-G 新旧语义 diff 记录 | M3-G | 与 #6 的三态对比合并执行 |
| 7 | danger.js 死分支清理（含 /unlock 陈旧话术） | M6-2 | 登记在 m6-exit-plan 清理清单 |
| — | M5/M6 执行 | G5/G6 | 门禁后执行 |

## 结论

- 昨晚交付的**代码与测试本身质量成立**：G0/G1 全绿、G2 基本全绿、M3/M4 的已声明交付物（适配器/回放/垂直切片/总开关）全部有测试背书且全量回归通过。
- **但按任务书的门禁原文，G3/G4 尚未放行**：M3-F 模块迁移、M4-4 发送面唯一 owner、M4-2 提问/审批旗开接入、M4-6 三态对比是真实缺口。**当前旗开态（FLAG_MODULAR_CORE=true）不具备灰度条件**——默认关姿态安全。
- 建议下一步按 #4 → #5 → #6 → #1/#2 顺序补齐后再走 G3/G4 复核放行。
