# 开发指南

本文面向 QQ Hub 插件核心、面板和扩展模块的维护者。用户安装与运行方式见 [README](../README.md)、[使用手册](USER-MANUAL.md) 和[配置参考](CONFIGURATION.md)。

## 环境与本地验证

项目使用 Node.js 原生测试运行器，最低版本为 `22.13.0`。从仓库根目录执行：

```bash
npm ci
npm ci --prefix extensions/tieba-reader
npm run lint
npm run test:all
npm run build:client
git diff --exit-code -- client/client.js
npm run pack:check
npm run benchmark
npm run smoke:pack
```

`npm test` 会先构建面板，再运行 `test/**/*.test.js`；`npm run test:extensions` 单独运行贴吧扩展测试。单测可直接运行 `node --test test/<name>.test.js`；涉及面板产物的测试前先运行 `npm run build:client`。面板源文件在 `client/src/`，`client/client.js` 是提交的构建产物；编辑面板后执行 `node scripts/build-client.mjs`，持续预览可用 `node scripts/build-client.mjs --watch`。

测试和基准必须使用合成账号、fake DSH / mock OneBot 和独立临时目录。不得将个人 QQ 数据、生产 `config.json`、Cookie 或令牌复制进工作区、fixture、日志或 CI artifact。确需配置数据目录时，使用全新的临时目录并在测试结束后清理。模拟测试与 `dryRun` 不是通用副作用沙箱，测试仍需检查是否发生了真实外部调用。

## 集成接口与稳定性

### DSH 宿主

`src/host.js` 导出的 `name`、`inject`、`apply(ctx)` 是 DSH 加载边界。宿主依赖、初始化顺序和卸载逻辑的变化要有宿主 fake 测试。插件返回值中的核心对象是进程内实现细节；除非单独写入契约和测试，不应当作第三方稳定 API。`ready` 表示插件启动流程完成，不代表 OneBot 已连接。

### 扩展模块

模块作者应以 [模块 API](../src/modules/API.md) 和 `src/modules/qq-hub.d.ts` 为准，优先使用 `api.*` 和文档明确列出的内置模块导出。模块定义中的 `api` 字段声明所依赖的扩展 API 版本；运行时 `api.apiVersion` 可用于诊断。一个 API 版本内，已有方法的参数、返回值和语义保持兼容；不兼容变更应提升 API 版本并提供迁移说明。

模块数据写入 `api.dataDir()`，模块自带只读文件从 `api.dir` 读取，准备发送给 QQ 的文件放在 `api.workspaceDir()` 允许的路径下。定时器、事件、路由和注册项必须随模块 dispose/reload 清理；替换模块时不要缓存其他模块可能失效的导出。

`api.core`、`api.lib(...)`、`api.dsh`、直接底层 `api.onebot(...)` 调用、未文档化的模块导出、内部 hook 顺序和持久化文件格式属于低稳定性接口。依赖这些接口的代码需自行承担升级验证成本。除非契约明确支持，不要直接读写核心存储文件。

### HTTP 与面板

外部联动接口仅在 `bridge.http` 启用且配置非空 `bridge.token` 时开放；使用 `Authorization: Bearer <token>` 或 `X-QQ-Hub-Token` 认证。当前可确认的路径为 `/open/info`、`/open/send`、`/open/think`、`/open/call`、`/open/events`。请求字段、完整响应 schema、HTTP method 与状态码映射尚未形成完整公开契约；在补齐契约文档及契约测试前，不应把未记录行为视为稳定接口。

`/qq-hub/api` 面板接口的认证由 DSH/fnOS 或部署反向代理承担；Host/同源检查不能替代认证。模块自有面板接口应通过模块 API 注册，并限定在 `/qq-hub/api/ext/<id>/...` 前缀。不要将面板或联动接口直接暴露到公网，也不要在日志或响应中回显密钥。

## 消息、投递与存储约束

所有会产生 QQ 出站副作用的操作都应通过模块 API 或共享 outbox/send bridge。不要绕过统一出口直接调用 OneBot 写动作，否则可能绕过总开关、dry-run、授权复核、身份检查和投递台账。`unknown` 表示副作用结果不确定，不得盲目自动重试。

改变配置/存储结构时，提供可诊断、可重入的迁移，并测试迁移中断、重复运行和目标数据已存在的情况。迁移失败不得静默覆盖旧数据；需要回滚时，代码回退与数据恢复分开处理。模块加载失败、停止和热重载也要验证清理及恢复路径。

普通 CI 只运行模拟宿主和网关，不登录真实 QQ。真实 DSH / OneBot / QQ 的验收依照 [M5 runbook](refactor/m5-runbook.md) 执行，要求维护者明确批准、单一发送账号、独立测试数据和维护窗口；CI 通过不能替代真实环境验收。

## 基准测试

运行 `npm run benchmark` 可测固定合成 OneBot 消息经规范化、turn controller 和 fake outbox 到达模拟回执的耗时。默认 workload 为 300 条；可通过 `--iterations <数量>` 调整。脚本断言处理数、投递数、状态和 ID 唯一性，并输出 JSON：总耗时、吞吐、端到端 p50/p95/p99、RSS、Node 版本和提交号。使用 `--output <路径>` 可将结果另存为 CI artifact。

基准用于比较相同 runner、Node 版本和 workload 下的趋势，不代表真实 QQ/模型延迟。GitHub runner 性能有噪声，目前只把正确性作为门禁，不以单次吞吐数据阻断 PR。新增基准场景应固定输入和响应、明确计时边界，不把初始化和任意 `sleep` 计入热路径。

`npm run smoke:pack` 会生成 npm tarball，在系统临时目录安装并导入包入口，同时检查面板 bundle。它不使用仓库的 `node_modules` 作为 consumer，也不读取插件运行数据。

## CI 与发布

Pull request 必须通过 Verify：lint、主套件和扩展测试、面板 bundle 同步、包内容检查、benchmark 正确性及隔离 tarball smoke。性能 JSON 作为 artifact 留存。发布 tag 必须是 `v<package.json version>`；版本号、变更日志和打包资产需在发布 PR 中核对。真实环境灰度、流量验证和回滚演练按 runbook 分别审批。
