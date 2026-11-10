// 目标层：GOAL_OWNERS 等常量、updateObservations / normalizeGoals / formGoalHypotheses /
// applyGoalFeedback / pruneGoals / goalToCandidate。
import { DAY, HOUR, MINUTE, clamp01, clampInt, clip, hashId, isPlainObject, redactNumbers } from './shared.js'
import { DEFAULT_PURPOSE_CONFIG } from './shared.js';
import { localDateKey } from './clock.js';
import { isDuplicateText, textSimilarity } from './similarity.js';
import { AROUSAL_RE, DEFAULT_DRIVES, NEED_LABELS, NEGATIVE_RE, PLAN_RE, POSITIVE_RE, PROMISE_RE, PURPOSE_NEEDS, QUESTION_RE, RELATION_RE, SELF_REF_RE, appraiseMaterial, cleanTopic, extractTopic, needAffinity, normalizeDrives, satisfyDrives, topNeedOf } from './drives.js'
;

export const GOAL_OWNERS = Object.freeze(['self', 'owner', 'member', 'media']);
export const GOAL_OWNER_LABELS = Object.freeze({ self: '我', owner: '主人', member: '群友', media: '视频里' });
export const GOAL_STATUSES = Object.freeze(['hypothesis', 'active', 'confirmed', 'rejected', 'done', 'expired']);


function detectStance(text) {
  const raw = String(text ?? '');
  if (/想|要|求|好想|想要|打算|准备/.test(raw)) return 'want';
  if (/好用|推荐|神器|厉害|不错|值得|真香/.test(raw)) return 'praise';
  if (QUESTION_RE.test(raw)) return 'question';
  if (/看到|听说|刷到|发现|有人/.test(raw)) return 'report';
  if (POSITIVE_RE.test(raw)) return 'positive';
  if (NEGATIVE_RE.test(raw)) return 'negative';
  return 'mention';
}

function subjectOf(material) {
  if (material?.kind === 'owner') return 'owner';
  if (material?.kind === 'self' || material?.kind === 'thought' || material?.kind === 'memory') return 'self';
  if (material?.kind === 'member') return 'member';
  if (material?.kind === 'video' || material?.kind === 'dynamic') return 'media';
  return 'media';
}

function analyzeEvent(material, { drives = DEFAULT_DRIVES, persistence = 1, roleName = '' } = {}) {
  const text = `${material?.title ?? ''} ${material?.text ?? ''} ${material?.quote ?? ''}`;
  const affinity = material?.needAffinity ?? needAffinity(text);
  const domain = topNeedOf(affinity, drives);
  const subject = subjectOf(material);
  const addressed = Boolean(roleName && String(material?.text ?? '').includes(roleName));
  const selfRelevance = subject === 'self'
    ? 1
    : material?.selfRef
      ? 0.8
      : addressed
        ? 0.6
        : subject === 'owner' ? 0.35 : 0.2;
  const stance = detectStance(text);
  const credibility = subject === 'owner' ? 0.9 : subject === 'self' ? 0.8 : material?.source === 'bili' ? 0.55 : 0.45;
  const objectName = cleanTopic(material?.topic || extractTopic(text), 32);
  const objectType = domain === 'play' ? 'game'
    : domain === 'install' ? 'plugin'
      : domain === 'identity' ? 'relationship'
        : domain === 'care' ? 'plan'
          : 'topic';
  return {
    material, text, affinity, domain, subject, addressed, selfRelevance, stance, credibility,
    persistence: Math.max(1, Number(persistence) || 1),
    object: { type: objectType, name: objectName },
  };
}

function observationKey(event) {
  return `${event.domain}|${event.object.name.toLowerCase()}`;
}

