# 模块化重构地基交接

> **2026-11-08 二次更新（分支 refactor/m2-m6）：M2~M4 代码交付完成，M5/M6 工件就绪。**  
> 分支结构：`backup/m0-m1-complete` = M1 完成点备份（不再推进）；`refactor/m2-m6` = 全量工作分支。  
> **2026-11-08 复核修复更新（分支 refactor/distill-groupmates）：** 按《M2-M6 代码审查报告》与《M0-M6 综合审查报告》逐条实证复核，R1-R3 已修并回归：
> R1 门禁（R1 导入闭包测试 + host 入口可加载测试 + Verify 覆盖 refactor/**、backup/**）；
> R2 安全与副作用（outbox 出队授权/FIFO、enabled/dryRun/身份闸统一出站点、OneBot 副作用 unknown 完整分类、面板 CSRF 不分方法 + 副作用路径 405、ledger fail-closed）；
> R3 回合与状态（Turn ChatKey 不变量、排队/dispose 取消终态、DSH turn/end 成功语义 + followup rejection 清理、session registry 持久化接线）。
> 全量测试 1442 pass / 0 fail / 4 skip；扩展 46/46。G2-G4 不放行结论需据此重跑，M5/M6 仍 blocked-on-fnOS/owner/G5+owner go。
> 分支现状：`refactor/m2-m6` = 缺 context-assembly 的历史快照（保留只读）；`refactor/distill-groupmates` = 唯一后继集成分支（补入该文件 + 蒸馏新功能 + 本次修复）。
> M2：六组纯模块（ChatKey/NormalizedInbound、SessionRegistry、TurnController、Outbox+Ledger、ContextAssembly、Module SDK）58 用例；  
> M3：四适配器 + 506 例确定性回放（合成链路不变式，非新旧用户可见对照）；M4：FLAG_MODULAR_CORE 新核心全链（默认关，flag-off 逐字不变）；  
> M5：m5-runbook.md（执行项 blocked-on-fnOS/owner，如实标记）；M6：m6-exit-plan.md（切换/清理程序就绪，blocked-on-G5+owner go）。

## 1. 本次负责范围（M0/M1 阶段原文保留，见 git 历史）

工作分支：`refactor/modular-core`。未修改 main，未接生产主链。

已提供：

1. 当前主线基线与 host 分层差异记录：`docs/refactor/baseline.md`。
2. 公共契约 ADR（Proposed）：`docs/refactor/adr/0001-modular-contracts.md`。
3. 核心数据契约与校验器：
   - `src/kernel/modular-contracts.js`
   - `src/kernel/modular-contracts.d.ts`
4. 旧模块兼容的新能力声明校验：
   - `src/core/module-contract.js`
   - `src/core/module-contract.d.ts`
5. 测试：
   - `test/modular-contracts.test.js`
   - `test/modular-module-contract.test.js`
6. 统一门禁：
   - package scripts：`test:extensions`、`test:all`、`pack:check`
   - 非发布验证 workflow：`.github/workflows/verify.yml`
   - Release 在发布前安装扩展依赖、运行全部测试和打包检查

### 2026-11-08 追加（M0 收口 + M1 交付）

7. M0-2 基线分类与修复（62e1315 / ae49305）：逐文件 142 文件分类（136过/4败/2卡），
   五类根因全部修复或门控（详见 baseline.md M0-2 节）；**卡住根因 = media.js 定时器泄漏（生产缺陷）已修**。
8. M0-3 功能矩阵：`docs/refactor/feature-matrix.md`（23 内置模块 + 59 面板路由 + 16 命令 +
   定时源 + 主动发送来源清单 + 行为基线；桌宠为 main 4b9bba59 移除的既有事实）。
9. M0-4：ADR-0001 转 **Accepted**（会签记录见 ADR §7）。
10. M0-5：`docs/refactor/board.md`（看板 + 文件所有权 + Integration 串行队列 + 单人体说明）。
11. M1-A 面板安全边界（7f2519a）：`src/host/panel/guard.js`（Host 白名单 + CSRF 同源校验），
    接线 http.js route() 与 host.js 模块前缀路由；config 新增 `security.panel.allowedHosts`；
    测试 `test/modular-panel-guard.test.js` 7/7。
12. M1-B backfill 锁定（61a8d44）：`test/modular-backfill-legacy.test.js` 11/11；
    gateway tooOld 不唤醒（原缺陷：无消费者）+ 命令类 seen 去重。
13. M1-C unknown 发送锁定（d528631）：`test/modular-delivery-legacy.test.js` 11/11；
    client.js 发送类动作禁止盲目重发（unknown 语义落地）+ sendFile/sendVoice fallback 状态依据。
14. M1-D 文档对齐：TOTP 无残留宣称（security-lock 已移除）；审批/提问/dryRun/模块隔离宣称属实；
    README 安全模型补第 8 条（面板防护）。
15. M1-E 开关姿态（5896d27）：`docs/refactor/flags.md` + `test/modular-flags.test.js` 6/6；
    四灰度位缺省全关，本阶段 0 灰度扩大。

## 2. 尚未完成，不得误判

- ~~G0 未放行~~ → **G0 已放行**（证据：baseline.md M0-2 节，两次全量一致 1287 用例 0 fail）。
- ~~M0-3 完整功能矩阵未建立~~ → 已建立（初版，模块 owner 段落为单人体代填，真实 owner 复核待多人协作启动）。
- ~~ADR 仍是 Proposed~~ → **Accepted**。
- 分支保护状态需由仓库管理员确认；未创建 Release。
- 契约校验器不是 Session/Turn/Outbox 的实现，也没有接管旧 pipeline。
- Module SDK 尚未消费新增能力字段；现有 `src/core/modules.js` 行为未改变。
- M1 遗留边界（G1 复核记录，见 §2b）：面板防护在反代部署形态未验证（M5 实测）；
  legacy 无「只落上下文」独立通道（tooOld 语义简化为不唤醒，M2-A 承接）；
  发送账本（Delivery Ledger）尚未存在（M2-D 交付）。

## 2b. G1 放行检查单（M1 任务书 §5）

- [x] 已知高风险项均有复现、修复或明确接受风险的书面结论（M1-A 面板零防护→已补齐；M1-B tooOld→已修；M1-C 盲目重发→已禁；基线卡住根因→已修；AUDIT_REPORT 历史 19 项中 M-06 心跳已在现有代码存在，其余属外围模块域，M2/M3 各域迁移时处理）
- [x] 主功能兼容矩阵有自动化测试或明确手工验收步骤（feature-matrix.md 每条目带测试列）
- [x] unknown 发送测试不再使用「请求失败即可安全重发」的旧假设（modular-delivery-legacy 11 用例）
- [x] backfill 不执行迟到命令、审批或过旧主动唤醒（modular-backfill-legacy 11 用例）
- [x] README/面板宣称与真实接线一致（M1-D 核对 + README 第 8 条）
- [x] 灰度默认姿态安全，生产未切换（flags.md + modular-flags 6 用例；0 开关打开）

## 3. 后续任务分派

| 优先级 | 任务 | 建议负责人 | 入口/边界 |
|---|---|---|---|
| ~~立即~~ 完成 | 分类并修复/登记基线主测试失败与卡住原因 | ✅ M0-2a/2b | 不删除测试；中文路径问题与业务失败分开 |
| ~~立即~~ 完成 | M0-3 全功能矩阵 | ✅ | owner 段落待真实 owner 复核 |
| ~~立即~~ 完成 | M0-5 看板 | ✅ | |
| ~~G0 前~~ 完成 | ADR-0001 会签并转 Accepted | ✅ | |
| ~~G0 后~~ 完成 | M1-A～E | ✅ 7f2519a/61a8d44/d528631/5896d27 | |
| G1 后 | M2-A 完整 NormalizedInbound 工厂与协议边界 | Inbound | 可复用 modular-contracts 校验器 |
| G1 后 | M2-B Session Registry | Session | single-flight、持久化、dispose |
| G1 后 | M2-C Turn Controller | Turn | 合流、取消、异常和 timer generation |
| G1 后 | M2-D Outbox/Delivery Ledger | Outbox | unknown 不自动重发，真实回执 |
| G1 后 | M2-E Context Assembly | Context | 全 provider、scope、sessionId |
| G1 后 | M2-F 在现有 modules.js 消费能力声明 | Module SDK | 不创建第二套模块系统 |
| G2 后 | M3 适配器、模块迁移和回放 | 各工作流 | 不接默认主链 |
| G3 后 | M4 垂直切片 | Integration | host/pipeline.js 串行接线 |
| G4 后 | M5 fnOS/DSH 验证 | QA + Owner | 真实动作逐阶段批准；面板防护反代形态补验 |
| G5 后 | M6 默认切换与 legacy 清理 | Integration + Release | 不提前删除兼容层 |

## 4. 给下一位实现者的约束

- 沿用现有模块 `id/api/setup`；新增字段由 `module-contract.js` 校验，不另造平行 SDK。
- 现有 runtime loader manifest 继续负责环境剪枝，不与业务模块定义混用。
- 现有 `src/kernel/types.d.ts` 和旧 InboundEnvelope 暂保留，M3/M4 通过适配器收敛。
- core 不 import 业务模块，业务模块不 import hub 私有实现。
- 新工作流只依赖公共契约和 fake，不依赖其他未合入分支的实现。
- ~~全量测试未恢复前，不得宣称阶段完成~~ → 全量已恢复（见 §2b G1 检查单与 baseline.md 证据）。

## 5. 验证命令

```bash
npm run test:all
npm run pack:check

# 地基快速回归
node --test test/modular-contracts.test.js test/modular-module-contract.test.js
node --test test/runtime-loader.test.js test/modules.test.js test/module-data-isolation.test.js test/no-bare-cross-module.test.js

# M1 交付回归（2026-11-08）
node --test test/modular-panel-guard.test.js test/modular-backfill-legacy.test.js test/modular-delivery-legacy.test.js test/modular-flags.test.js
```

本机如默认 PATH 没有 Node，先使用便携 Node 22（CI 同为 Node 22，先运行 `npm ci --prefix extensions/tieba-reader`）。

## 6. 推送方案（对仓库 owner 的操作说明）

- 本次工作在本地完成，**未向远端推送任何内容**。
- 推送时**新建干净分支**（建议 `refactor/m0-m1-foundation`），从远端 `main` 或 `refactor/modular-core` 切出后
  以本地产物建 PR；**不直接 push 到 `refactor/modular-core` 集成分支**。
- 分支提交序列（本地）：5117131 pristine 复刻 → 62e1315/ae49305（M0-2 修复）→ 7f2519a（M1-A）→
  61a8d44（M1-B）→ d528631（M1-C）→ 5896d27（M1-E）→ docs 收口（board/handoff/baseline/e2e 等待窗口）。
- 每个提交独立可回滚；合入前 rebase + 全量测试（npm run test:all + pack:check）。
