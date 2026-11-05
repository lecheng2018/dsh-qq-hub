// 时间与安静时段：localDateKey / parseClock / inQuietHours / quietEndAfter / nextDayStartAfter。
import { DAY, DEFAULT_PURPOSE_CONFIG, HOUR, MINUTE, clampInt, clip, isPlainObject } from './shared.js'

export function localDateKey(at = Date.now()) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function clockText(hh, mm) {
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** `"8:00"` / `"08:00"` → `{ hh, mm, text }`；非法值回退 fallback。 */
export function parseClock(value, fallback = '08:00') {
  const pick = (raw) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return null;
    return { hh, mm };
  };
  const parsed = pick(value) ?? pick(fallback) ?? { hh: 8, mm: 0 };
  return { ...parsed, text: clockText(parsed.hh, parsed.mm) };
}

function minutesOfDay(at) {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
}

/** 安静时段是否包含 now；quietStart === quietEnd 视为不启用。 */
export function inQuietHours(now, config = DEFAULT_PURPOSE_CONFIG) {
  const start = parseClock(config.quietStart, '23:30');
  const end = parseClock(config.quietEnd, '08:30');
  if (start.text === end.text) return false;
  const s = start.hh * 60 + start.mm;
  const e = end.hh * 60 + end.mm;
  const m = minutesOfDay(now);
  return s < e ? (m >= s && m < e) : (m >= s || m < e);
}

/** 下一个「安静结束」时刻（严格晚于 now）。 */
export function quietEndAfter(now, config = DEFAULT_PURPOSE_CONFIG) {
  const end = parseClock(config.quietEnd, '08:30');
  const d = new Date(now);
  d.setHours(end.hh, end.mm, 0, 0);
  while (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 下一天的起点（安静结束优先；没设安静时段就取次日 00:05）。 */
export function nextDayStartAfter(now, config = DEFAULT_PURPOSE_CONFIG) {
  const start = parseClock(config.quietStart, '23:30');
  const end = parseClock(config.quietEnd, '08:30');
  if (start.text !== end.text) return quietEndAfter(now, config);
  const d = new Date(now);
  d.setHours(0, 5, 0, 0);
  while (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

