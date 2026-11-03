// fnOS 目录耐久性同步容错补丁
//
// 背景：
//   在飞牛 OS (fnOS) 上，/vol1 与 /vol1/@appshare（以及 /vol2/@appshare）等祖先目录被设为 mode 000，
//   只由内核 trim_acl 授予遍历，非 root 进程无法以 O_RDONLY open() 祖先目录。
//   DSH 官方 attachment 服务的 LocalAttachmentStore 在保存图片时会调用 syncDirectory(parent)
//   一层层向上 open() 祖先目录做 fsync 耐久性同步。
//   由于 .pnpm 包中的代码未包裹 try/catch，遇到 /vol2/@appshare 时会抛出：
//     EACCES: permission denied, open '/vol2/@appshare'
//   导致 admitPromptContent() 整体失败；下游适配层继而因为缺失 attachment 对象抛出：
//     Cannot read properties of undefined (reading 'attachmentId')
//
// 本补丁拦截 fsPromises.open 在 O_RDONLY 模式下的 EACCES / EPERM 错误，返回空操作 handle，
// 既保证了合法子目录的正常落盘与同步，又避免不可读的系统级祖先目录掐断图片登记链路。
//
// ⚠ 关键实现细节（踩过坑，别改回去）：
//   附件服务的代码是 `import { open } from "node:fs/promises"` —— ES 模块的**具名导入**绑定的是
//   内建模块的实时绑定，不是 `fsPromises` 默认导出对象上的属性。所以单纯写
//   `fsPromises.open = 新函数` 对附件服务**完全无效**（实测仍抛 EACCES）。必须：
//     1) 用 createRequire 拿到 CJS 的 `require("fs").promises` 对象并改它的 open —— 这个对象
//        才是 ESM 具名导出的真正数据源；
//     2) 改完调 syncBuiltinESMExports()，把新值推进已经创建好的 ESM 命名空间。
//   两步缺一不可：只做 1 不做 2，已经 import 过的模块看不到新函数；只做 2 不做 1 则没有可同步的新值。

import fs, { statSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'

let patched = false

/** 造一个什么都不做的 handle，让 syncDirectory 的 open→sync→close 走完而不抛错。 */
function noopHandle() {
  return {
    sync: async () => {},
    close: async () => {},
  }
}

export function patchFnosFsync() {
  if (patched) return true
  patched = true

  let promises
  try {
    const require = createRequire(import.meta.url)
    promises = require('fs').promises
  } catch {
    return false // 拿不到 CJS 的 fs.promises，没法打补丁；调用方按没修补处理
  }
  const origOpen = promises.open
  if (typeof origOpen !== 'function') return false

  promises.open = function (path, flags, mode) {
    return origOpen.call(this, path, flags, mode).catch((err) => {
      // 只兜「只读打开**目录**做 fsync」这一种：不可读的祖先目录本就没法同步，跳过即可。
      // 必须判 isDirectory：普通文件只读失败（无读权限）如果也返回空 handle，
      // 会让调用方拿着假 handle 继续读，掩盖真正的权限/数据问题。
      if (err && (err.code === 'EACCES' || err.code === 'EPERM') && flags === fs.constants.O_RDONLY) {
        try {
          if (statSync(path).isDirectory()) return noopHandle()
        } catch { /* 路径本身也探不到：照常抛，不兜 */ }
      }
      throw err
    })
  }

  try {
    syncBuiltinESMExports()
  } catch {
    // 该 API 缺失或改名时，补丁对「还没 import 过 fs/promises」的模块仍然有效，不致命
  }
  return true
}

/** 测试与自检用：模拟附件服务 syncDirectory 的调用形状，返回是否成功拿到可 sync 的 handle。 */
export async function trySyncDirectory(path) {
  const { open } = await import('node:fs/promises')
  const handle = await open(path, fs.constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  return true
}
