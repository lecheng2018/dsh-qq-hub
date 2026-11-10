# 新核心功能等价台账（parity ledger）

> 更新：2026-11-10。本文只把可执行测试或真机证据算作完成；历史“已知缺口”不再作为当前状态引用。
> 回滚仍是显式 `FLAG_MODULAR_CORE=false` + 重启，由 `test/r3-flagoff-regression.test.js` 覆盖。

## 当前验证基线

| 验证面 | 当前结果 | 说明 |
|---|---|---|
| `test/e2e.test.js` | 70/70 | 默认新核心，不再设置 `FLAG_MODULAR_CORE=false` |
| `test/modules.test.js` | 22/22 | 模块、开放接口、DSH 联动、模拟测试均走默认新核心 |
| M2/M4/M5/M6/M7 + 自检定向套件 | 79 项中 78 通过后被修正；需随最终全量复核 | 流水测试原先用 UTC 日期读本地流水，已改用 `chatLogDays()` |
| 主仓 `npm test` | 1533 pass / 0 fail / 4 skip（共 1537） | 跳过项为 Windows 平台、CI 性能门禁和本机缺少 DSH 附件组件 |
| 扩展 `npm run test:extensions` | 46/46 | tieba-reader |
| `npm run pack:check` | 通过 | npm 包内容可生成 |

## 本轮已收口的行为差异

### 入站与回合

- 私聊运行中消息通过 `controller.steer` 注入当前 DSH 会话；已进入出站阶段后不再 steer，而是排入下一回合，避免旧回复覆盖新回复。
- 合并转发经 `get_forward_msg` 展开，保留发送者与正文；语音走本地 ASR 优先、网关转写兜底。
- 引用恢复正文、发送者、图片和表情；空 URL/裸文件名会从私聊或群消息历史补地址；失败提示明确允许模型回答“没看到”。
- 图片和表情支持 HTTP(S) 与 `base64://`，经 DSH 附件登记；普通照片不因收藏入口而误收进表情库。
- 群缓冲保留整段发言人、引用编号、直接呼叫者和时间锚；时间锚持久化在新核心会话注册表。
- 戳一戳有过滤目标、20 秒节流、回戳目标登记；群刹车使用 `noteSpeak` 的真实发言计数。

### 会话与模块

- 面板会话列表、单个/全部重置、人设切换、审批反查、主人私聊权限兜底均能看到新核心注册表。
- 主人在 DSH 会话窗口直接输入会登记 `directOwner`；排队回合不会继承上一轮的群友集合。
- purpose/companion 优先用 `runPromptTurn` 复用当前 QQ/DSH 会话，只生成、不在核心内自动投递。
- message/prompt/reply/items/send/groupDecide/model/poke 钩子接入；扩展命令不再被命令闸排除。
- 工具按 `mods.generation()` 重挂；联动工具 deny 清单变化也会重挂；dispose 卸载已挂工具。
- `mods.emit` 已透传，activity、开放接口事件和依赖它的模块不再断供。

### 出站

- 新核心与 legacy 在生产中共用同一个 Shared Outbox/台账，不再各自创建写同一文件的实例。
- 所有模型回复复用 legacy deliver 的出站语义适配（分条、长度、语音、表情、图片、`<reply:n>`、`<at:>`、`<poke>`、自动引用和概率装饰），物理发送仍只经 Shared Outbox。
- 模块 `api.reply` 保留群消息真实引用；模拟发送经 `captureOnly` 截获，不触发物理写。
- 私聊/群文件上传及路径失败后的 base64 回退均进入 Outbox；修复了 `chatKey` 未定义导致的上传前失败。
- 空间说说不按“机器人自身私聊”套用聊天白名单，但仍受总开关、dryRun、身份闸和台账约束。
- 生产媒体路径由 hub 入账，模块桥不再额外 `recordExternal` 造成重复记录。

## 仍需真实环境验收（不是代码侧已完成）

- [ ] fnOS/DSH 安装固定提交构建的测试包，核对模块加载、会话创建、真实模型回合和日志无重复注册。
- [ ] 发送矩阵：文本、图片、语音、表情、文件、戳一戳、引用/@、RSS、定时任务、生图、翻唱、空间说说；每项核对 `deliveries.json`。
- [ ] dryRun/总开关对上述出口全部零实发；身份泄露闸覆盖消息与直通参数。
- [ ] 真实本地 ASR、TTS 与远程 SnowLuma 文件路径不可见场景。
- [ ] 可控网关的 OneBot unknown：发送中途断连只记 unknown，不自动重发。
- [ ] owner 批准后才做小流量实发，并完成 72 小时观察与回滚演练。

