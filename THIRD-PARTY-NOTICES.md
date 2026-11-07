# 第三方组件署名与开源许可声明（THIRD-PARTY NOTICES）

本项目（**DSH-QQ-Hub**）是基于 MIT 许可证分发的开源软件（见 [LICENSE](LICENSE)）。
在项目开发与演进过程中，本项目衍生自、移植了或参考了下列优秀的第三方开源项目。

根据各项开源许可证（特别是 MIT 许可证第 12-13 行）的强制性合规要求，在此完整记录各上游及依赖组件的原作者版权声明、许可证文本及具体衍生/移植范围。

---

## 1. 上游源项目：dsh-aurabot-qq（MIT）

- **项目主页**：<https://github.com/aureth-labs/dsh-aurabot-qq>
- **原作者**：accomplish07zrh-eng 及 Aurabot 贡献者
- **原始许可证**：MIT License（Copyright (c) 2026 Aurabot contributors）

### 衍生与独立演进说明
本项目（DSH-QQ-Hub）最初脱胎于该项目。我们保留了其优秀的拟人化微内核架构与多模态交互底子（QQ 网关抽象、回复拆条延时仿真、语音、表情包、空间日记、B站/抖音/小黑盒等），并在此基础上实施了重度架构升维与派活能力注入：
- 完整接入 DSH `userQuestions` 交互式多选提问状态机（`ask_user_question`）；
- 完整接入 DSH `approval/request` 通用工具审批流与私聊审批卡；
- 引入断线离线消息自动补收与安全命令隔离（`backfill`）；
- 引入全功能通用定时调度器引擎（`scheduler` / `/remind`）；
- 引入 RFC 6238 TOTP 手机动态口令权限锁（`security-lock`）及 DSH 增强五件套；
- 引入 10 大平台内容无水印解析引擎（`multi-parser`）；
- 完成全量代码安全审计并修复了 16 项高/中危缺陷。

由于功能边界与架构定位已从轻量社交闲聊演进为工业级 QQ Agent 综合交互终端，本项目正式脱离原 Fork 关系独立分化维护。

### 原始 MIT 许可证文本
```text
MIT License

Copyright (c) 2026 Aurabot contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. astrbot_plugin_multi_parser —— 多平台内容解析器（MIT）

- **项目主页**：<https://github.com/Qfxaile/astrbot_plugin_multi_parser>
- **原作者**：Qfxaile
- **原始许可证**：MIT License（Copyright (c) 2026 Qfxaile）

### 移植范围
本项目中 `src/modules/multi-parser/` 模块的解析逻辑、正则表达式规则库、短链追踪策略及视频直链嗅探思路移植并改写自该项目：
- 覆盖平台：Bilibili、微博、小红书、知乎、微信公众号、百度贴吧、番茄小说、GitHub、抖音、小黑盒；
- 本项目采用纯 Node.js / ESM 原生重写，去除了原项目的 Python 环境依赖，并深度打通了 DSH 会话的 `feedToAi` 大模型上下文注入机制。

### 原始 MIT 许可证文本
```text
MIT License

Copyright (c) 2026 Qfxaile

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. dsh-qq —— 外部桥接能力与特性机制（MIT）

- **项目主页**：<https://github.com/h-D-ACE/dsh-qq> / <https://github.com/Derpyu520/qq-bridge>
- **原作者**：h-D-ACE / Derpyu520 及 qq-bridge 贡献者
- **原始许可证**：MIT License

### 移植与借鉴范围
本项目中以下核心生产力机制的思想、算法及设计规范移植自该项目：
- `src/chat/backfill.js`：心跳断档追踪、历史消息筛选与命令隔离安全逻辑；
- `src/modules/scheduler/`：全功能定时调度引擎、Cron 表达式解析器及 `/remind` 指令设计；
- `src/modules/security-lock/`：RFC 6238 TOTP 手机动态口令验证及 30 分钟降权时间锁；
- `src/modules/token-guardian/`：会话上下文 Token 估算与自动 Compaction 触发机制；
- `src/modules/memory-privacy/`：记忆三层作用域隔离；
- ~~`src/modules/slang-learner/`：群黑话收集与审核流程~~（该模块后续已从本项目移除，此条保留用于说明移植来源）；
- `src/core/store.js`：Windows 下 `renameWithRetry` 容错重试机制。

### 原始 MIT 许可证文本
```text
MIT License

Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors
Copyright (c) 2026 h-D-ACE

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 4. 「大肥鱼」形象与动画素材（CC BY-NC-SA 4.0）

- **来源**：dsh-pet 的 pet pack（作者：PC2005-cloud）
- **许可证**：[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)（署名 · 非商业 · 相同方式共享）
- **原作者声明**：“大肥鱼是遵守 CC BY-NC-SA 4.0 协议的形象，不可以以任何形式商业化。”
- **分发边界**：本项目源码仓库只分发静态默认头像（`assets/dafeiyu.jpg`）；桌宠模块及其动画素材管道已移除。任何重新分发素材的行为均须严格遵守原作者的非商业与署名要求。

---

## 5. Mieksido/surfcore —— 目的引擎（MIT）

- **项目主页**：<https://github.com/Mieksido/surfcore>
- **原始许可证**：MIT License（Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors）
- **移植范围**：`src/purpose/engine.js` 的纯逻辑核心（配置归一化、排程、素材摘要、目标假设、候选选择、回执解析）。

---

## 6. 其他思路借鉴与致谢

在 DSH 插件机制与生态踩坑上，还参考了 [Yuuyuko-uu](https://github.com/Yuuyuko-uu) 等开源贡献者的实践分享，特此致谢！
