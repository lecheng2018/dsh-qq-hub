# M6 · 默认切换与 legacy 清理 — 执行计划（G5/owner 门禁后逐项执行）

> 状态（2026-11-12）：新核心已经默认开启；旧实现删除仍未放行。当前执行基线、剩余依赖和逐批门禁见 [K-03 旧内核退出准备包](k03-exit-readiness.md)。真实环境证据与 owner 单独 go 之前，不删除旧实现。

## M6-1 新核心设为默认（已完成，旧开关尚待退出）

`FLAG_MODULAR_CORE` 已默认开启。后续不是再次切换默认，而是在 K-03 验收完成后删除 legacy/pipeline 分支和隐藏回退位；失败时停止相关业务，不自动启用旧实现。

## M6-2 legacy 清理顺序（稳定一个发布周期后）

按任务书「停止引用→验证无调用→删实现→删开关和文档」分批：
1. 停引用：host.js dispatchEvent 的 pipeline/legacy 分支按 M4 实测切换率决定移除顺序。
2. 验证无调用：发送点对账（feature-matrix §6）逐条确认全部走 outbox。
3. 删实现：hub 直调分支 → FLAG_USE_PIPELINE 管道 → 双合流窗口 → 旧 memory takeover。
4. 删开关与文档：flags.md 更新、README 架构节改写。

## M6-3 模块独立发布边界

- 内置 optional 模块继续随插件发布；确有独立发布需求的模块再拆包（不预先拆仓库）。
- 外部模块与内置模块同一 SDK（src/core/modules.js + module-sdk.js 能力声明）。

## M6-4 v2 文档清单

- [ ] README 架构节：新核心链路图（Registry→Turn→Assembly→Outbox）
- [ ] docs/refactor/feature-matrix.md：每条目标注新归属
- [ ] flags.md：最终开关清单（含 FLAG_MODULAR_CORE 语义）
- [ ] CHANGELOG：v2 候选条目
- [ ] 已知边界（反代形态、session/event 依赖）迁移至 USER-MANUAL 故障排查节
