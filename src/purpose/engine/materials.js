// 素材层：collectMaterials（QQ/B站/记忆卡/惦记 → 最近素材）+ 文本相似度（textSimilarity/isDuplicateText）。
import { MINUTE, HOUR, DAY, isPlainObject, clampInt, clip, redactNumbers, hashId, tokenSet } from './shared.js';
import { DEFAULT_PURPOSE_CONFIG } from './shared.js';
import { localDateKey } from './clock.js';
import { emotionCues, extractTopic, isSelfReference, needAffinity } from './drives.js';
import { textSimilarity, isDuplicateText } from './similarity.js';

function convoList(conversations) {
  if (conversations instanceof Map) return [...conversations.entries()].map(([key, value]) => ({ key, ...value }));
  if (Array.isArray(conversations)) return conversations.filter(isPlainObject);
  if (isPlainObject(conversations)) return Object.entries(conversations).map(([key, value]) => ({ key, ...(isPlainObject(value) ? value : {}) }));
  return [];
}

function messageText(msg) {
  return clip(redactNumbers(msg?.text ?? msg?.plain ?? msg?.tail ?? ''), 220);
}

function messageAt(msg) {
  const at = Number(msg?.time);
  return Number.isFinite(at) && at > 0 ? at : 0;
}

/**
 * 把 QQ / B站 / 记忆卡 / 她自己的惦记 汇总成一份「最近素材」。
 * 这里只做选取和压缩，不下结论 —— 目的由模型在这些素材上提炼。
 */
function enrichMaterial(item, roleName = '') {
  const text = `${item?.title ?? ''} ${item?.text ?? ''} ${item?.quote ?? ''}`;
  return {
    ...item,
    selfRef: isSelfReference(text, roleName),
    needAffinity: needAffinity(text),
    topic: item?.topic || extractTopic(text, item?.title),
    cues: emotionCues(text),
  };
}