## 测试维护约定

- 不再用删除断言、恢复 legacy 钉位或缩短功能面来让测试变绿。
- 存储格式已迁到 `modular-sessions.json` 时，测试使用注册表/公共接口，不直接修改旧 `sessions.json` 冒充新核心状态。
- 选择部分测试运行时要注意跨用例前置条件；最终结论必须以完整文件和全量测试为准。

## 第二轮真机自检收口（2026-11-10）

- 私聊身份闸补 `allowBareNumbers=true`，与 legacy 一致；群聊仍拦裸号码，拦截新增脱敏 warn。真实 Shared Outbox 回归见 `m6-outbox-unification`。
- 补收消息在装配头部加入 `backfillNoticeBlock`，带条数与最早消息年龄。
- activity 按 legacy 计算 direct（私聊/被 @/must）与 owner，不再固定为 false。
- 慢工具提示在每轮挂载时重置，同一聊天后续慢任务仍会收到提示。
- Outbox 链收尾改为 `then(cleanup, cleanup)`；独立 Node 子进程回归证明调用方捕获异常后进程不退出。
- 台账采用 H-A：超过 7 天的 sent/cancelled 正文只留前 200 字并保留元数据；unknown/failed 永不裁。
- 群刹车“双记”报告经源码与 e2e 复核不采纳删除方案：legacy 与新核心是不同状态实例；新核心的 `noteSpeak` 是刹车数据源，`noteSpokeInGroup` 是话题状态，不是重复计数。

## purpose 与真实补收时长修复（2026-11-10 下午）

- 修复目的引擎跨文件依赖：`kindLabel` 从 seeds 导入 prompt；`actionForNeed`/`kindForAction` 从 goals 导入 seeds；`emotionCues` 补 import。
- `purpose.test.js` 新增全入口冒烟：使用字段不完整但合法的 pending 与素材，实际执行 minePurposeSeeds → selectPurpose → buildPurposePrompt → summarizePurposeState；不再被字段齐全的既有用例绕过。
- gateway 调用 `dispatchBackfill(event, { gapMs, earliestAgeMs })`；新核心用 WeakMap 保存适配外元数据，提示词同时使用真实断线时长与消息年龄，不再硬编码“约 2 分钟”。
- 验证：purpose 23/23；backfill 接线 13/13；新核心补收提示回归通过。

## 入站文件、回合恢复与缓存收口（2026-11-10）

- J：新增 `src/chat/inbound-files.js`，新核心与 legacy 共用入站文件处理。文本最多读取 60000 字；二进制落盘到 `qq-inbox` 并向模型提供真实路径；失败时明确说明。
- K：legacy 的二进制文件落盘改用共享实现中的 `node:fs/promises` `mkdir`/`writeFile`，不再因未定义导入而失败。
- M：普通回合和主动任务均有 `turnTimeoutMs`（默认 600000）超时。超时清理监听与输入状态、释放串行道并归档旧会话；下一条消息新建会话，迟到旧回复不投递。
- L：新核心将 JSON 卡片解析为标题、摘要和链接，XML 卡片显示 `[卡片消息]`。
- N：重置会话时清理上下文、人设、工具和慢提示缓存，`stats().cacheEntries` 提供可验证计数。
- O：台账崩溃恢复将 queued 标为 cancelled、sending 标为 unknown，恢复结果立即落盘；两者均不自动重发。
- P：私聊人设查询只传 `userId`，群聊只传 `groupId`。
- Q：每轮只计算一次 `previousTurnAt`，装配、群聊和 steer 复用该时间锚。
- 定向验证：113/113，通过 `m7-live-parity`、`m2d-outbox-ledger`、`r3-flagoff-regression`、`purpose`、`m4-modular-core`、`m6-outbox-unification`。
- 真机门禁未取消：入站文本/二进制、超时后新消息、卡片展示、reset 和崩溃恢复仍需在 fnOS/DSH 的后续包上复核。

## 文件入站收尾与超时策略（2026-11-10）