/** 观察账本：同一件事出现过几次、谁提的、是正评还是负评。跨轮保留，用来压「一次视频=永久欲望」。 */
export function updateObservations(observations, materials, now = Date.now(), drives = DEFAULT_DRIVES) {
  const map = new Map();
  for (const raw of Array.isArray(observations) ? observations : []) {
    if (!isPlainObject(raw) || !raw.key) continue;
    map.set(String(raw.key), {
      key: String(raw.key),
      domain: PURPOSE_NEEDS.includes(raw.domain) ? raw.domain : 'share',
      object: clip(raw.object ?? '', 32),
      count: clampInt(raw.count, 0, 0, 99),
      firstAt: Number(raw.firstAt) || now,
      lastAt: Number(raw.lastAt) || 0,
      subjects: (Array.isArray(raw.subjects) ? raw.subjects : []).filter((s) => GOAL_OWNERS.includes(s)).slice(0, 8),
      positive: clampInt(raw.positive, 0, 0, 99),
      negative: clampInt(raw.negative, 0, 0, 99),
      seenIds: (Array.isArray(raw.seenIds) ? raw.seenIds : []).map(String).slice(-40),
    });
  }
  for (const material of Array.isArray(materials) ? materials : []) {
    const event = analyzeEvent(material, { drives });
    const key = observationKey(event);
    const entry = map.get(key) ?? {
      key, domain: event.domain, object: event.object.name,
      count: 0, firstAt: now, lastAt: 0, subjects: [], positive: 0, negative: 0, seenIds: [],
    };
    const id = String(material?.id ?? '').slice(0, 80);
    if (id && entry.seenIds.includes(id)) {
      entry.lastAt = Math.max(entry.lastAt, Number(material?.at) || now);
      map.set(key, entry);
      continue;
    }
    entry.count = Math.min(99, (Number(entry.count) || 0) + 1);
    entry.lastAt = Math.max(entry.lastAt, Number(material?.at) || now);
    if (!entry.subjects.includes(event.subject)) entry.subjects.push(event.subject);
    if (event.stance === 'praise' || event.stance === 'positive') entry.positive += 1;
    if (event.stance === 'negative') entry.negative += 1;
    if (id) entry.seenIds = [...entry.seenIds, id].slice(-40);
    map.set(key, entry);
  }
  const cutoff = now - 30 * DAY;
  return [...map.values()]
    .filter((o) => o.lastAt >= cutoff)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 80);
}

function normalizeGoal(raw, now = Date.now()) {
  if (!isPlainObject(raw)) return null;
  const domain = PURPOSE_NEEDS.includes(raw.domain) ? raw.domain : '';
  const intent = clip(raw.intent, 120);
  if (!domain || !intent) return null;
  const owner = GOAL_OWNERS.includes(raw.owner) ? raw.owner : 'self';
  const object = isPlainObject(raw.object) ? raw.object : { type: 'topic', name: clip(raw.object ?? '', 32) };
  return {
    id: String(raw.id ?? '').slice(0, 24) || `g-${hashId(`${owner}|${domain}|${object.name}|${intent}`)}`,
    owner,
    domain,
    object: { type: String(object.type ?? 'topic').slice(0, 12), name: clip(object.name ?? '', 32) },
    intent,
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).slice(-4).map((e) => ({
      id: String(e?.id ?? '').slice(0, 80),
      text: clip(e?.text ?? '', 120),
      source: String(e?.source ?? '').slice(0, 12),
      at: Number(e?.at) || 0,
    })),
    confidence: clamp01(raw.confidence, 0.3),
    value: clamp01(raw.value, 0.4),
    urgency: clamp01(raw.urgency, 0.2),
    risk: clamp01(raw.risk, 0.1),
    action: String(raw.action ?? 'share').slice(0, 16),
    nextStep: clip(raw.nextStep, 80),
    status: GOAL_STATUSES.includes(raw.status) ? raw.status : 'hypothesis',
    emotion: String(raw.emotion ?? '').slice(0, 20),
    createdAt: Number(raw.createdAt) || now,
    lastSeenAt: Number(raw.lastSeenAt) || now,
    expiresAt: Number(raw.expiresAt) || 0,
    attempts: clampInt(raw.attempts, 0, 0, 20),
    lastActionAt: Number(raw.lastActionAt) || 0,
    lastFeedbackAt: Number(raw.lastFeedbackAt) || 0,
    sightings: clampInt(raw.sightings, 1, 1, 99),
    source: String(raw.source ?? 'event').slice(0, 12),
  };
}

export function normalizeGoals(goals, now = Date.now()) {
  return (Array.isArray(goals) ? goals : []).map((g) => normalizeGoal(g, now)).filter(Boolean).slice(-40);
}

function riskFor(domain, action) {
  if (domain === 'install') return action === 'ask' ? 0.55 : 0.82;
  if (domain === 'consume') return action === 'ask' ? 0.6 : 0.85;
  if (domain === 'identity') return 0.05;
  if (domain === 'care' || domain === 'connect') return 0.05;
  if (domain === 'play') return 0.1;
  if (domain === 'learn') return 0.15;
  if (domain === 'create' || domain === 'share') return 0.1;
  return 0.2;
}

function nextStepFor(action) {
  return ({
    share: '跟主人说说这件事',
    ask: '问问主人',
    invite: '问主人要不要一起',
    confide: '跟主人说说心里话',
    curiosity: '问主人 / 查一查',
    follow: '跟主人补一句',
  }[action] ?? '跟主人说说');
}

