# 参考存档：外部项目设计文档

这里放的是从外部开源项目抄录/存档的设计文档，**不是 qq-hub 自己的实现说明**。
放进来是为了以后改 qq-hub 时有个成熟参照，避免重复踩别人踩过的坑。

每一份都标了来源与许可。原始项目未参与 qq-hub 的开发，也不对其背书。

| 文件 | 来源 | 许可 | 为什么存 |
| --- | --- | --- | --- |
| [surfcore-12-lessons-architecture.md](surfcore-12-lessons-architecture.md) | [Mieksido/surfcore](https://github.com/Mieksido/surfcore) `docs/guides/12-LESSONS-ARCHITECTURE.md` | MIT | 一个两万行双进程拟人系统的维护手册：系统事实、诊断流程、不变量、爆炸半径评估、「删改必隔离」等硬规则。改 qq-hub 前值得先扫一遍。 |
| [surfcore-conversation-closure.md](surfcore-conversation-closure.md) | [Mieksido/surfcore](https://github.com/Mieksido/surfcore) `docs/guides/CONVERSATION_CLOSURE.md` | MIT | 「这段聊完了没有」的判断方式，以及收尾时怎么留下「下次怎么接」的线索。对群聊拟人行为直接有参考价值。 |

## 存档时抓取的版本

- 抓取时间：2026-11-04
- 来源分支：`main`
- 原文可能已更新，需要最新版直接去上面的源链接取

## 已经借鉴到 qq-hub 的

- **记忆的四档清晰度与遗忘**（`src/features/memory.js` 的 `clarityOf` / `shouldForget`）：
  vivid → clear → fuzzy（正文截断）→ trace（只剩印象）→ 遗忘，主人相关记忆永不遗忘。
  对应 surfcore 的 `MEMORY_CARD.md`。见 `test/memory-clarity.test.js`。
- **`token-guardian` 的提前压缩**（`src/modules/token-guardian/index.js`）：压完摘要后调
  `hub.resetChat()` 真归档旧会话，而不是只贴一份摘要进上下文。
- **二代仿真群友角色卡**（`personas/persona-gen2.md`）：行为学规范抄自
  [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的 `qq-chat-v2` preset。

## 没抄的（架构不合）

surfcore 与 qq-bridge 都是 **独立桥接进程 + DSH 插件** 的双进程方案，且绑定 Windows；
qq-hub 是 **DSH 进程内原生插件**，跑在 Linux NAS 上。所以它们「AI 自主看消息/等待/潜水」
那套需要桥接层长轮询工具后端的机制，我们只能抄规则、抄不了实现。
