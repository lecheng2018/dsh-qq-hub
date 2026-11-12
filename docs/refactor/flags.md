# 运行开关与安全姿态

> K-03C 起，生产只有当前核心一条事件链，不再提供 legacy/pipeline 回退开关。回滚使用固定旧安装包，不通过环境变量重新启用旧实现。

## 生产装配

- 实时事件与补收：`SessionRegistry → TurnController → ContextAssembly → Shared Outbox`。
- `FLAG_MODULAR_CORE`、`FLAG_USE_PIPELINE`、`NEW_MEMORY_PIPELINE` 不再被 `src/host.js` 读取；设为任意值都不会创建旧 hub 或管道。
- 新核心初始化失败时插件装载失败并告警，不自动创建旧实例。
- `src/kernel/legacy-fallback.js`、`src/host/pipeline.js` 及部分 `mw-*` 文件暂时只供旧测试与共享纯函数使用，正式删除由 K-03D 按依赖清单执行，不能按目录一并删除。

## 保留的运行参数

| 参数 | 默认 | 当前用途 | 非法/空值行为 |
|---|---|---|---|
| `QQHUB_RL_CAPACITY` / `QQHUB_RL_REFILL_PER_SEC` | 30 / 5 | 当前核心入站限流桶 | 键不出现则使用构造缺省；`refill=0` 是合法极端闸 |
| `QQHUB_MAX_QUEUE` | 50 | 当前回合调度队列上限 | 非法值回默认值 |
| `QQHUB_RUNTIME_ENV` | 未设置 | runtime loader 环境声明，非灰度开关 | 未声明则事实探测 |

`FLAG_EGRESS_SHADOW` 与 `FLAG_INGRESS_AGGREGATOR` 的解析函数仍被旧中间件测试覆盖，但不参与生产装配。

## 证据与回滚

- `test/k03c-assembly-exit.test.js`：生产源码不创建旧 hub、管道或读取旧灰度开关。
- `test/r3-flagoff-regression.test.js`：旧 flag 关闭值不改变当前核心行为，也不创建旧 `sessions.json`。
- 回滚到 `v1.4.0-test.20261112.1` 等固定旧包前，先停写并核对数据备份；代码回滚不自动回滚数据。