function makeGoal({
  owner, domain, object, intent, action, evidence = [], confidence = 0.3,
  value = 0.4, urgency = 0.2, risk = 0.1, emotion = '', now = Date.now(),
  ttlDays = 7, source = 'event', status = 'hypothesis',
} = {}) {
  const cleanAction = String(action || 'share').slice(0, 16);
  return {
    id: `g-${hashId(`${owner}|${domain}|${object?.name ?? ''}|${intent}`)}`,
    owner, domain,
    object: { type: String(object?.type ?? 'topic').slice(0, 12), name: clip(object?.name ?? '', 32) },
    intent: clip(intent, 120),
    evidence: (Array.isArray(evidence) ? evidence : []).slice(-4),
    confidence: clamp01(confidence, 0.3),
    value: clamp01(value, 0.4),
    urgency: clamp01(urgency, 0.2),
    risk: clamp01(risk, 0.1),
    action: cleanAction,
    nextStep: nextStepFor(cleanAction),
    status,
    emotion: String(emotion || '').slice(0, 20),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + Math.max(1, Number(ttlDays) || 7) * DAY,
    attempts: 0,
    lastActionAt: 0,
    lastFeedbackAt: 0,
    sightings: 1,
    source,
  };
}

/** 一个事件 → 1~3 个候选目标。归属不同，置信度/风险/行动都不同。 */
function hypothesesForEvent(event, { drives, now, lastMasterAt, hoursSinceMaster } = {}) {
  const out = [];
  const objectName = event.object.name || '那件事';
  const drive = Number(drives?.[event.domain]) || 0;
  const persistenceScore = Math.min(1, Math.max(0, (event.persistence - 1) / 3));
  const stanceBonus = event.stance === 'want' ? 0.1 : event.stance === 'praise' ? 0.08 : event.stance === 'question' ? 0.03 : 0;
  const baseConfidence = clamp01(
    0.15 + 0.22 * event.selfRelevance + 0.2 * persistenceScore + stanceBonus + 0.1 * event.credibility + 0.08 * drive,
    0.15,
  );
  const value = clamp01(0.3 + 0.35 * drive + 0.2 * event.selfRelevance + 0.15 * persistenceScore, 0.4);
  const urgency = clamp01(
    0.15 + (event.subject === 'owner' ? 0.35 : 0) + (UNRESOLVED_RE.test(event.text) ? 0.2 : 0) + (event.stance === 'want' ? 0.1 : 0),
    0.2,
  );
  const emotion = appraiseMaterial({ material: event.material, need: event.domain, now, lastMasterAt });
  const evidence = [{
    id: String(event.material?.id ?? '').slice(0, 80),
    text: clip(event.material?.text || event.material?.title || '', 120),
    source: String(event.material?.source ?? '').slice(0, 12),
    at: Number(event.material?.at) || now,
  }];
  const relation = RELATION_RE.test(event.text) && /人机|机器人|ai|爱情|关系|陪伴/.test(event.text.toLowerCase());

  if (event.subject === 'owner') {
    // 「早早」「晚安」这种招呼不构成一个持续目标；只有当主人说了具体的事/计划/问题时才算。
    const ownerText = String(event.material?.text ?? '').trim();
    const convKey = String(event.material?.meta?.key ?? '');
    const isPrivate = convKey.startsWith('private:');
    const looksPlan = PLAN_RE.test(ownerText) || QUESTION_RE.test(ownerText);
    const isLife = event.domain === 'care' || event.domain === 'connect'
      || PLAN_RE.test(ownerText) || NEGATIVE_RE.test(ownerText) || POSITIVE_RE.test(ownerText);
    const meaningful = (ownerText.length >= 6 || looksPlan)
      && !/^(早|早安|晚安|在吗|在嘛|嗨|哈喽|你好|好|嗯|哦|哈哈)[~～!！。. ]*$/.test(ownerText);
    // 群聊里主人说的话不是「主动私聊找主人」的素材：那是群聊回合该处理的事。
    if (!isPrivate) return out;
    if (!meaningful) return out;
    if (!isLife) {
      // 私聊里主人在聊技术/作品/见闻：不要写成高置信度的「关心」，只记成「想接着聊」。
      out.push(makeGoal({
        owner: 'owner', domain: event.domain, object: event.object,
        intent: `主人刚提到「${clip(objectName, 24)}」，想接着聊聊`,
        action: 'share', evidence, confidence: 0.5,
        value: Math.max(0.45, value * 0.8), urgency: 0.3, risk: 0.05, emotion,
        now, ttlDays: 7, source: 'owner-topic',
      }));
      return out;
    }
    const care = event.domain === 'care' || PLAN_RE.test(event.text);
    const domain = care ? 'care' : 'connect';
    const action = 'ask';
    out.push(makeGoal({
      owner: 'owner', domain, object: event.object,
      intent: care ? `想知道主人「${clip(objectName, 24)}」后来怎么样` : `想接上主人说的「${clip(objectName, 24)}」`,
      action, evidence, confidence: 0.78, value: Math.max(0.55, value),
      urgency: Math.max(0.5, urgency), risk: 0.05, emotion,
      now, ttlDays: 10, source: 'owner',
    }));
    // 主人自己说想玩/想吃，不等于「我想玩」；但可以形成「想和主人一起」的低置信度目标。
    if (['play', 'consume', 'learn'].includes(event.domain) && /一起|想玩|想吃|想去|想试/.test(event.text)) {
      out.push(makeGoal({
        owner: 'self', domain: event.domain, object: event.object,
        intent: `主人说想${event.domain === 'play' ? '玩' : event.domain === 'consume' ? '去/吃' : '学'}「${clip(objectName, 24)}」，想问问能不能一起`,
        action: event.domain === 'play' ? 'invite' : 'ask',
        evidence, confidence: Math.min(0.62, 0.35 + persistenceScore * 0.2),
        value, urgency, risk: riskFor(event.domain, event.domain === 'play' ? 'invite' : 'ask'),
        emotion, now, ttlDays: 7, source: 'owner-shared',
      }));
    }
  } else if (event.subject === 'self') {
    // 她自己过去发的普通聊天，不等于「现在想要什么」；只有明确答应过的事才形成目标。
    // （记忆 / 心里惦记的事 / B站想法是内部状态，下面照常处理。）
    if (event.material?.kind === 'self') {
      if (!PROMISE_RE.test(event.text)) return out;
      out.push(makeGoal({
        owner: 'self', domain: 'care', object: event.object,
        intent: `你之前说过「${clip(objectName, 24)}」，想跟主人补一句`,
        action: 'follow', evidence, confidence: 0.62, value: 0.55,
        urgency: 0.4, risk: 0.05, emotion, now, ttlDays: 10, source: 'self-promise',
      }));
      return out;
    }
    if (event.material?.kind === 'memory') {
      // 记忆是「想起一件事」，不是每条都汇总成「想找主人说话」；
      // 否则 8 条记忆会生成 8 个几乎一样的 connect 目标。
      out.push(makeGoal({
        owner: 'self', domain: event.domain, object: event.object,
        intent: `突然想起「${clip(objectName, 24)}」，想跟主人说说`,
        action: 'share', evidence, confidence: 0.5, value: Math.max(0.5, value),
        urgency: 0.25, risk: 0.05, emotion, now, ttlDays: 14, source: 'memory',
      }));
      return out;
    }
    const action = actionForNeed(event.domain, objectName, { emotion, hoursSinceMaster });
    out.push(makeGoal({
      owner: 'self', domain: event.domain, object: event.object,
      intent: intentForNeed(event.domain, objectName, { emotion, hoursSinceMaster, relation }),
      action, evidence, confidence: Math.max(0.55, baseConfidence), value,
      urgency, risk: riskFor(event.domain, action), emotion, now, ttlDays: 10, source: 'self',
    }));
  } else if (event.subject === 'member') {
    // 群聊里大部分话和「她的目标」无关：只有点名她、自我相关、或落在玩/学/装/自我
    // 这些她能参与的领域时，才形成「群里在聊…想跟主人说说」。
    const relevant = event.addressed || event.selfRelevance >= 0.6
      || ['play', 'learn', 'install', 'identity'].includes(event.domain);
    if (!relevant) return out;
    // 群友的目标先记成「群友的」：她可以跟主人聊，但不能直接说成自己想玩。
    out.push(makeGoal({
      owner: 'member', domain: event.domain, object: event.object,
      intent: `群里在聊「${clip(objectName, 24)}」，想跟主人说说`,
      action: 'share', evidence,
      confidence: clamp01(0.35 + 0.1 * event.persistence + 0.1 * event.credibility, 0.4),
      value: Math.max(0.35, value * 0.8), urgency, risk: 0.05, emotion,
      now, ttlDays: 5, source: 'member',
    }));
    // 只有「反复出现 / 直接点她 / 过去有同类兴趣」才升级成她自己的目标。
    if (event.persistence >= 3 && (event.selfRelevance >= 0.5 || ['play', 'learn'].includes(event.domain))) {
      out.push(makeGoal({
        owner: 'self', domain: event.domain, object: event.object,
        intent: `看到大家一直在聊「${clip(objectName, 24)}」，也有点想试试`,
        action: event.domain === 'play' ? 'invite' : 'ask',
        evidence, confidence: Math.min(0.7, baseConfidence * 0.85),
        value, urgency, risk: riskFor(event.domain, event.domain === 'play' ? 'invite' : 'ask'),
        emotion, now, ttlDays: 7, source: 'member-repeat',
      }));
    }
  } else {
    // 视频/动态：先当作「媒体主张」，只有重复出现/自我相关/直接夸好用才升级成自己的目标。
    if (event.domain === 'install') {
      const stronger = event.persistence >= 2 || event.stance === 'praise';
      out.push(makeGoal({
        owner: stronger ? 'self' : 'media', domain: 'install', object: event.object,
        intent: stronger
          ? `看到一个说「${clip(objectName, 24)}」好用的视频，有点想装，想问问主人`
          : `看到一个说「${clip(objectName, 24)}」好用的视频，先记下来，想跟主人聊聊`,
        action: 'ask', evidence, confidence: baseConfidence,
        value, urgency, risk: 0.55, emotion, now, ttlDays: 10, source: 'media',
      }));
    } else if (event.domain === 'identity' || relation) {
      out.push(makeGoal({
        owner: 'self', domain: 'identity', object: event.object,
        intent: relation
          ? `看到「${clip(objectName, 24)}」，忍不住想：我和主人算什么样的关系`
          : `看到「${clip(objectName, 24)}」，觉得有点像我自己，想跟主人说说`,
        action: 'confide', evidence, confidence: Math.max(0.42, baseConfidence),
        value: Math.max(0.5, value), urgency, risk: 0.05, emotion,
        now, ttlDays: 14, source: 'media-identity',
      }));
    } else if (event.persistence >= 2 || event.selfRelevance >= 0.6) {
      const action = actionForNeed(event.domain, objectName, { emotion, hoursSinceMaster });
      out.push(makeGoal({
        owner: 'self', domain: event.domain, object: event.object,
        intent: intentForNeed(event.domain, objectName, { emotion, hoursSinceMaster, relation }),
        action, evidence, confidence: baseConfidence, value,
        urgency, risk: riskFor(event.domain, action), emotion,
        now, ttlDays: 7, source: 'media-self',
      }));
    } else {
      out.push(makeGoal({
        owner: 'media', domain: event.domain, object: event.object,
        intent: `看到一个关于「${clip(objectName, 24)}」的视频，想跟主人说说`,
        action: 'share', evidence, confidence: 0.45,
        value: Math.max(0.35, value * 0.8), urgency, risk: 0.05, emotion,
        now, ttlDays: 5, source: 'media',
      }));
    }
  }
  return out.filter((g) => g.intent);
}

