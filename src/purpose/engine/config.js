// 配置归一化：normalizePurposeConfig（外部输入 → 引擎配置）。
import { MINUTE, HOUR, isPlainObject, clampInt } from './shared.js';
import { DEFAULT_PURPOSE_CONFIG } from './shared.js';
import { parseClock } from './clock.js';

export function normalizePurposeConfig(input = {}, { ownerQQ = '' } = {}) {
  const src = isPlainObject(input) ? input : {};
  const fallbackOwner = String(ownerQQ ?? '').replace(/[^\d]/g, '').slice(0, 12);
  const rawOwner = String(src.ownerUin ?? '').replace(/[^\d]/g, '').slice(0, 12);
  const gapMinMs = clampInt(src.gapMinMs, DEFAULT_PURPOSE_CONFIG.gapMinMs, 5 * MINUTE, 24 * HOUR);
  const gapMaxMs = clampInt(src.gapMaxMs, Math.max(gapMinMs, DEFAULT_PURPOSE_CONFIG.gapMaxMs), gapMinMs, 24 * HOUR);
  return {
    enabled: src.enabled !== false,
    ownerUin: rawOwner || fallbackOwner,
    gapMinMs,
    gapMaxMs,
    initialDelayMinMs: clampInt(src.initialDelayMinMs, DEFAULT_PURPOSE_CONFIG.initialDelayMinMs, MINUTE, 12 * HOUR),
    // 0 = 不限次数（仍受 token 额度与安静时段约束）。
    dailyMax: clampInt(src.dailyMax, DEFAULT_PURPOSE_CONFIG.dailyMax, 0, 24),
    quietStart: parseClock(src.quietStart, DEFAULT_PURPOSE_CONFIG.quietStart).text,
    quietEnd: parseClock(src.quietEnd, DEFAULT_PURPOSE_CONFIG.quietEnd).text,
    idleThresholdMs: clampInt(src.idleThresholdMs, DEFAULT_PURPOSE_CONFIG.idleThresholdMs, 0, 12 * HOUR),
    materialWindowHours: clampInt(src.materialWindowHours, DEFAULT_PURPOSE_CONFIG.materialWindowHours, 1, 24 * 14),
    biliWindowDays: clampInt(src.biliWindowDays, DEFAULT_PURPOSE_CONFIG.biliWindowDays, 1, 60),
    maxMaterials: clampInt(src.maxMaterials, DEFAULT_PURPOSE_CONFIG.maxMaterials, 6, 80),
    minMaterials: clampInt(src.minMaterials, DEFAULT_PURPOSE_CONFIG.minMaterials, 0, 20),
    retryMs: clampInt(src.retryMs, DEFAULT_PURPOSE_CONFIG.retryMs, MINUTE, 6 * HOUR),
    maxAttempts: clampInt(src.maxAttempts, DEFAULT_PURPOSE_CONFIG.maxAttempts, 1, 10),
    historyLimit: clampInt(src.historyLimit, DEFAULT_PURPOSE_CONFIG.historyLimit, 10, 200),
    pendingTtlDays: clampInt(src.pendingTtlDays, DEFAULT_PURPOSE_CONFIG.pendingTtlDays, 1, 90),
    maxCandidates: clampInt(src.maxCandidates, DEFAULT_PURPOSE_CONFIG.maxCandidates, 3, 10),
    promptMaxChars: clampInt(src.promptMaxChars, DEFAULT_PURPOSE_CONFIG.promptMaxChars, 4000, 30000),
  };
}

