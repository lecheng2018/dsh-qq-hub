# K-03D 旧实现删除执行清单（源码删除已实施，发布验收未完成）

> 当前基线：main `aeda91f` 之后的 K-03D 任务分支。owner 已于 2026-11-13 明确要求继续删除旧内核，覆盖源码、测试和未来安装包中的旧实现；不覆盖真机发布或现网升级。

## 1. 发布门禁状态

- [ ] M5-1～M5-6 对删除后的固定提交逐项完成并回填，OneBot unknown 不再挂账。
- [ ] 真实 OneBot dryRun 全矩阵零实发，唯一物理写者确认。
- [ ] 小流量实发、至少 72 小时观察和固定旧包回滚演练完成。
- [ ] 删除后安装包在隔离 DSH profile 重新安装并通过 host smoke。
- [x] owner 明确批准旧实现和旧 SQLite 离开发布包。

源码删除可以先于上述真机验收进行；未完成项不得被源码测试或 CI 替代，也不得据此发布或升级现网。

## 2. 已删除实现

- `src/chat/hub.js`
- `src/host/pipeline.js`
- `src/kernel/legacy-fallback.js`
- `src/features/memory-sqlite.js`
- 旧管道专属装配件：`compose`、`context`、`ctx-store`、`dispatcher`、`mw-acl`、`mw-aggregator`、`mw-command-router`、`mw-dedup`、`mw-egress`、`mw-egress-cutover`、`mw-memory`、`mw-persona`。

只测上述旧实现的专项测试同步退出；有效用户行为已改挂当前核心或独立当前服务，不以删除断言代替验证。

## 3. 保留的当前实现

- `src/kernel/mw-ratelimit.js`：当前核心入站限流；`mw-tracing.js` 是其共享依赖，二者有独立当前测试。
- `src/kernel/modular-contracts.js`：当前 ChatKey 与回合契约。
- `src/host/current-hub.js`、`shared-outbox.js`、`hub-egress.js`：当前冻结 facade 与唯一出口。
- 当前聊天、会话、媒体、回复、Outbox、权限参与者和系统回合服务。
- `scripts/migrate-memory-markdown.js` 及静态旧库迁移夹具：仅迁移入口使用 `node:sqlite`，不 import 旧后端。

`test/k03d-delete-plan.test.js` 同时检查生产依赖图和文件存在性，防止旧实现恢复或当前共享文件被误删。

## 4. 行为转换记录

- 最近媒体、聊天列表、聊天流水改挂当前核心、当前 facade 和独立服务。
- 富媒体顺序、文件与语音 fallback、unknown、dryRun、身份闸改挂 `createModularCore().services` 与 Shared Outbox。
- 工作区、视觉、引用、人设、模型、时间、报告和权限架构断言改为检查当前归属。
- 限流和 tracing 保留直接针对当前中间件的测试，不保留旧 compose/context 依赖。
- 旧 hub 的鱼群密度、pair 对聊冷却、主人豁免和鱼叫人规则补入当前群回复闸，避免删除时丢失安全行为。
- 旧 SQLite 直接测试退出；迁移器及 Markdown 主库测试继续运行。

## 5. 部署与回滚

- `scripts/deploy-client.sh` 已改复制当前核心文件，并将目标目录旧实现精确移动为带时间戳的退役备份；不整目录删除 kernel。
- 回滚只使用固定旧安装包，不设置旧 flag。代码回滚不自动回滚 Markdown 数据；恢复旧包前必须停写并核对升级前备份。
- 真机安装、fnOS 功能矩阵、72 小时观察及发布批准仍属 K-03E/M5，不在本源码删除 PR 中冒充完成。

## 6. 验证要求

1. 全量测试、扩展测试、lint 和打包检查通过。
2. 安装包清单不含旧内核或旧 SQLite，包含当前 facade、Outbox 和迁移器。
3. 在隔离目录解包后执行真实 host smoke；生产 import 图无旧实现。
4. 真机验收完成前不发布、不升级现网。
