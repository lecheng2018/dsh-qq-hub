import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULTS } from '../src/core/config.js'
import { createDangerGuard, isDangerousCommand } from '../src/security/danger.js'

const dangerousCommands = [
  "rm -rf '/'",
  'rm -rf --no-preserve-root /',
  'rm --recursive --force --no-preserve-root /',
  'rm -r -f /',
  'sudo /bin/rm -rf --no-preserve-root /',
  'sh -c "rm -rf /"',
  'sh -c \'rm -rf "/"\'',
  "bash -lc 'rm -rf --no-preserve-root /'",
  "bash -c 'sh -c \"rm -rf /\"'",
  'find / -delete',
  'find /* -delete',
  "sh -c 'find / -delete'",
  'truncate -s 0 /*',
  'truncate --size=0 /etc/passwd',
  'chmod -R 777 /etc',
  'chmod -R 777 /etc/',
  'chmod --recursive 0777 /usr',
  `python3 -c "import os; os.system('rm -rf /')"`,
  `python3 -c 'import os; os.system("rm -rf --no-preserve-root /")'`,
  `python -c "import subprocess; subprocess.run(['rm', '-rf', '/'])"`,
  `python3 -c "import subprocess; subprocess.call('chmod -R 777 /etc', shell=True)"`,
  `python3 -c "import subprocess; subprocess.run(['sh', '-c', 'rm -rf --no-preserve-root /'])"`,
  `python3 -c "import subprocess; subprocess.run(['dd', 'if=/dev/zero', 'of=/dev/sda'])"`,
  `python3 -c "import os; os.execv('/bin/rm', ['rm', '-rf', '/'])"`,
  `python3 -c "import os; os.system('find / -delete')"`,
  `perl -e "system('rm -rf /')"`,
  `perl -e 'system("rm -rf /")'`,
  `perl -e 'system("find / -delete")'`,
  `perl -e "system('rm', '-rf', '/')"`,
  `perl -e "system('dd', 'if=/dev/zero', 'of=/dev/sda')"`,
  `perl -e "exec 'rm -rf /'"`,
]

const ordinaryCommands = [
  'ls -la /etc',
  'find /tmp -delete',
  'find ./build -name "*.tmp" -delete',
  'find /tmp -path / -delete',
  'find / -name "*.tmp" -print',
  'truncate -s 0 /tmp/cache-file',
  'truncate -s 0 /var/log/myapp.log',
  'truncate --reference /etc/passwd -s 0 /tmp/cache-file',
  'chmod -R 777 ./build',
  'chmod -R 755 /etc/myapp',
  'rm -rf /tmp/build',
  'bash -c "rm -rf /tmp/build"',
  `python3 -c "print('rm -rf /')"`,
  `python3 -c "print(\\"os.system('rm -rf /')\\")"`,
  `python3 -c "import os; os.system('ls /etc')"`,
  `python3 -c "import os; os.system('echo rm -rf /')"`,
  `python3 -c "import subprocess; subprocess.run(['find', '/tmp', '-delete'])"`,
  `perl -e 'print "ok\\n"'`,
  `perl -e "system('ls /')"`,
  `perl -e "system('echo rm -rf /')"`,
  'npm install',
  'git push origin main',
  'docker compose up -d',
  'curl https://api.example.com',
]

for (const command of dangerousCommands) {
  test(`危险命令需要确认：${command}`, () => {
    assert.ok(isDangerousCommand(command), `应识别危险命令：${command}`)
  })
}

for (const command of ordinaryCommands) {
  test(`普通命令不误报：${command}`, () => {
    assert.equal(isDangerousCommand(command), null, `不应误报：${command}`)
  })
}

test('默认主人权限与危险确认开关保持不变', () => {
  assert.equal(DEFAULTS.ownerLevel, 'full')
  assert.equal(DEFAULTS.security.dangerConfirm, false)
})

test('新增危险命令在非主人会话中全部拦截，不调用实际工具', async () => {
  const guard = createDangerGuard({
    getConfig: () => ({ security: { dangerConfirm: true } }),
    chatOfSession: () => 'private:999',
    ownerQQ: () => '10001',
  })
  for (const command of dangerousCommands) {
    const exec = { name: 'bash', arguments: { command } }
    assert.equal((await guard.preExecute(exec, () => 'NEXT')).kind, 'deny', command)
  }
})

test('危险确认默认关闭时放行，开启后对新识别命令询问主人', async () => {
  let enabled = false
  const delivered = []
  let calls = 0
  const guard = createDangerGuard({
    getConfig: () => ({ security: { dangerConfirm: enabled } }),
    deliver: async (chatId, text) => { delivered.push({ chatId, text }) },
    chatOfSession: () => 'private:10001',
    ownerQQ: () => '10001',
    timeoutMs: 1000,
  })
  const command = `python3 -c "import os; os.system('rm -rf /')"`
  const exec = { name: 'bash', arguments: { command }, agent: { session: { id: 'owner-session' } } }
  const next = () => { calls++; return 'NEXT' }

  assert.equal(await guard.preExecute(exec, next), 'NEXT')
  assert.equal(delivered.length, 0)
  enabled = true
  const pending = guard.preExecute(exec, next)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].chatId, 'private:10001')
  assert.ok(delivered[0].text.includes(command))
  assert.equal(calls, 1)
  assert.equal(guard.handleReply('private:10001', '10001', '取消'), true)
  assert.equal((await pending).kind, 'deny')
  assert.equal(calls, 1)
  const confirmed = guard.preExecute(exec, next)
  assert.equal(calls, 1)
  assert.equal(guard.handleReply('private:10001', '10001', '确认'), true)
  assert.equal(await confirmed, 'NEXT')
  assert.equal(calls, 2)
})
