# RFC-0001 洋葱内核重构 · 落地映射（最终版，US-012 收口）

RFC-0001 §1.2 的结构诊断图与 §4 示例代码用的是**示意名**（onMessage/timers[uid]/loadMemory 等），
与 `src/chat/hub.js`（2148 行巨石）里的真实符号并不一一对应。本表按真实代码逐一对照，并收口
**最终落地状态**（Phase 0-3 全量、Phase 4 首步=US-012 文档/演练/配置化）。行号基线：
`mission/onion-refactor` @ US-012 提交（hub.js 全链 12 个 story **一行未动**，§1 行号对重构前后均有效；
host.js 行号为装配现状，会随后续 Phase 漂移，以符号名检索为准）。

**完整版 RFC**：`9e070faedb554b7e8e5d5033ff61aaad_dsh-qq-hub-architecture-refactor-rfc__1_.md`（889 行 / 40624 字节，2026-11-07 收到）。重构执行以先前的截断版（814 行）为基准，两版 §0–5 主体一致；差异为 §1.3 非目标补全 3 条、新增附录 A 配置字典与附录 B 60+ 函数权威映射矩阵。重构链与完整版核对**无冲突**，对齐注记见 §10。

> **本期边界（PRD 明确，先说结论）**：RFC §4 Phase 4 的**终局**——hub.js 归零、ModelInferenceExecutor
> 替换 legacy 终端、物理删除遗留代码、`v2.0.0-rc.x` 灰度——**不在本期**。本期交付的是绞杀者路线图的
> 「可发布收口」：文档、开关全清单、限流配置化、三态冒烟与回滚演练实证。hub.js 仍存活的职责清单见 §7。

## 0. 落地状态表（Phase × story × commit）

| Phase | Story | 内容 | commit | 生效开关 |
|:--|:--|:--|:--|:--|
| **P0 基础设施垫片** | US-001 | 洋葱内核 `compose` + `createContext`（纯库零接线） | `7170305` | — |
| | US-002 | 能力探测 `EnvironmentDetector` + 条件装载器 `ConditionalModuleLoader`（六道门禁、剪枝零执行）+ validateManifest 硬化 | `77e15bb` | —（装载期） |
| | US-003 | 遗留核心终端化 `createLegacyHubFallback` + 熔断开关 | `d758a5d` | FLAG_USE_PIPELINE |
| | US-004 | Tracing & Metrics 管道最外层打点 | `5e27ada` | FLAG_USE_PIPELINE |
| **P1 出口解耦** | US-005 | 出站 Dispatcher + 优先级队列（纯库） | `935671e` | FLAG_USE_PIPELINE |
| | US-006 | 出口后处理链：栈守卫防思考泄漏 + stripReasoning + 4000 字语义分条 | `b6f52b3` | FLAG_USE_PIPELINE |
| | US-007 | 出口切换：ALS + onebot 包装收口（三道安全闸之后）+ 边界 flush + shadow 双算 | `edee277` | FLAG_USE_PIPELINE / FLAG_EGRESS_SHADOW |
| **P2 入口解耦** | US-008a | compose abort **unwind 语义**（已派发中间件 bubble 回溯收尾——中断并合并的前提） | `5d03c91` | （内核语义） |
| | US-008b | 入口合流中间件 per-chat 窗口聚合 + busy steer | `47a94ab` | FLAG_INGRESS_AGGREGATOR（灰度默认关，理由见 §2） |
| | US-009 | 入口防御链：令牌桶限流 / ACL（复用 access.js，fail-closed）/ messageId 去重 + poke 归窗修复 | `d643b94` | FLAG_USE_PIPELINE |
| **P3 上下文装配** | US-010 | mw-persona 预取 + mw-memory 检索写 ctx.state + contextProviders 接管层 | `0c03f88` | NEW_MEMORY_PIPELINE（灰度默认关，缺口 A/B 见 §8） |
| | US-011 | 命令路由终端中间件：16 内置主人命令 router 直答，ext/边界形态透传 legacy | `47083db` | FLAG_USE_PIPELINE |
| **P4 首步（本期）** | US-012 | 文档收口（本表/README/CHANGELOG）、三态冒烟 + 回滚演练实证、限流旋钮 env 配置化 | 本提交 | （无新增灰度） |

**Phase 4 终局未在本期**：hub.js 归零、legacy 物理删除、录制回放 500 例基线与 `v2.0.0-rc.x` 灰度长稳
均为后续发布负责人的动作；下表 §7 的存活职责清单即终局作业面的起点。

## 1. §1.2 结构诊断图 ↔ 真实符号

