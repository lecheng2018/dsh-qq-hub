# RFC-0001 示意名 ↔ 实际符号对照表（US-003 / Phase 0）

RFC-0001 §1.2 的结构诊断图与 §4 Phase 0 示例代码用的是**示意名**（onMessage/timers[uid]/loadMemory 等），
与 `src/chat/hub.js`（2148 行巨石）里的真实符号并不一一对应。本表按真实代码逐一对照，
是后续各 US 认领职责、验收定位的唯一索引。行号基线：`mission/onion-refactor` @ US-003 提交
（hub.js 未动过，行号对重构前后均有效；host.js 行号为 US-003 装配后的现状）。

## 1. §1.2 结构诊断图 ↔ 真实符号

| RFC 示意（§1.2） | 实际符号 | 位置（file:line） | 备注 |
|:--|:--|:--|:--|
| `onMessage(evt)` | `onMessage(event, opts)` | src/chat/hub.js:1307 | createHub 闭包内的真实事件入口，从 host 接线进来（见 §3）；`parseMessageEvent` 在 :1310 做 v11 报文解析（src/chat/inbound.js） |
| RFC §4 示例 `legacyHub.handleRawMessage(ctx.rawEvent)` | 同上 `onMessage`（另含 `onPoke` hub.js:1599 处理戳一戳） | src/chat/hub.js:1307 / 1599 | 示意名；实际终端入口**不止一个**，路由规则复刻 handleEvent（见 §3） |
| `timers[uid]` / `clearTimeout(...)` ← 防抖 | `pending` Map 内 `p.timer` + `clearTimeout` | src/chat/hub.js:1709（Map 定义）、1717（enqueue 装配）、1731/1738（清旧计时器+新 setTimeout(flush, min(wait,left))）、1745（flush 内清） | 键是 `chatId`（`private:<uid>`/`group:<gid>`），不是裸 uid；等待窗口按群/私聊分别取 `cfg.merge.waitSec/groupWaitSec/maxSec`（1735-1737） |
| `buffer[uid].push(evt)` ← 全局可变 | `pending` 条目里的 `p.texts/p.images/p.senders` | src/chat/hub.js:1719-1730 | 合流缓冲；另有群上下文环形缓冲 `groups.buffer(groupId)`（hub.js:1409 消费，src/chat/group-state.js 实现，append 在 onMessage 1319-1321）——两个"buffer"职责不同 |
| `mem = loadMemory(uid)` ← 记忆读 | 无独立函数：`contextProviders` → `mods.contextFor` 挂到 DSH 系统提示词 | src/chat/hub.js:546-559（挂载）、host.js:364-366（注入源）、host.js:370（`memoryScore: use('memory').topicScore`，消费于 hub.js:1413） | 记忆检索/遗忘曲线在 features/memory.js（模块侧，`use('memory')`）；hub 只负责"挂载 + 打分入口" |
| `sys = PERSONA + mem.join() + ...` ← 人设+拼接 | DSH systemPrompt 变量/上下文注入：`qq_hub_persona` 变量 + `qq-hub-context` 上下文块 | src/chat/hub.js:529-540（人设遮蔽）、546-559（上下文拼装）；改写 hook：`hooks.prompt`（hub.js:1843-1851） | 不存在集中式 buildPrompt——拼装分散在 systemPrompt 注入（DSH 渲染时惰性求值）与交给她之前的 `hooks.prompt` 改写两处 |
| `res = await callLLM(sys, buffer[uid])` | `agent.followup(message)`（新轮）/ `agent.steer(message)`（插话） | src/chat/hub.js:1890 / 1887（上下文 pushToSession:1837；准入 admit:1813；后台轮 runSystemTurn 内 followup:1920） | LLM 由 DSH agent 会话承载（`agentFor` hub.js:350），无直接 HTTP 调用点；超时/取消语义目前确实缺（RFC 痛点属实） |
| `for (part of split(res))` ← 分条 | `deliver(chatId, text, opts)` + `replyRules`/`parseReply` | src/chat/hub.js:833（deliver）、845-850（分条规则，src/chat/reply.js）、912-926（逐条发送循环） | 分条权威只有一处：规则（她写 `\|\|\|` 断句优先，字数兜底），1.3.43 起不再二次问模型 |
| `await send(part)` | `sendText/sendVoice/sendSticker/sendImage` → `sendSegments` | src/chat/hub.js:657/687/816/825 → 572 | 发送唯一收口 `sendSegments`（hub.js:572），`hooks.send` 拦截点在 :604；导出面 hub.js:2105 |
| `await sleep(rand)` ← 副作用内联 | `bubbleDelay(下一条) * mood().delay` | src/chat/hub.js:925（import 于 :13） | 不是纯随机，是按下一条内容长度算的拟人间隔 × 心情系数 |
| `saveMemory(uid, ...)` ← 记忆写 | `logChat(chatId,'bot',said)` + `dsh.sessions.flush(agent.session)` | src/chat/hub.js:934（bot 发言写回，定义 :210）、1893（会话持久化） | 长期记忆蒸馏/遗忘归 features/memory.js（`use('memory')`）；hub 只写聊天日志与会话 |
| `buffer[uid] = []` ← 竞态窗口 | `pending.delete(chatId)` | src/chat/hub.js:1750/1768（flush 各分支摘除） | 竞态确实存在：busy/running 两套状态（1711-1715）靠约定衔接，Phase 2 合流中间件收编 |

## 2. 熔断开关（FLAG_USE_PIPELINE）语义

