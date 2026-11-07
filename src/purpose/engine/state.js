// 状态层：createPurposeState / normalizePurposeState / ensurePurposeDay / ensurePurposeSchedule /
// planNextFire / evaluatePurposeTick / markPurposeDelivered / markPurposeSkip / applyPurposeOutcome /
// prunePurposeState。历史与待续条目的归一也在这里。
import { DAY, HOUR, MINUTE, clamp01, clampInt, clip, hashId, isPlainObject } from './shared.js'
import { DEFAULT_PURPOSE_CONFIG, PURPOSE_STATE_VERSION } from './shared.js';
import { clockText, inQuietHours, localDateKey, nextDayStartAfter, parseClock, quietEndAfter } from './clock.js'
import { normalizePurposeConfig } from './config.js';
import { DEFAULT_DRIVES, PURPOSE_NEEDS, normalizeDrives, satisfyDrives } from './drives.js'
import { GOAL_OWNERS, formGoalHypotheses, normalizeGoals, updateObservations } from './goals.js'
import { addPendingPurpose, resolvePendingPurpose } from './prompt.js'

export function createPurposeState(now = Date.now()) {
  return {
    version: PURPOSE_STATE_VERSION,
    day: localDateKey(now),
    countToday: 0,
    lastRunAt: 0,
    lastAttemptAt: 0,
    lastSentAt: 0,
    lastOutcome: '',
    lastPurpose: '',
    lastText: '',
    nextFireAt: 0,
    attempts: 0,
    // 驱动向量：为什么今天特别想玩 / 特别想找人说话。跨天保留，随时间衰减。
    drives: { ...DEFAULT_DRIVES },
    drivesAt: now,
    lastEmotion: '',
    lastEmotionText: '',
    lastGoalId: '',
    // 给设置页画「这一轮链路」用的计数（不参与决策）。
    lastMaterialCount: 0,
    lastCandidateCount: 0,
    // 目标假设 / 观察账本：让「一次视频」不等于「永久欲望」，也区分群友的想玩与她的想玩。
    goals: [],
    observations: [],
    pending: [],
    history: [],
    lastSkip: null,
  };
}

function normalizeHistoryEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const at = Number(raw.at) || 0;
  if (!at) return null;
  return {
    at,
    outcome: String(raw.outcome ?? '').slice(0, 20),
    kind: String(raw.kind ?? '').slice(0, 20),
    need: PURPOSE_NEEDS.includes(raw.need) ? raw.need : '',
    action: String(raw.action ?? '').slice(0, 20),
    emotion: String(raw.emotion ?? '').slice(0, 20),
    purpose: clip(raw.purpose, 120),
    text: clip(raw.text, 200),
    planned: clip(raw.planned, 120),
    sourceId: clip(raw.sourceId, 80),
    goalId: String(raw.goalId ?? '').slice(0, 24),
    goalOwner: GOAL_OWNERS.includes(raw.goalOwner) ? raw.goalOwner : '',
    confidence: Number.isFinite(Number(raw.confidence)) ? clamp01(raw.confidence, 0) : null,
  };
}

function normalizePendingEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const text = clip(raw.text, 120);
  if (!text) return null;
  return {
    id: String(raw.id ?? '').slice(0, 24) || `p-${hashId(text)}`,
    kind: String(raw.kind ?? 'share').slice(0, 20),
    need: PURPOSE_NEEDS.includes(raw.need) ? raw.need : '',
    action: String(raw.action ?? '').slice(0, 20),
    emotion: String(raw.emotion ?? '').slice(0, 20),
    text,
    source: String(raw.source ?? '').slice(0, 20),
    createdAt: Number(raw.createdAt) || Date.now(),
    expiresAt: Number(raw.expiresAt) || 0,
    hits: clampInt(raw.hits, 0, 0, 99),
  };
}