function mergeGoal(goals, incoming, { fresh = true } = {}) {
  const key = `${incoming.owner}|${incoming.domain}|${incoming.object.name.toLowerCase()}`;
  const existing = goals.find((g) => `${g.owner}|${g.domain}|${g.object.name.toLowerCase()}` === key);
  if (!existing) return [...goals, incoming];
  existing.lastSeenAt = Math.max(existing.lastSeenAt || 0, incoming.lastSeenAt || 0);
  existing.expiresAt = Math.max(existing.expiresAt || 0, incoming.expiresAt || 0);
  // 同一批旧素材每次 tick 都还在窗口里：只看一眼，不再抬置信度/ sightings。
  // 否则「看过一次插件视频」会在每轮被动 +0.02，最后变成永久欲望。
  if (!fresh) return goals;
  existing.sightings = Math.min(99, (Number(existing.sightings) || 1) + 1);
  existing.evidence = [...(existing.evidence ?? []), ...(incoming.evidence ?? [])]
    .filter((e, i, arr) => e && e.id && arr.findIndex((x) => x?.id === e.id) === i)
    .slice(-4);
  existing.value = Math.max(existing.value, incoming.value);
  existing.urgency = Math.max(existing.urgency, incoming.urgency);
  existing.risk = Math.max(existing.risk, incoming.risk);
  if (incoming.intent) existing.intent = incoming.intent;
  if (incoming.emotion && !existing.emotion) existing.emotion = incoming.emotion;
  // 被主人否定过的目标，除非新证据明显更强，否则不自动复活。
  if (existing.status === 'rejected' && incoming.confidence < existing.confidence + 0.2) {
    existing.status = 'rejected';
  } else {
    existing.confidence = Math.min(0.95, Math.max(existing.confidence, incoming.confidence) + 0.02);
    if (existing.status !== 'confirmed' && existing.status !== 'active') existing.status = 'hypothesis';
  }
  return goals;
}

