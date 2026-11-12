# K-03D 旧实现删除执行清单（筹备，未执行删除）

> 基线：`1.4.1-test.20261113.1` 与 main `4fdabdf`。本文只固定未来删除边界和验证方法，不表示 M5 或 owner 已放行。

## 1. 放行前不可缺少的证据

- [ ] M5-1～M5-6 对当前实现逐项完成并回填，OneBot unknown 不再挂账。
- [ ] 真实 OneBot dryRun 全矩阵零实发，唯一物理写者确认。
- [ ] 小流量实发、至少 72 小时观察和固定旧包回滚演练完成。
- [ ] 现网记忆/会话迁移及备份验收完成。
- [ ] owner 单独书面批准旧实现和旧 SQLite 离开发布包。

这些条件未满足前，不执行第 4 节的删除动作。

## 2. 删除候选（仅在放行后）

生产实现：

- `src/chat/hub.js`
- `src/host/pipeline.js`
- `src/kernel/legacy-fallback.js`
- `src/features/memory-sqlite.js`

旧管道专属装配件：

- `src/kernel/compose.js`
- `src/kernel/context.js`
- `src/kernel/ctx-store.js`
- `src/kernel/dispatcher.js`
- `src/kernel/mw-acl.js`
- `src/kernel/mw-aggregator.js`
- `src/kernel/mw-command-router.js`
- `src/kernel/mw-dedup.js`
- `src/kernel/mw-egress.js`
- `src/kernel/mw-egress-cutover.js`
- `src/kernel/mw-memory.js`
- `src/kernel/mw-persona.js`

## 3. 禁止随旧文件误删

- `src/kernel/mw-ratelimit.js`：当前核心入站限流直接依赖。
- `src/kernel/mw-tracing.js`：上述限流实现的共享依赖。
- `src/kernel/modular-contracts.js`：当前 ChatKey 与回合契约。
- `src/host/current-hub.js`、`src/host/shared-outbox.js`、`src/host/hub-egress.js`：当前 facade 与唯一出口。
- `src/chat/workspace.js`、`group-state.js`、`reply*.js`、`outbox*.js`、`session-*.js`、`system-turns.js`、`turn-*.js`：当前聊天、会话与投递服务。
- `src/persona/personas.js`、`src/features/memory-*.js`（除明确删除的 `memory-sqlite.js`）：当前人格与记忆实现。
- `scripts/migrate-memory-markdown.js` 及静态旧库迁移夹具：迁移入口独立使用 `node:sqlite`，不 import 旧后端。

`test/k03d-delete-plan.test.js` 从 `src/host.js` 递归检查上述生产依赖边界，不能只靠全仓 import 次数为零判断安全性。

## 4. 测试处理清单

### 4.1 直接旧实现行为测试

以下文件需先逐项核对当前核心已有覆盖，再转换有效断言或退出旧实现测试，不能仅为变绿删除行为：

- `recent-media.test.js`
- `known-chats.test.js`
- `selfcheck-regressions.test.js`
- `group-deliver-order.test.js`
- `modular-delivery-legacy.test.js`

重点保留：媒体恢复与卸载、聊天列表、回复顺序、主人权限、文件与富媒体、未知状态不重试。

### 4.2 旧管道专项

以下测试随对应实现逐项评审退出；其中可复用的安全语义必须先迁移到当前核心测试：

- `kernel-legacy-fallback.test.js`
- `kernel-egress-cutover.test.js`
- `kernel-tracing.test.js`
- `kernel-context-mw.test.js`
- `kernel-command-router.test.js`
- `kernel-ingress-guard.test.js`

### 4.3 旧 SQLite 专项

- `memory-sqlite-store.test.js`：旧事实后端直接测试，随后端退出。
- `memory-quality-round2.test.js`：只删除直接读取旧 SQLite 实现的断言，保留 Markdown 主库有效行为测试。
- 迁移器测试与静态旧库夹具继续运行，验证迁移不会重新启用旧写者。

### 4.4 仅引用旧路径的架构/行为断言

以下文件应改为检查当前归属，而不是直接删除：

- 工作区：`workspace-shared`、`workspace-per-chat-architecture`、`workspace-delete`、`pure`。
- 入站与媒体：`inbound-audio-architecture`、`inbound-images-architecture`、`inbound-vision-architecture`、`quoted-messages-architecture`、`shared-recent-media-architecture`、`hub-image-helper`、`report-path`。
- 会话与模型：`models-apply`、`compact-model`、`persona-switch-reset`、`persona-edit-reset`、`token-guardian-fixes`、`clockline`。
- 出站与规则：`outbox-turn-atomicity`、`outbox-force-semantics`、`fish-pingpong`、`talk-rules`、`chat-log-architecture`、`m6-outbox-unification`。

## 5. 放行后的执行顺序

1. 按第 4 节完成测试转换，保留当前用户行为证据。
2. 删除第 2 节候选实现及已确认只测旧实现的测试。
3. 更新 `scripts/deploy-client.sh`：移除旧 hub/pipeline 文件，加入 `current-hub`、`outbound*`、`presence`、`turn-*`、`capture`、`system-turns` 等当前文件；部署后 grep 改为当前核心 smoke。
4. 更新 README、`flags.md`、`feature-matrix.md`、回滚说明和模块 API 文档，明确固定旧包回滚而非 flag 回退。
5. 运行全量、扩展、lint 和打包检查；包清单不得出现旧内核或旧 SQLite。
6. 在隔离目录安装固定 tgz，执行真实 host smoke；确认生产 import 图无旧实现、无旧监听器或旧文件写入。
7. 完成 fnOS/owner 验收后才允许发布与现网升级；失败时使用固定旧包恢复，代码回滚不自动回滚数据。

## 6. 当前状态

- 生产依赖图红线测试已加入，但尚未执行删除。
- M5、72 小时观察、现网迁移和 owner 最终批准仍未完成。
- `scripts/deploy-client.sh` 仍含旧文件，必须在正式删除的同一 PR 同步处理。
