# 第三方组件署名与许可（THIRD-PARTY NOTICES）

本仓库是我们的原创作品（MIT，见 LICENSE），但部分文件从下列第三方项目移植/借鉴而来。
按各许可要求，在此逐文件署名并附许可原文。

## dsh-pet —— 桌宠（代码，MIT）

- 仓库：<https://github.com/PC2005-cloud/dsh-pet>
- npm：<https://www.npmjs.com/package/dsh-pet>
- 作者：PC2005-cloud
- 许可：MIT（Copyright (c) 2026 PC2005-cloud）

**桌宠模块（模块 id `pet`，含 `src/modules/pet/` 与桌面 Electron 客户端）不是本项目自研**，
它的设计、客户端形态与物理逻辑来自 dsh-pet。本项目的移植 / 参考范围：

| 位置 | 来源 | 说明 |
|---|---|---|
| `src/modules/pet/pet-client/physics.js` | `src/shared/physics/{spring,throw,release,squash,constants}.ts` | 去 TypeScript 化的 JS 单文件移植（弹簧跟手、软钳速、抛掷重力与反弹、松手初速、落地挤压） |
| `src/modules/pet/pet-client/main.js` | 主进程窗口/托盘/右键菜单 | 透明置顶窗、右键菜单（工具项 + 动作分类级联）、回到初始位置、托盘与单实例、长轮询与气泡流程的形态参考 |
| `src/modules/pet/pet-client/index.html` | 渲染页 | 透明窗口渲染、动画池/权重/事件驱动的播放形态参考 |
| `src/modules/pet/index.js` | pet pack 约定 | pack 目录约定、`animations`/`weights`/`events`/`physics` 配置形状、工作状态六档与碎碎念动画的中文命名约定 |
| `docs/PET_MODULE_API.md` | 文档 | 上述约定的接口文档（重写，不是原文） |

**未移植**：余额钱包、协议 / state 计数器长轮询、多宠物同屏、浏览器内 Web 版渲染——
Aurabot 只做单只宠物 + Electron 桌面客户端。

### MIT 许可原文（dsh-pet）

```text
MIT License

Copyright (c) 2026 PC2005-cloud

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

## 「大肥鱼」形象与动画素材 —— 独立仓库分发，运行时自动下载

- 来源：dsh-pet 的 pet pack（作者 PC2005-cloud）
- 许可：**CC BY-NC-SA 4.0**（署名 · 非商业 · 相同方式共享）
  <https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans>
- 作者声明原文：「大肥鱼是遵守 CC BY-NC-SA 4.0 协议的形象，不可以以任何形式商业化。」
- 本仓库**不包含**任何 `.webm` / 形象素材（体积 50MB+，不进 git）。素材放在独立素材仓库
  [dsh-aurabot-qq-mods](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq-mods)（同为 CC BY-NC-SA 4.0），
  插件启动发现 default 包缺失时**自动下载落位**到数据目录 `packs/`（地址可在面板换镜像）。
  重新分发素材（含该素材仓库）须遵守其许可：署名 + 非商业 + 相同方式共享。

## Mieksido/surfcore — 目的引擎（MIT）

- 项目：<https://github.com/Mieksido/surfcore>
- 许可：MIT
- 移植范围：`src/purpose/engine.js` 的纯逻辑核心（配置归一化、排程、素材摘要、目标假设、
  候选选择、提示词构建、回执解析、状态迁移）移植自该项目的 `src/purpose-engine.js`，
  并按 Aurabot 的模块与配置语境做了改写（接线层 `src/purpose/module.js`、独立模块
  `src/modules/purpose/index.js` 是我们为 Aurabot 新写的，不属于移植范围）。

其原许可全文如下：

```text
MIT License

Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors

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

## 其他

- `README.md` 的「致谢」一节还列出了在 DSH 插件机制上参考过思路的其他插件（MIT），那些只参考了踩坑经验，未复制代码。
