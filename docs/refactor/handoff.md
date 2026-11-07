# 模块化重构地基交接

## 1. 本次负责范围

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

## 2. 尚未完成，不得误判

- G0 未放行：基线主测试有既有失败且未正常收尾。
- M0-3 完整功能矩阵未建立。
- ADR 仍是 Proposed，需功能矩阵初版和各工作流会签后才能冻结。
- 分支保护状态需由仓库管理员确认；未创建 Release。
- 契约校验器不是 Session/Turn/Outbox 的实现，也没有接管旧 pipeline。
- Module SDK 尚未消费新增能力字段；现有 `src/core/modules.js` 行为未改变。

## 3. 后续任务分派

| 优先级 | 任务 | 建议负责人 | 入口/边界 |
|---|---|---|---|
| 立即 | 分类并修复/登记基线主测试失败与卡住原因 | QA + 各失败域 owner | 不删除测试；中文路径问题与业务失败分开 |
| 立即 | M0-3 全功能、命令、面板、配置、数据和副作用矩阵 | QA + 全模块 owner | 所有模块有 owner，功能不得无声消失 |
| 立即 | M0-5 确认真实人员、PR 所有权和 Integration 日历 | Controller | host.js、host/**、hub.js 串行 |
| G0 前 | ADR-0001 会签并转 Accepted | Controller + Core owners | 需要新增字段时走新 ADR |
| G0 后 | M1-A～E 安全与 legacy 行为锁定 | Security/Inbound/Outbox | 先复现；host 修改串行 |
| G1 后 | M2-A 完整 NormalizedInbound 工厂与协议边界 | Inbound | 可复用 modular-contracts 校验器 |
| G1 后 | M2-B Session Registry | Session | single-flight、持久化、dispose |
| G1 后 | M2-C Turn Controller | Turn | 合流、取消、异常和 timer generation |
| G1 后 | M2-D Outbox/Delivery Ledger | Outbox | unknown 不自动重发，真实回执 |
| G1 后 | M2-E Context Assembly | Context | 全 provider、scope、sessionId |
| G1 后 | M2-F 在现有 modules.js 消费能力声明 | Module SDK | 不创建第二套模块系统 |
| G2 后 | M3 适配器、模块迁移和回放 | 各工作流 | 不接默认主链 |
| G3 后 | M4 垂直切片 | Integration | host/pipeline.js 串行接线 |
| G4 后 | M5 fnOS/DSH 验证 | QA + Owner | 真实动作逐阶段批准 |
| G5 后 | M6 默认切换与 legacy 清理 | Integration + Release | 不提前删除兼容层 |

## 4. 给下一位实现者的约束

- 沿用现有模块 `id/api/setup`；新增字段由 `module-contract.js` 校验，不另造平行 SDK。
- 现有 runtime loader manifest 继续负责环境剪枝，不与业务模块定义混用。
- 现有 `src/kernel/types.d.ts` 和旧 InboundEnvelope 暂保留，M3/M4 通过适配器收敛。
- core 不 import 业务模块，业务模块不 import hub 私有实现。
- 新工作流只依赖公共契约和 fake，不依赖其他未合入分支的实现。
- 全量测试未恢复前，不得宣称阶段完成或进入真实 QQ 灰度。

## 5. 验证命令

```bash
npm run test:all
npm run pack:check

# 地基快速回归
node --test test/modular-contracts.test.js test/modular-module-contract.test.js
node --test test/runtime-loader.test.js test/modules.test.js test/module-data-isolation.test.js test/no-bare-cross-module.test.js
```

本机如默认 PATH 没有 Node，先使用既有 Node 24 安装路径；CI 使用 Node 22，并先运行 `npm ci --prefix extensions/tieba-reader`。
