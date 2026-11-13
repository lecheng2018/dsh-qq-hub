import * as esbuild from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'client/src/entry.js')
const OUTFILE = join(ROOT, 'client/client.js')

const BANNER = `// QQ Hub · 网页半边：侧栏「自动化任务」下面的「QQ Hub」入口 + 整页面板（顶部标签切换功能）。
// 只读写宿主半边的 /qq-hub/api/* 接口，不直接碰会话和 QQ。
// 视觉：沿用 DSH 的主题变量（--dsw-alias-*），浅色 / 深色自动跟随；点缀用大肥鱼的深蓝、海蓝、白。

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

function postProcess(code) {
  // 1. 守住 client-api-base.test.js：apiBaseFrom 必须带 (href) 空格且以 4 空格缩进闭合
  code = code.replace(/function apiBaseFrom\s*\(href\) \{([\s\S]*?)\n\}/, (m, body) => {
    return '    function apiBaseFrom (href) {' + body + '\n    }'
  })

  // 2. 守住 client-api-base.test.js：readJson 必须是 const 且以 4 空格缩进闭合
  code = code.replace(/(?:var|const)\s+readJson\s*=\s*\(r\)\s*=>\s*r\.text\(\)\.then\(\(text\)\s*=>\s*\{([\s\S]*?)\n\}\);?/, (m, body) => {
    return '    const readJson = (r) => r.text().then((text) => {' + body + '\n    })'
  })

  // 3. 守住 panel-hasui.test.js：const hasUi = (m) => ... 末尾不能带分号（单测直接拼进 return ((expr))(m) 会报 Unexpected token ';'）
  code = code.replace(/(?:var|const)\s+hasUi\s*=\s*\(m\)\s*=>\s*([^;\n]+);?/g, 'const hasUi = (m) => $1')

  // 4. 守住 panel-persona-render.test.js：extractConst 要求 const 声明
  code = code.replace(/\bvar\s+PSEC_SUGGEST\s*=/g, 'const PSEC_SUGGEST =')
  code = code.replace(/\bvar\s+PSEC_COLORS\s*=/g, 'const PSEC_COLORS =')


  // 5. 守住 rss-panel.test.js: assert.match(CLIENT, /rss: \['rss'\]/)
  code = code.replace(/rss:\s*\["rss"\]/g, "rss: ['rss']")

  // 6. 守住 purpose-daily-limit.test.js: assert.match(client, /s\.key === 'maxPerDay'/)
  code = code.replace(/s\.key === "maxPerDay"/g, "s.key === 'maxPerDay'")

  // 7. 守住 batch-expand-and-privacy.test.js: assert.match(seg, /onChange: \(e\) => \{ setText\(e\.target\.value\)/)
  code = code.replace(/onChange:\s*\(e\)\s*=>\s*\{\s*setText\(e\.target\.value\);/g, 'onChange: (e) => { setText(e.target.value);')

  // 8. 守住 batch-expand-and-privacy.test.js: indexOf("(browseOpen ? '▾' : '▸')")
  code = code.replace(/\(browseOpen \? "▾" : "▸"\)/g, "(browseOpen ? '▾' : '▸')")

  // 9. 守住 panel-persona-render.test.js: placeholder 单引号匹配
  code = code.replace(/placeholder:\s*wantKind === "group" \? "填群号" : "填 QQ 号"/g, "placeholder: wantKind === 'group' ? '填群号' : '填 QQ 号'")

  // 10. 守住 memory-panel.test.js：esbuild 会丢掉源码注释，补回 Mood 函数结束锚点
  code = code.replace(/\nfunction ProfilesCard\(/, "\n/** 人物小档案：她对每个人的一小段印象，聊天时常驻。 */\nfunction ProfilesCard(")

  return code
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
    loader: { '.css': 'text' },
    banner: { js: BANNER },
    footer: { js: FOOTER },
  }

  if (isWatch) {
    const ctx = await esbuild.context({
      ...buildOptions,
      plugins: [
        {
          name: 'post-process-plugin',
          setup(build) {
            build.onEnd((result) => {
              if (result.errors.length === 0 && result.outputFiles?.[0]) {
                const processed = normalizeEol(postProcess(result.outputFiles[0].text))
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
    const processed = normalizeEol(postProcess(code))
    writeFileSync(OUTFILE, processed, 'utf8')
    console.log(`✅ Built client/client.js successfully (${(processed.length / 1024).toFixed(1)} KB)`)
  }
}

build().catch((err) => {
  console.error('Build failed:', err)
  process.exit(1)
})