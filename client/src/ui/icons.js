import { h } from '../core/react.js'

function WhaleIcon({ size }) {
  const s = size || 16
  return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M3 13c0 3.6 3.3 6 8 6 4.6 0 8.2-2.7 8.7-6.6.1-.8.8-1.4 1.6-1.4H22c-.3-1.6-1.6-2.6-3-2.6-1.8 0-3 1.2-3.6 2.6H9c-3.4 0-6 .4-6 2Z' }),
    h('path', { d: 'M7.5 3.5c.8.9.9 2.3.2 3.3M10.5 3.5c-.8.9-.9 2.3-.2 3.3M9 6.8V9' }),
    h('circle', { cx: 7.3, cy: 13.3, r: 0.6, fill: 'currentColor' }),
  )
}

// ---------------- 基础控件 ----------------


const navIcon = (d) => h('svg', { viewBox: '0 0 24 24', 'aria-hidden': true }, h('path', { d }))


export { WhaleIcon, navIcon }