| RFC 示意（§1.2） | 实际符号 | 位置（file:line） | 备注 |
|:--|:--|:--|:--|
| `onMessage(evt)` | `onMessage(event, opts)` | src/chat/hub.js:1307 | createHub 闭包内的真实事件入口，从 host 接线进来（见 §3）；`parseMessageEvent` 在 :1310 做 v11 报文解析（src/chat/inbound.js） |
| RFC §4 示例 `legacyHub.handleRawMessage(ctx.rawEvent)` | 同上 `onMessage`（另含 `onPoke` hub.js:1599 处理戳一戳） | src/chat/hub.js:1307 / 1599 | 示意名；实际终端入口**不止一个**，路由规则复刻 handleEvent（见 §3） |
| `timers[uid]` / `clearTimeout(...)` ← 防抖 | `pending` Map 内 `p.timer` + `clearTimeout` | src/chat/hub.js:1709（Map 定义）、1717（enqueue 装配）、1731/1738（清旧计时器+新 setTimeout(flush, min(wait,left))）、1745（flush 内清） | 键是 `chatId`（`private:<uid>`/`group:<gid>`），不是裸 uid；等待窗口按群/私聊分别取 `cfg.merge.waitSec/groupWaitSec/maxSec`（1735-1737） |
| `buffer[uid].push(evt)` ← 全局可变 | `pending` 条目里的 `p.texts/p.images/p.senders` | src/chat/hub.js:1719-1730 | 合流缓冲；另有群上下文环形缓冲 `groups.buffer(groupId)`（hub.js:1409 消费，src/chat/group-state.js 实现，append 在 onMessage 1319-1321）——两个"buffer"职责不同 |
| `mem = loadMemory(uid)` ← 记忆读 | 无独立函数：`contextProviders` → `mods.contextFor` 挂到 DSH 系统提示词 | src/chat/hub.js:546-559（挂载）、host.js（注入源，US-010 后为 `hubContextProviders`）、`memoryScore: use('memory').topicScore`（消费于 hub.js:1413） | 记忆检索/遗忘曲线在 features/memory.js（模块侧，`use('memory')`）；hub 只负责"挂载 + 打分入口"。**接管面已就位**：NEW_MEMORY_PIPELINE=true 时 provider 链由 ctx.state 缓存供给（§7 缺口 A/B） |
| `sys = PERSONA + mem.join() + ...` ← 人设+拼接 | DSH systemPrompt 变量/上下文注入：`qq_hub_persona` 变量 + `qq-hub-context` 上下文块 | src/chat/hub.js:529-540（人设遮蔽）、546-559（上下文拼装）；改写 hook：`hooks.prompt`（hub.js:1843-1851） | 不存在集中式 buildPrompt——拼装分散在 systemPrompt 注入（DSH 渲染时惰性求值）与交给她之前的 `hooks.prompt` 改写两处。mw-persona 为**预取+观测快照**，人设直读路径未动（hub.js 红线） |
| `res = await callLLM(sys, buffer[uid])` | `agent.followup(message)`（新轮）/ `agent.steer(message)`（插话） | src/chat/hub.js:1890 / 1887（上下文 pushToSession:1837；准入 admit:1813；后台轮 runSystemTurn 内 followup:1920） | LLM 由 DSH agent 会话承载（`agentFor` hub.js:350），无直接 HTTP 调用点；超时/取消语义目前确实缺（RFC 痛点属实，终局 executor 化的正题） |
| `for (part of split(res))` ← 分条 | `deliver(chatId, text, opts)` + `replyRules`/`parseReply` | src/chat/hub.js:833（deliver）、845-850（分条规则，src/chat/reply.js）、912-926（逐条发送循环） | 分条权威只有一处：规则（她写 `\|\|\|` 断句优先，字数兜底），1.3.43 起不再二次问模型。**管道开启态另有第二道**：mw-egress 语义分条（4000 字硬线），两条叠加语义见 US-006/007 留档 |
| `await send(part)` | `sendText/sendVoice/sendSticker/sendImage` → `sendSegments` | src/chat/hub.js:572/604/657/687/816/825 → 572 | 发送唯一收口 `sendSegments`（hub.js:572），`hooks.send` 拦截点在 :604；导出面 hub.js:2105。**已被收口**：flag-on 时 `hubOnebot` 包装在 `onebot.call` 层（三道安全闸之后）吞包入队 ctx.reply → Dispatcher 下发 |
| `await sleep(rand)` ← 副作用内联 | `bubbleDelay(下一条) * mood().delay` | src/chat/hub.js:925（import 于 :13） | 不是纯随机，是按下一条内容长度算的拟人间隔 × 心情系数。bubbleDelay→delayMs 的换算在装配层 `createEgressSendHook`（hooks.send 包装）记投递草稿，flag-on 投递缺省 `delayMs=0`（US-007 拍板，防双限速叠加） |
| `saveMemory(uid, ...)` ← 记忆写 | `logChat(chatId,'bot',said)` + `dsh.sessions.flush(agent.session)` | src/chat/hub.js:934（bot 发言写回，定义 :210）、1893（会话持久化） | 长期记忆蒸馏/遗忘归 features/memory.js（`use('memory')`）；hub 只写聊天日志与会话。仍存活于 legacy 终端内（§7） |
| `buffer[uid] = []` ← 竞态窗口 | `pending.delete(chatId)` | src/chat/hub.js:1750/1768（flush 各分支摘除） | 竞态确实存在：busy/running 两套状态（1711-1715）靠约定衔接；管道侧对位收编 = mw-aggregator（FLAG_INGRESS_AGGREGATOR 灰度中） |

## 2. 开关全清单（四个管道开关 + 两个限流旋钮）

**解析行为四开关统一**：值 trim 后忽略大小写等于 `'true'` 或 `'1'` 才为真；`'false'`、乱值、空串、
未设置一律 **false**（熔断语义：不确定就回旧路/用默认）。该口径已由测试钉住——
`test/kernel-legacy-fallback.test.js`（FLAG_USE_PIPELINE 8 值对照）、`test/kernel-egress-cutover.test.js`
（FLAG_EGRESS_SHADOW）、`test/kernel-context-mw.test.js`（NEW_MEMORY_PIPELINE 全表含非字符串值）、
`test/kernel-aggregator`/装配回归（FLAG_INGRESS_AGGREGATOR）。**全部 env 只在 host 装配期读一次
`process.env`，改动需重启进程**（开关翻转即"重启切换"，回滚演练实证见 progress US-012 段）。

| env 开关 | 解析函数（位置） | 缺省 | 作用 | 依赖关系 |
|:--|:--|:--|:--|:--|
| `FLAG_USE_PIPELINE` | `isPipelineEnabled`（src/kernel/legacy-fallback.js） | **关** | 总闸：开=onebot 实时事件流走洋葱管道（legacy hub 作终端）；关=handleEvent 直调旧入口，管道**一个组件都不装配**（与重构前逐字等价） | 其余三个开关的前提 |
| `FLAG_EGRESS_SHADOW` | `isEgressShadowEnabled`（src/kernel/ctx-store.js） | **关（=live）** | 出口双算观测态：旧通道照旧真发 + 新链入队算 hash，边界 flush 后逐条比对（mismatch 出 warn）；不开即切权态 live（吞包入队，Dispatcher 独占外发） | 仅 FLAG_USE_PIPELINE=true 有意义 |
| `FLAG_INGRESS_AGGREGATOR` | `isIngressAggregatorEnabled`（src/kernel/mw-aggregator.js） | **关** | 入口合流窗装配：per-chat 等待窗聚合 followers + busy steer。**默认关的实因**：legacy 核心仍自持 pending 合流，本层吞掉 followers 会让旧核心只看得到 lead（实测丢消息）；须等 Phase 4 终局把 hub 的 Ingress 职责 executor 化后再并进 FLAG_USE_PIPELINE（US-008b 灰度决策） | 双闸 `FLAG_USE_PIPELINE && 本开关` |
| `NEW_MEMORY_PIPELINE` | `isNewMemoryPipelineEnabled`（src/kernel/mw-memory.js） | **关** | 记忆装配接管：contextProviders 命中（ALS 有 ctx ∧ state 有装配记录 ∧ 开关开）时原 provider 链零调用、由 ctx.state 缓存供给。**默认关的实因**：§8 缺口 A/B，可默认开前不该开 | 双闸同上（host 装配 `usePipeline && 本开关`） |

| env 旋钮（US-012 配置化） | 解析函数 | 缺省 | 语义 |
|:--|:--|:--|:--|
| `QQHUB_RL_CAPACITY` | `ratelimitOptionsFromEnv`（src/kernel/mw-ratelimit.js） | **30** | 限流令牌桶容量（突发上限）。仅**正数**字符串形态生效；乱值/负数/0/空串/未设置 → 回构造缺省 |
| `QQHUB_RL_REFILL_PER_SEC` | 同上 | **5** | 每秒补令牌数。**非负数**合法（0=突发用尽后全拒的极端闸）；其余非法值同样回缺省 |

（`test/kernel-ingress-guard.test.js` 两条 env 覆盖用例钉住「合法生效 / 非法回默认」。）

## 3. 接线链现状（flag-on 最终拓扑）

