# 模块化重构 M0 交接

## 1. 当前状态

- 工作分支：远端 `refactor/modular-core`，基于最新 `main` commit `a5cfcaec0f4aae6775a211f0d331e4d527b545e4`；已有地基提交 `8115132268be5b65de60b677dcde69ddfada54e9`。
- **M0 已完成，G0 已放行；下一阶段为 M1，M1 尚未开始。** 具体证据和范围见 `baseline.md`、`feature-matrix.md`、`task-board.md` 与 `integration-calendar.md`。
- ADR-0001 已接受为契约 v1。当前协调人 `yaozy2020` 作出执行基线接受决定；本记录不声称存在各工作流的多人签字。
- 回滚参照点为不可变 commit `a5cfcaec0f4aae6775a211f0d331e4d527b545e4`；未声称分支保护或 tag 已配置。

## 2. M0 已提供的交付物

1. 当前远端基线、历史失败分类及修复闭环：`docs/refactor/baseline.md`。
2. 已接受的公共契约 ADR v1：`docs/refactor/adr/0001-modular-contracts.md`。
3. 当前源码功能静态盘点：`docs/refactor/feature-matrix.md`；包括模块、命令、面板、配置/数据和副作用边界，并区分静态事实与测试/真实环境证据。
4. 40 个任务 ID 的看板与阶段依赖/串行集成日历：`docs/refactor/task-board.md`、`docs/refactor/integration-calendar.md`。
5. M0 最终门禁记录：主测试 1289 tests / 1285 pass / 0 fail / 4 skipped，第二次相同内容 dot reporter 运行退出码 0；扩展 46/46；`npm pack --dry-run` 成功，214 个包文件。

## 3. M1 是下一阶段；不得误判为已完成

M1-A～E 尚未开始，须依 M1 队列执行：面板安全边界、backfill、unknown/媒体 fallback、文档能力对齐、开关安全姿态。需要修改 `src/host.js`、`src/host/**` 或 `src/chat/hub.js` 时，按日历由 Integration 串行接线；不能因为 G0 放行就并行改共享接线或切换默认路径。

契约消费者只能依赖 ADR v1。任何公共字段变更须另立 ADR；不以本次执行基线接受替代后续变更审议。

## 4. 真实环境与后续未做边界

- 本次仅完成 M0 基线、文档矩阵、契约冻结及门禁记录；未接入新核心主链、未修改生产行为。
- 未完成 M1～M6 的实现、宿主集成、隔离安装、真实 DSH/OneBot/QQ/外站验证、生产灰度、默认切换或 legacy 删除。
- 未声称分支保护、tag、Release、真实环境权限或生产回滚演练已配置/完成。不可变 commit `a5cfcaec0f4aae6775a211f0d331e4d527b545e4` 是当前文档采用的回滚参照点。
- 当前基线无 pet；M3-E 标为不适用，而非待迁移现有功能。若未来重新引入 pet，须另立 ADR；M6-4 不要求恢复 pet。
- 不在本交接记录或公开验证证据中放入生产凭据、token、QQ 正文或隐私数据。

## 5. 后续验证命令参考

```bash
npm run test:all
npm run pack:check

# 地基快速回归
node --test test/modular-contracts.test.js test/modular-module-contract.test.js
node --test test/runtime-loader.test.js test/modules.test.js test/module-data-isolation.test.js test/no-bare-cross-module.test.js
```

历史说明：本机先前使用 Node v24.22.1；CI 使用 Node 22，并先运行 `npm ci --prefix extensions/tieba-reader`。实际阶段执行时仍需记录使用的 commit、命令、退出码、通过/失败/跳过数和未验证项。
