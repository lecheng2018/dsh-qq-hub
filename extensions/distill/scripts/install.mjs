import { mkdirSync, copyFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const source = fileURLToPath(new URL('../', import.meta.url))
const dataRoot = process.env.DSH_QQ_HUB_DATA_DIR || process.env.AURABOT_DATA_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins-data', 'aurabot')
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