export function collectMaterials({
  now = Date.now(),
  config = DEFAULT_PURPOSE_CONFIG,
  ownerUin = '',
  roleName = '',
  conversations = [],
  biliEntries = [],
  memoryRecords = [],
} = {}) {
  const windowStart = now - Math.max(1, Number(config.materialWindowHours) || 72) * HOUR;
  const list = convoList(conversations);
  const items = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || !item.text || item.text.length < 2) return;
    const key = `${item.source}|${item.kind}|${item.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(enrichMaterial(item, roleName));
  };
  const stats = { qq: 0, bili: 0, memory: 0, thought: 0 };

  // ① 和主人的私聊：最重要，也最不容易「隔着群」。
  const ownerKey = ownerUin ? `private:${String(ownerUin).replace(/[^\d]/g, '')}` : '';
  const ownerConv = ownerKey ? list.find((c) => c.key === ownerKey) : null;
  if (ownerConv) {
    const recent = (Array.isArray(ownerConv.recentMessages) ? ownerConv.recentMessages : [])
      .filter((m) => m && messageAt(m) >= windowStart)
      .slice(-30);
    for (const m of recent) {
      const text = messageText(m);
      if (!text || text.startsWith('[拍一拍]')) continue;
      const kind = m.isSelf ? 'self' : (m.isOwner ? 'owner' : 'member');
      push({
        id: `qq:${ownerKey}:${messageAt(m)}:${kind}`,
        source: 'qq',
        kind,
        at: messageAt(m) || now,
        who: kind === 'self' ? '你' : (kind === 'owner' ? '主人' : clip(m.sender, 20)),
        text,
        meta: { key: ownerKey },
      });
      stats.qq += 1;
    }
  }

  // ② 群聊：只取最近活跃的 3 个群，重点挑「跟她有关 / 在问事 / 有约定」的几句。
  const groups = list
    .filter((c) => String(c.key ?? '').startsWith('group:'))
    .map((c) => {
      const recent = (Array.isArray(c.recentMessages) ? c.recentMessages : []).filter((m) => m && messageAt(m) >= windowStart);
      const lastAt = recent.length ? messageAt(recent[recent.length - 1]) : 0;
      return { c, recent, lastAt };
    })
    .filter((x) => x.lastAt > 0)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 3);

  const selfPromises = [];
  for (const { c, recent } of groups) {
    const candidates = [];
    for (const m of recent.slice(-16)) {
      const text = messageText(m);
      if (!text || text.startsWith('[拍一拍]')) continue;
      if (m.isSelf) {
        if (/回头|下次|改天|待会|晚点|明天|之后|再聊|再告诉|再说/.test(text)) selfPromises.push({ c, m, text });
        continue;
      }
      let score = 0;
      if (roleName && text.includes(roleName)) score += 3;
      if (/[?？]|吗|呢|怎么|为什么|有没有|要不要|能不能/.test(text)) score += 2;
      if (text.length >= 12) score += 1;
      if (/(^|\s)@/.test(text)) score += 1;
      candidates.push({ m, text, score });
    }
    candidates.sort((a, b) => b.score - a.score || messageAt(b.m) - messageAt(a.m));
    for (const { m, text } of candidates.slice(0, 5)) {
      push({
        id: `qq:${c.key}:${messageAt(m)}`,
        source: 'qq',
        kind: m.isOwner ? 'owner' : 'member',
        at: messageAt(m) || now,
        who: m.isOwner ? '主人' : clip(m.sender || '群友', 20),
        text,
        meta: { key: c.key },
      });
      stats.qq += 1;
    }
  }
  for (const { c, m, text } of selfPromises.slice(-2)) {
    push({
      id: `qq:self:${c.key}:${messageAt(m)}`,
      source: 'qq',
      kind: 'self',
      at: messageAt(m) || now,
      who: '你',
      text,
      meta: { key: c.key },
    });
    stats.qq += 1;
  }

  // ③ B站：视频/动态/想法。优先收藏、高分、带评论的。
  const biliWindowStart = now - Math.max(1, Number(config.biliWindowDays) || 7) * DAY;
  const bili = [];
  for (const entry of Array.isArray(biliEntries) ? biliEntries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const at = Number.isFinite(Number(entry.at)) && Number(entry.at) > 0
      ? Number(entry.at)
      : Date.parse(String(entry.at ?? entry.date ?? ''));
    if (!Number.isFinite(at) || at < biliWindowStart) continue;
    const type = String(entry.type ?? 'video');
    if (!['video', 'dynamic', 'thought'].includes(type)) continue;
    const title = clip(entry.title ?? '', 90);
    const text = clip(entry.text ?? entry.reason ?? '', 200);
    if (!title && !text) continue;
    const quote = clip(entry.quote ?? '', 90);
    const score = Number(entry.score) || 0;
    const favorite = Boolean(entry.favorite);
    const priority = Number(entry.priority) || 0;
    bili.push({
      id: `bili:${entry.id ?? entry.bvid ?? title}`,
      source: 'bili',
      kind: type,
      at,
      who: 'B站',
      title,
      text: text || title,
      quote,
      meta: { score, favorite, priority, bvid: String(entry.bvid ?? ''), url: String(entry.url ?? '') },
      weight: (favorite ? 2 : 0) + (score >= 12 ? 1 : 0) + priority / 10,
    });
  }
  bili.sort((a, b) => b.weight - a.weight || b.at - a.at);
  for (const item of bili.slice(0, 10)) {
    push(item);
    stats.bili += 1;
  }

  // ④ 记忆卡：近期/高重要度/高情绪的经历，给她「想起一件事」的材料。
  const memoryWindowStart = now - 30 * DAY;
  const memories = [];
  for (const record of Array.isArray(memoryRecords) ? memoryRecords : []) {
    if (!record || typeof record !== 'object') continue;
    const rawAt = Number(record.lastSeenAt ?? record.createdAt ?? 0);
    const at = Number.isFinite(rawAt) && rawAt > 0
      ? rawAt
      : Date.parse(String(record.lastSeenAt ?? record.createdAt ?? ''));
    if (!Number.isFinite(at)) continue;
    // 钉住/锚点/初次相遇是「人格与记忆卡」的骨架：即使超过 30 天也要能成为动机素材。
    const salient = Boolean(record.pinned || record.anchor || record.isInitial || record.firstMet);
    if (at < memoryWindowStart && !salient) continue;
    const importance = Number(record.importance) || 0;
    const emotional = Number(record.emotional) || 0;
    if (!(salient || importance >= 35 || emotional >= 6)) continue;
    const text = clip(`${record.title ? `${record.title}：` : ''}${record.text ?? ''}`, 220);
    if (!text) continue;
    memories.push({
      id: `mem:${record.id ?? text}`,
      source: 'memory',
      kind: 'memory',
      at: at || now,
      who: '记忆',
      text,
      meta: { importance, emotional, pinned: Boolean(record.pinned), anchor: Boolean(record.anchor), initial: Boolean(record.isInitial) },
      weight: importance / 100 + emotional / 20 + (salient ? 0.5 : 0),
    });
  }
  memories.sort((a, b) => b.weight - a.weight || b.at - a.at);
  for (const item of memories.slice(0, 8)) {
    push(item);
    stats.memory += 1;
  }

  // ⑤ 她自己的「活跃话题 / 没说出口的话」：最像人心里惦记着的东西。
  const thoughts = [];
  for (const conv of list) {
    if (conv.key !== ownerKey && !String(conv.key ?? '').startsWith('group:')) continue;
    for (const t of Array.isArray(conv.activeTopics) ? conv.activeTopics : []) {
      if (!t || !t.text) continue;
      thoughts.push({
        id: `topic:${conv.key}:${t.text}`,
        source: 'thought',
        kind: 'thought',
        at: Number(t.lastMentionAt) || now,
        who: '你',
        text: clip(`${t.text}${t.pendingQuestion ? `（还没问：${t.pendingQuestion}）` : ''}`, 200),
        meta: { motivation: 'activeTopic' },
        weight: 1.4,
      });
    }
    for (const t of Array.isArray(conv.pendingThoughts) ? conv.pendingThoughts : []) {
      if (!t || !t.text) continue;
      if (t.expiresAt && Number(t.expiresAt) <= now) continue;
      thoughts.push({
        id: `thought:${conv.key}:${t.text}`,
        source: 'thought',
        kind: 'thought',
        at: Number(t.createdAt) || now,
        who: '你',
        text: clip(t.text, 200),
        meta: { motivation: t.motivation || '' },
        weight: 1.5,
      });
    }
  }
  thoughts.sort((a, b) => b.weight - a.weight || b.at - a.at);
  for (const item of thoughts.slice(0, 6)) {
    push(item);
    stats.thought += 1;
  }

  const rank = { owner: 0, self: 1, thought: 2, video: 3, dynamic: 4, memory: 5, member: 6 };
  items.sort((a, b) => {
    const ra = rank[a.kind] ?? 9;
    const rb = rank[b.kind] ?? 9;
    if (ra !== rb) return ra - rb;
    return b.at - a.at;
  });
  const limited = items.slice(0, Math.max(6, Number(config.maxMaterials) || 36));
  return { items: limited, stats: { ...stats, total: items.length, included: limited.length, windowStart } };
}

// ── 目的候选 ────────────────────────────────────────────────────────────────

