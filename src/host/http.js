// QQ Hub · 面板 HTTP 小工具（host.js 分层拆出：纯工具层，不持有任何业务状态）
//
// host.js 只保留「装配」，请求应答的小件都从这里出：send 统一应答头、readBody/readRaw
// 读请求体、query 解析查询串、answer 兜住 handler 抛错、route 把登记包进 ctx.effect。

import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'

import { redact } from '../core/redact.js'
import { createPanelGuard } from './panel/guard.js'

/**
 * 打开系统文件管理器到某个目录（面板「打开文件夹」按钮共用）。
 *
 * P0：spawn 的 'error' 事件**必须**有监听者。Linux/fnOS 上没有 explorer.exe，
 * 无监听的 ENOENT 会以未捕获异常直接打崩整个 DSH 宿主进程。
 * 无桌面会话（没有 DISPLAY / WAYLAND_DISPLAY）时干脆不 spawn，只回报目录路径。
 *
 * @param {string} dir 目标目录（不存在会自动建）
 * @param {{platform?:string, env?:object, spawnFn?:Function, log?:object}} [o]
 * @returns {{ok:boolean, headless?:boolean, dir?:string, message:string}}
 */
export function openLocalFolder(dir, { platform = process.platform, env = process.env, spawnFn = spawn, log } = {}) {
  const target = String(dir)
  mkdirSync(target, { recursive: true })
  if (platform === 'linux' && !env?.DISPLAY && !env?.WAYLAND_DISPLAY) {
    return { ok: true, headless: true, dir: target, message: `目录路径：${target}（当前为无桌面 Linux 环境，请直接访问该路径）` }
  }
  const [cmd, args] = platform === 'win32'
    ? ['explorer.exe', [target]]
    : platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]]
  try {
    const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore' })
    // 必须挂 error 监听：没有它，子进程不存在时的 ENOENT 会冒到 process 上直接崩宿主。
    child?.on?.('error', (err) => {
      log?.warn?.(`打开文件夹失败（${cmd}）：${err?.message || err}。目录路径：${target}`)
    })
    child?.unref?.()
  } catch (error) {
    log?.warn?.(`打开文件夹失败（${cmd}）：${error?.message || error}。目录路径：${target}`)
    return { ok: true, headless: true, dir: target, message: `目录路径：${target}` }
  }
  return { ok: true, message: '打开了' }
}

/**
 * @param {object} o
 * @param {object} o.ctx DSH 插件上下文（route 登记 webServer 要用）
 * @param {string} o.prefix 接口前缀（/qq-hub/api）
 * @param {() => object} o.getConfig 面板防护每请求现读配置（Host 白名单热生效）
 * @param {(req: object) => boolean} [o.isAuthorized] 开放 HTTP 接口鉴权（联动密钥校验）
 * @param {object} [o.log] 防护拒绝时的 debug 日志出口
 */
export function createHttpKit({ ctx, prefix, getConfig = () => ({}), isAuthorized, log }) {
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    try {
      res.statusCode = code
      res.setHeader?.('content-type', type)
      res.setHeader?.('cache-control', 'no-store')
      res.end?.(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    } catch (error) {}
  }
  // JSON 请求体上限（缺陷：readBody 无大小上限，可被大 POST 打爆内存）。
  const MAX_BODY_BYTES = 2 * 1024 * 1024
  const readBody = async (req) => {
    let s = ''
    let n = 0
    let tooBig = false
    try {
      for await (const c of req) {
        n += Buffer.isBuffer(c) ? c.length : Buffer.byteLength(String(c))
        if (n > MAX_BODY_BYTES) { tooBig = true; break }
        s += c
      }
    } catch (error) {}
    if (tooBig) throw new Error('请求体太大了（最多 2MB）')
    try { return JSON.parse(s || '{}', (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype') ? undefined : v) } catch (error) { return {} }
  }
  /** 原样读请求体（上传大文件用），超过 max 字节就报错。 */
  const readRaw = async (req, max) => {
    const parts = []
    let n = 0
    for await (const c of req) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
      n += b.length
      if (n > max) throw new Error(`文件太大了（最多 ${Math.round(max / 1024 / 1024)}MB）`)
      parts.push(b)
    }
    return Buffer.concat(parts)
  }
  const query = (req) => {
    try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams) } catch (error) { return {} }
  }
  const answer = async (res, fn) => {
    try {
      const r = await fn()
      if (r !== undefined) send(res, 200, r)
    } catch (error) {
      send(res, 200, { ok: false, message: redact(String(error && error.message ? error.message : error)) })
    }
  }
  // 核心自己的接口登记成精确路径；模块的接口都走一个前缀路由，请求进来再查表
  // （模块随时开关、重新加载；关着的模块的接口回「模块没开」，面板不会白屏）
  // 所有面板流量（route 精确路由 + host.js 的模块前缀路由）统一过 guard：
  // Host 白名单 + 同源校验（CSRF）+ 副作用路径方法约束；/open/* 保留联动密钥鉴权。
  // prefix 传给 guard 用于剥前缀匹配副作用路径表。
  const guard = createPanelGuard({ getConfig, log, prefix, isAuthorized })
  // meta 必须由调用方直接透传：旧实现把 sideEffect 挂到新建的匿名箭头函数上，
  // guard 读到的永远是 undefined（opts.sideEffect 等于白传，副作用路径可被 GET 触发）。
  const guardedAnswer = (res, req, fn, meta = {}) => answer(res, () => {
    const g = guard.check(req, meta)
    if (!g.ok) return send(res, g.code, { ok: false, message: g.message })
    return fn()
  })
  const route = (path, handler, opts = {}) => {
    const meta = { registeredSideEffect: opts.sideEffect, isModuleRoute: false }
    return ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: prefix + path, handler: (req, res) => guardedAnswer(res, req, () => handler(req, res), meta) }), `qq-hub: 路由 ${path}`)
  }
  return { send, readBody, readRaw, query, answer, route, guard }
}