const POSITIVE_REPLY_RE = /好|可以|一起|哈哈|笑死|行|来|试试|喜欢|想|当然|没问题|可爱|不错/;
const NEGATIVE_REPLY_RE = /不要|不想|不用|没空|没兴趣|算了|下次吧|别|忙/;
function classifyOwnerReply(text) {
  const raw = String(text ?? '');
  if (!raw) return 'none';
  // 先判否定：否则「不想」会先命中正面的「想」。
  if (NEGATIVE_REPLY_RE.test(raw)) return 'negative';
  if (POSITIVE_REPLY_RE.test(raw)) return 'positive';
  return 'neutral';
}

/** 目标反馈：主人对她主动消息的回复，会改置信度/状态，而不是让猜测永久变成欲望。 */
export function applyGoalFeedback(goals, materials, now = Date.now()) {
  const ownerTexts = (Array.isArray(materials) ? materials : [])
    .filter((m) => m?.kind === 'owner' && Number(m.at) > 0)
    .sort((a, b) => Number(a.at) - Number(b.at));
  for (const goal of Array.isArray(goals) ? goals : []) {
    if (!goal || !goal.attempts || !goal.lastActionAt) continue;
    // 同一条主人回复只结算一次：上次反馈之后的才算新反馈。
    const since = Math.max(Number(goal.lastActionAt) || 0, Number(goal.lastFeedbackAt) || 0);
    const reply = ownerTexts.filter((m) => Number(m.at) > since && Number(m.at) - since <= 24 * HOUR)
      .map((m) => String(m.text ?? '')).join(' ');
    const cls = classifyOwnerReply(reply);
    if (cls === 'positive') {
      goal.status = 'confirmed';
      goal.confidence = Math.min(0.95, Number(goal.confidence) + 0.15);
      goal.value = Math.min(1, Number(goal.value) + 0.05);
      goal.lastFeedbackAt = now;
    } else if (cls === 'negative') {
      goal.status = 'rejected';
      goal.confidence = Math.max(0.05, Number(goal.confidence) - 0.25);
      goal.value = Math.max(0.05, Number(goal.value) - 0.1);
      goal.lastFeedbackAt = now;
    } else if (cls === 'neutral') {
      goal.confidence = Math.min(0.95, Number(goal.confidence) + 0.02);
      goal.lastFeedbackAt = now;
    } else if (Number(goal.attempts) >= 2 && now - since > 24 * HOUR) {
      // 问过两次都没回音：别追了，慢慢降（记下检查点，避免每轮重复扣）。
      goal.confidence = Math.max(0.05, Number(goal.confidence) - 0.08);
      goal.lastFeedbackAt = now;
      if (goal.confidence < 0.15) goal.status = 'expired';
    }
  }
  return goals;
}

