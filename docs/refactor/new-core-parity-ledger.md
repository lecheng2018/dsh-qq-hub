# 新核心功能等价台账（parity ledger）

> 更新：2026-11-10。本文只把可执行测试或真机证据算作完成；历史“已知缺口”不再作为当前状态引用。
> 回滚仍是显式 `FLAG_MODULAR_CORE=false` + 重启，由 `test/r3-flagoff-regression.test.js` 覆盖。

## 当前验证基线

| 验证面 | 当前结果 | 说明 |
|---|---|---|
| `test/e2e.test.js` | 70/70 | 默认新核心，不再设置 `FLAG_MODULAR_CORE=false` |
| `test/modules.test.js` | 22/22 | 模块、开放接口、DSH 联动、模拟测试均走默认新核心 |
| M2/M4/M5/M6/M7 + 自检定向套件 | 79 项中 78 通过后被修正；需随最终全量复核 | 流水测试原先用 UTC 日期读本地流水，已改用 `chatLogDays()` |
| 主仓 `npm test` | 1502 pass / 1 fail / 4 skip（共 1507） | 唯一失败是既有 `local.test.js` 硬编码 `/tmp/aurabot-local-img.png`，其他用户占用导致 EACCES；以干净 CI 复核 |
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