```
src/onebot/client.js        onEvent(data)                 ← WS 收到原始事件
src/host.js                 handleEvent(ev)               ← 前置段：gapTracker.notePacket / seenIds.add
                                                            / mods.emit('onebot', ev) / dangerGuard.handleReply
        ├─ FLAG_USE_PIPELINE 关（缺省）：hub.onMessage(ev) / hub.onPoke(ev)   直走旧入口，管道零装配
        └─ 开：dispatchLegacyPipeline(ev)
             = legacyEventToEnvelope(ev) → createContext(envelope, 'onebot')
             → compose([
                 0 createTracingMiddleware            打点（US-004）
                 1 createRatelimitMiddleware          令牌桶（US-009；env 旋钮 QQHUB_RL_*，US-012）
                 2 createAclMiddleware                复用 access.js，fail-closed（US-009）
                 3 createDedupMiddleware              聊天域|messageId 复合键（US-009）
                 4 createEgressFlushMiddleware        边界 flush + Dispatcher drain（shadow/live）（US-007）
                 5 createEgressMiddleware             栈守卫 + stripReasoning + 分条（US-006）
                 6 pipelineCommandRouter              16 内置主人命令直答（US-011）
                 7 …(useIngressAggregator ? [aggregator] : [])                    （US-008b，灰度默认关）
                 8 …(memoryAssemblyOn ? [persona, memory] : [])                   （US-010，灰度默认关）
                 9 createLegacyHubFallback(hub)       终端：原事件引用送达 hub.onMessage/onPoke
               ])
        发送面收口（与上表正交）：flag-on 时注入 hub 的 onebot 是 createEgressOnebot 包装（call 层，
        在 模拟闸/总开关/试运行 三道安全闸**之后**）；hooks.send 换成 createEgressSendHook（记投递草稿）。
        Dispatcher 的物理出口 egressSender 吃**没被包装的**原 onebot——新旧通道不互相套娃。
```

**不随开关接管的路径**（flag-on 也走旧入口，终局再收）：

- backfill 补收：`hub.onMessage(it.event, { backfill: true, … })` 与 `triggerBackfill` 内 `hub.sendText`——
  带 legacy 专属 opts 的直调，不经管道；信封无法无损承载 opts，属终局 Ingress executor 化议题。
- `hub.*` 其余旁路入口（deliver/pushToSession/runSystemTurn/面板路由/调度器后台任务/B 站 duty……）：
  非"入站事件流"，与开关无关；其中发送若发生且 ALS 无 ctx（或本轮 flush 边界已过），**回落旧通道直发**
  ——宁可多发不静默丢（US-007 learnings 3）。
- handleEvent 前置段（gap 检测/去重登记/mods.emit/dangerGuard）：两态都原位先跑，管道只包住
  "交给旧核心的那一步"。

## 4. 职责归属速查（终版：谁已认领什么、什么还在 hub）

| 职责（真实位置） | 归属 | 状态 |
|:--|:--|:--|
| 事件归一化 / InboundEnvelope 物化（hub.js:1310 `parseMessageEvent`；临时版 legacyEventToEnvelope） | Protocol Adapter → Ingress | **半收编**：管道信封已由 kernel 承担；hub 内部 parseMessageEvent 仍是权威（终局上提） |
| seenIds 去重、dangerGuard（host.js 前置段） | Ingress 前置 | 原位保留（两态等价红线） |
| ACL / checkAllowed（access.js: 一份权威） | Ingress 守卫 | **已认领**（mw-acl 复用同一函数，flag-on 入口短路；旧核心复检兜底） |
| 限流防抖（RFC Debounce & Throttling） | Ingress 守卫 | **已认领 + 已配置化**（mw-ratelimit，QQHUB_RL_* env） |
| messageId 去重（重传） | Ingress 守卫 | **已认领**（mw-dedup，聊天域复合键） |
| 防抖合流 `pending/enqueue/flush`（hub.js:1709-1795） | Ingress Aggregator | **已建灰度**（mw-aggregator + busy steer；默认关，实因见 §2，终局并进主开关） |
| 人设/记忆装配（mount 529/546 + contextProviders + memoryScore） | Context Assembly | **接管面已就位**（mw-persona 预取快照 + mw-memory 检索写 state；NEW_MEMORY_PIPELINE 默认关） |
| 命令路由（onCommand 链、hub.js:1365-1376 主人命令分支） | Terminal Handler | **已认领**（mw-command-router：16 内置直答；ext/混段/提问等待/非主人透传 legacy，闸门保留第二权威；覆盖矩阵 progress US-011 段） |
| 推理调用 `agent.followup/steer`（hub.js:1887/1890） | 暂留 legacy 终端 | 终局 = ModelInferenceExecutor 替换（**不在本期**） |
| 分条发送 `deliver`+`sendSegments`+`hooks.send`（hub.js:833/572/604） | Egress → Dispatcher | **已切权**（flag-on live：onebot.call 收口入队，Dispatcher 独占物理外发；shadow 为观测态） |
| 记忆写回 `logChat`+`sessions.flush`（hub.js:934/1893） | Sink 侧写 | 仍在 legacy 终端内（发送收口不影响写回路径；终局 executor 侧评估） |

## 5. 内核契约速记

- `compose(middlewares)(ctx, tail?)`：double-next 熔断、PipelineError 包装（index 递增链 + Caused by:）。
  **abort 语义以 US-008a（`5d03c91`）为准**：abort 后**已派发**中间件的 bubble（next 之后代码）正常回溯
  收尾，未派发中间件两级都不进（US-001 的"abort 零 bubble"旧承诺作废）。这是 G2「中断并合并+丢弃未
  flush 回复」与守卫拒绝短路的前提。
- `createContext(envelope, driverId, parentTraceId?)`：meta 冻结 / reply 队列（浅冻结纪律，消费方只读）/
  state Map 键隔离 / signal。
- `Middleware = async (ctx, next) => {...}`，JSDoc 契约见 src/kernel/types.d.ts（编辑器消费，零编译）。
- 遗留终端：`createLegacyHubFallback(legacyHub)` + `legacyEventToEnvelope(ev)` + `isPipelineEnabled(env)`
  + `unwrapPipelineError(error)`（src/kernel/legacy-fallback.js）。
- 信封字段约定：`type` 由 post_type 归一（`message_sent`→`message`，细分看 `rawPayload.post_type`）；
  `rawPayload` 是原事件**引用**（不拷贝不冻结——旧入口有就地读取习惯）；`timestamp` 毫秒（v11 秒 ×1000）；
  缺失字段一律 `undefined` 不臆造。
- ALS（src/kernel/ctx-store.js）：legacy 终端在 `runWithContext(ctx)` 里调旧入口，`onebot.call` 收口包装
  与 hooks.send 草稿层据此认领本轮 ctx。**中间件在 hub 公开方法里要触发收口必须自包 ALS**（US-011 硬前提）。
- 消费语义三态（Dispatcher）：live 成功排空→clear（失败项不回流）；shadow 成功→不动队列（旧通道还要吃）；
  abort→clear + dropped 计数。

## 6. 无头 NAS 条件装载（RFC §5，US-002，速记）

`src/runtime/environment-detector.js` + `src/runtime/module-loader.js`：冷启动按六道门禁（平台→display→
Docker→envVars→内存→customDetector，严格短路次序）剪枝 GUI/原生模块，**被剪模块 entrypoint 零执行**；
manifest 契约见 `src/runtime/types.d.ts`。指引详见本表与 README「RFC-0001 洋葱内核」节。

