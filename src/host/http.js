// QQ Hub · 面板 HTTP 小工具（host.js 分层拆出：纯工具层，不持有任何业务状态）
//
// host.js 只保留「装配」，请求应答的小件都从这里出：send 统一应答头、readBody/readRaw
// 读请求体、query 解析查询串、answer 兜住 handler 抛错、route 把登记包进 ctx.effect。

import { redact } from '../core/redact.js'

/**
 * @param {object} o
 * @param {object} o.ctx DSH 插件上下文（route 登记 webServer 要用）
 * @param {string} o.prefix 接口前缀（/qq-hub/api）
 */
export function createHttpKit({ ctx, prefix }) {
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
  const route = (path, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: prefix + path, handler: (req, res) => answer(res, () => handler(req, res)) }), `qq-hub: 路由 ${path}`)
  return { send, readBody, readRaw, query, answer, route }
}
