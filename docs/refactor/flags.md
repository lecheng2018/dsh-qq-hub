# 运行开关与安全姿态

> K-03D 起，生产只有当前核心一条事件链，旧 hub、pipeline、fallback 与旧灰度解析实现均已删除。回滚使用固定旧安装包，不通过环境变量重新启用旧实现。

## 生产装配

- 实时事件与补收：`SessionRegistry → TurnController → ContextAssembly → Shared Outbox`。
- `FLAG_MODULAR_CORE`、`FLAG_USE_PIPELINE`、`NEW_MEMORY_PIPELINE`、`FLAG_EGRESS_SHADOW`、`FLAG_INGRESS_AGGREGATOR` 不再是有效运行参数；设置后不会改变装配。
- 新核心初始化失败时插件装载失败并告警，不自动创建旧实例。
- 当前仍使用 `src/kernel/mw-ratelimit.js` 及其共享 `mw-tracing.js`；旧管道专属 `mw-*` 已退出源码和发布包。

## 保留的运行参数

| 参数 | 默认 | 当前用途 | 非法/空值行为 |
|---|---|---|---|
| `QQHUB_RL_CAPACITY` / `QQHUB_RL_REFILL_PER_SEC` | 30 / 5 | 当前核心入站限流桶 | 键不出现则使用构造缺省；`refill=0` 是合法极端闸 |
| `QQHUB_MAX_QUEUE` | 50 | 当前回合调度队列上限 | 非法值回默认值 |
| `QQHUB_RUNTIME_ENV` | 未设置 | runtime loader 环境声明，非灰度开关 | 未声明则事实探测 |

## 证据与回滚

- `test/k03c-assembly-exit.test.js`：生产源码不创建旧 hub、管道或读取旧灰度开关。
- `test/k03d-delete-plan.test.js`：旧实现文件已删除，当前共享依赖仍在生产图中。
- `test/r3-flagoff-regression.test.js`：旧 flag 关闭值不改变当前核心行为，也不创建旧 `sessions.json`。
- 回滚到 `v1.4.0-test.20261112.1` 等固定旧包前，先停写并核对数据备份；代码回滚不自动回滚数据。
