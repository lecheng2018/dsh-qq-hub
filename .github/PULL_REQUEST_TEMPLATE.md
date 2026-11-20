## 变更说明

说明本 PR 解决的问题、行为变化和实现方案。

## 验证

- [ ] `npm run lint`
- [ ] `npm run test:all`（包含回归测试）
- [ ] `npm run build:client`；面板产物已提交且同步
- [ ] `npm run pack:check`
- [ ] `npm run benchmark`（正确性通过；性能数据仅作参考）
- [ ] `npm run smoke:pack`

未运行的检查及原因：

## 接口与数据影响

- 公共模块 API / HTTP / 面板接口兼容性：
- 配置、持久化格式和迁移影响：
- 权限、外部副作用及回滚方式：

## 安全与隐私

- [ ] 未加入真实令牌、Cookie、QQ 个人信息或未脱敏消息
- [ ] 已检查日志、测试产物和 CI artifact 的敏感数据
- [ ] 需要真实 DSH/OneBot/QQ 验收时，已按 runbook 单独取得批准；常规 CI 不连接真实账号
