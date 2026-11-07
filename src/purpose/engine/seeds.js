// 决策层：minePurposeSeeds（从素材挖「可以主动说起的事」）+ selectPurpose（候选去重、打分、选出本轮目的）。
import { DAY, HOUR, MINUTE, clampInt, clip, hashId, isPlainObject } from './shared.js'
import { DEFAULT_PURPOSE_CONFIG } from './shared.js';
import { ACTION_LABELS, DEFAULT_DRIVES, DESIRE_RE, EMOTION_LABELS, NEED_LABELS, PLAN_RE, PROMISE_RE, PURPOSE_NEEDS, QUESTION_RE, appraiseMaterial, needAffinity, normalizeDrives, topNeedOf } from './drives.js'
import { clockText, localDateKey } from './clock.js';
import { isDuplicateText, textSimilarity } from './similarity.js';
import { goalToCandidate } from './goals.js'
import { clamp01 } from './shared.js'

export function minePurposeSeeds({
  materials = [],
  now = Date.now(),
  roleName = '',
  config = DEFAULT_PURPOSE_CONFIG,
  drives = DEFAULT_DRIVES,
  history = [],
  lastMasterAt = 0,
} = {}) {
  const seeds = [];
  const query = normalizeDrives(drives);
  const hoursSinceMaster = lastMasterAt > 0 ? Math.max(0, (now - lastMasterAt) / HOUR) : 24;
  // 「主人问过、她回没回」只看主人私聊里的她，不能被她在群里说话误判成已答。
  const selfTimes = materials
    .filter((m) => m.kind === 'self' && (!m.meta?.key || String(m.meta.key).startsWith('private:')))
    .map((m) => Number(m.at) || 0);
  const answeredAfter = (at, ms = 45 * MINUTE) => selfTimes.some((t) => t > at && t - at <= ms);
  const textOf = (m) => `${m?.title ?? ''} ${m?.text ?? ''} ${m?.quote ?? ''}`;
  const add = (kind, text, material, weight = 1, extra = {}) => {
    const clean = clip(text, 120);
    if (!clean || clean.length < 4) return;
    const aff = material?.needAffinity ?? needAffinity(textOf(material));
    const need = extra.need || topNeedOf(aff, query);
    const emotion = extra.emotion || appraiseMaterial({ material, need, now, lastMasterAt });
    seeds.push({
      id: `seed-${hashId(`${need}|${kind}|${clean}`)}`,
      kind,
      need,
      action: extra.action || actionForNeed(need, extra.topic || material?.topic, { emotion, hoursSinceMaster }),
      emotion,
      topic: extra.topic || material?.topic || '',
      text: clean,
      source: material?.source || '',
      sourceId: material?.id || '',
      at: Number(material?.at) || now,
      weight: Math.max(0.2, Number(weight) || 1),
      evidence: clip(material?.text || material?.title || '', 120),
    });
  };

  for (const m of materials) {
    const text = String(m.text ?? '');
    if (m.kind === 'owner') {
      if (QUESTION_RE.test(text) && !answeredAfter(m.at)) {
        add('curiosity', `想接上主人之前问的「${clip(text, 36)}」`, m, 1.25, {
          need: 'connect', action: 'curiosity',
        });
      }
      if (PLAN_RE.test(text)) {
        add('care', `想知道主人「${clip(text, 32)}」后来怎么样了`, m, 1.35, {
          need: 'care', action: 'ask',
        });
      }
    } else if (m.kind === 'self' && PROMISE_RE.test(text)) {
      add('follow-up', `你之前说过「${clip(text, 32)}」，想跟主人补一句`, m, 1.15, {
        need: 'care', action: 'follow',
      });
    } else if (m.kind === 'video') {
      const title = m.title ? `《${m.title}》` : '';
      if (DESIRE_RE.test(`${text} ${m.title ?? ''}`)) {
        add('ask', `你在B站看到${title || '一个东西'}，有点想试试，想跟主人提一句`, m, 1.2, {
          need: topNeedOf(m.needAffinity || needAffinity(text), query), action: 'ask',
        });
      } else if (m.meta?.favorite || Number(m.meta?.score) >= 12 || (m.quote && m.quote.length >= 12)) {
        add('share', `想跟主人说说你在B站看的${title || '那条视频'}`, m, 1.0, {
          need: 'share', action: 'share',
        });
      } else {
        add('share', `想把B站看到的${title || '一件小事'}讲给主人听`, m, 0.55, {
          need: 'share', action: 'share',
        });
      }
    } else if (m.kind === 'dynamic') {
      add('share', `你发过一条B站动态「${clip(m.text, 32)}」，想跟主人聊聊`, m, 0.8, {
        need: 'create', action: 'share',
      });
    } else if (m.kind === 'memory') {
      add('share', `突然想起「${clip(m.text, 34)}」，想跟主人提一句`, m, 0.9, {
        need: 'connect', action: 'share',
      });
    } else if (m.kind === 'thought' && m.source === 'bili') {
      add('share', `你在B站想过「${clip(m.text, 34)}」，想跟主人说说`, m, 0.85, {
        need: 'share', action: 'share',
      });
    } else if (m.kind === 'thought') {
      const kind = m.meta?.motivation === 'curiosity' ? 'curiosity' : 'share';
      add(kind, `你心里还惦记着「${clip(m.text, 36)}」`, m, 1.5, {
        need: topNeedOf(m.needAffinity || needAffinity(text), query),
        action: kind === 'curiosity' ? 'curiosity' : 'share',
      });
    } else if (m.kind === 'member') {
      const addressed = roleName ? text.includes(roleName) : /@/.test(text);
      if (addressed && QUESTION_RE.test(text)) {
        add('curiosity', `群里有人问「${clip(text, 32)}」，你想弄清楚`, m, 0.6, {
          need: 'learn', action: 'curiosity',
        });
      }
    }
  }

  // ② 推断层不在这里：`formGoalHypotheses` 负责「注意力 + 归属 + 置信度/风险」。
  //    这一层只产出「明确说出口/明确欠着」的种子；否则群友想玩会被误当成她想玩。

  // 没有可靠种子时给两个很轻的兜底，避免「素材有、但一条目的都提不出来」。
  if (!seeds.length && materials.length > 0) {
    add('share', '把最近看到的一件小事讲给主人听', materials[0], 0.5, { need: 'share', action: 'share' });
    add('ask', '想问主人一件一直没问出口的小事', materials[0], 0.45, { need: 'connect', action: 'ask' });
  }

  // 同一件事只留权重最高的一条；同 need+topic 也只留一条（避免「想玩A」写三遍）。
  const unique = [];
  const seenNeedTopic = new Set();
  for (const seed of seeds.sort((a, b) => b.weight - a.weight)) {
    if (unique.some((s) => textSimilarity(s.text, seed.text) >= 0.75)) continue;
    const key = `${seed.need}|${seed.topic}`;
    if (seed.topic && seenNeedTopic.has(key)) continue;
    if (seed.topic) seenNeedTopic.add(key);
    unique.push(seed);
  }
  return unique.slice(0, 16);
}

