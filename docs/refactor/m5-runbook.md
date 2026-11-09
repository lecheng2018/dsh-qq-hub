# M5 · fnOS/DSH 隔离验证与生产灰度 Runbook（真实环境门禁项如实标记）

> 状态（2026-11-08，单人体）：**M5 的代码侧工件已就绪；执行项全部 blocked-on-真实环境/owner**。
> 任务书红线：任何阶段不得出现两个真实写者；未经 owner 当阶段批准不开放真实发送。
> 本 runbook 由 owner/QA 在 fnOS 上逐项执行并回填证据；不得以本文件代替实测。

## M5-1 工件与安装验证（blocked-on-fnOS）

- [ ] `git archive`/`npm pack` 固定 commit 的 tgz，记录 sha256 与内容清单
- [ ] 隔离 DSH profile 安装（不动生产 profile）
- [ ] 重启加载：模块清单与 feature-matrix §2 一致（23 内置模块）
- [ ] 默认姿态验证：不设 FLAG_* 时走模块化新核心；显式 `FLAG_MODULAR_CORE=false` + 重启才回 legacy

## M5-2 真实 DSH + fake OneBot（blocked-on-fnOS）

- [ ] FLAG_MODULAR_CORE=true + fake 网关：私聊/群聊会话创建、preset 路由（private/private-long/social）
- [ ] 断线补收经新核心（gateway.getModularCore 分支）
- [ ] 模块启停（mods.health 快照）

## M5-3 真实 OneBot dryRun（blocked-on-owner 维护窗口）

- [ ] 连真实 SnowLuma/NapCat，dryRun 全出口拦截零实发
- [ ] 唯一写者确认（旧桥停用或隔离 profile 不挂真实号）

## M5-4/5/6 小流量实发 / 72 小时观察 / 回滚演练（blocked-on-owner 逐级批准）

- 顺序与门禁见任务书 M5 §3/§4；每一步独立批准 + 证据回填本文件。
- 回滚姿态：FLAG_MODULAR_CORE 关 + 重启 = 回 legacy 路径（代码回退用 backup/m0-m1-complete 分支工件）。

## 已知边界（诚实登记）

- 面板 Host/CSRF 防护在「DSH 前置反向代理」部署形态未验证（插件层判定只看 Host/Origin，反代改写 Host 需在 allowedHosts 登记）。
- 新核心 execute 依赖 `session/event` 的 `assistant/message` 事件取回复文本；真实 DSH 若事件形状不同，适配缺口会**如实失败**（M4-0 fail-closed 用例），不会伪造成功。

## 实测记录（2026-11-08 两轮开旗内测，owner 执行；VERIFY-REPORT 归档）

**包**：`1.3.65-test.20261108`（sha256 d72cc47c…）与 `.2`（b0d874e0…）；宿主 DSH 0.2.2-rc.1 / fnOS / profile web / 数据目录 `plugins-data/aurabot/`（历史别名）。

- 9 条断言两轮后：#0/1/2/3/4/5/6/8 ✅；#7 真 aborted 语义 ✅（kill -TERM：turn/end reason=aborted/disposed、零半截投递、重启后槽不卡死）；#9 OneBot unknown ❌ 未完成（SnowLuma 在另一主机，本机无法重启网关；仅有「发送瞬间断 WS」近似验证）。
- 第一轮发现 8 缺陷全部修复并进源码 + 回归用例（followup 消息形状、图片附件登记、ctx.get 三连、工作区注入、出站后处理链、失败留痕、模型跟随面板、cancelReason）。
- 第二轮（`.2` 包）复验通过后再发现并修复 2 缺陷：**9 会话不命名（面板未命名）**——createSession 后按 legacy titleFor 语义 rename + 启动对存量映射回填；**10 图片入站只降级未入模**——admitContent 补「下载（15s/10MB 上限）→ mimeOf → base64 → admitPromptContent」，任一步失败回降级文案，绝不把裸 image 块写进历史（毒化会话防线，真机曾连续废 3 轮）。修复后真机两张图直接进模，她不再需要 `curl 网关→下载→read_image` 三步绕路。

### 环境坑（实测踩到，务必遵守）

- `loadLayeredEnv` 只填**尚未设置**的变量：从已带 `FLAG_MODULAR_CORE` 的 shell 手工拉起 dsh 会继承旧值、`.env` 静默失效。面板重启/Watchdog 起的进程才读 `.env`。
- fnOS supervisor 不会自动拉起**自己挂掉**的 dsh 子进程（只在它发起的 stop/start 时重启）——kill 后需人工或兜底脚本拉起，且兜底脚本注意上一条的 env 继承。
- 热重载（set_plugin off/on）可 3 秒换代码不重启宿主；但**跨热重载复用旧会话会踩脏状态**（旧实例 agent 被新实例 resolve），测试期清 `modular-sessions.json` 即恢复。生产不受影响（每次全新进程）。