## 7. hub.js 仍存活的职责清单（本期边界 = Phase 4 终局作业面）

flag-on 时 legacy hub 是管道**终端**，以下职责全部仍在 hub.js 闭包内运行（红线：本期一行未动，
全部 12 story 实证）。每条标未来归宿——`executor 化`（终局 ModelInferenceExecutor/装配层接管）、
`继续注入面接管`（host 注入点扩面，hub 不动）、`保留`（本就是 hub 的合理内核）：

| # | 存活职责 | 位置 | 现状与本期边界 | 归宿 |
|:--|:--|:--|:--|:--|
| 1 | LLM 推理调用（followup/steer/admit + 会话轮状态机） | hub.js:1887/1890/1813 | 管道无取消通道：aggregator 的 steer **打断不了进行中的推理**（G2 诚实边界）；超时语义缺失仍在 | **executor 化**（终局核心命题：ModelInferenceExecutor 替换整个 legacy 终端） |
| 2 | 提示词组装主体（systemPrompt 变量挂载 + hooks.prompt 改写 + mount 遮蔽） | hub.js:529-559/1843-1851 | 人设/上下文**数据面**已被 persona/memory 预取接管，**文本面**仍由 hub 直读拼装；接管命中时挂载循环照跑、数据换供 | **继续注入面接管**（装配层吃下 prompt 文本面属终局；缺口 §8-A/B 先行） |
| 3 | DSH 会话持有与 steer（agentFor/sessions/pushToSession，sessionId 生成于 hub 闭包） | hub.js:350/1837/1893 | 中间件拿不到 DSH 会话 id → 接管态 speakersOf 档案子块为空（缺口 B） | **executor 化**（会话管理成为执行器一等公民，sid 由装配层自持） |
| 4 | 群策略/群配额（decideGroupReply + groupQuota 计数 + mood/插话概率） | hub.js:1415 起 + group-policy.js | 入口 ACL 只承载 cfg.allow 白名单粗筛；回复策略刻意不前置（双判定会消耗两次随机数，US-009 移交）；限流双闸保守叠加（delayMs=0 让位） | 短期**保留**；终局若 dispatcher 单点限速拍板，配额计数迁 dispatcher 侧 |
| 5 | bubbleDelay 打字估时计算 | hub.js:925 + reply.js | flag-on 投递草稿换算已在 hooks.send 包装层（createEgressSendHook 记 delayMs），**换算消费**在 Dispatcher shaping；缺省 delayMs=0 = 整轮齐发（US-007 行为变化） | **executor 化**（节奏策略归 Dispatcher 单点后 hub 侧让位） |
| 6 | 记忆写回（logChat 聊天日志 + sessions.flush 会话持久化）+ memoryScore 打分入口 | hub.js:934/210/1893/1413 | 读侧已有接管面（检索装配写 state），写侧完全在 legacy 终端内 | **executor 化**（Sink 侧写归 Dispatcher/executor，US-007 预留评估） |
| 7 | 主人命令闸门（hub.js:1350-1376：recentMedia/questions 前置消费 + onCommand 复检） | hub.js | router 已直答 16 内置；闸门保留为**第二权威**：透传形态复检 + handler 半途抛错的兜底复检执行（已知副作用重复窗口 §8-C） | **继续注入面接管**（ext 命令矩阵列 + 复检去重化，终局前不动） |
| 8 | Ingress 逐事件预处理（parseMessageEvent 全套 msg 归一化、groups.buffer、媒体暂存） | hub.js:1310-1330 | 管道信封是浅适配；ext 命令/混段透传的根因就是这套归一化没上提 | **executor 化**（parseMessageEvent 上提 kernel，矩阵 ext 列转适配层接管，US-011 预留） |
| 9 | backfill 补收链路（selectBackfill + hub.onMessage(opts)+sendText） | host.js:160/179/183 | 不经管道的旁路入口（legacy 专属 opts） | **保留**（旁路与开关无关）或随 #8 一并 executor 化，终局拍板 |
| 10 | 面板 API/本地路由/SnowLuma 生命周期/危险拦截等 host 侧一切 | host.js/local/panel | 与事件管道正交，两态共用 | **保留**（不在洋葱拓扑内） |

## 8. 已知缺口清单（灰度位默认关的实因，终局验收项）

- **A（NEW_MEMORY_PIPELINE）**：`mods.contextFor` 聚合**多模块** api.context（memory/mood/token-guardian/
  group-admin/multi-parser），mw-memory 只装 memory——接管命中时其余模块贡献一并被缓存替换。
  全量装配接管（或收窄接管面）前该开关不该默认开。（host/mw-memory 头注同记）
- **B（同上）**：接管缓存由中间件产出、拿不到 hub 的 DSH 会话 sessionId → 群聊 speakersOf「正在说话的
  人」档案子块在命中路径为空（legacy 回退分支不受影响，sid 由 hub 真传）。
- **C（US-011）**：router handler 半途抛错 → 回滚入队增量并透传 legacy **复检执行**，副作用类命令
  （/remember、/sing）在异常窗口理论有重复风险；零重复需复检前幂等化，终局评估。
- **D（US-007）**：无 ctx 的后台发送与晚到气泡**回落旧通道直发**——"出口收敛到 Dispatcher"并非 100%；
  对账 grep `egress: 收口待发` 与 `[egress-shadow]` 两条 debug。
- **E（G2 边界）**：管道层中断≠推理中断；steer 后新回合要等旧轮 release 才被旧核心受理（#1 取消通道）。
- **F（US-008b）**：aggregator 与 hub 自家 pending 双合流并存会实测丢消息，故 FLAG_INGRESS_AGGREGATOR
  默认关；并进主开关的前置 = §7-#8 Ingress 归一化上提。
- **G（RFC 原文验收未执行项）**：录制回放 ≥500 例基线、1000 QPS 穿透削减实测、`v2.0.0-rc.x` 7 天长稳——
  均属发布负责人动作，本期以 e2e 三态冒烟 + 回滚演练替代留档。

## 9. 回滚路径（已实证）

**全部四个开关 unset/置非真值 → 重启 = 回到重构前行为**（flag-off 装配旁路逐字保留，红线贯穿 12 story）。
US-012 演练（见 progress 留档）：同一 stub 事件序列在三个独立子进程按 flag-off → flag-on → flag-off
顺序跑（env 切换模拟重启），第一/三次旧通道发送调用序列**逐条全等**；第二次经 Dispatcher，外发文本
序列与语义与第一次一致。开关切换无需回滚代码或数据。

## 10. 完整版附录对齐（2026-11-07）

完整版 RFC（见文档头部引用行）相对截断版的新增内容——§1.3 非目标补全 3 条、附录 A 配置字典、附录 B
60+ 函数权威映射矩阵——与重构链（`mission/onion-refactor` @ US-012）逐项核对，**无冲突**。本节只记录
核对结论，不改变 §0–9 的任何决策与状态。

**10.1 §1.3 非目标（完整版补全 3 条）——全部天然满足**

