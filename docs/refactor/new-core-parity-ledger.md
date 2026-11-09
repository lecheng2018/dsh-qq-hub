# 新核心转正台账（parity ledger）—— 2026-11-09

> 背景：现网验证树（官方 `.5` + 19 项 local 热修 + 3 项未固化 = 汇总报告 22 项）经
> `aa122ea` 逐字节合入本分支，`0882ed8` 把 `FLAG_MODULAR_CORE` 翻为**缺省开**。
> 本文件是转正时点的**诚实欠账清单**：新核心相对 legacy 尚未拉齐的行为面，全部有出处、有归属、有收口路径。
> 回滚姿态：显式 `FLAG_MODULAR_CORE=false` + 重启（`test/r3-flagoff-regression.test.js` 持续钉住逃生阀）。

## 验证锚点（数据，不是感觉）

| 面 | 数值 | 出处 |
|---|---|---|
| 基线（282b64a3，flag 缺省关）全量 | **1470 pass / 0 fail**（本机 Windows） | `C:\Temp\m7-base-test.log` |
| 转正首跑（集成树，缺省开） | 1425 pass / 45 fail | `C:\Temp\m7-int-test.log` |
| e2e 70 例在新核心下 | 40 pass / 30 fail（下表 B 类） | 同上 |
| modules 22 例在新核心下 | 15 pass / 7 fail | 同上 |
| chat-model 12 例在新核心下 | 12 pass（观察面修复后；模型选择本身新核无缺） | `test/chat-model.test.js` agentOf 双文件回退 |
| 现网真机 | 25 模块 0 error、工具 66、审批触达 QQ、流水 128 行/日、压缩 144802→784 | 《全部修复汇总-20261109.md》§四 |

45 例失败的处置去向：38 例随文件钉回 legacy（B 类挂账）、7 例改为跟新现实/观察面修复（A 类已补 + 测试更新），
另有 m7-live-parity 13 例**新增**在默认开姿态下钉住 22 项热修的关键接线。

## A 类 · 转正时点顺手补齐（新增代码，不在现网热修内）

| # | 项 | 落码 | 覆盖 |
|---|---|---|---|
| A1 | 「正在输入」指示：新核心此前完全不亮（legacy hub.js:1854/1903 有） | `modular-core` 复用 `createActivityState`：回合开始 `startTyping`、回合终（含失败路径）`stopTyping`；私聊/enabled/非 dryRun 门在 activity-state 内 | `test/m7-live-parity.test.js` typing 平账例 |
| A2 | 桥的媒体新口径（图片段进 outbox、语音/文件 legacy+补台账）测试跟现实 | `m5-parity` 「审计§2」例更新（补 ledgerFile 夹具 + deliveryId 回查断言） | 同左 |
| A3 | 面板指定模型从 DSH 消失时的「退回下一级」校验缺失：新核心调 `resolveChatModel(cfg, chat, null)`，legacy 传在线清单（hub.js:411）——抱着死模型名硬选会静默用不存在的模型 | 新核心新增 `availableModels` 装配项，host 注入 `models.cache`（与 legacy 同一份） | `test/chat-model.test.js` #43（转正在默认开姿态跑出此缺口） |

> A1 属于现网未观察到的行为差（主人没抱怨过没 typing，但 e2e 钉着）。改动只在新核路径，legacy 一字未动；
> 需在 fnOS `.7` 包上真机复验（见文末验收清单）。

## B 类 · 钉在 legacy 的挂账（文件头 `process.env.FLAG_MODULAR_CORE = 'false'`）

### B1 `test/e2e.test.js` — 30 例

