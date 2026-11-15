// OneBot 动作的「只读白名单」注册表。
//
// 出处：原来内嵌在 onebot/client.js 里的 READ_ACTIONS Set。迁出来成为独立数据文件，
// 是为了让新模块接新查询动作时**只登记、不改 client.js**（避免巨石文件越堆越大）。
//
// 红线不变（ADR-0001 / 代码审查 P1 修正）：
//   · 只有显式登记的幂等查询默认可回退/重试；
//   · 不在表里的动作一律按**副作用**对待——unknown 不自动重试；
//   · 枚举漏一个查询只是少一次安全重试（保守、无害）；
//     把副作用错登记进来则会重复发消息（有害）。所以运行时登记有前缀门槛（见下）。
//
// 三条使用方式：
//   1. 静态清单：直接往下面的 BASE_READ_ACTIONS 里加一行（内置、永远有效）；
//   2. 运行时登记：模块 setup 里 registerReadActions(['get_xxx', ...])；
//   3. 判定：一律用 isReadAction(action)，不要自己持有副本（会错过运行时登记）。

const BASE_READ_ACTIONS = [
  // 纯查询（get_*）：幂等，失败了可以安全重发
  'get_login_info', 'get_status', 'get_stranger_info', 'get_friend_list', 'get_group_list',
  'get_group_info', 'get_group_member_info', 'get_group_member_list', 'get_msg', 'get_forward_msg',
  'get_group_msg_history', 'get_friend_msg_history', 'get_group_file_url', 'get_private_file_url',
  'get_record', 'get_image', 'get_qzone_feeds', 'get_qzone_msg_list', 'get_qzone_msg_detail',
  'get_doubt_friends_add_request',
  // 权限预检查（can_*）：只读不回写
  'can_send_group_msg', 'can_send_private_msg',
  // 媒体/转写读取：网关只是转码或取回文本，无对外副作用
  'fetch_ptt_text', 'fetch_custom_face',
]

const READ_ACTIONS = new Set(BASE_READ_ACTIONS)

/** 允许运行时登记的前缀：查询/预检/取回/下载，都是「重试也无害」的形状。 */
const REGISTERABLE_PREFIXES = ['get_', 'can_', 'fetch_', 'download_']

/**
 * 运行时登记新的只读动作（模块 setup 里调用；重复登记幂等）。
 *
 * 前缀门槛是 fail-closed：只放行 REGISTERABLE_PREFIXES 里的形状，
 * send_/set_/delete_/upload_ 一律拒收——模块作者手滑把发送动作当查询登记，
 * 最坏结果是「少一次重试」，绝不可能是「重试把消息发两遍」。
 *
 * @param {string|string[]} actions
 * @returns {{added: string[], rejected: string[]}} 实际新增与被拒收的名字（面板/日志可解释）
 */
export function registerReadActions(actions) {
  const list = Array.isArray(actions) ? actions : [actions]
  const added = []
  const rejected = []
  for (const raw of list) {
    const action = String(raw ?? '').trim()
    if (!action) continue
    if (READ_ACTIONS.has(action)) continue
    if (!REGISTERABLE_PREFIXES.some((p) => action.startsWith(p))) { rejected.push(action); continue }
    READ_ACTIONS.add(action)
    added.push(action)
  }
  return { added, rejected }
}

/** 判定一个动作是不是只读（client.js 的唯一判定入口）。 */
export function isReadAction(action) {
  return READ_ACTIONS.has(String(action ?? ''))
}

/** 当前白名单快照（测试/排查用；排序保证输出稳定）。 */
export function snapshotReadActions() {
  return [...READ_ACTIONS].sort()
}
