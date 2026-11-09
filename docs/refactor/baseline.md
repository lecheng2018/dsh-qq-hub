# 模块化重构基线记录

## 执行基线

- 远端主线：`origin/main`。
- 实际基线 commit：`2be1be63abaa02adb73a50d72117ce5afcb26a50`。
- 本地工作分支：`refactor/modular-core`。
- package 版本：1.3.64；未修改版本号。
- 本机 Node：v24.22.1。
- 基线验证时尚未推送；未打 tag、未发布、未修改生产环境。远端分支创建状态以仓库分支页为准。

## 与调查基线的差异

调查基线为 `51b334cf91a9119c022d6c016d63446385ebd52e`。实际基线新增了 host 分层重构：

- 根 `src/host.js` 从 1638 行缩减为 405 行组合根。
- 管道装配迁至 `src/host/pipeline.js`。
- 面板路由迁至 `src/host/panel/`。
- 网关、模型和宿主副作用分别迁至 `src/host/gateway.js`、`models.js`、`effects.js`。

后续 Integration 必须独占 `src/host.js` 和整个 `src/host/`，不能继续按旧根 host 行号提交补丁。

## 改动前基线结果

### 主测试

命令：`npm test`。

结果：未通过且未正常收尾。输出中有 18 个失败标记，最后一条用例后进程长期无进展，已停止该测试进程。没有完整最终统计，不能写成“基线测试通过”。

失败中同时存在：

- 多项面板、记忆和模块静态/行为断言失败。
- 当前工作路径包含中文时，部分测试把 URL pathname 直接当文件路径，出现 `%E4%B8%8B...` 的 ENOENT；这类环境相关问题需要单独分类，不能与其他失败混为一谈。

这些均为地基改动前观察到的基线问题，本任务未修复或删除相关测试。

### 扩展测试

首次直接运行 `node --test "extensions/**/*.test.mjs"`：18 项中 13 过、5 失败，原因是扩展自己的 `cheerio`/`esbuild` 依赖未安装。

执行既有 lockfile 的 `npm ci --prefix extensions/tieba-reader` 后，扩展测试为 46/46 通过。根测试脚本与 CI 因此必须显式安装扩展测试依赖。

### 打包

`npm pack --dry-run` 成功，基线 tgz 内容 218 个文件，未实际生成或发布 tgz。

## 地基改动后的针对性验证

- 新契约测试：15/15 通过，包含当前全部内置模块兼容校验。
- 新契约 + runtime loader：40/40 通过。
- 既有模块/生命周期/数据隔离相关测试：58/58 通过。
- 扩展测试：46/46 通过。
- `npm run pack:check` 成功，tgz 内容 222 个文件，新增契约实现与类型声明均进入包。

这些测试范围有重叠，数量不能相加为唯一用例总数。全量主测试的既有失败仍使 G0 保持未放行。

## M0-2 全量基线分类与修复（2026-11-08，单人体 QA 执行）

### 逐文件分类结果（Windows 10 / Node v22.20.0 / commit 8115132 内容，142 文件）

- **PASS 136 / FAIL 4 / TIMEOUT 2**。整跑 `node --test test/**/*.test.js` 另复现「最后一条用例后长期无进展」（与前基线记录一致）。
- 分类（按 M0-2 要求，环境问题与业务失败分开）：

| 类别 | 文件 | 根因 | 处置 |
|---|---|---|---|
| 环境类（URL.pathname 当路径） | batch-expand-and-privacy(7 fail)、fnos-fsync-patch(1 fail)；另 21 个文件用 ASCII 专用 replace hack，中文路径下失效 | `new URL('..', import.meta.url).pathname` 在 Windows 产生 `/C:/...`，join 后成 `C:\C:\...` | 23 文件统一改 `fileURLToPath`（跨平台/Unicode 一致，不删测试不改断言） |
| 测试自述纪律违背 | runtime-loader(2 fail) | isDocker 两用例没注入 `platform:'linux'`，依赖宿主是 Linux | 补注入（对齐文件头「全部注入」纪律） |
| 生产缺陷（测试卡住） | douyin-media、media-cleanup（用例全过但进程 121s 不退，实测 121s exit 0） | `src/douyin/media.js` downloadVideo 在 fetch reject 路径漏 clearTimeout，120s abort 定时器钉住事件循环——也是前基线「长期无进展」的根因 | try/finally 清理（语义不变）；生产每次下载失败不再延迟进程退出 |
| 环境敏感断言 | kernel-legacy-fallback(1 fail) | P99 全链绝对值 ≤1.5ms 的兜底线与 RFC「增量 ≤1.5ms」验收线自相矛盾（裸 compose 基线在慢机 >1.5ms） | 兜底改「基线+1.5ms」，增量硬断言一字不动；加噪声守卫（空管道 P99>1ms 显式 skip 并记录实测值） |
| POSIX 专有语义 | fnos-fsync-patch 第 122 行用例 | chmod 0o000→EACCES 是 POSIX 语义，Windows 不复现 | 按平台门控 skip（与同文件 ATT_LIB 门控设计一致） |
| 负载敏感等待预算 | chat-model(并行时偶发) | 全量并行高负载下 10s 轮询窗口不够 | 等待窗口 10s→30s（「条件最终成立」断言不变） |

### 修复后全量结果（同一 commit 两次一致，M0-2 验收）

- 轮 2：`node --test test/**/*.test.js` → **1287 tests / 1283 pass / 0 fail / 4 skip（均为有据可查的环境门控）/ 182s，干净退出**。
- 轮 3：同命令 → 1288 tests（含新增 M1-B 锁定测试 1 文件，其 tooOld 用例当时红=缺陷复现）/ 其余全绿。
- 扩展测试：46/46 通过（`npm ci --prefix extensions/tieba-reader` 后）。
- `npm run pack:check`：成功，tgz 214 个文件（222→214 的差异来自 main 在基线后移除桌宠服务的 4b9bba59，非打包回归）。

### G0 复核记录

- 基线可重复：✅（两次全量一致；修复使 Windows/POSIX/CI 结果可一致）
- M0-3 功能矩阵：✅（`docs/refactor/feature-matrix.md`，23 模块全部有归属；桌宠为 main 移除的既有事实，非本重构行为）
- M0-4 契约冻结：✅（ADR-0001 转 Accepted，会签记录见 ADR §7）
- M0-5 看板与队列：✅（`docs/refactor/board.md`）
- 未改变生产行为：✅（除 media.js 定时器泄漏修复——纯资源清理，无行为变化；面板防护为 M1-A 范围）
