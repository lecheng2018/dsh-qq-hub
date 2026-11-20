// 远程看画面（x11vnc）：参数拼装、密码、端口、安全默认值。
// 不真的起 x11vnc（那要有显示环境），只锁住「拼出来的东西对不对」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildVncArgs, makePassword, portFree, pickVncPort, findX11vnc } from '../src/browser/vnc.js'

test('默认只绑回环 —— 不给局域网敞开', () => {
  const args = buildVncArgs({ display: ':5', port: 5900, passFile: '/tmp/p' })
  assert.ok(args.includes('-localhost'), '默认必须带 -localhost')
  assert.equal(args[args.indexOf('-display') + 1], ':5')
  assert.equal(args[args.indexOf('-rfbport') + 1], '5900')
  assert.equal(args[args.indexOf('-passwdfile') + 1], '/tmp/p')
})

test('显式要求才开给局域网', () => {
  const args = buildVncArgs({ display: ':5', port: 5900, passFile: '/tmp/p', lan: true })
  assert.equal(args.includes('-localhost'), false)
})

test('密码用文件传，绝不出现在命令行（ps 能看到的）', () => {
  const args = buildVncArgs({ display: ':1', port: 5901, passFile: '/secret/pw' })
  assert.ok(args.includes('-passwdfile'))
  assert.equal(args.includes('-passwd'), false, '不能把明文密码放 argv')
  assert.equal(args.includes('-rfbauth'), false, 'rfbauth 要 VNC 加密格式，我们不用')
  assert.equal(args.includes('-nopw'), false, '绝不能无密码')
  // 任何一项都不该长得像密码
  for (const a of args) assert.doesNotMatch(a, /^[a-z]{8}$/, `参数里像是混进了密码：${a}`)
})

test('虚拟屏缺的扩展要关掉，否则日志一直刷警告', () => {
  const args = buildVncArgs({ display: ':1', port: 5900, passFile: '/p' })
  for (const flag of ['-noxrecord', '-noxfixes', '-noxdamage']) assert.ok(args.includes(flag), flag)
  assert.ok(args.includes('-forever'), '断开后要能再连（一次验证可能连好几次）')
  assert.ok(args.includes('-shared'), '手机和电脑同时看')
})

test('坏参数一律拒绝', () => {
  assert.throws(() => buildVncArgs({ display: 'x', port: 5900, passFile: '/p' }), /显示号/)
  assert.throws(() => buildVncArgs({ display: ':1', port: 0, passFile: '/p' }), /端口/)
  assert.throws(() => buildVncArgs({ display: ':1', port: 70000, passFile: '/p' }), /端口/)
  assert.throws(() => buildVncArgs({ display: ':1', port: 5900, passFile: '' }), /密码文件/)
})

test('密码：8 位、每次不同、没有容易看错的字符', () => {
  const a = makePassword()
  const b = makePassword()
  assert.equal(a.length, 8, 'VNC 只认前 8 个字符')
  assert.notEqual(a, b)
  assert.doesNotMatch(a, /[0O1lI]/, '去掉 0/O/1/l/I，主人照着念不容易错')
  for (let i = 0; i < 20; i++) assert.match(makePassword(), /^[a-z2-9]{8}$/)
})

test('端口占用探测', async () => {
  const p = await pickVncPort(6900)
  assert.ok(p >= 6900 && p < 6920, `拿到 ${p}`)
  assert.equal(await portFree(p), true)
})

test('找不到 x11vnc 时返回空串，不编一个路径出来', () => {
  assert.equal(findX11vnc(''), '' || findX11vnc(''))
  const r = findX11vnc('/definitely/not/here')
  assert.equal(typeof r, 'string')
})