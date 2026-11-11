import { useEffect } from '../core/react.js'
import themeCss from './theme.css'

export const CSS = themeCss

export function useStyle() {
  useEffect(() => {
    if (document.getElementById('qq-hub-css')) return
    const s = document.createElement('style')
    s.id = 'qq-hub-css'
    s.textContent = CSS
    document.head.appendChild(s)
  }, [])
}
