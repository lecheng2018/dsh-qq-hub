import * as esbuild from 'esbuild'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'client/src/entry.js')
const OUTFILE = join(ROOT, 'client/client.js')

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
 */
function postProcess(code) {
  return code.replace(/\nfunction ProfilesCard\(/, '\n/** 人物小档案：她对每个人的一小段印象，聊天时常驻。 */\nfunction ProfilesCard(')
}

async function build() {
  const isWatch = process.argv.includes('--watch')

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
    writeFileSync(OUTFILE, processed, 'utf8')
    console.log(`✅ Built client/client.js successfully (${(processed.length / 1024).toFixed(1)} KB)`)
  }
}

build().catch((err) => {
  console.error('Build failed:', err)
  process.exit(1)
})