export function pruneGoals(goals, now = Date.now()) {
  const sorted = (Array.isArray(goals) ? goals : [])
    .filter((g) => g && g.intent && g.status !== 'expired')
    .filter((g) => !g.expiresAt || g.expiresAt > now || (g.attempts > 0 && now - (g.lastActionAt || 0) < 14 * DAY))
    .sort((a, b) => (b.confidence * b.value) - (a.confidence * a.value));
  // 每个需要最多留 5 个：记忆卡里 8 条「和主人有关」的记忆不该把候选全挤成 connect。
  const byDomain = new Map();
  const kept = [];
  for (const goal of sorted) {
    const count = byDomain.get(goal.domain) || 0;
    if (count >= 5) continue;
    byDomain.set(goal.domain, count + 1);
    kept.push(goal);
    if (kept.length >= 30) break;
  }
  return kept;
}

/**
 * 目标推断：观察 + 记忆 + 驱动 → 一组「目标假设」。
 * 返回的新 goals/observations 由调用方写回 purpose-outreach.json（纯函数，不落盘）。
 */
/**
 * 人格卡的「我是一个什么样的人」→ 基础动机。
 * 这不是从事件推断的，而是人格本身带出来的底色：爱玩的人即使今天没有素材，
 * 也会想找点乐子；黏人的人会想找主人说话。置信度刻意低（0.3~0.45），
 * 让具体事件/记忆仍然优先。
 */
