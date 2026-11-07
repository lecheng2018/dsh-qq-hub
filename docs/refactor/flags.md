# 灰度开关清单与安全姿态（M1-E）

> 任务书：M1-E「灰度开关安全姿态」。生产姿态：**全部开关默认关，legacy 默认路径可回滚，本阶段无人扩大灰度。**  
> 证据：`test/modular-flags.test.js`（fail-closed 边界）+ e2e/kernel-* 套件在默认关姿态下持续背书。

## 开关清单（2026-11-08 基线，package 1.3.64）

| 开关 | 默认 | 适用路径 | 读取时机 | 重启要求 | 非法/空值行为 |
|---|---|---|---|---|---|
| `FLAG_USE_PIPELINE` | **关** | host.js `dispatchEvent`：onebot 实时事件流走洋葱管道 vs 直调 legacy hub | 装配期一次（`isPipelineEnabled(process.env)`） | 改后需重启 | 关（fail-closed 回 legacy） |
| `FLAG_EGRESS_SHADOW` | **关**（live） | 管道出口切换的 shadow 双算比对；**仅在管道开启时有意义**（host.js 装配位 gating） | 装配期一次（`isEgressShadowEnabled`） | 重启 | live |
| `FLAG_INGRESS_AGGREGATOR` | **关** | 管道内的入口合流中间件（暂停版，透传）；**仅在管道开启时装配** | 装配期一次（`isIngressAggregatorEnabled`） | 重启 | 关（不装配） |
| `NEW_MEMORY_PIPELINE` | **关** | 管道内 persona/memory 装配接管 + contextProviders takeover；**仅管道开启时生效** | 装配期一次（`isNewMemoryPipelineEnabled`） | 重启 | 关（legacy provider 链） |
| `QQHUB_RL_CAPACITY` / `QQHUB_RL_REFILL_PER_SEC` | 缺省 30 / 5 | 管道限流桶参数 | 装配期一次（`ratelimitOptionsFromEnv`） | 重启 | 键不出现 → 工厂构造缺省；refill=0 合法（极端闸） |
| `QQHUB_RUNTIME_ENV` | 未设置 | runtime loader 环境剪枝声明（container/host），非灰度位 | 每次探测（detector 内缓存） | — | 未声明 → 事实探测 |

## 解析契约（四开关同款）

- 只认 trim + lowercase 后恰为 `'true'` / `'1'` 的值；`'false'`、乱值、空串、未设置一律关。
- 语义：**不确定就回旧路**（熔断语义）。非法值绝不半开。
- 测试：`test/modular-flags.test.js` 锁定上述边界 + 默认全关清单。

## 必测项与证据对应

| 任务书要求 | 证据 |
|---|---|
| flag-off 与基线一致 | e2e/chat-model/modules 等全量套件全部在默认关姿态下运行并通过（本阶段无任何 flag-on 生产路径） |
| 非法/空值 fail-closed 到已声明默认 | `test/modular-flags.test.js`（OFF_CASES 矩阵 ×4 开关 + 限流旋钮键不出现） |
| 切换不双发 | 开关只路由装配（legacy 直调 vs 管道），单写者：`dispatchEvent` 二选一；shadow 模式为显式开启的双算比对，不实发（`kernel-egress-cutover.test.js`） |
| 不存在私自扩大灰度 | 本阶段 0 个开关被打开；`FLAG_INGRESS_AGGREGATOR` 与 memory takeover 保持默认关（任务书点名项） |

## 回滚姿态

- legacy 默认路径 = flag 全关 = 与 1.3.64 发版行为一致；任何灰度开启后均可通过关闭开关 + 重启回到该路径。
- 配置面新增（M1-A）：`security.panel.allowedHosts`（面板 Host 白名单额外放行域名），非灰度开关，见 `docs/refactor/feature-matrix.md` §1。