| 非目标（RFC §1.3） | 满足方式（重构链现状） |
|:--|:--|
| 不更换底座 QQ 协议端（仅接口标准化，不重造网络协议） | 协议端不动：`onebot/client.js` 原样，只经 Transport.sender 注入标准化接口。 |
| 不动 Cordis 插件框架的根级上下文拓扑 | Cordis 根级拓扑未触碰，接线只在 host 装配与 kernel 组件内收口。 |
| 不强制重写 24 个业务功能模块的具体业务算法（向下兼容层平滑桥接） | 业务模块算法零重写：`createLegacyHubFallback` + provider 包装即向下兼容层本体。 |

**10.2 附录 A 配置字典——逐路径现状（五行全列）**

| 配置路径 | RFC 归属（附录 A） | 现状核对 |
|:--|:--|:--|
| `merge.*`（enabled / waitSec / maxSec） | 入口层 `Ingress.Debounce.*`（秒→毫秒） | **已迁**：mw-aggregator 实时读 `getConfig().merge`，秒→毫秒换算在位。 |
| `gateway` | 传输层 `Transport.Gateway` | **方向一致**：以 `Transport.sender` 注入实现。 |
| `reply.groupMaxChars`(40) / `reply.maxBubbles`(6) | 出口层 `Pipeline.ReplyFormatter.*` | **legacy 保留**：仍由 legacy 内 `reply.js` 分条消费——气泡级切分属 hub（replyRules），mw-egress 管协议级 4000 字分条；归属留待 Phase 4 装配一行接线。 |
| `security.identityGuard` | 出口层 `Pipeline.IdentityGuardMiddleware` | **已在防线、未成独立中间件**：guardOutbound 五出口在 `hooks.send` **之前**，pipeline 模式覆盖不旁路（US-007 verifier 实证）。 |
| `group.quota` | 传输层 `Transport.RateLimiter` | **双重限速语义**：hub 侧保留（Phase 1 保守拍板）+ Dispatcher shaping，叠加入口 mw-ratelimit（env 30/5）。 |

**10.3 附录 B 权威映射矩阵——性质声明与可对应行**

- **性质**：附录 B 的行级目标路径（`src/kernel/` 下 `ingress/`、`middlewares/`、`transport/`、`services/`
  的 `.ts` 文件）是 **Phase 4 终局 roadmap**；本期刻意止步 Phase 4 首步（US-012），不按矩阵铺文件。
- 已落地件可对应的行：

| 附录 B 旧函数 | 终局目标（附录 B） | 本期已落地件 |
|:--|:--|:--|
| `enqueue(...)` / `flush(chatId)` | `ingress/debounce.ts` | mw-aggregator（FLAG_INGRESS_AGGREGATOR 灰度，§2） |
| `deliver(...)`（拆条前置清洗与格式化） | `middlewares/reply-formatter.ts` | mw-egress（US-006） |
| `sendSegments(...)` | `transport/dispatcher.ts` | Dispatcher（US-005/007，flag-on live 态独占物理外发） |
| `admit(...)` / `release(...)`（会话锁） | `ingress/session-lock.ts` | busy-steer（mw-aggregator 内；G2 中断/取消边界已文档化，见 §8-E、§7-#1） |
| `checkIdentityLeak(...)` | `middlewares/identity-guard.ts` | guardOutbound 既有防线（五出口 `hooks.send` 之前，见 §10.2 行 4） |

- **其余行**（Ingress 归一化与 preprocessors、Pipeline 装配类、Transport senders、Storage & State
  services 各表）＝ **Phase 4 终局任务清单**，后续按行核对推进；作业面起点见 §7 存活职责清单。
- **本仓政策**：仓库为 ESM JS——终局落地时该矩阵的 `.ts` 文件名一律转 `.js`。


## 11. review 修复回应清单（2026-11-07，修复批 `a15f53e`）

外部双模型审查报告 `dsh-qq-hub-onion-refactor-review.md`（审查对象为分支 `ae78ee05` 快照；修复批基线
`f34b1cb→a15f53e`，22 文件）。下表逐条对着 **a15f53e 真实 diff** 记录处置，不照 review 文本脑补；测试列
全部取自 `test/kernel-*.test.js` / `test/runtime-loader.test.js` 实际存在的用例标题，对不上号的留空。
编号沿用 review 自身体系：A2 小节在原文未编号，本表按小节次序记 A2-1…A2-6；B 节条目（原文编号 1–16）
与汇总表代号对照为 1–7→B-A1…B-A6+B#7、8–10→D1–D3、11–13→R1–R3、15→B-C1；报告顶层「C1. 出口与 legacy
fallback」一节审查超时缺失（US-003 补评），与 B 节 ACL 代号 C1 无关。

### 11.1 逐条处置总表（数据行 48 ≥ review 缺陷汇总表 14 条，B 节 16 项全覆盖）

