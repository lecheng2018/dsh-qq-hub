// 会话历史提取（1.3.63）：从 DSH 自己的会话记录里翻出群友的原话，给蒸馏群友当证据源。
//
// chatlog 按保留天数滚动清理；会话历史提供更长窗口，不依赖新目标重新积累流水。
// 而 DSH 的会话记录（session.v4.jsonl.zstd）保存了每一轮的完整上下文——包括群友的原话
// 「名字(QQ号)：内容」——而且比 chatlog 留得久。翻它就能「立刻学」，不用等。
//
// 只读不改：这些文件是 DSH 的，本模块只解压+解析，不写。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** DSH 把工作区路径编码成会话目录名：'/' → '-'，'@' → '~0040'，两侧包 '--'。 */
export function escapeWorkspaceName (dir) {
  return '--' + String(dir || '').replace(/^\//, '').replace(/\//g, '-').replace(/@/g, '~0040') + '--'
}

/** 找这个工作区对应的 DSH 会话目录；找不到返回 ''。 */
export function sessionsDirFor (workspaceDir, { home = homedir(), dshHome = '' } = {}) {
  const roots = []
  if (dshHome) roots.push(join(dshHome, 'sessions'))
  roots.push(join(home, '.dsh', 'sessions'))
  if (process.env.DSH_HOME) roots.push(join(process.env.DSH_HOME, 'sessions'))
  const want = escapeWorkspaceName(workspaceDir)
  for (const root of roots) {
    if (!existsSync(root)) continue
    const exact = join(root, want)
    if (existsSync(exact)) return exact
    // 编码规则万一变了：退一步找名字里含工作区末段目录的
    const tail = String(workspaceDir || '').split(/[\\/]/).filter(Boolean).pop()
    if (!tail) continue
    try {
      const hit = readdirSync(root).find((n) => n.includes(tail))
      if (hit) return join(root, hit)
    } catch {}
  }
  return ''
}

// 一行群聊记录：可选前缀（`[3] ` / `-` / `* `）+ 名字 + (QQ号) + ：内容
// 名字里可能带括号和空格，所以从**最后一个** （数字） 处切。
const LINE_RE = /^(?:\[(\d+)\]\s*|[-*]\s*)?(.{1,32}?)[（(](\d{5,12})[）)]\s*[:：]\s*(.*)$/
const GROUP_RE = /【(?:群聊|群)\s*([^】]{1,40})】/

/**
 * 从一段会话文本里解析出群聊发言人。
 * @returns {Array<{name:string,uid:string,text:string,group:string,order:number}>}
 */
export function parseGroupLines (raw) {
  const out = []
  let group = ''
  const text = String(raw || '')
  if (!text) return out
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const g = GROUP_RE.exec(line)
    if (g) group = String(g[1]).trim()
    const m = LINE_RE.exec(line.trim())
    if (!m) continue
    const [, , name, uid, body] = m
    const clean = String(name).replace(/[（(]\s*$/, '').trim()
    // 「主人@了你」这种没有 QQ 号的会被上面的数字要求挡掉；系统提示行也跳过
    if (!uid || !body) continue
    if (/^(主人|系统|你)/.test(clean) && !/\d/.test(uid)) continue
    out.push({ name: clean, uid: String(uid), text: String(body).trim(), group, order: i })
  }
  return out
}

/** 解压一个会话文件成 JSONL 文本。坏了就返回 ''（不让一个坏文件毁掉整次扫描）。 */
export function readTranscript (file) {
  try {
    if (statSync(file).size === 0) return ''
    const buf = readFileSync(file)
    // 有的会话可能是明文 jsonl（没压缩）
    if (buf[0] === 0x7b) return buf.toString('utf8')
    return zstdDecompressSync(buf).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * 扫一个会话目录，抽出所有群聊发言。
 * @param {string} dir sessionsDirFor() 的结果
 * @param {{ group?: string }} [opts] 只要某个群的（按群名匹配，空 = 全部）
 * @returns {{ lines: Array, sessions: number, spans: {from:number,to:number} }}
 */
export function scanTranscripts (dir, { group = '' } = {}) {
  const lines = []
  let sessions = 0
  let from = 0
  let to = 0
  if (!dir || !existsSync(dir)) return { lines, sessions, spans: { from, to } }
  let names = []
  try { names = readdirSync(dir) } catch { return { lines, sessions, spans: { from, to } } }
  for (const name of names) {
    const file = join(dir, name, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const text = readTranscript(file)
    if (!text) continue
    sessions++
    let seq = 0
    for (const raw of text.split('\n')) {
      if (!raw.includes('user/message')) continue
      let obj
      try { obj = JSON.parse(raw) } catch { continue }
      const at = Number(obj.time) || 0
      if (at) { if (!from || at < from) from = at; if (at > to) to = at }
      for (const c of obj.data?.content || []) {
        const t = c?.text
        if (typeof t !== 'string' || !t.includes('：')) continue
        for (const item of parseGroupLines(t)) {
          if (group && item.group && item.group !== group) continue
          lines.push({ ...item, at, seq: seq++ })
        }
      }
    }
  }
  return { lines, sessions, spans: { from, to } }
}

/** 只留某个人的发言，按时间正序（和历史里的顺序一致）。 */
export function linesOf (lines, uid) {
  const want = String(uid || '').trim()
  if (!want) return []
  return (lines || []).filter((l) => String(l.uid) === want)
}

/** 统计每个人说了多少句——面板上用来看「值不值得学这个人」。 */
export function speakerCounts (lines, topN = 20) {
  const m = new Map()
  for (const l of lines || []) {
    const cur = m.get(l.uid) || { uid: l.uid, name: l.name, count: 0 }
    cur.count++
    if (!cur.name && l.name) cur.name = l.name
    m.set(l.uid, cur)
  }
  return [...m.values()].sort((a, b) => b.count - a.count).slice(0, topN)
}
