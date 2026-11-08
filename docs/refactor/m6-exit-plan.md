# M6 · 默认切换与 legacy 清理 — 执行计划（G5/owner 门禁后逐项执行）

> 状态（2026-11-08）：**M6 是执行阶段，不是本分支的代码变更**。任务书 M6 前置 = G5 放行 +
> 生产 owner 的 go 决定；在真实环境证据（M5 runbook 全部回填）之前切换默认 = 违反任务书
> 「不得为赶进度跳过真实环境」。本文件把切换程序、清理顺序和 v2 文档清单备齐到可执行状态。

## M6-1 新核心设为默认（程序）

1. 证据前置：M5-1..M5-6 全部回填、G5 评审通过、owner 书面 go。
2. 单独 PR：`FLAG_MODULAR_CORE` 缺省值改开（kernel/legacy-fallback.js 的 isModularCoreEnabled
   缺省分支 + flags.md 同步），保留紧急 flag-off（设 FLAG_MODULAR_CORE=false + 重启）。
3. 全新安装 + 既有升级两条路径验证；发布说明写明默认变化与回滚方式。

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
