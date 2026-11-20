import * as esbuild from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'client/src/entry.js')
const OUTFILE = join(ROOT, 'client/client.js')

// --check：只比对、不落盘（`npm run check:client`）。
// 存在的理由：产物和源码不同步时，`npm test` 会现场构建、测试照样全绿，只有 push 之后的
// Verify 门禁会红（2026-11-19 的 f1e6100 / bd7f993 就是这么红的：脚本改了、产物没重新提交）。
// 这里给出同一份判断，供 CI 与本地 pre-push 钩子（.githooks/pre-push）共用。
const isCheck = process.argv.includes('--check')

const BANNER = `// QQ Hub · 网页半边：侧栏「自动化任务」下面的「QQ Hub」入口 + 整页面板（顶部标签切换功能）。
// 只读写宿主半边的 /qq-hub/api/* 接口，不直接碰会话和 QQ。
// 视觉：中性底色 + 单一强调色的现代风，底色/文字跟随 DSH 主题变量（--dsw-alias-*），浅色 / 深色自动跟随。

window.__ModuleLoader__.load({
  id: 'dsh-qq-hub',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
`

const FOOTER = `
    exports.apply = apply
    exports.inject = inject
    exports.QQHubPage = QQHubPage
    exports.WhaleIcon = WhaleIcon
    return module.exports
  },
})
`

/**
 * 统一成 LF。esbuild 在 Windows 上输出 CRLF，而仓库里的 client/client.js 是 LF；
 * 不归一化的话每次 Windows 构建都会产生「整文件重写」的假 diff（几百行，评审没法看）。
 * 注意要把**所有** \r 都去掉：CSS 是当字符串内联进 bundle 的，那些 \r 落在模板字符串
 * 内部，只替换 \r\n 会漏掉它们（源码里是 \r\n，压缩后变成行内的单个 \r）。
 */
function normalizeEol(code) {
  return String(code).replace(/\r\n/g, '\n').replace(/\r/g, '')
}

/**
 * memory-panel.test.js 从产物里切出 Mood 函数体求值渲染（「记忆页必须能真跑」的回归锁），
 * 它用「/ ** 人物小档案」这条注释作为 Mood 的结束锚点，而 esbuild 会把源码注释剥掉。
 * 这里在打包后把锚点注释补回（只此一条；其余产物文本补丁已随 JSX 重构一并移除——
 * 纯函数类断言已改为直接读源码或 import 模块，不再依赖产物格式）。
 *
 * 另外补第二个锚点：`pii-scan:ignore` 豁免标记必须和它豁免的那一行**同一行**（扫描按行匹配），
 * 而 nav 的别名表在源码里是一整行、esbuild 会把它拆成每个 key 一行，行尾注释因此漂到别的行去。
 * 产物里手工贴标记 = 产物与构建结果不一致，CI 的「bundle 是否最新」门禁会红
 * （2026-11-19：main 上 caf896b 就是这样红了一次，连带所有 PR 一起红）。
 * 所以在构建阶段把它挂回 token 别名那一行，产物与源码从此自洽。
 */
function postProcess(code) {
  return code
    .replace(/\nfunction ProfilesList\(/, '\n/** 人物小档案：她对每个人的一小段印象，聊天时常驻。 */\nfunction ProfilesList(')
    // 先摘掉所有**独占一行**的标记（esbuild 把源码行尾注释拆出去的结果），
    // 再把它挂到真正被豁免的 token 别名那一行末尾。
    .replace(/\n[ \t]*\/\*!? ?pii-scan:ignore ?\*\/[ \t]*(?=\n)/g, '')
    .replace(
      /([ \t]*token: "token 用量[^"\n]*",)/,
      '$1 /* pii-scan:ignore */',
    )
}

/**
 * 比对「磁盘上的产物」和「现场构建的结果」，一致才算过关。
 * 不一致时打印第一处差异（够定位就行，完整 diff 让用户自己 `git diff -- client/client.js` 看），
 * 以 exit 1 结束——CI 里 `::error::` 会变成一条注解。
 */
function check(processed) {
  let current = ''
  try {
    current = readFileSync(OUTFILE, 'utf8')
  } catch {
    // 产物还没生成：下面按「完全不一致」报。
  }

  if (current === processed) {
    console.log(`✅ client/client.js 与构建结果一致（${(processed.length / 1024).toFixed(1)} KB）`)
    return
  }

  if (!current) {
    console.error('::error::client/client.js 缺失：请在本地运行 npm run build:client 并提交产物')
    process.exitCode = 1
    return
  }

  const disk = current.split('\n')
  const built = processed.split('\n')
  let line = 0
  while (line < disk.length && line < built.length && disk[line] === built[line]) line++
  const clip = (s) => (s === undefined ? '(文件已结束)' : s.length > 200 ? `${s.slice(0, 200)}…` : s)

  console.error('::error::client/client.js 与 client/src 不同步：请在本地运行 npm run build:client 并提交产物')
  console.error(`最先在第 ${line + 1} 行不同（磁盘 ${disk.length} 行 / 构建 ${built.length} 行）：`)
  console.error(`  - ${clip(disk[line])}`)
  console.error(`  + ${clip(built[line])}`)
  console.error('确认无误后运行 `npm run build:client`，把重新生成的 client/client.js 一起提交。')
  process.exitCode = 1
}

async function build() {
  const isWatch = process.argv.includes('--watch')
  if (isWatch && isCheck) throw new Error('--check 与 --watch 不能同时使用：检测模式只比对、不落盘')

  const buildOptions = {
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    write: false,
    format: 'cjs',
    target: ['es2022'],
    charset: 'utf8',
    external: ['react'],
    loader: { '.css': 'text', '.js': 'jsx' },
    // 经典 JSX 转换：h 是 core/react.js 导出的 React.createElement，Fragment 同源。
    // （不用 automatic runtime：那会 import 'react/jsx-runtime'，宿主的 require 里没有这层。）
    jsx: 'transform',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    banner: { js: BANNER },
    footer: { js: FOOTER },
  }

  if (isWatch) {
    const ctx = await esbuild.context({
      ...buildOptions,
      plugins: [
        {
          name: 'write-plugin',
          setup(build) {
            build.onEnd((result) => {
              if (result.errors.length === 0 && result.outputFiles?.[0]) {
                const processed = postProcess(normalizeEol(result.outputFiles[0].text))
                writeFileSync(OUTFILE, processed, 'utf8')
                console.log(`[${new Date().toLocaleTimeString()}] ⚡ Client rebuilt successfully.`)
              }
            })
          },
        },
      ],
    })
    await ctx.watch()
    console.log('⚡ Watching client/src/** -> client/client.js...')
  } else {
    const result = await esbuild.build(buildOptions)
    const code = result.outputFiles[0].text
    const processed = postProcess(normalizeEol(code))
    if (isCheck) {
      check(processed)
      return
    }
    writeFileSync(OUTFILE, processed, 'utf8')
    console.log(`✅ Built client/client.js successfully (${(processed.length / 1024).toFixed(1)} KB)`)
  }
}

build().catch((err) => {
  console.error('Build failed:', err)
  process.exit(1)
})