**真缺口（新核心行为未实现，收口=PR-2/PR-4）**
| 用例 | 缺口 | 归属 |
|---|---|---|
| 引用消息 ×6（#221-#226：私聊/群聊 quotedInfo、引用内图/表情、get_msg 空 url 补历史、拉不到要明说） | 基础正文/发送者已水合并有 m7 回归；空 url 历史补图等完整 e2e 尚钉在 legacy，解除 pin 后才算全量收口 | PR-2 InboundService |
| 群聊被引用回复 + `<reply:n>` ×2（#208/#209） | reply/at 已委托 legacyDeliver 并有 m7 回归；完整群聊 e2e 尚钉在 legacy，待解除 pin | PR-3 |
| 戳一戳回戳（#212） | poke 的 legacy 交互语义（回戳+20s 去重）未接 | PR-4 |
| 合并转发读记录（#213） | forward 段展开（get_forward_msg）未进新核内容拼装 | PR-2 |
| 模块接管/改写/热重载重挂/慢工具「正在做」/排队轮说话人兜底/DSH 窗口直打字（#921/#923/#255/#257/#258/#259/#254） | 模块钩子在新核的等价面：takeover/rewrite 已桥接但 e2e 断言的是 legacy 装配细节；「正在做」提示与排队兜底未实现 | PR-4 交互+钩子 |
| 空间日记/换头像/表情整理/翻记录/强制语音（#227/#239/#241/#242/#233） | 命令/工具旁路的 legacy 内部时序断言（deliver 节奏、TTS 强制） | PR-3 |
| 重新开始（#231）、时间锚 ×2（#261/#262） | userText 来源行/时间锚格式与 legacy pushToSession 不同构（内容都在，形态断言钉死） | PR-3 |

**观察面（新核心行为大概率等价，但断言面钉 legacy 内部）**
| 用例 | 说明 |
|---|---|
| 主人私聊拆条（#194 除 typing 外的来源行断言）、群刹车（#214）、看图收藏（#215/#216） | 收藏/刹车已接线（热修 #18/#7），e2e 读的是 hub 内部状态；待 PR-3 把断言面改双源 |

### B2 `test/modules.test.js` — 7 例

模块接管、热重载、开放接口事件列表、ctx.get(aurabot) 全局工具、钩子改「怎么想怎么说」、模拟(dryRun)测试、api.reply 引用回复 + api.isOwner：
同属 B1 的钩子面/引用面缺口；模块系统本身在新核下 15/22 直接绿。

## C 类 · 报告点名、本合并不解决

| 项 | 现状 | 收口 |
|---|---|---|
| `ask_user_question` 服务接线 | 已改 `userQuestions.ask()` 包装，按会话分流且可卸载；工具在自定义 preset 的挂载仍需真机/上游时序验证 | `test/modular-user-questions.test.js` + fnOS 验收 |
| 富媒体出站/模块媒体台账「代码已接、待真实流量触发」 | 单测已钉（m7 富媒体例）；真机以 `.7` 包跑一次生图+语音验证 | fnOS 验收 |
| PR-1 共享 Outbox（#13） | 独立 base-main 线，不动本次合并；发送面矩阵（imagegen/rss/scheduler/song）在其分支完成后跑 | PR #13 |

## 摘钉流程（怎么让 B 类回到新核路径）

1. 每个缺口：先写 m8 契约测试（新核路径），实现，`C:\Temp` 全量回归 0 新增失败；
2. 整批（如「引用族」）齐了就删对应文件的 `process.env.FLAG_MODULAR_CORE = 'false'` 行——
   删行本身即 PR 的验收证据（套件立刻在新核跑那批用例）；
3. verify.yml 后续可加 flag-on/off 双跑矩阵（CI infra 已随 #13 落 main 的话）。

## fnOS `.7` 验收清单（真机部分，合并后立刻做）

- [ ] 装 `.7`（由本分支构建）后 25 模块 0 error、网关 connected、工具 66
- [ ] 私聊回合 QQ 端出现「正在输入」（A1 新行为）
- [ ] 生图/语音主动发 → deliveries.json 有 sourceModuleId；dryRun 全拦
- [ ] 现网热修行为抽查：审批卡到 QQ、流水在长、上下文跟轮（连发三轮不重复注入）