| 编号 | 级别 | 处置 | 落点（文件） | 测试用例（实际标题） |
|:--|:--|:--|:--|:--|
| A1#1 onAbort 不释放在飞 next | P1 | **拒+取舍**（见 11.2-1） | compose.js 头注释 §2.2 按实况改写 | 契约钉死：abort 不强制作废在飞 next()——管道完成=已启动中间件真实结束（review A1#1 拍板） |
| A1#2 正常完成不卸载 abort 监听 | P1 | 已修（预 abort 不注册；完成/失败 finally 卸载） | compose.js | 监听器卫生：正常完成/异常完成后卸载 abort 监听；预 abort 不注册（review A1#2） |
| A1#3 abort 短路不推进游标，同层二次 next 放行 | P2 | 已修（每层独立 nextCalled 资格位，abort 短路同样消耗；全局游标降为第二重防御） | compose.js | 对抗：abort 短路后同层第二次 next() 仍被熔断（review A1#3：旧游标方案会放行） |
| A1#4 double-next 的 PipelineError.index 指向下游 | P2 | 已修（异常以调用者 currentIndex 构造，index=违规调用者） | compose.js | 对抗：同一层重复调用 next() 触发 double-next 熔断（A1#4 修复后断言 originalCause.index 指向调用者） |
| A2-1 inbound/rawPayload 深度不可变 | P1 | **拒+取舍**（同一性契约，见 11.2-2） | context.js 头注释留档 | inbound：原样引用驱动层信封，不做二次拷贝 |
| A2-2 reply.queue 暴露内部数组 | P1 | 已修（getter 返回冻结快照；配套 restoreFront/rollbackTo 正规 API 接管 deferred 归还与 router 回滚） | context.js；mw-command-router.js | queue getter 返回冻结快照：push/splice/length=0 一律失效（review A2 P1）；restoreFront/rollbackTo：正规 API 取代外部偷改（dispatcher deferred / router 回滚位） |
| A2-3 segments 只冻数组不冻元素 | P1 | 已修（enqueue 深拷贝+逐层冻结，非纯数据保留引用冻容器） | context.js | enqueue 深冻结：入队后改原段对象/原 data，队列内容不动（review A2 P1） |
| A2-4 外部取消信号未透传 | P1 | 已修（createContext 第 4 参 options.signal：父已 abort 出生即 abort、后续 abort 转发、本地 abort 卸载转发监听） | context.js | 父信号透传（review A2 P1）：createContext 第 4 参接上游 AbortSignal，断开即取消本轮 |
| A2-5 state 无命名空间隔离 | P2 | 已修=文档化约定（拍板：不引入第二容器；symbol/string 键天然隔离为契约，业务 string 键自带前缀，见 §5 内核契约速记） | context.js（实现未动） | state：symbol 与 string 同名键互不干扰 |
| A2-6 meta 冻结策略对未来扩展不安全 | P2 | 本批未动（review 自评「当前字段安全」，属未来扩展提示；给 meta 加引用型新字段时须同批深冻并补用例） | — | — |
| A3#1 runWithContext(null) 继承外层 ctx | P1 | 已修（改 ctxStore.exit(fn) 显式退出，后台无上下文任务不再投进别人的死队列） | ctx-store.js | ctx-store：runWithContext(null) 在 A 上下文内显式退出（review A3#1）；WeakSet 收口标记裸 ctx 也有效（A3#2） |
| A3#2 markContextFlushed 静默丢标记 | P2 | 已修（ctx.state 键改模块私有 WeakSet，裸 ctx/state 故障不再吞标记） | ctx-store.js | 同上（后半句） |
| A4#1 drain 结尾 clear() 吞 drain 期间新入队 | P1 | 已修（takeBatch：首个 await 之前同步「快照+clear」原子领取；新条目留队列归下一批；并发 drain 领不相交批次） | dispatcher.js | A4#1 drain 期间新入队的条目不被吞：归下一批（旧结尾 clear 连锅端已修）；快照纪律：drain 期间外部 enqueue 的新条目绝不进本轮（queue getter 是内部引用，先 slice） |
| A4#2 浅快照隔离不了 payload 篡改 | P1 | 已修（由 A2-2/A2-3 根治：深冻结+快照化；本模块全程只读纪律留档） | dispatcher.js（联动 context.js） | payload 全程只读：dispatcher 拿原件引用、条目从入队到消费逐字段不变 |
| A4#3 sleep 拒绝炸整批、已成功条目重发 | P1 | 已修（捕获后未尝试条目 restoreFront 回队头，计 deferred + infrastructureError；已发送绝不重放） | dispatcher.js | A4#3 sleep 拒绝：未尝试条目 restoreFront 回队列计 deferred，已发送绝不重放 |
| A4#4 限流状态只在单次循环 | P1 | 已修（实例级 lastSentAt + 单调钟跨 drain pacing；delayMs 显式覆写契约三选一拍板留档——cutover 路径 hub 自 pacing，覆写 0 是接线契约非绕限流） | dispatcher.js | A4#4 跨 drain pacing：上一条发出后的最小间隔对下一轮第一条同样生效 |
| A4#5 createdAt 次排序重排同优先级 | P2 | 已修（删 createdAt 次排序，稳定排序保入队序即 FIFO） | dispatcher.js | A4#5 createdAt 倒序不打乱同优先级入队序（FIFO 契约，删 createdAt 次排序） |
| A4#6 canonicalJSON 与 JSON 出站语义不一致 | P2 | 已修（先按 JSON.stringify 语义归一——函数省略、Date 走 toJSON、BigInt/循环抛错归调用方计失败——再稳定键排序） | dispatcher.js | ⑤：hashReplyPayload 只吃 target+segments——元数据、键序、段序无关性 |
| A4#7 gapFor jitter 突破声明边界 | P2 | 已修（jitter 后二次 clamp 回 [min,max]；构造参数 assertFinite/序校验；jitter 非法值取中位 0.5 不炸批） | dispatcher.js | shaping 参数构造校验：NaN/倒挂直接抛错（review A4#7 附带）；③对抗：估式先 clamp 后乘抖动系数（700 下限 / 4500 上限 / 满抖动 1.3），与 bubbleDelay 语义对齐 |
| B-A1（B#1） 合并信封与终端消费不是同一份数据 | **P0** | 已修（止损：聚合执行暂停，mw-aggregator 退化为逐事件透传，吞并语义下线） | mw-aggregator.js | 透传契约：每个事件都到达 next()，顺序=入队序，零吞并零 abort；不写聚合 state：AGGREGATION_KEY 永不落（旧吞并语义彻底下线） |
| B-A2（B#2） lead 取消连带销毁有效 follower | **P0** | 已修（同上：无窗可吞、无 follower 可陪葬；合流语义仍由 hub 内部 pending 提供） | mw-aggregator.js | 已 abort 的入站事件不下行（compose §2.2 边界语义保留） |
| B-A3（B#3） flush 与在飞登记空档，同 chat 可并发 | P1 | 已修（随暂停消除：透传版不开窗、不登记，空档不存在；恢复实现必须满足 11.3 前置③） | mw-aggregator.js | stats：aggregationSuspended=true，窗口/合流计数恒零 |
| B-A4（B#4） 已到期旧 timer 撤回不了 | P1 | 已修（随暂停消除：透传版零定时器；恢复前置④） | mw-aggregator.js | abort unwind 联动（聚合暂停版）：守卫层 abort 后各级两级不进、tracing 收尾 aborted、零定时器 |
| B-A5（B#5） timer/flush 异常留永久等待者 | P1 | 已修（随暂停消除：透传版无等待者、无 deferred 三路唤醒；恢复前置④） | mw-aggregator.js | 同上 |
| B-A6（B#6） dispose 不取消在飞任务 | P1 | 已修（暂停版 dispose：拒绝后续回合下行 + abort 全部 active 在飞 ctx，active 以 finally 诚实回收） | mw-aggregator.js | dispose：在飞 ctx 全部 abort(aggregator-disposed)；后续事件拒绝下行 |
| B#7 busy steer 输入继承（A 被抑制后 B 不带 A 输入） | 边界 | **roadmap**（透传版无 steer；「新输入替代旧输入」的回合输入继承语义须随聚合恢复一并设计，前置见 11.3） | — | — |
| B#14 判定异常不调 next | 已成立 | 确认非缺陷（维持现状，回归已钉） | —（mw-acl.js 未动此语义） | ACL：判定桩 reject/缺字段 → abort(acl)；桩抛错 → fail-closed 拒绝（拍板：权限防御异常不放行） |
| B-D1（B#8） 失败后缓存永久拦重传 | **P0** | 已修（inProgress 处理中键与 seen 成功缓存两层分离；成功且未 abort 才落缓存，失败/abort 重传可重新准入） | mw-dedup.js | dedup（review D1）：首次处理失败后重传可重新准入；成功后重传仍被拦 |
| B-D2（B#9） LRU 逐出在飞键→同消息并发 | P1 | 已修（在飞键独立 Set 不参与 LRU 逐出；has+add 之间无 await 构成原子准入点） | mw-dedup.js | dedup（review D2）：在飞键并发只放一个，且处理中键不被 LRU 逐出 |
| B-D3（B#10） 复合键缺边界编码/实例命名空间/缺字段策略 | P2 | 已修（键改 JSON 数组编码消歧义；群事件缺 groupId/私聊缺 userId → keyless 放行，不把不同事件强汇「-」域；capacity 收紧正整数）。跨实例命名空间→roadmap（11.4） | mw-dedup.js | dedup：跨聊天同 messageId 不算重传（聊天域复合键，对齐 seenIds 口径） |
| B-R1（B#11） 时钟回拨基线后退重复补令牌 | P1 | 已修（缺省单调钟 performance.now；注入时钟回拨时 effectiveNow=max(now, b.at) 基线不回退） | mw-ratelimit.js | ratelimit（review R1）：时钟回拨不后退基线，恢复不多发令牌 |
| B-R2（B#12） NaN 毒化桶；capacity<1 永不放行 | P1 | 已修（clock 非有限在改动桶状态**之前**抛错→外层 fail-open 计 errors 不毒化；capacity≥1、maxKeys 正整数构造校验） | mw-ratelimit.js | ratelimit（review R2）：NaN 时钟 fail-open 放行且桶不被毒化；capacity<1 构造拒绝 |
| B-R3（B#13） LRU 逐出重置额度，无总量防线 | P2 | 文档化+**roadmap**（逐出=新桶复活保留为资源防御取舍，注释留档；实例级总桶总量防线见 11.4） | mw-ratelimit.js（行为未动） | — |
| B-C1（B#15） owner 入口直通绕过群白名单 | P1 | 已修（补丁 D：isOwner 直通分支删除，owner 策略全权收回 access.js checkAllowed；入口层自此可独立作为权限边界） | mw-acl.js | acl（review C1 加严三面）：缺配置拒绝、群事件缺 groupId 拒绝、缺 sender.userId 拒绝 |
| B#16 需补齐的信任边界（非 message 放行/kind 臆断/cfg 缺失） | 补充项 | 已修（非 message 放行理由改注「对应处理器执行权限检查」；subType=group 缺 groupId 直接拒；cfg/信封/userId 缺失一律 fail-closed 拒绝） | mw-acl.js | 同 B-C1 行；ACL：defaultAclDecision 独立可用——非 message 放行、无 sender 私聊判白名单外 |
| B-O1 inFlight/pendingTimers 指标不真实 | P2 | 已修（暂停版诚实观测：stats.inFlight=active.size 为实际在飞数，windows/pendingTimers 恒 0，aggregationSuspended 旗标显式暴露暂停态） | mw-aggregator.js | stats：aggregationSuspended=true，窗口/合流计数恒零 |
| C1 出口与 legacy fallback | — | **审查超时缺失**，未出结论；US-003 补评，本批未对其预设处置 | — | — |
| C2#1 wrapper/dispatcher 模式错配双发 | P1 | 已修（createEgressOnebot 非法 mode 构造即抛 TypeError，杜绝静默回 live；host 装配两处同源 egressMode） | mw-egress-cutover.js | C2#1 模式校验：createEgressOnebot 非法 mode 构造即抛，杜绝 wrapper/dispatcher 错配双发 |
| C2#2 整轮边界批量外发 + deferredOk 伪 message_id 被下游消费 | P1 | **roadmap**（Phase 4 待办，见 11.2-3/11.4；本批刻意不动 flush 边界，不留「已解决」假象） | — | — |
| C2#3 内层抛错：已受理条目留死队列、ctx 不收口 | P1 | 已修（catch：markContextFlushed + 清空队列计数告警 + 原样上抛；刻意不放进 finally——清洗中途失败的内容不发脏话） | mw-egress-cutover.js | C2#3 内层抛错：markFlushed + 队列清空计日志 + 原样上抛，不留死队列 |
| C2#4 「ctx 已收口」后晚到任务直发绕过出口策略 | P1 | **拒+理由**（现设计=回落旧通道直发是刻意保投递——ctx-store.js 头注释契约「宁可多发一条，也绝不把消息静默吞在死队列里」；该回落同时是 §8-D 留档缺口，收敛属 Phase 4） | ctx-store.js 头注释；mw-egress-cutover.js（行为保留） | ⑦ flush 之后晚到的发送回落旧通道直发，绝不落进已排空的队列（防静默丢消息） |
| C2#5 上传任意异常都 base64 重传→回包丢失时双份上传 | P1 | 已修（isConfirmedPathReadError 白名单：仅结构化「路径读不到」信号回退重传；超时/连接重置/鉴权明确排除、直接上抛计 failed） | mw-egress-cutover.js | C2#5 上传回退白名单：仅确认的路径读取失败才转 base64 重传；超时/鉴权直接上抛 |
| C2#6 delayMs 与旧路径逐条等价未被证明 | P2 | 部分修+契约文档化（shadow 不真睡不消费队列——比对不需要 pacing；live 侧 delayMs 显式覆写语义与「cutover 路径 hub 已自 pacing」写进 gapFor JSDoc，等价性由 e2e 三态冒烟背书而非单测逐证） | dispatcher.js | ③：间隔 = delayMs 覆写优先，否则 typing 估式；首条不等待、gap=0 不产生 sleep；⑤：shadow 不调 sender、hash 稳定可查、成功排空不动队列；live 不走 hash 记录路径 |
| C2#7 shadow 旧通道 hash 发送前记录，失败也显示匹配 | P2 | 已修（账本带 status，failed/pending 不入比对样本，oldFailed 单独计数告警） | mw-egress-cutover.js | C2#7 shadow 账本带状态：失败请求不计入比对样本 |
| C3#1 isDocker 探测失败缓存成「不在容器」 | P1 | 已修（三态 true/false/null：未知≠安全，allowDocker:false 门禁必须 ===false 才放行；QQHUB_RUNTIME_ENV=container/host 部署声明最高优先；cgroup v2 假阴形态不再当否定证据；未声明容器约束的模块不再白耗 fs 探测） | environment-detector.js；module-loader.js | isDocker 抗炸（review C3#1 三态）：非 Linux 平台确证 false；Linux 证据链全断返回 null（未知≠安全）；门禁3（C3#1）：allowDocker:false 的模块遇「未知」也剪枝；未声明的模块不触发探测；部署声明覆盖（C3#1）：QQHUB_RUNTIME_ENV=container/host 直接定论，优先于 fs 探测 |
| C3#2 显示变量假阳性；isFnOS 未参与门禁 | P1 | 已修（manifest 新增 requiresGUI 政策位：声明件在 fnOS、容器、容器状态未知时一律剪枝，customDetector 不得反向放行——部署政策不是模块意见） | module-loader.js；types.d.ts | requiresGUI 政策位（C3#2）：fnOS/容器/未知一律剪枝，customDetector 不得反向放行 |
| C3#3 内存门禁不校验阈值/探测结果，NaN 静默放行 | P2 | 已修（探测抛错或非有限值按**拒绝**：配了要求拿不到事实=门禁失效，NaN<阈值恒 false 的静默绕过封死） | module-loader.js | customDetector 抛错只剪该模块、不炸整批（C3#4）；内存探测失败按拒（C3#3） |
| C3#4 「整批预检不留半装载」承诺不成立 | P2 | 已修（validateManifest 预检补全 requiredEnvVars/deniedEnvVars/customDetector/allowDocker/requiresGUI/minFreeMemoryBytes/entrypoint 字段校验，坏配置在任何 entrypoint 执行前整批拦下；customDetector 探针抛错只剪该模块不再拖死冷启动） | module-loader.js | manifest 预检补全（C3#4）：坏配置在任何 entrypoint 执行前整批拦下；customDetector 抛错只剪该模块、不炸整批（C3#4）；内存探测失败按拒（C3#3） |

