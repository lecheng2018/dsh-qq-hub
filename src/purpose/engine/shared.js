/**
 * 目的机制（purpose outreach）—— 纯逻辑层。
 *
 * 模块边界：本文件零 import、零 I/O；副作用（读盘、投递、生成回合）都在接线层
 * src/purpose/module.js，单测可以只测这里。
 *
 * 目标：像人一样「定期、稳定地主动找主人搭话」。
 * 原理不是定时复读一句问候，而是：
 *   · 从近期 QQ 聊天流水 + 人格卡 + 记忆卡里提取「目的」；
 *   · 区分「谁的目标」（我 / 主人 / 群友 / 视频里）与「观察/推断/事实」；
 *   · 目标带置信度、价值、紧迫度、风险、反馈，不是一句话直接变成欲望；
 *
 * 这个文件只做「算」：配置归一化、排程、素材摘要、目的候选、提示词、回执解析、状态迁移。
 * 不读盘、不发 QQ、不碰 DSH —— 这些副作用都在接线层，单测可以只测这里。
 *
 * 分工：
 *   · module.js（接线层）负责「什么时候可以说」「素材从哪来」「怎么投递」「发没发出去」；
 *   · 本文件负责「该不该轮到」「这次想做什么」「让她怎么说」。
 *
 * 来源：逻辑移植自 Mieksido/surfcore 的 purpose-engine（MIT），署名与许可原文见
 * THIRD-PARTY-NOTICES.md；已按 QQ Hub 的模块与配置语境改写。
 */


/** 本目录是 engine.js 拆出来的子模块；对外入口仍是 src/purpose/engine.js（barrel），别直接 import 这里。 */

export const PURPOSE_STATE_VERSION = 1;

/** 默认值刻意保守：白天每 2.5~5 小时最多一次，一天最多 4 次，23:30~08:30 不打扰。 */
export const DEFAULT_PURPOSE_CONFIG = Object.freeze({
  enabled: true,
  // 空 = 用 config.json 的 ownerQQ；一般不需要改。
  ownerUin: '',
  gapMinMs: 150 * 60 * 1000,
  gapMaxMs: 300 * 60 * 1000,
  initialDelayMinMs: 30 * 60 * 1000,
  dailyMax: 4,
  quietStart: '23:30',
  quietEnd: '08:30',
  // 主人最近说过话 / 她最近发过言时先不打扰，避免在正在进行的聊天里硬插一句。
  idleThresholdMs: 30 * 60 * 1000,
  materialWindowHours: 72,
  biliWindowDays: 7,
  maxMaterials: 36,
  // 素材太少就别硬找话；有「心里惦记的事」时例外。
  minMaterials: 2,
  retryMs: 15 * 60 * 1000,
  maxAttempts: 3,
  historyLimit: 60,
  pendingTtlDays: 14,
  maxCandidates: 6,
  promptMaxChars: 16000,
});

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function clip(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 群聊素材里常带 QQ 号；给主人看的摘要不带号，只留事。 */
/** 0~1 夹取（置信度/风险/价值这类分数）。 */
export function clamp01(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

export function redactNumbers(text) {
  return String(text ?? '').replace(/\b\d{6,12}\b/g, '[号码]');
}

/** FNV-1a 变体：给素材/目的生成稳定短 id（跨重启可复现）。 */
export function hashId(text) {
  let h = 2166136261;
  for (const ch of String(text ?? '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function tokenSet(text) {
  const s = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const set = new Set();
  for (const part of s.split(/\s+/)) {
    if (!part) continue;
    if (/^[a-z0-9]{2,}$/.test(part)) set.add(part);
    for (let i = 0; i + 1 < part.length; i += 1) set.add(part.slice(i, i + 2));
  }
  return set;
}
