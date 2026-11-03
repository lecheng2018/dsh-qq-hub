# `dsh-aurabot-qq` 全量代码安全与稳定性审计报告

> **报告生成日期**：2026-11-02  
> **审计基准仓库**：[https://github.com/lecheng2018/dsh-aurabot-qq](https://github.com/lecheng2018/dsh-aurabot-qq)  
> **审计基准分支**：`main`（Commit: `d805381`）  
> **目标运行时**：DeepSeek Harness (DSH) 0.2.x ~ 0.3.x (Cordis 4 框架) / Node.js ≥ 22.13.0  
> **协议网关**：OneBot v11（SnowLuma / NapCat 等）

---

## 目录

- [一、 仓库基础信息](#一-仓库基础信息)
- [二、 审计范围与审计方法](#二-审计范围与审计方法)
- [三、 风险汇总总表](#三-风险汇总总表)
- [四、 详细风险清单（逐项绑定代码位置）](#四-详细风险清单逐项绑定代码位置)
  - [4.1 高危风险（Critical / High）](#41-高危风险critical--high)
  - [4.2 中危风险（Medium）](#42-中危风险medium)
  - [4.3 低危风险与潜在隐患（Low / Informational）](#43-低危风险与潜在隐患low--informational)
- [五、 修复优先级排序与落地建议](#五-修复优先级排序与落地建议)
- [六、 针对性验证方案](#六-针对性验证方案)
- [七、 审计总结与风险评级结论](#七-审计总结与风险评级结论)

---

## 一、 仓库基础信息

| 属性 | 说明 |
|:---|:---|
| **项目名称** | `dsh-aurabot-qq`（住在 QQ 里的 AI 伙伴「大肥鱼」· DSH 原生插件） |
| **架构形态** | DSH 进程内原生插件（In-Process Native Plugin），基于 `@deepseek-ai/cordis` 框架 |
| **核心特点** | 微内核 + 插件式模块体系（24个模块），具备原生交互提问、工具审批、断线补收与定时任务 |
| **代码总量** | 110+ 源码文件，约 28,000 行 JavaScript/ESM 代码 |
| **生产依赖** | 0 个外部生产 npm 依赖（纯 Node.js 内置模块：`fs`, `path`, `crypto`, `http`, `dns`, `net` 等） |
| **自动化测试** | 原生 `node --test` 套件，727 个测试用例 |

---

## 二、 审计范围与审计方法

### 2.1 审计范围
本次审计对仓库全部源码、扩展脚本、配置文件及测试辅助工具执行了无死角扫描：
1. **核心中枢与网关**：
   - 宿主与生命周期：`src/host.js`, `cordis.patch.yml`, `package.json`
   - 微内核与模块系统：`src/core/modules.js`, `src/core/config.js`, `src/core/store.js`, `src/core/bridge.js`, `src/core/redact.js`
   - 聊天中枢与策略：`src/chat/hub.js`, `src/chat/reply.js`, `src/chat/group-policy.js`, `src/chat/access.js`, `src/chat/inbound.js`
   - OneBot 客户端与底层网络：`src/onebot/client.js`, `src/core/net.js`, `src/snowluma/manager.js`
2. **状态机与权限治理**：
   - 交互提问系统：`src/chat/questions.js`
   - 通用审批流：`src/chat/approvals.js`
   - 断线补收机制：`src/chat/backfill.js`
   - 终端安全守卫：`src/security/danger.js`
3. **增强移植特性模块**：
   - `src/modules/security-lock/`（TOTP 权限锁）
   - `src/modules/token-guardian/`（上下文压缩守门员）
   - `src/modules/complete-guard/`（截断回复识别）
   - `src/modules/memory-privacy/`（记忆三层作用域隔离）
   - `src/modules/scheduler/`（全功能通用定时调度器）
4. **外部社交与多模态子系统**：
   - `src/bili/`, `src/douyin/`, `src/heybox/`, `src/song/`, `src/voice/`, `src/features/`
5. **前端交互与扩展**：
   - `client/client.js`（React 侧边栏面板）, `extensions/tieba-reader/`

### 2.2 审计方法
- 静态 AST 与规则扫描：排查无超时 fetch、裸奔 JSON.parse、子进程调用、内存未回收定时器、未捕获 Promise 等。
- 运行时控制流分析：重点审查网络重连、EOF、并发覆写（Race Condition）、死锁及超时降级。
- 边界条件与安全攻防演练分析：SSRF 穿透、本地文件越权、重放攻击、正则逃逸。

---

## 三、 风险汇总总表

| 编号 | 代码位置 | 级别 | 类型 | 风险简述 |
|:---|:---|:---:|:---:|:---|
| **H-01** | `src/heybox/site.js:516, 554` | 🔴 **高危** | **BUG** | 裸调未定义函数 `hasLogin()`，导致轮询任务抛未捕获异常中断 |
| **H-02** | `src/douyin/site.js:571-579` | 🔴 **高危** | **安全漏洞** | 驱动受控浏览器任意 URL 导航（缺乏域名校验），引发内网 SSRF |
| **H-03** | `src/song/studio.js:630, 645` | 🔴 **高危** | **稳定性缺陷** | `spawn(ffmpeg)` 提取时长/音量无超时保护，畸形流导致任务队列永久死锁 |
| **H-04** | `src/features/memory.js:307-333` | 🔴 **高危** | **BUG / 竞态** | 消息命中高频全量覆写 JSON，与后台记忆提炼产生读写竞争导致事实丢失 |
| **H-05** | `src/core/net.js:123-124` | 🔴 **高危** | **安全漏洞** | `assertPublicUrl` 校验后配置 `redirect: 'follow'`，302 跳转绕过 SSRF 防御 |
| **M-01** | `src/bili/api.js:206-222` | 🟡 **中危** | **安全漏洞 / OOM** | 头像更新无内网 IP 拦截；检查大小前调用 `arrayBuffer()`，超大流可耗尽内存 |
| **M-02** | `src/core/store.js:32-37` | 🟡 **中危** | **稳定性缺陷** | Windows 下 `renameSync` 无重试，遭遇杀毒扫描或并发锁直接抛 `EPERM` 崩溃 |
| **M-03** | `src/features/codex-auth.js:241-244` | 🟡 **中危** | **资源泄漏** | 本地 OAuth 回调端口在 `error` 分支漏调 `server.close()`，端口死锁 10 分钟 |
| **M-04** | `src/song/studio.js:782, 827` | 🟡 **中危** | **资源泄漏** | 翻唱异常时未清理独立临时音频切片目录，导致磁盘空间永久膨胀 |
| **M-05** | `src/douyin/duty.js:600-608` | 🟡 **中危** | **状态竞争** | 私信处理 `finally` 提前释放 `busy=false`，微任务重叠引发双协程操作同窗口 |
| **M-06** | `src/onebot/client.js:125-167` | 🟡 **中危** | **稳定性缺陷** | WebSocket 连接缺少应用层心跳探活，遭遇 TCP 半开连接时永久陷入“假在线” |
| **M-07** | `src/song/studio.js:363` | 🟡 **中危** | **资源泄漏** | Windows 下 `child.kill()` 无法终结子进程树（Python/uv），易留僵尸进程 |
| **L-01** | `src/core/net.js:144-150` | 🟢 **低危** | **安全隐患** | `fetchImage` 默认 `allowLocal !== false`，潜在任意本地绝对路径越权读取 |
| **L-02** | `src/voice/wav.js:12, 42-45` | 🟢 **低危** | **稳定性缺陷** | WAV `fmt` 块截断或采样率/声道为 0 时计算出 `Infinity`，抛出越界异常 |
| **L-03** | `src/features/memory.js:594, 712` | 🟢 **低危** | **容错缺陷** | 正则匹配模型输出后直接 `JSON.parse` 无保护，非标输出打断提炼流程 |
| **L-04** | `src/modules/security-lock/index.js:112` | 🟢 **低危** | **代码规范** | 模块状态文件错误调用根目录 `dataDir` 而非 `api.dataDir`，产生文件污染 |
| **L-05** | `src/heybox/site.js:17`, `codex-auth.js:148` | 🟢 **低危** | **安全隐患** | 社区 Cookie 及 OAuth refresh_token 明文以 JSON 存储，缺乏 OS 级凭据加密 |
| **L-06** | `src/douyin/browser.js:131`, `qzone.js:73` | 🟢 **低危** | **稳定性缺陷** | 少数边缘 `onebot.call` 与 `fetch` 未配置超时 Signal |
| **L-07** | `src/chat/hub.js:63, 66` | 🟢 **低危** | **内存隐患** | `turnState` 与 `mounted` 按 sessionKey 存储，缺乏长时间不活动的自动淘汰机制 |

---

## 四、 详细风险清单（逐项绑定代码位置）

### 4.1 高危风险（Critical / High）

#### 【H-01】[BUG] 裸调未定义函数 `hasLogin()` 导致定时器抛未捕获异常
- **代码位置**：`src/heybox/site.js` 第 516 行、第 554 行
- **问题描述**：在小黑盒自动化巡查任务 `runDuty` 与定时轮询 `tick` 中，代码直接调用了未定义的全局函数 `hasLogin()`。
- **根因分析**：
  ```javascript
  // src/heybox/site.js:516
  async function runDuty(opts = {}) {
    // ...
    if (!c.enabled || !c.autoBrowse || !hasLogin()) return // 抛出 ReferenceError
  ```
  `site.js` 及引用的 `api.js` 中均未定义或导出 `hasLogin` 标识符。`tick()` 每 60 秒轮询执行一次，一旦用户在面板勾选了 `autoBrowse: true`，定时器立即抛出致命异常中断执行。
- **可复现条件**：在配置中设置 `heybox.enabled = true`，勾选 `autoBrowse: true`，等待 1 分钟调度器执行 `tick()` 或手动调用 `runDuty()`。
- **修复方案**：将 `hasLogin()` 替换为模块已有的登录凭据检查逻辑：
  ```javascript
  if (!c.enabled || !c.autoBrowse || !Boolean(cookie())) return
  ```

---

#### 【H-02】[安全漏洞] 抖音受控浏览器任意 URL 导航（客户端/内网 SSRF）
- **代码位置**：`src/douyin/site.js` 第 571-579 行（触发链：`src/douyin/duty.js:457`）
- **问题描述**：主动私信功能 `directDm({ target, text })` 中，`site.profileOf(target)` 对传入的 `target` 缺乏域名白名单校验，直接驱动受控浏览器导航至该地址。
- **根因分析**：
  ```javascript
  // src/douyin/site.js:571
  if (/^https?:\/\//i.test(s)) {
    await b.goto(s) // 未校验目标域名，直接驱动浏览器访问
    for (let i = 0; i < 10; i++) {
      const href = String(await b.evaluate('location.href').catch(() => ''))
      const sec = href.match(/douyin\.com\/user\/(MS4w[\w-]+)/)?.[1]
      if (sec) return user(sec)
      await sleep(1000)
    }
  ```
  仅使用 `/^https?:\/\//i` 正则校验协议头，未限制目标域名。攻击者可通过聊天发送恶意目标链接（例如 `http://127.0.0.1:8080/admin/api` 或云元数据地址 `http://169.254.169.254/`），促使带有用户真实 Cookie、挂载 CDP 调试端口的主机 Edge/Chrome 发起网络请求，引发高危内网穿透。
- **可复现条件**：通过聊天向机器人发送特定私信指令，将目标指定为内网 HTTP 端点。
- **修复方案**：严格限制仅允许 `douyin.com` 或 `v.douyin.com` 官方域名：
  ```javascript
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      if (!/(^|\.)douyin\.com$/i.test(u.hostname)) {
        throw new Error('只支持抖音官方主页或短链')
      }
    } catch {
      throw new Error('无效的链接格式')
    }
    await b.goto(s)
  ```

---

#### 【H-03】[稳定性缺陷] `spawn(ffmpeg)` 提取时长/音量无超时保护导致任务死锁
- **代码位置**：`src/song/studio.js` 第 630-642 行（`ffprobeDuration`）、第 645-653 行（`meanVolume`）
- **问题描述**：提取音频时长和人声音量分析时，直接调用 `spawn` 执行 `ffmpeg`，完全未设置超时计时器。
- **根因分析**：
  ```javascript
  // src/song/studio.js:630
  async function ffprobeDuration(file) {
    return new Promise((resolve) => {
      const c = spawn(P().ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true })
      // 未设置 setTimeout，未监听进程 hang 死情况
      c.stderr.on('data', (b) => { s += b })
      c.on('exit', () => { ... })
      c.on('error', () => resolve(0))
    })
  }
  ```
  在翻唱主流程 `process1` 中同步 `await ffprobeDuration` 和 `await meanVolume`。如果处理包含异常元数据或损坏流的音频文件导致 ffmpeg 阻塞等待 I/O，该子进程永远不退出，Promise 永久 pending，翻唱队列 `pump()` 彻底死锁。
- **可复现条件**：点播包含畸形流、损坏头导致 ffmpeg 阻塞挂起的音频文件。
- **修复方案**：添加超时控制并强制销毁子进程：
  ```javascript
  async function ffprobeDuration(file, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const c = spawn(P().ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true })
      let s = ''
      const timer = setTimeout(() => {
        try { c.kill('SIGKILL') } catch {}
        resolve(0)
      }, timeoutMs)
      c.stderr.on('data', (b) => { s += b })
      c.on('exit', () => {
        clearTimeout(timer)
        const m = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
        resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0)
      })
      c.on('error', () => { clearTimeout(timer); resolve(0) })
    })
  }
  ```

---

#### 【H-04】[BUG / 竞态] 记忆库 `recall` 高频全量覆写导致长期记忆丢失
- **代码位置**：`src/features/memory.js` 第 307-333 行（`recall`）、第 174-177 行（`save`）
- **问题描述**：每次消息召回命中记忆时直接重新 load 全量 JSON 并全量覆写回盘；若后台 `consolidate()` 提炼新记忆时并发触发 `recall()`，后完成的写操作会彻底抹除新提炼的事实。
- **根因分析**：
  ```javascript
  // src/features/memory.js:320-330
  if (hits.length) {
    const s = load() // 重新载入全量文件
    for (const h of hits) {
      const m = s.items.find((x) => x.id === h.it.id)
      if (!m) continue
      m.hits = (m.hits || 0) + 1
      m.lastHit = Date.now()
    }
    writeJson(file(), s) // 全量覆盖写入
  }
  ```
  在日常多轮对话中，`recallHint` 触发频率极高。当后台整理任务正在调用大模型异步提炼记忆（耗时数秒到数十秒）并保存新记忆时，前台对话命中的 `recall()` 会读取旧列表并执行覆盖写入，导致新提炼的长期事实记忆被静默抹除。
- **可复现条件**：后台正在进行 `consolidate()` 提炼，前台连续发送多条触发记忆命中（recall）的消息。
- **修复方案**：
  1. 解耦命中统计与核心记忆持久化，将命中频率更新放入内存脏标记队列，防抖批量合并；
  2. 对 `memories.json` 的写操作引入互斥锁（Promise Queue / Mutex），避免全量快照脏写回。

---

#### 【H-05】[安全漏洞] `fetchImage` 重定向跟随导致 SSRF 防护失效
- **代码位置**：`src/core/net.js` 第 123-124 行
- **问题描述**：`assertPublicUrl` 仅校验了初始 URL，而随后的 `fetch` 设置了 `redirect: 'follow'`，可通过 302 重定向完全绕过内网 SSRF 防御。
- **根因分析**：
  ```javascript
  // src/core/net.js:123-124
  await assertPublicUrl(s) // 仅检查初始 URL
  const r = await fetch(s, { signal: AbortSignal.timeout(o.timeoutMs ?? 20000), redirect: 'follow' })
  ```
  攻击者可以在公网部署一个合法的域名（通过 `assertPublicUrl` 的 IP 检查），但该服务返回 `302 Found` 并将 `Location` 指向 `http://127.0.0.1:3000` 或内网路由器管理地址。Node 原生 `fetch` 在 `redirect: 'follow'` 模式下会自动追随跳转，从而绕过安全断言直达内网。
- **可复现条件**：提供一个公网服务 URL，配置该 URL 返回 302 跳转至内网 IP。
- **修复方案**：改用 `redirect: 'manual'`，若收到 3xx 响应，提取 `Location` 头递归调用 `assertPublicUrl` 进行二次安全检验后再继续请求。

---

### 4.2 中危风险（Medium）

#### 【M-01】[安全漏洞 / OOM] B 站头像更新无内网拦截且无上限读取流
- **代码位置**：`src/bili/api.js` 第 206-222 行；`src/bili/duty.js` 第 355-365 行
- **问题描述**：`setFace(imageUrl)` 未调用 `assertPublicUrl` 校验；且在校验 `buf.length > FACE_MAX` 前先执行了 `Buffer.from(await r.arrayBuffer())`。
- **根因分析**：
  ```javascript
  // src/bili/api.js:209-214
  const r = await fetchImpl(imageUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) })
  const buf = Buffer.from(await r.arrayBuffer()) // 先全量读取到堆内存
  if (buf.length > FACE_MAX) throw new Error('图片超过 2MB，B 站不收') // 后做大小检查
  ```
  既缺少 SSRF 边界拦截，又缺少内存流控保护。恶意超大响应（例如远端持续吐出数 GB 数据）将瞬间耗尽 Node.js 进程内存引发 OOM 崩溃。
- **修复方案**：引入 `assertPublicUrl` 校验，并在流式读取时检查字节计数，一旦超出 2MB 立即调用 `r.body.cancel()` 熔断并报错。

---

#### 【M-02】[稳定性缺陷] Windows 平台下 `writeJson` 原子重命名缺乏 EPERM 重试
- **代码位置**：`src/core/store.js` 第 32-37 行
- **问题描述**：在 Windows 平台下，`renameSync(tmp, file)` 在目标文件被杀毒软件或并发读句柄锁定时会直接抛出 `EPERM: operation not permitted` 致命异常。
- **根因分析**：
  ```javascript
  export function writeJson(file, value) {
    ensureDir(dirname(file))
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file) // Windows 下极易因文件锁定抛出 EPERM
  }
  ```
  Windows 文件系统在目标文件正被其他读句柄打开（如杀毒软件实时扫描、VS Code 文件索引、其他异步 `readFileSync`）时，不允许瞬间覆盖改名。
- **修复方案**：借鉴 `dsh-qq` 的做法，引入带退避重试的原子重命名机制（重试 4 次，每次间隔 25ms）：
  ```javascript
  function renameWithRetry(from, to, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
      try {
        renameSync(from, to)
        return
      } catch (err) {
        if (i === attempts - 1 || (err.code !== 'EPERM' && err.code !== 'EBUSY')) throw err
        const end = Date.now() + 25
        while (Date.now() < end) {} // 微同步让步
      }
    }
  }
  ```

---

#### 【M-03】[资源泄漏] OAuth 本地回调服务出错分支漏调 `server.close()`
- **代码位置**：`src/features/codex-auth.js` 第 241-244 行
- **问题描述**：在本地 1455 端口处理 OAuth 回调时，当收到 `error` 参数时直接 return，未调用 `server.close()`。
- **根因分析**：本地 1455 端口保持绑定直到 10 分钟定时器超时。用户在控制台重新点击登录时，由于端口被未关闭的 server 占用，抛出 `EADDRINUSE`，导致自动登录模式完全失效。
- **修复方案**：在 `if (err)` 分支内确保调用 `try { server.close() } catch {}`。

---

#### 【M-04】[资源泄漏] 翻唱任务异常时未清理独立临时目录
- **代码位置**：`src/song/studio.js` 第 782-784 行、第 827-833 行
- **问题描述**：翻唱任务创建的 `data/songs/<timestamp>/` 目录包含数个大体积音频切片（动辄数百兆），清理逻辑仅写在成功执行的分支中，报错时整个目录永久留在磁盘上。
- **修复方案**：在任务执行失败的 `catch/finally` 块中补齐对临时目录的清理逻辑。

---

#### 【M-05】[状态竞争] 抖音私信后台刷流提前释放 `busy` 锁
- **代码位置**：`src/douyin/duty.js` 第 600-608 行
- **问题描述**：`checkOwnerDms()` 在 `finally` 块中先设置了 `busy = false`，随后才异步调用 `run(...)`。在微任务排队期间，定时器可能再次进入触发重入冲突。
- **修复方案**：保持锁的持续占有，或在微任务启动前立即设置占用标记。

---

#### 【M-06】[稳定性缺陷] WebSocket 缺少应用层心跳导致半开连接假死
- **代码位置**：`src/onebot/client.js` 第 125-167 行
- **问题描述**：仅依赖底层 WS 的 `onclose` 事件判定掉线。在遭遇路由器断网或网关假死未发 FIN 时，Socket 会长达数十分钟不报错，导致机器人完全失联。
- **修复方案**：在客户端内增加 30 秒心跳包发送与应答超时检测，连续 2 次无应答主动销毁并重连。

---

#### 【M-07】[资源泄漏] Windows 下子进程超时无法杀死进程树
- **代码位置**：`src/song/studio.js` 第 363 行；`src/voice/tts.js` 第 32-35 行
- **问题描述**：Windows 环境下调用 `child.kill()` 仅向顶层进程发信号，由 Python 或 shell 派生的孙子进程继续驻留后台。
- **修复方案**：在 Windows 上超时使用 `taskkill /pid <PID> /T /F` 进行树形强杀。

---

### 4.3 低危风险与潜在隐患（Low / Informational）

#### 【L-01】[安全隐患] `fetchImage` 默认允许读取本地绝对路径
- **代码位置**：`src/core/net.js` 第 144-150 行
- **问题描述**：`o.allowLocal !== false` 为真，如果协议段传入任意文件路径（如 `C:\Windows\win.ini`），会被直接读取。建议严格限制在工作区或允许的媒体目录内。

#### 【L-02】[稳定性缺陷] WAV 畸形数据包未校验长度导致越界崩溃
- **代码位置**：`src/voice/wav.js` 第 12 行、第 42-45 行
- **问题描述**：解析缺少足够长度的 `fmt` 块时读取抛 `RangeError`；`channels = 0` 时除以 0 导致数组长度非法。

#### 【L-03】[容错缺陷] 模型输出 JSON 匹配后直接 `JSON.parse` 缺乏保护
- **代码位置**：`src/features/memory.js` 第 594 行、第 712 行
- **问题描述**：正则匹配后直接反序列化，若模型输出包含尾随逗号或未闭合引号，将抛出语法错误中断处理。

#### 【L-04】[代码规范] `security-lock` 状态文件路径错误调用根目录
- **代码位置**：`src/modules/security-lock/index.js` 第 112 行
- **问题描述**：写成 `const stateFile = () => dataDir('state.json')`，导致把文件写在插件全局根目录下，应为 `api.dataDir('state.json')`。

#### 【L-05】[安全隐患] 外部凭证未加密存储在明文 JSON
- **代码位置**：`src/heybox/site.js:17`、`src/features/codex-auth.js:148`
- **问题描述**：小黑盒 Cookie 与 ChatGPT 刷新令牌直接存放在磁盘 JSON，存在多用户主机被窃取风险。

#### 【L-06】[稳定性缺陷] 边缘调用缺少超时 Signal
- **代码位置**：`src/douyin/browser.js:131`、`src/features/qzone.js:73`、`src/features/stickers.js:138, 181`。

#### 【L-07】[内存隐患] `hub.js` 会话 Map 缺乏长时间不活动的自动淘汰机制
- **代码位置**：`src/chat/hub.js` 第 63, 66 行
- **问题描述**：`turnState` 随群聊和陌生人增加持续扩增，未做 LRU 上限限制。

---

## 五、 修复优先级排序与落地建议

```
[第 1 优先级：核心 BUG 与高危漏洞]
  ├── H-01: 修复 heybox hasLogin() 未定义报错
  ├── H-02: 修复 douyin 受控浏览器任意 URL 跳转
  ├── H-05: 修复 net.js 302 重定向 SSRF 绕过
  ├── H-03: 修复 studio.js ffmpeg 缺少超时死锁
  └── H-04: 修复 memory.js 记忆覆写并发竞态
         │
[第 2 优先级：系统稳定性与资源防泄漏]
  ├── M-02: 增强 store.js 在 Windows 下的写盘 EPERM 重试
  ├── M-03: 补全 codex-auth 错误分支的端口关闭
  ├── M-04: 补齐翻唱任务异常中断时的垃圾文件清理
  ├── M-06: 为 onebot 客户端引入应用层心跳探活机制
  └── M-07: 完善 Windows 进程树销毁 (taskkill)
         │
[第 3 优先级：健壮性提升与规范收敛]
  ├── L-04: security-lock 状态文件路径纠正为 api.dataDir()
  ├── L-02: wav.js 补齐格式与采样率边界防御
  └── L-03: memory.js 模型 JSON 解析增加 try...catch 容错
```

---

## 六、 针对性验证方案

| 验证目标 | 测试用例设计方案 | 判定成功基线 |
|:---|:---|:---|
| **H-01 验证** | 编写 `test/heybox-login.test.js`：在未登录状态下模拟调用 `tick()` 与 `runDuty()` | 不抛出 `ReferenceError`，静默优雅跳过 |
| **H-02 验证** | 模拟传入 `http://127.0.0.1:8080` 及 `https://v.douyin.com/xxx` 作为目标 | 恶意内网地址抛出域名拦截错误，官方链接正常放行 |
| **H-03 验证** | Mock 一个不发送任何输出且不退出的子进程，传入 `ffprobeDuration` | 在 15 秒后准时触发超时并强杀，函数返回 0，不阻塞队列 |
| **H-04 验证** | 编写并发用例：同时发起 10 次 `recall()` 与 1 次 `consolidate()` 保存 | 最终持久化文件中的 facts 事实条目数量无缺失、不回退 |
| **H-05 验证** | 本地构造 302 重定向路由指向 `127.0.0.1`，传入 `fetchImage` | 成功拦截 302 重定向目标为内网 IP，抛出安全拒绝异常 |

---

## 七、 审计总结与风险评级结论

### 综合安全评级：**B+（架构优良，核心防御完善，存在局部高危漏洞与单点缺陷）**

1. **架构优越性**：
   - 核心系统高度模块化，插件微内核调度机制设计极其严谨；
   - 生产环境 **零外部 npm 依赖**，从根源上杜绝了复杂的软件供应链投毒隐患；
   - 权限隔离彻底，`aurabot-social` 在 Preset 层从物理上剔除了本地高危工具，底线守卫坚固。
2. **主要缺陷分布**：
   - 缺陷主要集中在外围模块（小黑盒、抖音、音频翻唱），代码成熟度与主干聊天中枢存在一定代差；
   - 网络调用层与流式数据读取缺乏严格的二次跳转防线与内存读取限额；
   - Windows 平台下特有的文件锁定与子进程树孤儿管理缺少必要的防抖重试与强杀机制。

本报告所列出的全部 19 项风险均已准确定位到代码行号，且均具备清晰明确、低破坏性的修复路径。及时修复上述高、中危风险后，系统的工业级健壮性与安全性将全面达标。