### 11.2 三项设计取舍（如实记录，不粉饰成「已修」）

1. **A1#1：abort 不强释在飞 next()——完成契约选「真实完成」。** review 提供的补丁（race 释放等待）与
   「管道返回=所有已启动中间件结束」的内核前提冲突，review 自己承认：「『所有中间件收尾完成』和
   『无条件快速完成』不能同时保证」。本管道选择前者：abort 只短路**新的** dispatch 调用，已在飞的
   dispatch Promise 等内层真实 settle 后 bubble 正常回溯；「内层永不 settle」由内层自带超时兜底
   （legacy 终端由 LLM 层超时），abort 后内层迟到 reject 时错误照常上抛（错误语义优先）。头注释 §2.2
   已按此实况改写，compose 回归测试「契约钉死：abort 不强制作废在飞 next()——管道完成=已启动中间件
   真实结束（review A1#1 拍板）」把两种时序钉死。**代价如实**：下游挂死且无超时的场景，abort 不能
   让管道返回——这是选择不是遗漏。
2. **A2-1：rawPayload 不深拷贝、不深冻结——legacy 同一性契约。** legacy 终端与 backfill 记账依赖
   `ctx.inbound.rawPayload === 原事件对象` 的引用同一性（§5 信封字段约定：不拷贝不冻结，旧入口有就地
   读取习惯）；深拷贝破坏同一性、深冻结可能踩旧核心就地写习惯。取舍换向：信封壳、segments、reply 条目
   全量深冻（A2-3），消费侧（dispatcher）全程只读纪律留档（A4#2），把「篡改防线」从入站信封挪到出站
   缓冲。该契约由 context 回归「inbound：原样引用驱动层信封，不做二次拷贝」持续钉住。