/**
 * 在「新提炼的候选」和「上次没说完的事」之间选一个。
 * 返回 { purpose, candidates, fromPending }。
 */
export function selectPurpose({
  seeds = [],
  goals = [],
  pending = [],
  history = [],
  config = DEFAULT_PURPOSE_CONFIG,
  drives = DEFAULT_DRIVES,
  now = Date.now(),
  lastMasterAt = 0,
  random = Math.random,
} = {}) {
  const recent = (Array.isArray(history) ? history : []).slice(-10);
  const query = normalizeDrives(drives);
  const hoursSinceMaster = lastMasterAt > 0 ? Math.max(0, (now - lastMasterAt) / HOUR) : 24;
  const candidates = [];
  const add = (item, weight, fromPending) => {
    const text = clip(item?.text, 120);
    if (!text) return;
    if (isDuplicateText(text, recent)) return;
    // 同一个目标已经主动说过：就算换了措辞也不重复。
    if (item?.goalId && recent.some((h) => h && h.goalId === item.goalId)) return;
    // 同一件 B站 视频 / 同一条记忆已经用过：就算措辞不同也换一个，别复读。
    if (item?.sourceId && recent.some((h) => h && h.sourceId && h.sourceId === item.sourceId)) return;
    if (candidates.some((c) => textSimilarity(c.text, text) >= 0.8)) return;
    const needAff = item.needAffinity || needAffinity(text);
    const need = PURPOSE_NEEDS.includes(item.need) ? item.need : topNeedOf(needAff, query);
    const emotion = item.emotion || appraiseMaterial({
      material: { text, title: '', selfRef: Boolean(item.selfRef), cues: emotionCues(text), needAffinity: needAff },
      need,
      now,
      lastMasterAt,
    });
    let action = item.action || actionForNeed(need, item.topic || '', { emotion, hoursSinceMaster });
    // 高风险目标只能「问」或「说」，不能默认替她做（装/买/联系别人）。
    if ((Number(item.risk) || 0) >= 0.5 && !['ask', 'share'].includes(action)) action = 'ask';
    candidates.push({
      id: item.id || `candidate-${hashId(text)}`,
      kind: String(item.kind || kindForAction(action, need)).slice(0, 20),
      need,
      needLabel: NEED_LABELS[need] || need,
      action: ACTION_LABELS[action] ? action : 'share',
      actionLabel: ACTION_LABELS[action] || ACTION_LABELS.share,
      emotion,
      emotionLabel: EMOTION_LABELS[emotion] || '',
      topic: String(item.topic || '').slice(0, 40),
      text,
      source: String(item.source || '').slice(0, 20),
      sourceId: String(item.sourceId || '').slice(0, 80),
      at: Number(item.at) || 0,
      weight: Math.max(0.1, Number(weight) || 1),
      evidence: clip(item.evidence || '', 120),
      fromPending: Boolean(fromPending),
      goalId: item.goalId || '',
      goalOwner: item.goalOwner || '',
      goalOwnerLabel: item.goalOwnerLabel || '',
      confidence: Number.isFinite(Number(item.confidence)) ? clamp01(item.confidence, 0) : null,
      risk: Number.isFinite(Number(item.risk)) ? clamp01(item.risk, 0) : null,
      value: Number.isFinite(Number(item.value)) ? clamp01(item.value, 0) : null,
      nextStep: String(item.nextStep || '').slice(0, 80),
    });
  };

  for (const goal of Array.isArray(goals) ? goals : []) {
    // 被拒绝/已完成/过期的目标不再主动提；新证据会把 rejected 重新变回 hypothesis。
    if (!goal || ['rejected', 'done', 'expired'].includes(goal.status)) continue;
    const candidate = goalToCandidate(goal);
    if (candidate) add(candidate, 1, false);
  }
  for (const seed of Array.isArray(seeds) ? seeds : []) add(seed, seed?.weight ?? 1, false);
  for (const p of Array.isArray(pending) ? pending : []) add(p, (Number(p?.weight) || 1) + 0.35, true);

  // 驱动越高的需要，越容易在这一次被选中；寂寞/羡慕这种情绪会再推一把。
  for (const c of candidates) {
    if (c.goalId) {
      // 目标假设：置信度/价值/风险都参与排序；风险高的不因为「想说」就排前面。
      c.weight *= 0.55 + (c.confidence ?? 0.3) * 0.7 + (c.value ?? 0.4) * 0.35 - (c.risk ?? 0.1) * 0.25;
    }
    c.weight *= 0.65 + 0.55 * (query[c.need] ?? 0);
    if (c.emotion === 'lonely') c.weight *= 1.2;
    if (c.emotion === 'envious') c.weight *= 1.1;
  }

  // 需要也要轮换：连续两次都在「陪」/「玩」，第三次先换一个维度，别把人设聊成单曲循环。
  const lastNeeds = recent.map((h) => h?.need).filter(Boolean);
  for (const c of candidates) {
    if (lastNeeds.slice(-3).includes(c.need)) c.weight *= 0.72;
    if (lastNeeds.slice(-2).length === 2 && lastNeeds.slice(-2).every((n) => n === c.need)) c.weight *= 0.65;
  }

  // 连续分享/连续索取都容易腻：按最近 3 次的类型轻轻调权。
  const lastKinds = recent.slice(-3).map((h) => String(h?.kind || ''));
  const shares = lastKinds.filter((k) => k === 'share').length;
  const asks = lastKinds.filter((k) => k === 'ask' || k === 'curiosity').length;
  for (const c of candidates) {
    if (shares >= 2 && c.kind !== 'share') c.weight *= 1.35;
    if (asks >= 2 && ['share', 'care', 'follow-up'].includes(c.kind)) c.weight *= 1.2;
  }

  candidates.sort((a, b) => b.weight - a.weight);
  // 候选去重：同一需要最多 2 个、同一目标归属最多 2 个；否则记忆卡一多，
  // 提示词会被 6 条一模一样的「想找主人说话」占满。
  const maxCandidates = Math.max(3, Number(config.maxCandidates) || 6);
  const diverse = [];
  const byNeed = new Map();
  const byOwner = new Map();
  for (const c of candidates) {
    const needCount = byNeed.get(c.need) || 0;
    const ownerCount = c.goalOwner ? (byOwner.get(c.goalOwner) || 0) : 0;
    if (needCount >= 2) continue;
    if (c.goalOwner && ownerCount >= 2) continue;
    diverse.push(c);
    byNeed.set(c.need, needCount + 1);
    if (c.goalOwner) byOwner.set(c.goalOwner, ownerCount + 1);
    if (diverse.length >= maxCandidates) break;
  }
  if (diverse.length < 3) {
    for (const c of candidates) {
      if (diverse.includes(c)) continue;
      diverse.push(c);
      if (diverse.length >= 3) break;
    }
  }
  const top = diverse;
  if (!top.length) return { purpose: null, candidates: [], fromPending: false };

  // 有一半概率优先处理「心里惦记着的事」——人也会先把没说完的话说完。
  const pendingTop = top.filter((c) => c.fromPending);
  if (pendingTop.length && random() < 0.5) {
    return { purpose: pendingTop[0], candidates: top, fromPending: true };
  }
  const total = top.reduce((sum, c) => sum + c.weight, 0);
  let roll = random() * total;
  for (const c of top) {
    roll -= c.weight;
    if (roll <= 0) return { purpose: c, candidates: top, fromPending: Boolean(c.fromPending) };
  }
  return { purpose: top[0], candidates: top, fromPending: Boolean(top[0].fromPending) };
}

