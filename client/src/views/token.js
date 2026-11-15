import { h } from '../core/react.js'
import { Card } from '../ui/primitives.js'
import { cx } from '../core/utils.js'

// 「用量」页：Token 记账 / 上下文守卫 / 完整性守卫三个模块的设置与面板由 page.js 自动嵌在本页底部。
// 这里刻意不重复读数：具体数字是 token-billing 的 panel.js 自己拉 /token-usage 画的，
// 本页只负责讲清这三件事的关系，以及「没在跑」时该去哪儿开。
const ITEMS = [
  { id: 'token-billing', name: 'Token 记账', desc: '今天烧了多少、还剩多少、每个会话分到多少；预算在这里改，烧完只熔断主动开口' },
  { id: 'token-guardian', name: '预算守门员', desc: '某个会话上下文涨太多时提前压缩历史，省下重复读取的钱' },
  { id: 'complete-guard', name: '话说完没', desc: '回复停在「因为」「1.」这种半截上时，提醒她把话说完' },
]

function Token({ st }) {
  const mods = st.modules || []
  const running = (id) => mods.some((m) => m.id === id && m.running)
  return (
    <div className="ab-grid">
      <Card
        title="Token 用量与守卫"
        desc="这一页管三件事：今天花了多少 Token、上下文什么时候压缩、回复被截断时怎么补。三件事都在下面各自的卡里改，改完点「保存设置」。"
        more={'说清楚一件事：每日预算烧完，只会熔断「她主动开口」（主动搭话 / 目的引擎），你正常问她不受影响；跨日自动恢复。模块开关在「系统 → 扩展」，这里只给设置。'}
      >
        <div className="ab-list">
          {ITEMS.map((it) => (
            <div key={it.id} className="ab-li">
              <div className="meta"><b>{it.name}</b></div>
              <div className="body">
                <div className="ab-small">{it.desc}</div>
              </div>
              <span className={cx('ab-badge', !running(it.id) && 'dim')}>{running(it.id) ? '在跑' : '没在跑'}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

export { Token, ITEMS as TOKEN_ITEMS }
