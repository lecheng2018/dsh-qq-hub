import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 把仓库里的 .githooks/ 挂成本地钩子目录（pre-push 用来拦「面板产物忘了重新构建」）。
//
// 由开发者显式执行 `npm run setup:hooks` 启用；刻意不挂进 package.json 的 `prepare`：
// 终端用户通过 DSH 插件市场（pnpm）按 Git 源安装/更新时，pnpm 会拦截任何带 `prepare`
// 的 git 依赖并要求逐次放行构建脚本，而 git hooks 对终端用户毫无用处。
// 拿不到 git（从 tarball 装、或 CI 里没 .git）、以及 git 命令失败，都不算错：
// 钩子只是本地便利，缺了它 CI 的 Verify 门禁照样兜底。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

if (!existsSync(join(ROOT, '.git'))) {
  console.error('跳过 git hooks 安装：当前目录不是 git 检出（.git 不存在）')
  process.exit(0)
}

try {
  // 没设过时 git 退出码是 1、stdout 为空，不是错误。
  const read = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (read.status !== 0 && read.status !== 1) throw new Error((read.stderr || '').trim() || 'git config 读取失败')
  const previous = (read.stdout || '').trim()
  if (previous === '.githooks') {
    console.error('git hooks 已指向 .githooks')
  } else {
    execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: ROOT })
    console.error(
      previous
        ? `git hooks 由 ${previous} 改为 .githooks（pre-push 拦面板产物不同步）`
        : 'git hooks 已指向 .githooks（pre-push 拦面板产物不同步）',
    )
  }
} catch (err) {
  console.error(`跳过 git hooks 安装：${err.message.split('\n')[0]}`)
}