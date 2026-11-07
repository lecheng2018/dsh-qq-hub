# ADR-0001：模块化核心公共契约

- 状态：Accepted（契约 v1）
- 接受决定：当前协调人 `yaozy2020` 将本 ADR 作为执行基线接受；这不是各工作流成员的多人签字或会签记录，不据此虚构任何个人签署。
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

旧模块必须保留现有 `id/setup`；`version` 可省略，提供时必须为非空字符串；`api` 缺省仍为 1。新能力字段均可选，归一化返回副本，不修改调用方对象。

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

- `test/modular-contracts.test.js`：ChatKey、Inbound、Turn、Delivery、ContextFragment 的成功和失败边界；`sender.nickname/card/role` 可选，存在时按各自字段规则校验。
- `test/modular-module-contract.test.js`：旧定义兼容（含缺省 `version`）、能力声明、非法输入和当前全部内置模块兼容。
- M0 最终门禁记录：主测试 1289 tests / 1285 pass / 0 fail / 4 skipped，第二次相同内容 dot reporter 运行正常退出（0）；扩展 46/46；`npm pack --dry-run` 成功，214 个文件。详细边界见 `docs/refactor/baseline.md`。

本 ADR 已由当前协调人 `yaozy2020` 接受为执行基线；该记录不声称多人签字。`version` 可选、`sender` 可选字段校验及断言类型改善等兼容修复已纳入契约 v1。后续字段变化必须另立 ADR，不因本次接受而免审。

## 6. 后续工作

- M1 是 G0 放行后的下一阶段；本 ADR 本身不表示 M1 或之后阶段已实施。
- M2 各核心模块只能依赖本契约，不私自增加公共字段。
- M2-F 在现有 `src/core/modules.js` 上消费模块能力声明，并补依赖解析、冲突处理、生命周期和替代实现测试。
- M3/M4 通过适配器接入真实 DSH/OneBot，不在契约层导入宿主实现。
