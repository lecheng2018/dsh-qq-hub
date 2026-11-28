import { mkdirSync, copyFileSync, renameSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const source = fileURLToPath(new URL('../', import.meta.url))
// 数据目录口径与 src/core/store.js:dataDir() 对齐：显式环境变量优先；否则
// `plugins-data/dsh-qq-hub` 已存在（或老的 `aurabot` 不存在）就用新目录。
// 旧脚本一律落到 plugins-data/aurabot，新装用户的模块会被装到一个插件根本不读的目录里。
const pluginDataHome = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins-data')
const newDataRoot = join(pluginDataHome, 'dsh-qq-hub')
const legacyDataRoot = join(pluginDataHome, 'aurabot')
const defaultDataRoot = existsSync(newDataRoot) || !existsSync(legacyDataRoot) ? newDataRoot : legacyDataRoot
const dataRoot = process.env.DSH_QQ_HUB_DATA_DIR || process.env.AURABOT_DATA_DIR || defaultDataRoot
const target = resolve(process.argv[2] || join(dataRoot, 'modules', 'distill'))

if (resolve(source).toLowerCase() === target.toLowerCase()) {
  throw new Error('当前目录已是安装目录；更新请从 repo 中运行此命令。')
}

mkdirSync(target, { recursive: true })

const filesToCopy = ['prompt.mjs', 'verifier.mjs', 'store.mjs', 'history-miner.mjs', 'panel.js', 'package.json', 'README.md']
for (const name of filesToCopy) {
  copyFileSync(join(source, name), join(target, name))
}

// 原子生效：先写 .next 再 rename
copyFileSync(join(source, 'index.mjs'), join(target, 'index.mjs.next'))
renameSync(join(target, 'index.mjs.next'), join(target, 'index.mjs'))

console.log(`[distill] 群友蒸馏模块已安装到: ${target}`)
console.log('QQ Hub 现已自动热加载该模块，前往 Web 面板「扩展」即可查看与配置。')
