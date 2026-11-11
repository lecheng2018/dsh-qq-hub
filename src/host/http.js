// QQ Hub · 面板 HTTP 小工具（host.js 分层拆出：纯工具层，不持有任何业务状态）
//
// host.js 只保留「装配」，请求应答的小件都从这里出：send 统一应答头、readBody/readRaw
// 读请求体、query 解析查询串、answer 兜住 handler 抛错、route 把登记包进 ctx.effect。

import { redact } from '../core/redact.js'
import { createPanelGuard } from './panel/guard.js'

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
  const readBody = async (req) => {
    let s = ''
    try { for await (const c of req) s += c } catch (error) {}
    try { return JSON.parse(s || '{}') } catch (error) { return {} }
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
  const guardedAnswer = (res, req, fn) => answer(res, () => {
    const g = guard.check(req)
    if (!g.ok) return send(res, g.code, { ok: false, message: g.message })
    return fn()
  })
  const route = (path, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: prefix + path, handler: (req, res) => guardedAnswer(res, req, () => handler(req, res)) }), `qq-hub: 路由 ${path}`)
  return { send, readBody, readRaw, query, answer, route, guard }
}