export function normalizePurposeState(raw, now = Date.now()) {
  const base = createPurposeState(now);
  if (!isPlainObject(raw)) return base;
  base.day = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.day ?? '')) ? String(raw.day) : localDateKey(now);
  base.countToday = clampInt(raw.countToday, 0, 0, 99);
  base.lastRunAt = Number(raw.lastRunAt) || 0;
  base.lastAttemptAt = Number(raw.lastAttemptAt) || 0;
  base.lastSentAt = Number(raw.lastSentAt) || 0;
  base.lastOutcome = String(raw.lastOutcome ?? '').slice(0, 24);
  base.lastPurpose = clip(raw.lastPurpose, 120);
  base.lastText = clip(raw.lastText, 200);
  base.nextFireAt = Number(raw.nextFireAt) || 0;
  base.attempts = clampInt(raw.attempts, 0, 0, 20);
  base.drives = normalizeDrives(raw.drives);
  base.drivesAt = Number(raw.drivesAt) || 0;
  base.lastEmotion = String(raw.lastEmotion ?? '').slice(0, 20);
  base.lastEmotionText = clip(raw.lastEmotionText, 30);
  base.lastGoalId = String(raw.lastGoalId ?? '').slice(0, 24);
  base.lastMaterialCount = clampInt(raw.lastMaterialCount, 0, 0, 999);
  base.lastCandidateCount = clampInt(raw.lastCandidateCount, 0, 0, 99);
  base.goals = normalizeGoals(raw.goals, now);
  base.observations = updateObservations(raw.observations, [], now);
  base.pending = (Array.isArray(raw.pending) ? raw.pending : []).map(normalizePendingEntry).filter(Boolean).slice(-20);
  base.history = (Array.isArray(raw.history) ? raw.history : []).map(normalizeHistoryEntry).filter(Boolean).slice(-200);
  base.lastSkip = isPlainObject(raw.lastSkip)
    ? { at: Number(raw.lastSkip.at) || 0, reason: String(raw.lastSkip.reason ?? '').slice(0, 80) }
    : null;
  return base;
}

/** 跨天重置今日次数（不重置 nextFireAt；排程会自己纠正）。 */
export function ensurePurposeDay(state, now = Date.now()) {
  const day = localDateKey(now);
  if (state.day !== day) {
    state.day = day;
    state.countToday = 0;
  }
  return state;
}

/** 首次启动 / 状态里没有 nextFireAt 时，排一个初始延迟（落在安静时段就推到安静结束）。 */
export function ensurePurposeSchedule(state, { now = Date.now(), config = DEFAULT_PURPOSE_CONFIG, random = Math.random } = {}) {
  if (!state.nextFireAt) {
    let at = now + Math.max(MINUTE, Math.min(config.initialDelayMinMs, config.gapMinMs));
    if (inQuietHours(at, config)) at = quietEndAfter(at, config) + Math.round(random() * 20 * MINUTE);
    state.nextFireAt = at;
  }
  return state;
}

/**
 * 下一次该在什么时候主动找主人。
 * · 距上次「真正完成」至少 gapMin~gapMax；
 * · 桥接停机很久后只补一枪（不连着补）；
 * · 算出来落在安静时段就推到安静结束 + 0~20 分钟抖动。
 */
export function planNextFire({
  now = Date.now(),
  config = DEFAULT_PURPOSE_CONFIG,
  lastRunAt = 0,
  countToday = 0,
  random = Math.random,
} = {}) {
  const min = Math.max(5 * MINUTE, Number(config.gapMinMs) || DEFAULT_PURPOSE_CONFIG.gapMinMs);
  const max = Math.max(min, Number(config.gapMaxMs) || min);
  const gap = Math.round(min + random() * (max - min));
  let at;
  if (config.dailyMax > 0 && countToday >= config.dailyMax) {
    at = nextDayStartAfter(now, config);
  } else if (lastRunAt > 0) {
    at = lastRunAt + gap;
    // 停机很久：别攒一堆补发，只补一枪（2 分钟后）。
    if (at < now + 2 * MINUTE) at = now + 2 * MINUTE;
  } else {
    at = now + Math.max(MINUTE, Math.min(config.initialDelayMinMs, min));
  }
  if (inQuietHours(at, config)) at = quietEndAfter(at, config) + Math.round(random() * 20 * MINUTE);
  return at;
}

function waitUntil(at, reason) {
  return { action: 'wait', reason, nextFireAt: Math.max(0, Math.round(at)) };
}

/**
 * 每次 tick 的判定：能不能现在主动找主人。
 * env 由接线层提供（都是便宜的状态，不读大文件）：
 *   enabled / modeOk / dshReady / paused / ownerAllowed / busy / friendOk / budgetBlocked / ownerIdleMs
 */
