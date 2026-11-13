# ADR-0002 · 转向"共享行为服务"架构；PR-11 降级为工作产物

- 状态：accepted（2026-11-08，owner 定案）
- 取代：ADR-0001 §「新核心逐补丁追平 legacy」的隐含路线
- 关联：《新核心空转与缺口审计》《dsh-qq-hub-1.3.65-test-验收报告》、PR #11

## 决策

1. **PR #11 保持 Draft**，不作为正式重构合并入口；停止继续扩张 `src/host/modular-core.js`。
   其中保留价值的资产（公共契约、纯模块测试、SessionRegistry、TurnController、Delivery Ledger、Outbox、
   flag-off 断言回归）作为后续 PR 的原料，不废弃、不再叠加新核心功能补丁。
   第四轮审计落地提交（本地 8ecd1df）**不再推送**，其内容作为 PR-2/PR-3 抽取共享服务时的行为参照。
2. **蒸馏/黑话另开 PR**，不与核心重构混合。
3. 目标架构：副作用与会话统一 → legacy 行为能力抽成**唯一实现**的共享服务 → 新旧核心都只是调用方 → 最后才切主链。

```
OneBot 事件 → InboundService(解析/ASR/引用/群缓冲/表情收集/recentMedia)
  → NormalizedInbound → SessionService(ChatKey→session 唯一映射/workspace/preset/标题/模型)
  → ContextService(按聊天人设/蒸馏卡/记忆/黑话/群前情)
  → TurnController(合流/取消/turn/end/异常/dispose)
  → ReplyService(分条/maxChars/语音表情/引用/富媒体)
  → 唯一 Outbox(ACL/enabled/dryRun/身份闸/台账/真实回执)
```

## 实施顺序（各自独立可合并）

- **PR-1 Outbox 收口**：hub.sendText/sendSegments/sendFile/sendVoice 及模块 api.send*、生图、RSS、
  头像、面板自测、purpose/speakup deliver、multi-parser 转发全部转进 Outbox；默认关闭保持 legacy。
  验收：所有主动发送有 deliveryId+台账；dryRun/身份闸覆盖全部出口；不存在第二个物理 OneBot 写者。
  **PR-1 完成前不进行新核心聊天测试。**
- **PR-2 入站与上下文共享服务**：从 hub.js 提取 buildInbound/buildContext（不是新核心重写）；
  contexts 不可用必须明确失败不静默。验收：同一事件跑新旧路径，内容块/提示词/persona/preset/workspace/群前情/引用/转写一致。
- **PR-3 会话与回复等价**：一个 ChatKey 一个 session（新旧共享映射）；/reset /new 同 registry；
  ReplyService 复用 parseReply/replyRules（maxChars/maxBubbles/voice/sticker/引用/图片；
  超时/取消不留「模型以为已发」假历史）。验收：同一模型输出→新旧等价出站序列。
- **PR-4 交互与群策略等价**：提问/审批/扩展命令统一入站路由；群策略复用 legacy decideGroupReply 全套；
  purpose/speakup 同 registry 同 outbox；真实 turn/end 成功才发送；失败/aborted/热重载有可观测终态。

## 验收方式变更

完成度不再以「模块存在+测试数量」证明。每个 legacy 职责建三列矩阵
（能力 / legacy 期望 / 新核心实际），逐项必须一致（含同随机种子下的语音表情概率、调用次数、台账条目）。
测试三层：纯模块契约；真实 host+fake DSH/OneBot 新旧对照；fnOS 真机开关旗对照。

## 合并与上线

PR-1..4 全绿（矩阵全过+CI+fnOS 开旗）→ 才可作为"功能等价模块化核心"合 main（仍默认关）
→ owner 私聊→测试群→72h 观察→回滚演练 → 设默认、清 legacy、发 v2。
**先证明新旧表现一样，再允许替代。**