| 项 | 值 |
|:--|:--|
| 开关读取 | `isPipelineEnabled(process.env)`（src/kernel/legacy-fallback.js），host.js:403 装配期一次性读取；改 env 需重启 |
| 开启值 | 仅 `'true'` / `'1'`（忽略大小写与首尾空白）；`'false'`/乱值/未设一律 **false**（熔断语义：不确定就回旧路） |
| 关闭态（默认） | handleEvent 直调 `hub.onMessage(ev)`（host.js:252）/ `hub.onPoke(ev)`（host.js:257），**与重构前逐字等价**，管道不装配 |
| 开启态 | `compose([tracing 占位透传, createLegacyHubFallback(hub)])`（host.js:405-408）；事件经 `dispatchLegacyPipeline`（host.js:263）→ `legacyEventToEnvelope` 造信封 → `createContext(envelope, 'onebot')` → 管道；终端把 `rawPayload`（原事件引用）**原样**送回旧入口，`await` 完成后 `next()` |
| 错误日志一致性 | 管道会把旧入口异常包成 PipelineError（index 递增链）；host 捕获走 `unwrapPipelineError` 剥回根因，日志文案与旧路径一致（host.js:250/255 sink） |

## 3. onebot 事件 → hub 的实际接线链（Phase 0 现状）

```
src/onebot/client.js:163  onEvent(data)            ← WS 收到原始事件
host.js:276               onEvent: (ev) => {...}   ← loginOk 门禁（核对期间攒 pendingEvents）
host.js:229               handleEvent(ev)          ← 前置段：gapTracker.notePacket / seenIds.add
                                                   /   mods.emit('onebot', ev) / dangerGuard.handleReply
        ├─ 开关关：host.js:252  hub.onMessage(ev)          （直走旧入口）
        │        host.js:257  hub.onPoke(ev)
        └─ 开关开：dispatchLegacyPipeline(ev)（host.js:263）
                   = compose([占位, legacyFallback])(createContext(envelope,'onebot'))
                   legacyFallback（src/kernel/legacy-fallback.js）按 rawPayload.post_type 路由：
                     'message' | 'message_sent'      → legacyHub.onMessage(原事件)
                     'notice'/notify/poke            → legacyHub.onPoke(原事件)
                     其余（request/meta/普通 notice） → 旧核心本就不处理，直接放行 next()
```

**Phase 0 边界**（开启态也不接管的路径，后续 US 收编时再动）：

- backfill 补收：`hub.onMessage(it.event, { backfill: true, gapMs, earliestAgeMs })`（host.js:160/183）——
  带 legacy 专属 opts 的直调，不经管道；信封无法无损承载 opts，Phase 2 Ingress 落位时再统一。
- `triggerBackfill` 内 `hub.sendText`（host.js:179）与其余 `hub.*` 调用（deliver/pushToSession/
  runSystemTurn/面板路由等）：非"入站事件流"，与开关无关。
- handleEvent 前置段（gap 检测/去重登记/mods.emit/dangerGuard）：开关开时**仍在 handleEvent 里先跑**，
  管道只包住"交给旧核心的那一步"。RFC §2.1 的 Protocol Adapter + Middleware 2-4（Ingress）落地
  （US-008/009）时再逐项迁入——迁移前挪动它们就违反零风险红线。

## 4. 职责归属速查（谁将来认领什么）

| 职责（真实位置） | 归属 | 认领 story |
|:--|:--|:--|
| 事件归一化 / InboundEnvelope 物化（hub.js:1310 `parseMessageEvent`；Phase 0 临时版 legacyEventToEnvelope） | Protocol Adapter → Ingress | US-008/009（Phase 2） |
| seenIds 去重、dangerGuard、ACL（checkAllowed hub.js:1324）、群决策（decideGroupReply hub.js:1415） | Ingress Middleware 2-4 | US-009 |
| 防抖合流 `pending/enqueue/flush`（hub.js:1709-1795） | Ingress Aggregator | US-008 |
| 人设/记忆装配（mount 529/546 + contextProviders + memoryScore） | Context Assembly | US-010 |
| 命令路由（onCommand 链、hub.js:1365-1376 主人命令分支） | Terminal Handler | US-011 |
| 推理调用 `agent.followup/steer`（hub.js:1887/1890） | 暂留 legacy（管道终端之内） | Phase 4 换 ModelInferenceExecutor（US-012 后） |
| 分条发送 `deliver`+`sendSegments`+`hooks.send`（hub.js:833/572/604） | Egress → Dispatcher | US-005/006/007 |
| 记忆写回 `logChat`+`sessions.flush`（hub.js:934/1893） | Dispatcher & Sink 侧写 | US-007 收口发送时评估 |

## 5. 内核契约速记（US-001/002 已验收）

- `compose(middlewares)(ctx, tail?)`：double-next 熔断、abort 短路、PipelineError 包装（src/kernel/compose.js）。
- `createContext(envelope, driverId, parentTraceId?)`：meta 冻结 / reply 队列 / state Map / signal（src/kernel/context.js）。
- `Middleware = async (ctx, next) => {...}`，JSDoc 契约见 src/kernel/types.d.ts（编辑器消费，零编译）。
- 遗留终端：`createLegacyHubFallback(legacyHub)` + `legacyEventToEnvelope(ev)` + `isPipelineEnabled(env)`
  + `unwrapPipelineError(error)`（src/kernel/legacy-fallback.js）。
- 信封字段约定：`type` 由 post_type 归一（`message_sent`→`message`，细分看 `rawPayload.post_type`）；
  `rawPayload` 是原事件**引用**（不拷贝不冻结——旧入口有就地读取习惯，Phase 0 不做深拷贝风险）；
  `timestamp` 为毫秒（v11 `time` 秒级 ×1000，缺失用接收时刻）；私聊无 `groupId`、非频道无 `channelId`、
  poke 无 `sender`/`messageId`，缺一律 `undefined` 不臆造。