export function evaluatePurposeTick({ now = Date.now(), config = DEFAULT_PURPOSE_CONFIG, state, env = {}, random = Math.random } = {}) {
  ensurePurposeDay(state, now);
  if (!config.enabled || env.enabled === false) return waitUntil(0, 'disabled');
  if (env.modeOk === false) return waitUntil(now + 5 * MINUTE, 'mode');
  if (env.dshReady === false) return waitUntil(now + 5 * MINUTE, 'dsh');
  if (env.paused === true) return waitUntil(now + 10 * MINUTE, 'paused');
  if (env.ownerAllowed === false) return waitUntil(now + HOUR, 'owner-not-allowed');
  if (inQuietHours(now, config)) {
    // 安静时段不在每次 tick 上抖动（否则状态文件每分钟都在变）；到点后由 planNextFire 再加随机。
    return waitUntil(quietEndAfter(now, config), 'quiet');
  }
  if (config.dailyMax > 0 && state.countToday >= config.dailyMax) {
    return waitUntil(nextDayStartAfter(now, config), 'daily-max');
  }
  if (state.nextFireAt && now < state.nextFireAt) return waitUntil(state.nextFireAt, 'waiting');
  if (env.busy === true) return waitUntil(now + 5 * MINUTE, 'busy');
  const idle = Number(env.ownerIdleMs);
  if (Number.isFinite(idle) && idle >= 0 && idle < config.idleThresholdMs) {
    const remain = Math.max(MINUTE, config.idleThresholdMs - idle);
    return waitUntil(now + Math.min(30 * MINUTE, remain), 'owner-active');
  }
  if (env.friendOk === false) return waitUntil(now + 6 * HOUR, 'not-friend');
  if (env.budgetBlocked === true) return waitUntil(now + 30 * MINUTE, 'budget');
  return { action: 'run', reason: 'due', nextFireAt: now };
}

/** 投递出去就先占今日次数（不管最后她有没有发消息，模型回合已经花钱了）。 */
export function markPurposeDelivered(state, { now = Date.now(), planned = null } = {}) {
  ensurePurposeDay(state, now);
  state.countToday += 1;
  state.lastAttemptAt = now;
  state.attempts = (Number(state.attempts) || 0) + 1;
  state.lastOutcome = 'pending';
  if (planned?.text) state.lastPurpose = clip(planned.text, 120);
  return state;
}

export function markPurposeSkip(state, { now = Date.now(), reason = '', nextFireAt = 0 } = {}) {
  state.lastSkip = { at: now, reason: String(reason ?? '').slice(0, 80) };
  if (nextFireAt > 0) state.nextFireAt = nextFireAt;
  return state;
}

/**
 * 一轮结束后的状态迁移。
 * outcome: sent（真发出）/ silent（她选择不发）/ failed（投递或回合出错）/ delivery-failed
 */
