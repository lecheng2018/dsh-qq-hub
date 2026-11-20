import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = await mkdtemp(join(tmpdir(), 'dsh-qq-hub-pack-smoke-'))
const consumer = join(temp, 'consumer')
const npmCli = process.env.npm_execpath

function runNpm(args, cwd) {
  const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const commandArgs = npmCli ? [npmCli, ...args] : args
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32' && !npmCli,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

try {
  runNpm(['run', 'build:client'], root)
  const packed = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root))
  assert.equal(packed.length, 1, 'npm pack must create exactly one archive')
  const tarball = join(temp, packed[0].filename)
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', consumer, tarball], temp)

  const requireFromConsumer = createRequire(join(consumer, 'smoke.cjs'))
  const hostPath = requireFromConsumer.resolve('dsh-qq-hub')
  const host = await import(pathToFileURL(hostPath).href)
  assert.equal(typeof host.apply, 'function', 'package root must export the DSH apply entrypoint')

  const packageRoot = dirname(dirname(hostPath))
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const clientPath = join(packageRoot, packageJson.exports['./client'].replace(/^\.\//, ''))
  const client = await readFile(clientPath, 'utf8')
  assert.ok(client.includes('__ModuleLoader__'), 'packed client bundle must include the DSH module loader')
  assert.ok(client.includes('QQHubPage'), 'packed client bundle must include the panel entrypoint')
  process.stdout.write(`Package smoke passed: ${packed[0].filename}\n`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
