# RFC-0001 洋葱内核重构 · 落地映射（最终版，US-012 收口）

RFC-0001 §1.2 的结构诊断图与 §4 示例代码用的是**示意名**（onMessage/timers[uid]/loadMemory 等），
与 `src/chat/hub.js`（2148 行巨石）里的真实符号并不一一对应。本表按真实代码逐一对照，并收口
**最终落地状态**（Phase 0-3 全量、Phase 4 首步=US-012 文档/演练/配置化）。行号基线：
`mission/onion-refactor` @ US-012 提交（hub.js 全链 12 个 story **一行未动**，§1 行号对重构前后均有效；
host.js 行号为装配现状，会随后续 Phase 漂移，以符号名检索为准）。

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