### 遗留挂账（勿当已解决）

- #9 断言需在有 SnowLuma 可控重启的环境补测。
- 富媒体、`<reply:n>` 与 `<at:>` 出站统一委托 legacyDeliver；模型无视觉能力时的图片退让探测未做（当前面板配的是 vision 模型）。
- ~~模块上下文投喂在部分宿主拿不到 `contexts` 服务~~ —— 已被第四轮审计证伪并修复：真 seam 是 `agent.ctx.systemPrompt.context`（见下表 1.1）。

## 第四轮：空转与缺口审计（2026-11-08 22:20 报告）→ 源码落地对照

| 审计项 | 状态 | 落地方式 |
|---|---|---|
| §1 群回复策略缺失 | ✅ | 复用 legacy 纯函数（createGroupState/policyFor/decideGroupReply/topicRelevance），顺序=先 activity 计数后回复闸；离线+真机 22:07 双证 |
| 1.1 模块上下文投喂（双层 bug） | ✅ | 第一层：seam 改回 legacy 同款 `agent.ctx.systemPrompt.context`（hub.js:546），agent 级注册一次、闭包每轮读最新；第二层：legacy-context adapter 改传 `{chat, sessionId}`（provider 解构 chat.kind，此前传 chatId → provider 全员抛错被吞） |
| 1.2 按聊天人设分流 | ✅ | `personaTextFor`（personaIdFor+readPersona+rewrite）经 `systemPrompt.variable` agent 作用域遮蔽（hub.js:529 同款）；蒸馏语感群卡从此生效。persona 变更即换会话未复刻（挂账） |
| 1.3 群聊上下文拼接 | ✅ | groupPromptLight：未投喂20+已投喂8、发言人标记、主人不落号码、相对时间、mode hint；引用/编号指令文案随 1.5/R4 配套再补 |
| 1.4 语音转写 | ⏸ | 需抽取 hub 转写管线，独立轮 |
| 1.5 引用解析 | ⏸ | quotedInfo/quoteCache 在 hub 内部；群闸 repliedToBot 暂 false（不猜） |
| 1.6 偷表情 | ⏸ | collectMode 三分支在 hub 内部 |
| 1.7 出站装饰+心情调制 | ◐ | 群闸 interjectChance 已乘 mood().chatty；语音/表情概率装饰未接 |
| 1.8 maxChars | ✅ 澄清 | parseReply(replyRules) 内部 segmentBubbles 已按 maxChars 封顶（审计该项为误报）；m5-parity 已钉住行为 |
| 1.9 旁路指令三件 | ✅ 审批/提问 | hub 新增 `interceptInteraction`，新核心入口消费；hooks.message 模块接管未接（挂账） |
| 1.10 总开关/静音不拦执行 | ✅ | dispatch 入口 enabled→disabled、isMuted→muted，不跑回合不烧 token；出站动态闸保留兜底 |
| 1.11 统计/recentMedia | ⏸ | bump/received 与「刚才那张」素材在 hub 内部 |
| §2 模块发送绕开唯一出口 | ✅ 文本 | `createModuleSendBridge`：开旗态 sendText/reply/纯文本 sendSegments 并入 outbox（台账/dryRun/泄露闸生效）；媒体管线透传 legacy、purpose/companion 双会话问题未解（均挂账） |

回归：`test/m5-parity.test.js` 8 例（群闸/群上下文/静音/旁路/双层 context/人设/发送桥/maxChars）+ m4/m3 三例改钉新现实（入口 enabled 语义、身份闸配 @ 场景、adapter chat 形状）。

## 全接入测试版验收补充（2026-11-10）

代码侧已解除 e2e/modules 的 legacy 钉位；e2e 70/70、modules 22/22、扩展 46/46，打包检查通过。以下仍必须在目标环境执行，不得用 fake 结果替代：

1. 安装后先开 dryRun，分别触发文本、图片、语音、表情、文件、戳、引用/@、RSS、定时、生图、翻唱和说说；确认 QQ 零实发且台账有 cancelled 记录。
2. 恢复正常发送后逐项执行同一矩阵；文件必须实际出现在私聊/群文件中，不能只看到 `[file]` 或工具成功文本。
3. 私聊连续输入验证 steer；在上一回复正在发送时再输入，验证它进入下一轮而不是覆盖旧回复。
4. 引用带图/表情、合并转发、语音输入、主人权限、群刹车、命令和模块热重载各做一次。
5. 检查 `deliveries.json` 每次物理发送仅一笔；检查 `modular-sessions.json` 与面板列表/全部重置一致。
6. 上述通过后，再由 owner 决定是否进入小流量和 72 小时观察。
