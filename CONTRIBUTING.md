# 贡献指南

感谢为 DSH QQ Hub 提交改进。开始前请阅读 [开发指南](docs/DEVELOPMENT.md)、[模块 API](src/modules/API.md) 和适用的 [安全说明](SECURITY.md)。

## 开发流程

1. 从最新 `main` 创建短期分支，使用描述性名称，例如 `fix/outbox-timeout`、`docs/module-api`。
2. 保持改动聚焦。修复问题时补充回归测试；行为、接口、存储或安全边界变化时，在 PR 中说明影响和兼容方式。
3. 面板源代码在 `client/src/`。修改后运行 `npm run build:client` 并提交更新后的 `client/client.js`。
4. 提交 PR 前按 [开发指南](docs/DEVELOPMENT.md#环境与本地验证) 执行验证命令。CI 不可替代必要的真实环境验收。

## 代码与测试纪律

- 使用 Node.js `>=22.13.0`、ES modules 和仓库现有命名/格式习惯；尽量复用原生 Node 测试工具与现有 fake DSH / mock OneBot。
- 测试使用固定合成输入、独立临时目录和可控 fake 服务。不要依赖真实账号、外网服务、系统当前时间或未固定的随机值；如必须使用随机 ID，断言其语义而非具体值。
- 覆盖正常路径及拒绝、取消、超时、重复请求和未知结果等相关边界。凡是预期不发送的路径，都断言物理 gateway 调用数为零。
- outbox 投递状态必须诚实：没有网关回执时不能声称成功；结果未知时不做盲目重试。新增副作用要检查 dry-run 和权限语义。
- 模块新增监听器、定时器、路由或注册项时，测试 stop/reload/dispose 后清理及重复加载行为。
- 存储格式或迁移改动需说明旧数据兼容、备份与失败恢复方案，并提供迁移测试；不得覆盖用户模块或静默删除数据。
- 基准测试需固定 workload、计时边界和运行元数据。性能阈值只有在同一 runner 上有稳定重复基线后才能提议为阻断门禁。
- 日志、测试快照和 artifact 不得包含 token、Cookie、QQ 个人信息或未经脱敏的真实消息。

## PR 检查清单

PR 描述请说明问题/目标、实现概要和验证结果，并逐项确认：

- [ ] 新增或更新了相关测试；失败/取消/无发送路径有明确断言。
- [ ] `npm run lint`、`npm run test:all`、`npm run pack:check` 通过。
- [ ] 面板变更已运行 `npm run build:client`，产物与源码同步。
- [ ] 已运行 `npm run benchmark` 和 `npm run smoke:pack`，或说明未运行原因。
- [ ] 已说明公共 API/HTTP/模块兼容性及迁移影响；无影响也请明确写出。
- [ ] 已检查权限、外部副作用、日志脱敏和凭据处理。
- [ ] 需要真实 DSH/OneBot/QQ 验收时，已按 runbook 单独获得批准；未将生产凭据放入 CI。

涉及共享投递、权限、安全、存储迁移、模块接口和发布流程的 PR，应请求熟悉该边界的维护者审查。合并前 Verify 必须通过；不得通过删除/跳过相关测试来规避门禁。

## 发布

发布版本由 `package.json` 的 `version` 决定，正式 tag 使用 `v<version>`。变更需记录到 `CHANGELOG.md` 合适章节。只有获得维护者明确批准后才能创建版本 tag 或执行真实环境灰度；回滚需准备已验证旧包和独立数据备份。
