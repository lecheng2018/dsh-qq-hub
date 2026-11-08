# ADR-0001：模块化核心公共契约

- 状态：Accepted（2026-11-08 会签冻结；见 §7 会签记录）
- 契约版本：1
- 执行分支：`refactor/modular-core`
- 范围：纯数据契约、运行时边界校验和模块定义兼容，不接生产主链

## 1. 决定

采用模块化单体。核心与功能模块通过版本化公共契约协作，不引入独立服务，不复制 DSH 的会话、模型、工具和权限系统。

新增：

- `ChatKey`：`private:<数字ID>` 或 `group:<数字ID>`。
- `NormalizedInbound`：标准化入站事件，明确来源为 realtime/backfill。
- `Turn`：回合 ID、ChatKey、成员事件和生命周期状态。
- `Delivery`：投递 ID、来源模块、投递状态、尝试次数、结构化 segments 和可选真实网关 messageId。
- `ContextFragment`：模块 ID、作用域、sessionId、优先级、缓存稳定性和错误策略。
- 模块能力声明：沿用现有 `id/api/setup`，增加可选 `provides/requires/conflicts/defaultEnabled/requiresGUI/configVersion/storageVersion`。

运行时校验器位于：

- `src/kernel/modular-contracts.js`
- `src/core/module-contract.js`

## 2. 兼容性

旧模块只需保留现有 `id/version/setup`，`api` 缺省仍为 1。新能力字段均可选，归一化返回副本，不修改调用方对象。

现有同名模块替换机制继续保留。`provides` 表达抽象能力，供后续 Module SDK 做依赖检查和替代实现选择；本 ADR 不引入第二套装载器。

现有 runtime loader 的 manifest（`name/targetPlatforms/displayRequirements/entrypoint`）仍只负责环境剪枝，不与业务模块定义混用。

## 3. 状态与失败语义

Turn 状态：

- `pending/merging/running/succeeded/failed/cancelled`

Delivery 状态：

- `queued/sending/sent/failed/unknown/cancelled`

`unknown` 表示副作用可能已经发生，不能自动重试。`gatewayMessageId` 只能保存真实网关回执，不用 queued 或 deliveryId 冒充。

ContextFragment 的 scope 只能是 ChatKey 或 global。`onError` 只允许 isolate/fail-closed；具体采用哪种由 provider 的隐私和可靠性要求决定。

## 4. 原始事件边界

NormalizedInbound 不要求核心携带或理解 OneBot 原始对象。legacy raw 对象只能留在适配层。现有 `src/kernel/types.d.ts` 的 InboundEnvelope 继续服务旧管道，待 M3/M4 适配后再收敛，不在本阶段做破坏性替换。

## 5. 验证

- `test/modular-contracts.test.js`：ChatKey、Inbound、Turn、Delivery、ContextFragment 的成功和失败边界。
- `test/modular-module-contract.test.js`：旧定义兼容、能力声明、非法输入和当前全部内置模块兼容。

## 6. 后续工作

- ~~M0-3 完成完整功能矩阵后，各工作流会签并将状态转为 Accepted。~~（已完成，见 §7）
- M2 各核心模块只能依赖本契约，不私自增加公共字段。
- M2-F 在现有 `src/core/modules.js` 上消费模块能力声明，并补依赖解析、冲突处理、生命周期和替代实现测试。
- M3/M4 通过适配器接入真实 DSH/OneBot，不在契约层导入宿主实现。

## 7. 会签记录（M0-4 冻结）

- 前置：M0-3 功能矩阵初版已建立（`docs/refactor/feature-matrix.md`），23 个内置模块全部有 owner 归属，无无人认领条目。
- 验证：`test/modular-contracts.test.js`（7 用例：成功/缺字段/错误输入/版本兼容/状态枚举含 cancelled）与 `test/modular-module-contract.test.js`（8 用例：旧定义兼容 + 全部内置模块校验）在基线 commit 上通过。
- 会签（单人体兼任，按角色逐一确认）：
  - Controller：契约字段与依赖方向冻结 ✅
  - Inbound：NormalizedInbound/ChatKey 满足 M2-A 输入，raw 边界（§4）认可 ✅
  - Session/Turn：Turn 状态与成员事件语义满足 M2-B/C 设计 ✅
  - Outbox：Delivery 六态与 unknown 语义（§3）满足 M2-D，gatewayMessageId 不可伪造 ✅
  - Context：ContextFragment scope/onError 满足 M2-E，与 memory-privacy 三层作用域兼容 ✅
  - Module SDK：能力字段可选且归一化（§2），现有 modules.js 行为不变 ✅
  - QA：两测试文件纳入统一门禁（npm test glob 覆盖）✅
- 冻结效力：后续任何公共字段变化必须走新 ADR；任务分支不得私改 `modular-contracts.js` / `module-contract.js` 的公共校验面。
- 已知保留项：Turn/Delivery 契约中「取消是否真实传播到 DSH」属 M2-C/D 实现能力缺口，不阻塞本数据契约冻结（任务书 M2-C 交接项）。