- 群缓冲使用水合前的文件段，只保留 `[文件 名称]`；文件正文块带内部标记，只加入当前回合。回归同时证明群聊当前回合能读正文、后续回合不重复注入。
- `textOfSegments` 对文件、语音、视频提供非空文本，聊天流水和 activity 不再丢失这类事件。
- 文件声明大小检查移到 url/base64 快捷路径之前；超出前 3 个的文件生成明确未下载说明；小文件显示 `<1KB`。
- 文件修复独立经 PR #23 合并；定向 41/41，主仓当时 1523 pass / 0 fail / 4 skip。
- 回合超时改为发送提示并标记待重建，不立即 reset；下一条普通消息或主动任务到来时才归档旧会话。迟到回复仍由监听清理保证不投递。
- 面板新增分钟单位的 `turnTimeoutMs`，配置归一化限制 1～120 分钟，默认 10 分钟不变。
- `.6` 最终验证：主仓 1524 pass / 0 fail / 4 skip；扩展 46/46；打包通过。真机仍需复核群文件后续回合、超时提示和面板保存。

## token-guardian 超时与退避修复（2026-11-10 晚）

- 真机出现两种故障：模型 Request timed out 后每 30 秒重试，以及请求挂起后 compactBusy 永久占用。源码确认 api.ask 无超时、失败无状态、成功后 chars 被提前乘 1.4。
- 压缩请求新增可配置 `askTimeoutSeconds`（默认 90 秒），Promise.race 保证落定，AbortSignal 经 askModel 传入 DSH `llm.stream` 的 `signal`；外层 finally 继续负责放锁。
- 模型失败记录 lastAttemptAt、lastError、failures、nextAttemptAt，按 30 秒/1 分钟/5 分钟/15 分钟/30 分钟退避；成功清零。lastCompactAt 仍只表示成功压缩。
- chars 只保存真实字符数，estimate 是唯一 token 换算点；面板增加压缩中、失败原因和下次重试时间。
- 新增 `token-guardian-recovery.test.js` 四项行为回归，与既有 token-guardian 套件合计 27/27。真机需复核挂起后解锁、失败退避和再次成功压缩。

## 后台任务生命周期修复（2026-11-10 晚）

- 启发式自检动态探针证实：`hub.isBusy(chatId)` 位于 `let chatId` 之前，TDZ 异常被空 catch 吞掉，busyChecks=0 且仍调用模型。现将判断移到 chatId 计算后，并新增忙时零模型调用回归。
- token-guardian 记录在途 AbortController，dispose 统一 abort；doCompact 在入口、异常和模型返回后检查 disposed，旧请求不再 reset、写摘要或记失败。
- 新增 `withAbortTimeout`，distill 模型请求默认 120 秒超时，L1 失败退避 5 分钟并释放 pendingL1，后续批次可恢复。
- 定向回归：distill/token-guardian 32/32。主回合 followup 只停止等待的既有边界保持不变。

## 静态门禁与静默异常治理（2026-11-10 晚）

- 新增 ESLint + globals 开发依赖和根 package-lock；Verify/Release 先 `npm ci` 再 `npm run lint`。
- `no-undef` 为 error；`no-use-before-define`、`no-empty` 为 warn。首轮扫描 0 个未定义符号、48 个声明前使用、231 个空 catch；多数是延后执行的安全闭包或明确预期的能力降级，不批量改写。
- token-guardian 的 isBusy 同类问题由行为回归钉住，忙时读取异常与 distill 计数异常改为 debug。
- 依赖链 minimatch 通过 overrides 固定到修复版本，npm audit 0。
- 本地 lint：0 errors / 277 warnings（其中两个关键空 catch 已修）。

## purpose 备忘出站过滤（2026-11-10 晚）

- 根因是 purpose 与普通聊天共用 DSH 会话，结构化备忘进入历史后被普通回复模仿；cleanReply 原先只保护 purpose 投递。
- `stripInternalMemo` 下沉到 chat/reply.js，parseReply 在分条前调用；purpose cleanReply 复用同一实现，parsePurposeMemo 不变。
- 新核心普通回合的发送与 bot logChat 均新增行为回归；legacy deliver 的 said 同样来自过滤后的 items。
- 定向 89/89；历史三条污染流水不做数据迁移或删除。