3. **C2#2：checkpoint flush + 假 message_id 的下游消费改造 = Phase 4 待办，本批刻意不动。** review 明说
   「这需要调整旧入口或发送接口，不能靠修改 deferredOk() 的字符串解决」——checkpoint flush（业务边界显式
   flushPending、不收口）与真实投递回执契约（`{ queued: true, deliveryId }` 替代伪成功回包、要真实
   message_id 的调用等真实发送）都在 legacy 终端替换（llm-invoker 化）的作业面上，本期红线（hub.js 零
   改动）内不可达。已列 roadmap；当前 live 态的「整轮结束批量外发」行为仍是 §7/CHANGELOG 留档的行为变化。

### 11.3 聚合重新启用前置条件（review B 节五条原样收录，当前 0/5 达成）

写在 mw-aggregator.js 头注释，缺一不得恢复吞并实现；恢复前须先做 shadow 合流（只记批次不吞输入），
批次完整性/顺序/取消语义与终端消费比对一致后才灰度：

1. 终端直接消费聚合批次（Phase 4 llm-invoker 化后由管道组装回合输入），或提供经协议验证的多消息适配器
   （rawPayload 重建含 senders/引用/附件）；
2. 每个成员事件独立的有效性与完成状态（lead 取消不得销毁 follower）；
3. flush 同步阶段建立同 chat 执行占位（消除窗口删除与在飞登记间的空档）；
4. timer generation 检查；任意异常路径所有等待者都能收敛；
5. dispose 覆盖排队+执行中的全部任务。

达成度 **0/5**：暂停版的 dispose-abort-in-flight 只是透传实现自建的防线，不构成任何一条「聚合实现」的达成
证明——恢复吞并时五条都得由新实现自己满足。

### 11.4 roadmap 行（本批明确不做的，按此四处留档）

| 项 | 来源 | 归属 |
|:--|:--|:--|
| checkpoint flush + 投递回执契约（真 message_id） | C2#2 | Phase 4 终端替换（见 11.2-3） |
| busy steer 回合输入继承（替代=输入继承，不是只抑制回复） | B#7 | 随聚合恢复一并设计（前置 11.3） |
| 限流实例级总桶（逐出重置额度的总量防线） | B-R3 | 灰度前评估；多实例部署另需跨实例配额 |
| dedup 跨实例持久化幂等键（进程内 seen/inProgress 不保证跨实例幂等） | B-D3 + review 八节灰度注 | Phase 4 存储作业面 |

**遗留观察**：B 节七张「可直接落地补丁」A/B/C/D 中，A（聚合暂停+卸载取消）、B（处理中/成功缓存分离）、
C（单调钟不回退基线）、D（owner 收回权威判定）全部按仓内语境适配落地；与本表口径差异仅在 R3（补丁 C
未含总量防线，review 亦自评「已知设计取舍」）。e2e 唯一联动改动：PIPELINE 态 issue #74 用例读取时机
改为等待落线再断言（A4#4 pacing 的预期后果，断言语义未松，见 US-001 留档）。

### 11.5 补评新增 roadmap（2026-11-07 US-003 补评 §五；本批只入账，不动代码语义）

补评报告：`reports/2026-11-07-dsh-qq-hub-C1C-补评.md`（计数 P0=0 / P1=4 / P2=5）。其中轻量防线与观测
诚实化已随 US-003b 落地（F4/F5/F1-a/F8，见 CHANGELOG P5「补评即修」）；下列三项涉 hub/装配语义，挂账留档：

| 编号 | 内容 | 爆点引用（补评 §五） |
|:--|:--|:--|
| **F1-b** | 气泡入队列的**根治**方案：round-aware flush（边界 flush 延后到本轮 `turn/end` 的 deliver 全部落地），或气泡 checkpoint 入队。「终端 await 整轮」要改 hub 语义（红线不动则留待 Phase 4 事件化收编）；把 egress 认领点下沉进 onebot client 内层违背 kernel 纯库原则——两条都需 controller 拍板 | §五-6（仅针对气泡投递路径；F1-a 已把实况写进装配日志与文档） |
| **F2** | **真实 id 回传契约**：deferred 成功形态改 `{ queued: true, deliveryId }` 并迁移消费点（hub.js:639 sentIds → 1151 repliedToBot 快路径、1089/1113-1114 quoteCache 失败缓存、1494 群 direct、profile/bili/voice 的「无回执=失败」判定），Dispatcher 不再丢弃网关真实 message_id | §五-5（与 Phase 4 同批；气泡入链前不做，F2 立即升主流量 P0） |
| **F3** | **队列支路重试策略**：drain 被网关拒（含 299/120 限流）现为零重试静默丢且调用方已拿假成功；需在 sender 层对齐 legacy `groupQuota` 65s 跨窗重试（2026-11-04 真实事故背书），并同批补 drain 前安全闸复核（F6 同一面） | §五-5（同批第三件事） |