// ── 提示词 ──────────────────────────────────────────────────────────────────

const KIND_LABEL = {
  share: '分享',
  ask: '索取',
  care: '关心',
  curiosity: '好奇',
  'follow-up': '追问',
};

export function relTime(at, now = Date.now()) {
  const t = Number(at) || 0;
  if (!t) return '时间未知';
  const diff = now - t;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < MINUTE) return '马上';
    if (ahead < HOUR) return `${Math.max(1, Math.round(ahead / MINUTE))} 分钟后`;
    const d = new Date(t);
    const today = new Date(now);
    const tomorrow = new Date(now + DAY);
    if (d.toDateString() === today.toDateString()) return `今天 ${clockText(d.getHours(), d.getMinutes())}`;
    if (d.toDateString() === tomorrow.toDateString()) return `明天 ${clockText(d.getHours(), d.getMinutes())}`;
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clockText(d.getHours(), d.getMinutes())}`;
  }
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))} 分钟前`;
  if (diff < 12 * HOUR) return `${Math.max(1, Math.round(diff / HOUR))} 小时前`;
  const d = new Date(t);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `今天 ${clockText(d.getHours(), d.getMinutes())}`;
  const yesterday = new Date(now - DAY);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${clockText(d.getHours(), d.getMinutes())}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clockText(d.getHours(), d.getMinutes())}`;
}

export function formatMaterialLine(material, now = Date.now()) {
  if (!material) return '';
  const prefix = material.source === 'bili'
    ? ({ video: 'B站·视频', dynamic: 'B站·动态', thought: 'B站·想法' }[material.kind] ?? 'B站')
    : material.kind === 'owner' ? 'QQ·主人'
      : material.kind === 'self' ? 'QQ·你'
        : material.kind === 'member' ? 'QQ·群友'
          : material.kind === 'memory' ? '记忆'
            : '心里';
  const title = material.title ? `《${material.title}》` : '';
  const quote = material.quote ? `（你当时评论：「${clip(material.quote, 60)}」）` : '';
  const who = material.kind === 'member' && material.who ? `${material.who}：` : '';
  return `- [${prefix}·${relTime(material.at, now)}] ${who}${title}${clip(material.text, 140)}${quote}`;
}

function kindLabel(kind) {
  return KIND_LABEL[kind] ?? '念头';
}

/**
 * 主动找主人的提示词。
 * 目标不是「让她复述素材」，而是让她先形成一个自己的目的，再按目的说话。
 */
