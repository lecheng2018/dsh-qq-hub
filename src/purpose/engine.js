/**
 * 目的机制（purpose outreach）—— 纯逻辑层。入口（barrel）。
 *
 * 1.3.48 起按职责拆成本目录子模块；所有既有具名导出在这里原样 re-export，
 * 调用方（module.js / 测试）的 import 一个字都不用改：
 *
 *   shared.js        常量与小工具（MINUTE/HOUR/DAY、clampInt、clip、hashId、tokenSet…）
 *   clock.js         时间与安静时段（localDateKey / parseClock / inQuietHours / nextDayStartAfter…）
 *   config.js        配置归一化（normalizePurposeConfig）
 *   state.js         状态层（createPurposeState / normalizePurposeState / ensurePurposeDay /
 *                    ensurePurposeSchedule / planNextFire / evaluatePurposeTick /
 *                    markPurposeDelivered / markPurposeSkip / applyPurposeOutcome / prunePurposeState）
 *   materials.js     素材选取（collectMaterials）
 *   similarity.js    文本相似度（textSimilarity / isDuplicateText）
 *   drives.js        需求与情绪（PURPOSE_NEEDS / DEFAULT_DRIVES / deriveDrives / analyzePersona /
 *                    appraiseMaterial / satisfyDrives / needAffinity / extractTopic…）
 *   goals.js         目标层（updateObservations / normalizeGoals / formGoalHypotheses /
 *                    applyGoalFeedback / pruneGoals / goalToCandidate）
 *   seeds.js         决策层（minePurposeSeeds / selectPurpose / formatMaterialLine）
 *   prompt.js        发言层（buildPurposePrompt / parsePurposeMemo / addPendingPurpose /
 *                    resolvePendingPurpose / summarizePurposeState）
 *
 * 依然是零外部 import（仅子模块互引）、零 I/O：副作用全在 src/purpose/module.js。
 * 逻辑移植自 Mieksido/surfcore 的 purpose-engine（MIT），署名见 THIRD-PARTY-NOTICES.md。
 */

// 常量与小工具
export {
  PURPOSE_STATE_VERSION, DEFAULT_PURPOSE_CONFIG, MINUTE, HOUR, DAY, isPlainObject,
  clampInt, clip, redactNumbers, hashId, tokenSet,
} from './engine/shared.js';

// 时间与安静时段
export {
  localDateKey, parseClock, inQuietHours, quietEndAfter, nextDayStartAfter,
} from './engine/clock.js';

// 配置归一化
export {
  normalizePurposeConfig,
} from './engine/config.js';

// 状态层
export {
  createPurposeState, normalizePurposeState, ensurePurposeDay, ensurePurposeSchedule, planNextFire, evaluatePurposeTick,
  markPurposeDelivered, markPurposeSkip, applyPurposeOutcome, prunePurposeState,
} from './engine/state.js';

// 素材选取
export {
  collectMaterials,
} from './engine/materials.js';

// 文本相似度
export {
  textSimilarity, isDuplicateText,
} from './engine/similarity.js';

// 需求与情绪
export {
  PURPOSE_NEEDS, NEED_LABELS, ACTION_LABELS, EMOTION_LABELS, DEFAULT_DRIVES, normalizeDrives,
  needAffinity, analyzePersona, cleanTopic, extractTopic, deriveDrives, appraiseMaterial,
  satisfyDrives,
} from './engine/drives.js';

// 目标层
export {
  GOAL_OWNERS, GOAL_OWNER_LABELS, GOAL_STATUSES, updateObservations, normalizeGoals, applyGoalFeedback,
  pruneGoals, formGoalHypotheses, goalToCandidate,
} from './engine/goals.js';

// 决策层
export {
  minePurposeSeeds, selectPurpose, formatMaterialLine,
} from './engine/seeds.js';

// 发言层
export {
  buildPurposePrompt, parsePurposeMemo, addPendingPurpose, resolvePendingPurpose, summarizePurposeState,
} from './engine/prompt.js';
