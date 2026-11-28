// 她在每个群里的身份（群主 / 管理员 / 普通成员）：决定能不能做群管。查一次缓存 10 分钟。

const TTL = 10 * 60_000
// 常驻进程里见过的群只会越来越多（进过的群退掉、被拉进去又踢出来），
// 这张身份表以前没有上限。按最近使用淘汰到上限以内。
const MAX_GROUPS = 500
export const ROLE_LABEL = { owner: '群主', admin: '管理员', member: '普通成员' }

export function createGroupRoles({ onebot, getConfig, log }) {
  const cache = new Map() // groupId → { role, at }
  const inflight = new Map()

  /** 写入（或刷新）一条缓存，并把最久没查过的群淘汰掉（LRU）。 */
  function remember(gid, rec) {
    const id = String(gid)
    cache.delete(id) // 先删再插：Map 的插入序就是我们的 LRU 序
    cache.set(id, rec)
    while (cache.size > MAX_GROUPS) cache.delete(cache.keys().next().value)
  }

  async function fetchRole(gid) {
    const r = await onebot.call('get_group_member_info', { group_id: Number(gid), user_id: Number(getConfig().botQQ), no_cache: true }, { timeoutMs: 8000 })
    const role = ['owner', 'admin', 'member'].includes(r && r.role) ? r.role : 'member'
    remember(gid, { role, at: Date.now() })
    return role
  }

  /** 查身份（会等结果）。查不到返回 ''。 */
  async function get(gid, { fresh = false } = {}) {
    const c = cache.get(String(gid))
    if (!fresh && c && Date.now() - c.at < TTL) {
      remember(gid, c) // 命中即刷新 LRU 次序
      return c.role
    }
    if (!inflight.has(String(gid))) {
      inflight.set(String(gid), fetchRole(gid).catch((error) => {
        log?.debug(`查群 ${gid} 里的身份失败：`, error.message)
        return c ? c.role : ''
      }).finally(() => inflight.delete(String(gid))))
    }
    return inflight.get(String(gid))
  }

  /** 同步拿缓存（给每轮上下文用），过期就顺手在后台刷新。 */
  function peek(gid) {
    const c = cache.get(String(gid))
    if (!c || Date.now() - c.at >= TTL) get(gid).catch(() => {})
    return c ? c.role : ''
  }

  const canManage = (role) => role === 'owner' || role === 'admin'

  return { get, peek, canManage, label: (role) => ROLE_LABEL[role] || '不清楚' }
}