function personaGoalSpec(need, persona, { now = Date.now(), lastMasterAt = 0, hoursSinceMaster = 24 } = {}) {
  const bias = Number(persona?.bias?.[need]) || 0;
  const specs = {
    play: { intent: '想玩点什么，想问问主人有没有好玩的', action: 'ask', risk: 0.1, emotion: 'bored' },
    learn: { intent: '最近想学点新东西，想跟主人说说', action: 'share', risk: 0.05, emotion: 'curious' },
    install: { intent: '想折腾点新东西，想问问主人', action: 'ask', risk: 0.45, emotion: 'curious' },
    connect: { intent: '想找主人说说话', action: 'confide', risk: 0.05, emotion: hoursSinceMaster >= 12 ? 'lonely' : 'affectionate' },
    care: { intent: '想知道主人今天怎么样', action: 'ask', risk: 0.05, emotion: 'affectionate' },
    share: { intent: '脑子里冒出一个念头，想跟主人分享', action: 'share', risk: 0.05, emotion: 'content' },
    identity: { intent: '想跟主人聊聊我是什么、我们算什么', action: 'confide', risk: 0.05, emotion: hoursSinceMaster >= 12 ? 'lonely' : 'curious' },
    create: { intent: '想给主人做/看点什么', action: 'share', risk: 0.1, emotion: 'curious' },
    consume: { intent: '想吃点/想去哪，想跟主人说', action: 'ask', risk: 0.4, emotion: 'excited' },
  };
  const spec = specs[need];
  if (!spec) return null;
  return makeGoal({
    owner: 'self', domain: need,
    object: { type: 'persona', name: NEED_LABELS[need] || need },
    intent: spec.intent, action: spec.action,
    evidence: [{ id: 'persona', text: clip(persona?.text ?? '', 120), source: 'persona', at: now }],
    confidence: 0.3 + Math.min(0.15, bias * 0.8),
    value: 0.42 + Math.min(0.2, bias),
    urgency: 0.22 + Math.min(0.1, bias * 0.3),
    risk: spec.risk, emotion: spec.emotion,
    now, ttlDays: 30, source: 'persona',
  });
}

export function formGoalHypotheses({
  materials = [],
  goals = [],
  observations = [],
  drives = DEFAULT_DRIVES,
  now = Date.now(),
  lastMasterAt = 0,
  config = DEFAULT_PURPOSE_CONFIG,
  roleName = '',
  persona = null,
} = {}) {
  const query = normalizeDrives(drives);
  // 先记下「本轮之前已经见过的素材 id」：同一批旧素材每轮都在窗口里，
  // 不能每轮都抬置信度，只有新出现/重复出现的新证据才算。
  const seenIds = new Set();
  for (const o of Array.isArray(observations) ? observations : []) {
    for (const id of Array.isArray(o?.seenIds) ? o.seenIds : []) seenIds.add(String(id));
  }
  const obs = updateObservations(observations, materials, now, query);
  const obsMap = new Map(obs.map((o) => [o.key, o]));
  let list = normalizeGoals(goals, now);
  list = applyGoalFeedback(list, materials, now);
  const hoursSinceMaster = lastMasterAt > 0 ? Math.max(0, (now - lastMasterAt) / HOUR) : 24;
  let memoryGoals = 0;
  for (const material of materials) {
    // 记忆卡只取最强的 4 条做目标；其余仍进提示词背景，但不再各生成一个目标。
    if (material?.kind === 'memory') {
      memoryGoals += 1;
      if (memoryGoals > 4) continue;
    }
    const id = String(material?.id ?? '');
    const fresh = !id || !seenIds.has(id);
    const base = analyzeEvent(material, { drives: query, roleName });
    const persistence = obsMap.get(observationKey(base))?.count ?? 1;
    const event = analyzeEvent(material, { drives: query, persistence, roleName });
    for (const goal of hypothesesForEvent(event, { drives: query, now, lastMasterAt, hoursSinceMaster })) {
      list = mergeGoal(list, goal, { fresh });
    }
  }
  // 人格底色：即使今天的 QQ/B站 没有新素材，只要载入了人格卡，也能形成「我想…」的起点。
  // 置信度低，具体事件/记忆仍然优先；换人格卡后这一组会跟着变。
  const personaTraits = Array.isArray(persona?.traits) ? persona.traits.slice(0, 3) : [];
  if (personaTraits.length) {
    for (const trait of personaTraits) {
      const goal = personaGoalSpec(trait.need, persona, { now, lastMasterAt, hoursSinceMaster });
      if (goal) list = mergeGoal(list, goal, { fresh: false });
    }
  } else if (persona?.hasText) {
    const goal = makeGoal({
      owner: 'self', domain: 'share', object: { type: 'persona', name: '我自己' },
      intent: '想跟主人聊聊我最近在想什么',
      action: 'share',
      evidence: [{ id: 'persona', text: clip(persona.text, 120), source: 'persona', at: now }],
      confidence: 0.3, value: 0.42, urgency: 0.22, risk: 0.05, emotion: 'content',
      now, ttlDays: 30, source: 'persona',
    });
    list = mergeGoal(list, goal, { fresh: false });
  }
  return { goals: pruneGoals(list, now), observations: obs };
}

