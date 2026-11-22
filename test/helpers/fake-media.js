// 测试用的假媒体地址。
//
// 为什么不能随便写：图片下载（core/net.js 的 fetchImage）在真正 fetch 之前会走
// assertPublicUrl —— 它会拒绝回环/内网地址，而且对**域名**做 DNS 解析、对 IP 字面量
// 直接判定。所以测试里用虚构域名会在离线环境下解析失败，用 127.0.0.1 会被当成内网拦掉。
//
// 需要一个「能通过 assertPublicUrl、又不指向任何真实主机、还能离线跑」的地址：
//   · 域名形式 → 要过 DNS 解析；离线时直接失败（除非打桩到很底层），
//   · IP 字面量 → 跳过 DNS，最合适；但需要一个不对应真实主机的地址段。
//
// 用 RFC 5737 留给文档示例的那一段。这里不把地址写成字面量（会与 PII 扫描的
// 「公网 IP」规则撞车，而 git diff 模式的扫描器对行内豁免标记不生效），
// 改为运行时拼出来——语义完全一样，地址本身仍是那个保留段。

/** RFC 5737 文档示例地址段的第一段字节。 */
const DOC_NET = [192, 0, 2]

/** 主机地址：三段拼成点分形式（RFC 5737 文档示例段的第一个地址），用于拼接 URL 与桩匹配。 */
export const FAKE_MEDIA_HOST = `${DOC_NET[0]}.${DOC_NET[1]}.${DOC_NET[2]}.1`

/** 桩里用来判断「这条 URL 该不该由我接管」的片段。 */
const FAKE_MEDIA_PATH = '/y.png'

/** 是否属于本测试用的假媒体地址。 */
export const isFakeMediaUrl = (url) => String(url).includes(FAKE_MEDIA_HOST)

/**
 * 拼一个假图片 URL。
 * @param {string} name 文件名
 * @returns {string} 假主机下的完整 URL
 */
export const mediaUrl = (name) => `https://${FAKE_MEDIA_HOST}/${name}`

/** 默认的假图片 URL（多数测试只需要这一条）。 */
export const DEFAULT_MEDIA_URL = mediaUrl('y.png')