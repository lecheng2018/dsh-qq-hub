# M5 · fnOS/DSH 隔离验证与生产灰度 Runbook（真实环境门禁项如实标记）

> 状态（2026-11-08，单人体）：**M5 的代码侧工件已就绪；执行项全部 blocked-on-真实环境/owner**。
> 任务书红线：任何阶段不得出现两个真实写者；未经 owner 当阶段批准不开放真实发送。
> 本 runbook 由 owner/QA 在 fnOS 上逐项执行并回填证据；不得以本文件代替实测。

## M5-1 工件与安装验证（blocked-on-fnOS）

- [ ] `git archive`/`npm pack` 固定 commit 的 tgz，记录 sha256 与内容清单
- [ ] 隔离 DSH profile 安装（不动生产 profile）
- [ ] 重启加载：模块清单与 feature-matrix §2 一致（23 内置模块）
- [ ] default-off 验证：不设任何 FLAG_* 时行为与 1.3.64 一致（M4-6 已在 fake 环境背书）

## M5-2 真实 DSH + fake OneBot（blocked-on-fnOS）

- [ ] FLAG_MODULAR_CORE=true + fake 网关：私聊/群聊会话创建、preset 路由（private/private-long/social）
- [ ] 断线补收经新核心（gateway.getModularCore 分支）
- [ ] 模块启停（mods.health 快照）

## M5-3 真实 OneBot dryRun（blocked-on-owner 维护窗口）

- [ ] 连真实 SnowLuma/NapCat，dryRun 全出口拦截零实发
- [ ] 唯一写者确认（旧桥停用或隔离 profile 不挂真实号）

## M5-4/5/6 小流量实发 / 72 小时观察 / 回滚演练（blocked-on-owner 逐级批准）

- 顺序与门禁见任务书 M5 §3/§4；每一步独立批准 + 证据回填本文件。
- 回滚姿态：FLAG_MODULAR_CORE 关 + 重启 = 回 legacy 路径（代码回退用 backup/m0-m1-complete 分支工件）。

## 已知边界（诚实登记）

- 面板 Host/CSRF 防护在「DSH 前置反向代理」部署形态未验证（插件层判定只看 Host/Origin，反代改写 Host 需在 allowedHosts 登记）。
- 新核心 execute 依赖 `session/event` 的 `assistant/message` 事件取回复文本；真实 DSH 若事件形状不同，适配缺口会**如实失败**（M4-0 fail-closed 用例），不会伪造成功。