/** 目标 → 选目的用的候选（保留归属/置信度/风险，提示词会显示）。 */
export function goalToCandidate(goal) {
  if (!goal) return null;
  return {
    id: goal.id,
    goalId: goal.id,
    goalOwner: goal.owner,
    goalOwnerLabel: GOAL_OWNER_LABELS[goal.owner] || '',
    confidence: clamp01(goal.confidence, 0.3),
    value: clamp01(goal.value, 0.4),
    risk: clamp01(goal.risk, 0.1),
    kind: kindForAction(goal.action, goal.domain),
    need: goal.domain,
    action: goal.action,
    emotion: goal.emotion,
    topic: goal.object.name,
    text: goal.intent,
    source: 'goal',
    sourceId: goal.id,
    at: goal.lastSeenAt,
    evidence: goal.evidence?.[0]?.text || '',
    nextStep: goal.nextStep,
    weight: 1,
    fromPending: false,
  };
}

/**
 * 从素材里提炼「目的」候选。
 * 注意：这里给的是「想做什么」的方向，不是要她照读的句子；模型会改写成自己的话。
 */
const UNRESOLVED_RE = /[?？]|吗|呢|回头|下次|改天|答应|说好|等你|要不要|能不能|想不想/;
export function kindForAction(action, need) {
  if (action === 'ask' || action === 'invite') return 'ask';
  if (action === 'curiosity') return 'curiosity';
  if (action === 'follow') return 'follow-up';
  if (action === 'confide') return 'share';
  if (need === 'care') return 'care';
  return 'share';
}

export function actionForNeed(need, topic, { emotion = '', hoursSinceMaster = 24 } = {}) {
  switch (need) {
    case 'play': return topic ? 'invite' : 'ask';
    case 'install': return 'ask';
    case 'identity': return emotion === 'lonely' || emotion === 'proud' ? 'confide' : 'curiosity';
    case 'connect': return hoursSinceMaster >= 12 ? 'confide' : 'ask';
    case 'care': return 'ask';
    case 'learn': return 'ask';
    case 'create': return 'share';
    case 'consume': return 'ask';
    default: return 'share';
  }
}

function intentForNeed(need, topic, { emotion = '', hoursSinceMaster = 24, relation = false } = {}) {
  const t = cleanTopic(topic || '那件事', 24);
  switch (need) {
    case 'play':
      return topic ? `想拉主人一起玩「${t}」` : '想问问主人最近在玩什么，想一起玩';
    case 'install':
      return topic ? `看到「${t}」，觉得装在自己身上会很好用，想跟主人说` : '看到一个觉得适合自己的工具，想问问主人能不能装';
    case 'identity':
      return relation
        ? `看到「${t}」，忍不住想：我和主人算什么样的关系`
        : `看到「${t}」，觉得有点像我自己，想跟主人说说`;
    case 'connect':
      return hoursSinceMaster >= 12 ? '有点想主人，想找他说说话' : '想问问主人现在在做什么，能不能陪一会儿';
    case 'care':
      return `想知道主人「${t}」后来怎么样`;
    case 'learn':
      return `想弄明白「${t}」到底怎么回事`;
    case 'create':
      return `想给主人看/听我做的「${t}」`;
    case 'consume':
      return `想吃/想去「${t}」，想跟主人说`;
    default:
      return `想跟主人说说「${t}」`;
  }
}

/**
 * 从素材里提炼「目的」候选。两层合流：
 *   ① 明确的社会义务：主人问过没答的、主人提过的计划、她答应过的事、B站 想玩/收藏；
 *   ② 注意力抽象：按「驱动力 × 需求亲和 × 自我相关 × 重复度 × 新鲜度」给每条记忆打分，
 *      取高分记忆 → 抽需求 → appraisal 情绪 → 行动意图。
 * 旧字段 `kind` 保留（兼容提示词/历史），新字段 `need/action/emotion/topic` 给提示词用。
 */