export function applyPurposeOutcome(state, {
  now = Date.now(),
  config = DEFAULT_PURPOSE_CONFIG,
  outcome = 'sent',
  text = '',
  memo = null,
  planned = null,
  random = Math.random,
} = {}) {
  ensurePurposeDay(state, now);
  state.lastRunAt = now;
  state.lastOutcome = String(outcome ?? 'sent').slice(0, 24);
  state.lastPurpose = clip(memo?.purpose || planned?.text || state.lastPurpose || '', 120);
  state.lastText = clip(text || state.lastText || '', 200);
  const need = PURPOSE_NEEDS.includes(memo?.need) ? memo.need : (PURPOSE_NEEDS.includes(planned?.need) ? planned.need : '');
  const action = memo?.action || planned?.action || '';
  const emotion = memo?.emotionText ? '' : (planned?.emotion || '');
  state.lastEmotion = String(emotion || planned?.emotion || state.lastEmotion || '').slice(0, 20);
  state.lastEmotionText = clip(memo?.emotionText || state.lastEmotionText || '', 30);
  // 目标假设记账：这次主动说了/没说，都会影响下一次的置信度；主人回复在 formGoalHypotheses 里结算。
  const goalId = String(planned?.goalId || '').slice(0, 24);
  const goal = goalId ? (Array.isArray(state.goals) ? state.goals : []).find((g) => g?.id === goalId) : null;
  state.lastGoalId = goalId;
  if (goal && (state.lastOutcome === 'sent' || state.lastOutcome === 'silent')) {
    goal.attempts = Math.min(20, (Number(goal.attempts) || 0) + 1);
    goal.lastActionAt = now;
    if (state.lastOutcome === 'sent') {
      if (goal.status === 'hypothesis') goal.status = 'active';
      goal.confidence = Math.min(0.95, (Number(goal.confidence) || 0.3) + 0.03);
    } else {
      goal.confidence = Math.max(0.05, (Number(goal.confidence) || 0.3) - 0.03);
    }
  }
  // 驱动满足：真发出去了，对应的「想玩/想装/想陪」才会降；没发出去只轻微回落。
  state.drives = satisfyDrives(state.drives, { need, action, outcome: state.lastOutcome });
  state.drivesAt = now;
  if (state.lastOutcome === 'sent') {
    state.lastSentAt = now;
    state.attempts = 0;
    // 发出去了但备忘标记待续：记一条「心里还惦记着」，下次优先接着问。
    if (memo?.status === '待续') {
      addPendingPurpose(state, {
        text: memo.followUp && memo.followUp !== '无' ? memo.followUp : (memo.purpose || ''),
        kind: memo.kind || 'curiosity',
        need: need || planned?.need || '',
        action: action || planned?.action || '',
        emotion: emotion || planned?.emotion || '',
        now,
        config,
      });
    } else if (memo?.status === '完成') {
      resolvePendingPurpose(state, memo.purpose || '');
    } else if (planned?.fromPending && planned?.text) {
      // 没写备忘，但这次本来就是接着「惦记的事」说的：默认这件事已经推进过一轮。
      resolvePendingPurpose(state, planned.text);
    }
  } else if (state.lastOutcome === 'silent') {
    state.attempts = 0;
    if (memo?.status === '待续') {
      addPendingPurpose(state, {
        text: memo.followUp && memo.followUp !== '无' ? memo.followUp : (memo.purpose || ''),
        kind: memo.kind || 'curiosity',
        need: need || planned?.need || '',
        action: action || planned?.action || '',
        emotion: emotion || planned?.emotion || '',
        now,
        config,
      });
    }
  }

  state.history.push({
    at: now,
    outcome: state.lastOutcome,
    kind: clip(memo?.kind || planned?.kind || '', 20),
    need,
    action,
    emotion: emotion || planned?.emotion || '',
    purpose: state.lastPurpose,
    text: state.lastText,
    planned: clip(planned?.text || '', 120),
    sourceId: clip(planned?.sourceId || '', 80),
    goalId,
    goalOwner: goal?.owner || planned?.goalOwner || '',
    confidence: goal?.confidence ?? planned?.confidence ?? null,
  });

  const retry = state.lastOutcome !== 'sent' && state.lastOutcome !== 'silent'
    && Number(state.attempts) < Number(config.maxAttempts);
  state.nextFireAt = retry
    ? now + Math.max(MINUTE, Number(config.retryMs) || DEFAULT_PURPOSE_CONFIG.retryMs)
    : planNextFire({ now, config, lastRunAt: now, countToday: state.countToday, random });
  prunePurposeState(state, { now, config });
  return state;
}

export function prunePurposeState(state, { now = Date.now(), config = DEFAULT_PURPOSE_CONFIG } = {}) {
  const ttlMs = Math.max(1, Number(config.pendingTtlDays) || DEFAULT_PURPOSE_CONFIG.pendingTtlDays) * DAY;
  state.pending = (Array.isArray(state.pending) ? state.pending : [])
    .filter((p) => p && p.text && (!p.expiresAt || Number(p.expiresAt) > now))
    .map((p) => ({ ...p, expiresAt: Number(p.expiresAt) || now + ttlMs }))
    .slice(-20);
  const limit = Math.max(10, Number(config.historyLimit) || DEFAULT_PURPOSE_CONFIG.historyLimit);
  state.history = (Array.isArray(state.history) ? state.history : []).slice(-limit);
  return state;
}

// ── 素材 ────────────────────────────────────────────────────────────────────

