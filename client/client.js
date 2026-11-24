// QQ Hub · 网页半边：侧栏「自动化任务」下面的「QQ Hub」入口 + 整页面板（顶部标签切换功能）。
// 只读写宿主半边的 /qq-hub/api/* 接口，不直接碰会话和 QQ。
// 视觉：中性底色 + 单一强调色的现代风，底色/文字跟随 DSH 主题变量（--dsw-alias-*），浅色 / 深色自动跟随。

window.__ModuleLoader__.load({
  id: 'dsh-qq-hub',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/src/entry.js
var entry_exports = {};
__export(entry_exports, {
  QQHubPage: () => QQHubPage,
  WhaleIcon: () => WhaleIcon,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(entry_exports);

// client/src/core/inner-fold.js
var OPEN_TAG = /<inner(?![A-Za-z0-9_-])[^>]*>/gi;
var CLOSE_TAG = /<\/inner\s*>/gi;
function splitInnerBlocks(text) {
  const source = String(text ?? "");
  const parts = [];
  let cursor = 0;
  let searchAt = 0;
  for (; ; ) {
    OPEN_TAG.lastIndex = searchAt;
    const open = OPEN_TAG.exec(source);
    if (!open) break;
    const contentStart = open.index + open[0].length;
    searchAt = contentStart;
    if (/\/>\s*$/.test(open[0])) continue;
    CLOSE_TAG.lastIndex = contentStart;
    const close = CLOSE_TAG.exec(source);
    if (!close) break;
    if (open.index > cursor) parts.push({ type: "text", value: source.slice(cursor, open.index) });
    parts.push({ type: "inner", value: source.slice(contentStart, close.index) });
    cursor = close.index + close[0].length;
    searchAt = cursor;
  }
  if (cursor === 0) return [{ type: "text", value: source }];
  if (cursor < source.length) parts.push({ type: "text", value: source.slice(cursor) });
  return parts;
}
function hasInnerBlock(text) {
  return /<inner(?![A-Za-z0-9_-])[^>]*>/i.test(String(text ?? "")) && splitInnerBlocks(text).some((part) => part.type === "inner");
}
var SKIP_KINDS = /* @__PURE__ */ new Set(["user", "steering", "context", "turn-trigger", "system-prompt", "command"]);
var SKIP_CLOSEST = "pre, code, .qqhub-inner";
var FOLD_ATTR = "data-qqhub-fold";
var STYLE_ID = "qqhub-inner-fold-style";
var FOLD_CLASS = "qqhub-inner";
var FOLD_SRC = "qqhubFoldSrc";
var FOLD_SRC_TEXT = "qqhubFoldText";
var STYLE_TEXT = `
.qqhub-inner { display: block; margin: 2px 0; }
.qqhub-inner-head {
  display: inline-flex; align-items: center; gap: 6px;
  margin: 0; padding: 0; border: 0; background: none;
  color: var(--dsw-alias-label-tertiary, currentColor);
  font: inherit; font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  cursor: pointer;
}
.qqhub-inner-head::before {
  content: ""; flex: none; width: 5px; height: 5px;
  border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg); transition: transform .12s;
}
.qqhub-inner-head[aria-expanded="true"]::before { transform: rotate(45deg); }
.qqhub-inner-head:focus-visible {
  outline: 1.5px solid var(--dsw-focus-ring-color, currentColor);
  outline-offset: 2px; border-radius: 2px;
}
.qqhub-inner-body {
  display: block; white-space: pre-wrap; overflow-wrap: anywhere;
  margin: 2px 0 4px; padding-left: 12px;
  border-left: 1px solid var(--dsw-alias-border-l2, currentColor);
  color: var(--dsw-alias-label-secondary, currentColor);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
}
/* hidden 属性 + 这条规则一起管折叠：只靠 UA 的 [hidden]{display:none} 会被上面的
   display:block 按特异性盖掉，于是正文永远摊开、点箭头也没反应（真机 2026-11-24 13:07）。 */
.qqhub-inner-body[hidden],
.qqhub-inner-body[data-collapsed="true"] { display: none !important; }
@media (prefers-reduced-motion: reduce) { .qqhub-inner-head::before { transition: none; } }
`;
function createFold(doc, raw, srcNode) {
  const wrap = doc.createElement("span");
  wrap.className = FOLD_CLASS;
  wrap.setAttribute(FOLD_ATTR, "");
  const text = String(raw ?? "").trim();
  if (srcNode !== void 0) wrap[FOLD_SRC] = srcNode;
  wrap[FOLD_SRC_TEXT] = text;
  const head = doc.createElement("button");
  head.type = "button";
  head.className = "qqhub-inner-head";
  head.setAttribute("aria-expanded", "false");
  head.textContent = "思考";
  const body = doc.createElement("span");
  body.className = "qqhub-inner-body";
  const setOpen = (next) => {
    head.setAttribute("aria-expanded", next ? "true" : "false");
    body.setAttribute("data-collapsed", next ? "false" : "true");
    if (next) body.removeAttribute("hidden");
    else body.setAttribute("hidden", "");
    body.hidden = !next;
  };
  setOpen(false);
  body.textContent = text;
  head.addEventListener("click", (event) => {
    event.preventDefault();
    setOpen(head.getAttribute("aria-expanded") !== "true");
  });
  wrap.append(head, body);
  return wrap;
}
function removeNode(node) {
  if (typeof node?.remove === "function") {
    node.remove();
  } else if (node?.parentNode && typeof node.parentNode.removeChild === "function") {
    node.parentNode.removeChild(node);
  }
}
function isAttached(node) {
  if (typeof node?.isConnected === "boolean") return node.isConnected;
  let cur = node;
  for (let depth = 0; cur !== null && cur !== void 0 && depth < 500; depth += 1) {
    if (cur.nodeType === 9) return true;
    cur = cur.parentNode;
  }
  return false;
}
function removeStaleSiblings(node) {
  let prev = node.previousSibling;
  while (prev && prev.nodeType === 1 && prev.hasAttribute?.(FOLD_ATTR)) {
    const stale = prev;
    prev = prev.previousSibling;
    removeNode(stale);
  }
  let next = node.nextSibling;
  while (next && next.nodeType === 1 && next.hasAttribute?.(FOLD_ATTR)) {
    const stale = next;
    next = next.nextSibling;
    removeNode(stale);
  }
}
function pruneFolds(root) {
  const latest = /* @__PURE__ */ new Map();
  const order = [];
  for (const span of root.querySelectorAll?.("." + FOLD_CLASS) ?? []) {
    const src = span[FOLD_SRC];
    if (src === void 0 || src === null || !isAttached(src)) {
      removeNode(span);
      continue;
    }
    const text = String(span[FOLD_SRC_TEXT] ?? "");
    if (!latest.has(text)) order.push(text);
    latest.set(text, span);
  }
  for (const text of order) {
    const keep = latest.get(text);
    for (const span of root.querySelectorAll?.("." + FOLD_CLASS) ?? []) {
      if (span === keep) continue;
      if (String(span[FOLD_SRC_TEXT] ?? "") === text) removeNode(span);
    }
  }
}
function foldTextNode(node, doc) {
  if (!node?.parentNode) return false;
  const parts = splitInnerBlocks(node.nodeValue);
  if (!parts.some((part) => part.type === "inner")) return false;
  const built = parts.filter((part) => part.value !== "").map((part) => part.type === "inner" ? { kind: "inner", dom: createFold(doc, part.value, node) } : { kind: "text", dom: doc.createTextNode(part.value) });
  const first = built[0];
  const last = built[built.length - 1];
  if (first === void 0 || last === void 0) return false;
  removeStaleSiblings(node);
  if (first.kind === "text") {
    node.nodeValue = first.dom.nodeValue;
    node.after(...built.slice(1).map((item) => item.dom));
    return true;
  }
  if (last.kind === "text") {
    node.nodeValue = last.dom.nodeValue;
    node.before(...built.slice(0, -1).map((item) => item.dom));
    return true;
  }
  node.nodeValue = "";
  node.before(...built.map((item) => item.dom));
  return true;
}
function foldWithin(root, doc) {
  try {
    pruneFolds(root);
  } catch (error) {
    console.warn("[qq-hub] 清理陈旧折叠行失败：", error);
  }
  const walker = doc.createTreeWalker(
    root,
    4
    /* SHOW_TEXT */
  );
  const targets = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const value = node.nodeValue;
    if (!value || value.indexOf("<") === -1 || !hasInnerBlock(value)) continue;
    if (node.parentElement?.closest(SKIP_CLOSEST)) continue;
    targets.push(node);
  }
  let folded = 0;
  for (const node of targets) {
    try {
      if (foldTextNode(node, doc)) folded += 1;
    } catch (error) {
      console.warn("[qq-hub] 折叠 <inner> 独白失败：", error);
    }
  }
  return folded;
}
function foldChatInner(doc) {
  if (!doc?.querySelectorAll) return 0;
  let folded = 0;
  for (const root of doc.querySelectorAll("[data-chat-flow-kind]")) {
    const kind = root.getAttribute("data-chat-flow-kind") || "";
    if (SKIP_KINDS.has(kind)) continue;
    folded += foldWithin(root, doc);
  }
  return folded;
}
function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  doc.head.append(style);
}
function installInnerFold({ doc = globalThis.document, delayMs = 400, observe = true } = {}) {
  if (!doc?.body || typeof doc.createTreeWalker !== "function") return () => {
  };
  ensureStyle(doc);
  let timer = null;
  let disposed = false;
  const run = () => {
    if (disposed) return;
    try {
      foldChatInner(doc);
    } catch (error) {
      console.warn("[qq-hub] 扫描聊天流失败：", error);
    }
  };
  const schedule = () => {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delayMs);
  };
  let observer = null;
  const View = doc.defaultView;
  if (observe && typeof View?.MutationObserver === "function") {
    observer = new View.MutationObserver(schedule);
    observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
  }
  run();
  return () => {
    disposed = true;
    observer?.disconnect();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

// client/src/core/react.js
var React = require("react");
var { useState, useEffect, useRef, useCallback, useMemo, Fragment } = React;
var h = React.createElement;

// client/src/ui/icons.js
function WhaleIcon({ size }) {
  const s = size || 16;
  return /* @__PURE__ */ h("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, /* @__PURE__ */ h("path", { d: "M3 13c0 3.6 3.3 6 8 6 4.6 0 8.2-2.7 8.7-6.6.1-.8.8-1.4 1.6-1.4H22c-.3-1.6-1.6-2.6-3-2.6-1.8 0-3 1.2-3.6 2.6H9c-3.4 0-6 .4-6 2Z" }), /* @__PURE__ */ h("path", { d: "M7.5 3.5c.8.9.9 2.3.2 3.3M10.5 3.5c-.8.9-.9 2.3-.2 3.3M9 6.8V9" }), /* @__PURE__ */ h("circle", { cx: "7.3", cy: "13.3", r: "0.6", fill: "currentColor" }));
}
var navIcon = (d) => /* @__PURE__ */ h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, /* @__PURE__ */ h("path", { d }));

// client/src/core/utils.js
var clone = (o) => JSON.parse(JSON.stringify(o));
var setPath = (obj, path, value) => {
  const next = clone(obj == null ? {} : obj);
  let cur = next;
  const ks = path.split(".");
  for (let i = 0; i < ks.length - 1; i++) cur = cur[ks[i]] = cur[ks[i]] || {};
  cur[ks[ks.length - 1]] = value;
  return next;
};
var getPath = (obj, path) => path.split(".").reduce((o, k) => o == null ? void 0 : o[k], obj);
var pct = (v) => Math.round((Number(v) || 0) * 100);
var cx = (...a) => a.filter(Boolean).join(" ");
var parsePct = (t) => {
  const n = Number(String(t).trim());
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(Math.min(n, 100));
};
var parseNumText = (t, { min, max, clamp, step } = {}) => {
  const s = String(t ?? "").trim();
  if (!s) return "";
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return "";
  const n = Number(s);
  if (!Number.isFinite(n)) return "";
  let v = Number(step || 1) === 1 ? Math.floor(n) : n;
  if (clamp) {
    if (min !== void 0 && min !== null && v < min) v = min;
    if (max !== void 0 && max !== null && v > max) v = max;
  }
  return v;
};
var commitNumText = (raw, { min, max, step, allowEmpty, scale } = {}) => {
  const unit = Number(step || 1);
  const parsed = parseNumText(raw, { min, max, clamp: true, step: unit });
  if (parsed === "") {
    if (allowEmpty) return { value: "", text: "" };
    const fallback = min !== void 0 && min !== null ? min : max !== void 0 && max !== null ? max : "";
    return { value: fallback === "" ? "" : fallback * (scale || 1), text: fallback === "" ? "" : String(fallback) };
  }
  return { value: parsed * (scale || 1), text: String(parsed) };
};
var pitchNum = (s) => {
  const m = /^([+-]?\d+)Hz$/i.exec(String(s || ""));
  return m ? Math.max(-80, Math.min(80, Number(m[1]))) : 0;
};
var pitchText = (n) => (n < 0 ? "-" : "+") + Math.abs(n) + "Hz";
var pitchLabel = (n) => n === 0 ? "正常（+0Hz）" : (n > 0 ? "+" : "") + n + " Hz";
var timeAgo = (t) => {
  if (!t) return "—";
  const s = Math.round((Date.now() - t) / 1e3);
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return new Date(t).toLocaleDateString();
};
var copy = (text, toast, msg) => {
  try {
    navigator.clipboard.writeText(text);
    if (msg) toast(msg, "ok");
  } catch (e) {
    toast("复制失败，手动选中复制吧", "err");
  }
};

// client/src/styles/theme.css
var theme_default = '/* QQ Hub 面板样式 —— 现代中性 SaaS 风。\n * 设计原则：\n *   - 一套 token 从上到下只声明一次，不再有「美化」覆盖段；\n *   - 层级靠间距和字重，不靠渐变和装饰条；\n *   - 跟随宿主 DSH 的主题变量（--dsw-alias-*），浅色/深色自动切换；\n *   - 变量名与类名沿用 .ab- / --ab- 前缀：内置模块的自定义面板（memory-privacy、\n *     token-guardian 等）直接引用这些类和变量，是隐形契约，不能改名。\n */\n\n/* ---------------- tokens ---------------- */\n.ab-root {\n  --ab-bg: var(--dsw-alias-bg-base, #f5f6f8);\n  --ab-card: var(--dsw-alias-bg-layer-1, #ffffff);\n  --ab-card-2: var(--dsw-alias-bg-layer-2, #f3f4f6);\n  --ab-text: var(--dsw-alias-label-primary, #1a1c20);\n  --ab-sub: var(--dsw-alias-label-secondary, #5c626d);\n  --ab-dim: var(--dsw-alias-label-tertiary, #878d97);\n  --ab-line: var(--dsw-alias-border-l1, rgba(17, 20, 28, .08));\n  --ab-line-2: var(--dsw-alias-border-l2, rgba(17, 20, 28, .14));\n  --ab-sea: #3366e6;\n  --ab-deep: #274fb8;\n  --ab-sky: #7fa3f0;\n  --ab-foam: rgba(51, 102, 230, .07);\n  --ab-foam-2: rgba(51, 102, 230, .14);\n  --ab-ok: var(--dsw-alias-state-success-primary, #1a8a4a);\n  --ab-warn: var(--dsw-alias-state-warn-primary, #b37d00);\n  --ab-err: var(--dsw-alias-state-error-primary, #d33b3b);\n  --ab-hover: var(--dsw-alias-interactive-bg-hover, rgba(17, 20, 28, .05));\n  --ab-shadow: 0 1px 2px rgba(16, 24, 40, .05);\n  --ab-shadow-lg: 0 8px 28px rgba(16, 24, 40, .16);\n  --ab-radius: 12px;\n  --ab-radius-sm: 8px;\n  --ab-focus: 0 0 0 3px var(--ab-foam-2);\n\n  height: 100%;\n  overflow: auto;\n  background: var(--ab-bg);\n  color: var(--ab-text);\n  font-size: 14px;\n  line-height: 1.55;\n  padding: var(--dsh-frame-top-clearance, 24px) 0 48px;\n  box-sizing: border-box;\n  font-family: var(--dsh-font-family-ui, inherit);\n  -webkit-font-smoothing: antialiased;\n}\nbody[data-ds-dark-theme] .ab-root, .ab-root.ab-dark {\n  --ab-sea: #6a95f5;\n  --ab-deep: #a5c0fa;\n  --ab-sky: #8fb0f7;\n  --ab-foam: rgba(106, 149, 245, .10);\n  --ab-foam-2: rgba(106, 149, 245, .20);\n  --ab-ok: #3fb968;\n  --ab-warn: #d9a13a;\n  --ab-err: #e5584f;\n  --ab-shadow: 0 1px 2px rgba(0, 0, 0, .3);\n  --ab-shadow-lg: 0 8px 28px rgba(0, 0, 0, .45);\n}\n.ab-root *, .ab-root *::before, .ab-root *::after { box-sizing: border-box }\n\n/* ---------------- 布局 ---------------- */\n.ab-wrap { max-width: 1020px; margin: 0 auto; padding: 0 24px }\n/* 单列轨道必须写成 minmax(0, 1fr)：裸 1fr 的最小值是 min-content，卡片里任何不可收缩的\n * 内容（扩展页紧凑行的 nowrap 描述、长路径、sha256……）都会把轨道顶到内容宽，\n * 整页跟着横向溢（真机 2026-11-21：系统 → 扩展页 393px 视口下轨道被撑到 1344px）。 */\n.ab-grid { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) }\n/* 网格轨道用 min(Npx, 100%) 而不是裸 Npx：窄屏（<320px 内容宽）时轨道能收到容器宽，\n * 否则 1fr 的隐式 min-content 会把整条轨道顶出视口、页面出现横向滚动（真机 2026-11-15） */\n.ab-g2 { grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)) }\n.ab-g4 { grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr)) }\n\n/* ---------------- 顶栏（替代旧 hero，无卡片无波浪） ---------------- */\n.ab-topbar { display: flex; align-items: center; gap: 14px; padding: 14px 2px 16px }\n.ab-avatar { width: 46px; height: 46px; border-radius: 50%; object-fit: cover; object-position: 50% 18%; background: var(--ab-card); border: 1px solid var(--ab-line-2); flex: none; display: block }\n.ab-topbar-main { flex: 1; min-width: 0 }\n.ab-topbar h1 { margin: 0; font-size: 18px; font-weight: 650; line-height: 1.3; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap }\n.ab-topbar .ab-meta { color: var(--ab-sub); font-size: 13px; margin-top: 2px }\n.ab-topbar-side { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; flex: none }\n.ab-avatar-btn { position: relative; padding: 0; border: 0; background: none; cursor: pointer; border-radius: 50%; flex: none }\n.ab-avatar-btn .ab-avatar-tip { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(15, 23, 42, .5); color: #fff; font-size: 12px; opacity: 0; transition: opacity .15s }\n.ab-avatar-btn:hover .ab-avatar-tip, .ab-avatar-btn:focus-visible .ab-avatar-tip { opacity: 1 }\n\n.ab-pills { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px }\n.ab-pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; font-size: 12px; background: var(--ab-card); border: 1px solid var(--ab-line); color: var(--ab-sub) }\n.ab-pill.ok { color: var(--ab-ok); border-color: color-mix(in srgb, var(--ab-ok) 25%, transparent); background: color-mix(in srgb, var(--ab-ok) 7%, var(--ab-card)) }\n.ab-pill.warn { color: var(--ab-warn); border-color: color-mix(in srgb, var(--ab-warn) 30%, transparent); background: color-mix(in srgb, var(--ab-warn) 8%, var(--ab-card)) }\n.ab-pill.err { color: var(--ab-err); border-color: color-mix(in srgb, var(--ab-err) 30%, transparent); background: color-mix(in srgb, var(--ab-err) 7%, var(--ab-card)) }\n.ab-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ab-dim); flex: none }\n.ab-dot.ok { background: var(--ab-ok) }\n.ab-dot.warn { background: var(--ab-warn) }\n.ab-dot.err { background: var(--ab-err) }\n\n/* ---------------- 桌面导航（分组 + 标签两层） ---------------- */\n/* 背景用不透明底色：吸顶元素挂 backdrop-filter 会让 Electron 每帧都对背后内容做模糊，\n * 滚动/点击掉帧的大头就是它（真机 2026-11-15 反馈）。毛玻璃观感让位给流畅度。 */\n.ab-nav { position: sticky; top: 0; z-index: 5; margin: var(--dsh-frame-top-clearance, 24px) 0 14px; border: 1px solid var(--ab-line); border-radius: var(--ab-radius); background: var(--ab-card); box-shadow: var(--ab-shadow) }\n/* ::before 是滚动遮罩：吸顶后盖住导航上方的宿主预留条，防止滚动内容从那一条里透出来。\n * 所以导航必须保留等高的顶部间距，把非滚动内容（顶栏）让出这条带——之前删掉这段间距，\n * 遮罩条正好压在顶栏的状态胶囊上，文字被「裁」掉一半（真机 2026-11-14 反馈）。 */\n.ab-nav::before { content: ""; position: absolute; left: -26px; right: -26px; bottom: calc(100% + 1px); height: var(--dsh-frame-top-clearance, 24px); background: var(--ab-bg); pointer-events: none }\n.ab-nav-top { display: flex; align-items: center; gap: 6px; padding: 6px }\n.ab-nav-groups { display: flex; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none }\n.ab-nav-groups::-webkit-scrollbar, .ab-nav-sub::-webkit-scrollbar { display: none }\n.ab-grp { flex: none; position: relative; display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 13px; border: 0; border-radius: var(--ab-radius-sm); background: transparent; color: var(--ab-sub); font: inherit; font-size: 13px; cursor: pointer; transition: background .15s, color .15s }\n.ab-grp svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; flex: none }\n.ab-grp:hover { background: var(--ab-hover); color: var(--ab-text) }\n.ab-grp.on { background: var(--ab-foam-2); color: var(--ab-deep); font-weight: 600 }\n.ab-grp .dirty { position: absolute; top: 5px; right: 5px; width: 6px; height: 6px; border-radius: 50%; background: var(--ab-warn) }\n.ab-find-btn { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px 0 10px; border: 1px solid var(--ab-line); border-radius: var(--ab-radius-sm); background: var(--ab-card-2); color: var(--ab-dim); font: inherit; font-size: 12px; cursor: pointer; transition: color .15s, border-color .15s }\n.ab-find-btn:hover { color: var(--ab-text); border-color: var(--ab-line-2) }\n.ab-find-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round }\n.ab-nav-sub { display: flex; gap: 2px; padding: 0 8px; border-top: 1px solid var(--ab-line); overflow-x: auto; scrollbar-width: none }\n.ab-tab { flex: none; position: relative; border: 0; background: transparent; color: var(--ab-sub); padding: 9px 12px 10px; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; transition: color .15s }\n.ab-tab:hover { color: var(--ab-text) }\n.ab-tab::after { content: ""; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px; border-radius: 2px; background: transparent; transition: background .15s }\n.ab-tab.on { color: var(--ab-deep); font-weight: 600 }\n.ab-tab.on::after { background: var(--ab-sea) }\n.ab-tab .dirty { width: 6px; height: 6px; border-radius: 50%; background: var(--ab-warn) }\n.ab-tab .ab-dot { width: 6px; height: 6px }\n.ab-finder { position: absolute; right: 6px; top: calc(100% + 6px); width: 340px; max-width: calc(100% - 12px); padding: 8px; border: 1px solid var(--ab-line-2); border-radius: var(--ab-radius); background: var(--ab-card); box-shadow: var(--ab-shadow-lg); z-index: 20 }\n.ab-finder .ab-input { width: 100% }\n.ab-finder-list { margin-top: 6px; max-height: 300px; overflow: auto; display: flex; flex-direction: column; gap: 1px }\n.ab-finder-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 0; background: transparent; border-radius: var(--ab-radius-sm); padding: 7px 10px; font: inherit; font-size: 13px; color: var(--ab-text); cursor: pointer }\n.ab-finder-item small { margin-left: auto; color: var(--ab-dim); font-size: 11.5px }\n.ab-finder-item.on, .ab-finder-item:hover { background: var(--ab-foam) }\n.ab-finder-empty { padding: 12px 10px; color: var(--ab-dim); font-size: 12px }\n.ab-kbd { font-family: var(--dsh-font-family-code, ui-monospace, monospace); font-size: 11px; padding: 0 5px; border: 1px solid var(--ab-line-2); border-radius: 5px; color: var(--ab-dim) }\n\n/* ---------------- 移动端导航：底部栏 + 当前分组横滚 chips ---------------- */\n.ab-mobilebar, .ab-chips { display: none }\n@media (max-width: 720px) {\n  .ab-nav { display: none }\n  .ab-root { padding-bottom: calc(64px + env(safe-area-inset-bottom, 0px)) }\n  .ab-wrap { padding: 0 14px }\n  .ab-topbar { flex-wrap: wrap; padding: 10px 0 12px }\n  .ab-topbar-side { flex-direction: row; align-items: center; width: 100%; justify-content: flex-start; gap: 14px }\n  .ab-chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding: 0 0 10px }\n  .ab-chips::-webkit-scrollbar { display: none }\n  .ab-chipbtn { flex: none; border: 1px solid var(--ab-line); background: var(--ab-card); color: var(--ab-sub); border-radius: 999px; padding: 6px 13px; font: inherit; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap }\n  .ab-chipbtn.on { background: var(--ab-foam-2); border-color: color-mix(in srgb, var(--ab-sea) 35%, transparent); color: var(--ab-deep); font-weight: 600 }\n  .ab-mobilebar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; display: flex; background: color-mix(in srgb, var(--ab-card) 94%, transparent); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-top: 1px solid var(--ab-line); padding: 4px 4px calc(4px + env(safe-area-inset-bottom, 0px)) }\n  .ab-mgrp { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; border: 0; background: transparent; color: var(--ab-dim); font: inherit; font-size: 10.5px; padding: 6px 2px; cursor: pointer; border-radius: var(--ab-radius-sm); position: relative }\n  .ab-mgrp svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round }\n  .ab-mgrp.on { color: var(--ab-deep) }\n  .ab-mgrp .dirty { position: absolute; top: 4px; right: calc(50% - 14px); width: 6px; height: 6px; border-radius: 50%; background: var(--ab-warn) }\n  /* 扩展页：窄屏下搜索框收窄，分组头允许换行 */\n  .ab-search { max-width: 132px }\n  .ab-modgroup-head { flex-wrap: wrap; row-gap: 2px }\n}\n\n/* ---------------- 卡片 ---------------- */\n.ab-card { background: var(--ab-card); border: 1px solid var(--ab-line); border-radius: var(--ab-radius); padding: 16px 18px; box-shadow: var(--ab-shadow) }\n.ab-card h3 { margin: 0 0 2px; font-size: 14.5px; font-weight: 620; display: flex; align-items: center; gap: 8px }\n.ab-card .ab-desc { color: var(--ab-sub); font-size: 12.5px; margin: 2px 0 12px; line-height: 1.6 }\n.ab-stat { padding: 14px 16px }\n.ab-stat .n { font-size: 26px; font-weight: 650; color: var(--ab-text); font-variant-numeric: tabular-nums; line-height: 1.25 }\n.ab-stat .l { color: var(--ab-sub); font-size: 12px; margin-top: 2px }\n.ab-stat .ic { position: absolute; right: 14px; top: 12px; font-size: 20px; opacity: .85 }\n\n/* ---------------- 字段行（label + hint + 控件） ---------------- */\n.ab-row { display: flex; align-items: flex-start; gap: 20px; padding: 12px 0; border-top: 1px solid var(--ab-line) }\n.ab-row:first-of-type { border-top: 0 }\n.ab-row .ab-label { flex: 0 0 200px; padding-top: 5px }\n.ab-row .ab-label b { display: block; font-weight: 560; font-size: 13.5px }\n.ab-row .ab-label small { display: block; color: var(--ab-dim); font-size: 12px; line-height: 1.5; margin-top: 2px }\n/* 控件列限宽：一行只有一个数字框时右侧不再留出大片空白，整页更紧凑 */\n.ab-row .ab-ctl { flex: 1; min-width: 0; max-width: 640px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap }\n\n/* ---------------- 控件 ---------------- */\n.ab-input, .ab-select, .ab-textarea { border: 1px solid var(--ab-line-2); border-radius: var(--ab-radius-sm); padding: 6px 10px; background: var(--ab-card); color: var(--ab-text); font: inherit; outline: none; min-width: 0; transition: border-color .12s, box-shadow .12s }\n.ab-input:hover, .ab-textarea:hover { border-color: var(--ab-sky) }\n.ab-input:focus, .ab-select:focus, .ab-textarea:focus { border-color: var(--ab-sea); box-shadow: var(--ab-focus) }\n.ab-input { width: 240px; max-width: 100%; height: 34px }\n.ab-input.sm { width: 120px }\n.ab-input.wide { width: 100% }\n.ab-textarea { width: 100%; min-height: 90px; resize: vertical; line-height: 1.55; font-family: var(--dsh-font-family-code, ui-monospace, monospace); font-size: 12.5px }\n.ab-btn { border: 1px solid var(--ab-line-2); background: var(--ab-card); color: var(--ab-text); padding: 6px 14px; border-radius: var(--ab-radius-sm); font: inherit; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; transition: background .12s, border-color .12s, box-shadow .12s, filter .12s; min-height: 32px }\n.ab-btn:hover { background: var(--ab-hover) }\n.ab-btn:disabled { opacity: .5; cursor: default }\n.ab-btn.primary { background: var(--ab-sea); border-color: var(--ab-sea); color: #fff }\n.ab-btn.primary:hover { filter: brightness(1.08) }\n.ab-btn.danger { color: var(--ab-err) }\n.ab-btn.danger:hover { background: color-mix(in srgb, var(--ab-err) 7%, transparent); border-color: color-mix(in srgb, var(--ab-err) 30%, transparent) }\n.ab-btn.ghost { border-color: transparent; background: transparent; color: var(--ab-sub) }\n.ab-btn.ghost:hover { color: var(--ab-text); background: var(--ab-hover) }\n.ab-btn.sm { padding: 3px 10px; font-size: 12px; min-height: 27px }\n.ab-spin { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: abSpin .7s linear infinite; vertical-align: -2px }\n@keyframes abSpin { to { transform: rotate(360deg) } }\n.ab-switch { position: relative; width: 38px; height: 22px; border-radius: 999px; background: var(--ab-line-2); border: 0; cursor: pointer; flex: none; transition: background .15s; padding: 0 }\n.ab-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .2); transition: left .15s }\n.ab-switch.on { background: var(--ab-sea) }\n.ab-switch.on::after { left: 19px }\n.ab-switch-row { display: flex; align-items: center; gap: 10px }\n.ab-seg { display: inline-flex; border: 1px solid var(--ab-line-2); border-radius: var(--ab-radius-sm); overflow: hidden }\n.ab-seg button { border: 0; background: transparent; padding: 6px 14px; font: inherit; font-size: 13px; color: var(--ab-sub); cursor: pointer; border-left: 1px solid var(--ab-line); min-height: 32px }\n.ab-seg button:first-child { border-left: 0 }\n.ab-seg button.on { background: var(--ab-foam-2); color: var(--ab-deep); font-weight: 600 }\n.ab-seg.off { opacity: .45 }\n.ab-seg.off button { cursor: not-allowed }\n.ab-choices { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr)); gap: 8px; width: 100% }\n.ab-choice { border: 1px solid var(--ab-line-2); border-radius: 10px; padding: 10px 12px; background: var(--ab-card); cursor: pointer; text-align: left; font: inherit; color: var(--ab-text); transition: border-color .12s, box-shadow .12s }\n.ab-choice:hover { border-color: var(--ab-sky) }\n.ab-choice.on { border-color: var(--ab-sea); box-shadow: var(--ab-focus); background: linear-gradient(var(--ab-foam), var(--ab-foam)), var(--ab-card) }\n.ab-choice b { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13.5px }\n.ab-choice.on b { color: var(--ab-deep) }\n.ab-choice small { display: block; color: var(--ab-dim); font-size: 12px; margin-top: 3px; line-height: 1.5 }\n.ab-range { display: flex; align-items: center; gap: 10px; min-width: 240px; max-width: 440px }\n.ab-range input[type=range] { flex: 1; accent-color: var(--ab-sea); height: 4px }\n.ab-range .val { min-width: 0; padding: 1px 9px; border-radius: 999px; background: var(--ab-foam); color: var(--ab-deep); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap }\n.ab-drop { border: 2px dashed var(--ab-line-2); border-radius: var(--ab-radius); padding: 22px 16px; text-align: center; color: var(--ab-sub); cursor: pointer; transition: border-color .15s, background .15s; background: var(--ab-card-2) }\n.ab-drop:hover, .ab-drop:focus-visible { border-color: var(--ab-sky); outline: none }\n.ab-drop.over { border-color: var(--ab-sea); background: var(--ab-foam); color: var(--ab-deep) }\n\n/* 自定义下拉 */\n.ab-sel { position: relative; display: inline-block; min-width: 200px; max-width: 100% }\n.ab-sel-btn { width: 100%; display: flex; align-items: center; gap: 8px; border: 1px solid var(--ab-line-2); border-radius: var(--ab-radius-sm); padding: 6px 10px; background: var(--ab-card); color: var(--ab-text); font: inherit; font-size: 13px; cursor: pointer; text-align: left; min-height: 34px; transition: border-color .12s, box-shadow .12s }\n.ab-sel-btn:hover { border-color: var(--ab-sky) }\n.ab-sel-btn:focus-visible, .ab-sel.open .ab-sel-btn { outline: none; border-color: var(--ab-sea); box-shadow: var(--ab-focus) }\n.ab-sel-btn .v { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }\n.ab-sel-btn .chev { flex: none; color: var(--ab-dim); transition: transform .15s }\n.ab-sel.open .chev { transform: rotate(180deg) }\n.ab-sel-pop { position: absolute; z-index: 40; top: calc(100% + 6px); left: 0; min-width: 100%; max-height: 300px; overflow: auto; padding: 5px; border-radius: 10px; background: var(--ab-card); border: 1px solid var(--ab-line-2); box-shadow: var(--ab-shadow-lg); animation: abPop .12s ease-out }\n@keyframes abPop { from { opacity: 0; transform: translateY(-4px) } to { opacity: 1; transform: none } }\n.ab-sel-opt { display: flex; align-items: flex-start; gap: 8px; padding: 7px 10px; border-radius: var(--ab-radius-sm); cursor: pointer; color: var(--ab-text); white-space: nowrap }\n.ab-sel-opt .ck { width: 14px; flex: none; color: var(--ab-sea); font-weight: 700 }\n.ab-sel-opt .tx { flex: 1; min-width: 0 }\n.ab-sel-opt .ds { display: block; font-size: 11.5px; color: var(--ab-dim); margin-top: 1px; white-space: normal }\n.ab-sel-opt.act { background: var(--ab-hover) }\n.ab-sel-opt.on { background: var(--ab-foam); color: var(--ab-deep); font-weight: 560 }\n.ab-sel-group { font-size: 11px; color: var(--ab-dim); padding: 6px 10px 2px; letter-spacing: .04em }\n\n/* ---------------- 提示 / 徽章 / 小件 ---------------- */\n.ab-note { padding: 10px 12px; border-radius: 10px; background: var(--ab-foam); color: var(--ab-text); font-size: 12.5px; border: 1px solid var(--ab-foam-2); line-height: 1.6 }\n.ab-note.warn { background: color-mix(in srgb, var(--ab-warn) 8%, var(--ab-card)); border-color: color-mix(in srgb, var(--ab-warn) 28%, transparent) }\n.ab-note.err { background: color-mix(in srgb, var(--ab-err) 7%, var(--ab-card)); border-color: color-mix(in srgb, var(--ab-err) 26%, transparent) }\n.ab-badge { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; background: var(--ab-sea); color: #fff; font-weight: 500; white-space: nowrap }\n.ab-badge.dim { background: var(--ab-card-2); color: var(--ab-sub); border: 1px solid var(--ab-line) }\n.ab-badge.warn { background: color-mix(in srgb, var(--ab-warn) 14%, var(--ab-card)); color: var(--ab-warn); border: 1px solid color-mix(in srgb, var(--ab-warn) 30%, transparent) }\n.ab-badge.err { background: color-mix(in srgb, var(--ab-err) 10%, var(--ab-card)); color: var(--ab-err); border: 1px solid color-mix(in srgb, var(--ab-err) 30%, transparent) }\n.ab-badge.mine { background: var(--ab-deep) }\n.ab-chip { border: 1px dashed var(--ab-line-2); background: transparent; color: var(--ab-sub); border-radius: 999px; padding: 3px 12px; font: inherit; font-size: 12px; cursor: pointer; transition: border-color .12s, color .12s, background .12s }\n.ab-chip:hover { border-color: var(--ab-sea); color: var(--ab-deep); background: var(--ab-foam) }\n.ab-chip.solid { border-style: solid }\n.ab-chip.on { border-style: solid; border-color: var(--ab-sea); background: var(--ab-foam-2); color: var(--ab-deep); font-weight: 600 }\n.ab-chip .n { margin-left: 6px; font-size: 11px; color: var(--ab-dim); font-weight: 400 }\n.ab-ibtn { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 7px; background: transparent; color: var(--ab-sub); cursor: pointer; padding: 0 }\n.ab-ibtn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round }\n.ab-ibtn:hover { background: var(--ab-hover); color: var(--ab-text) }\n.ab-ibtn.danger:hover { color: var(--ab-err) }\n.ab-ibtn:disabled { opacity: .3; cursor: default; background: transparent }\n.ab-aibtn { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; margin-left: 2px; border: 0; border-radius: 7px; background: var(--ab-foam); color: var(--ab-deep); font: inherit; font-size: 12px; cursor: pointer; transition: background .12s }\n.ab-aibtn:hover, .ab-aibtn.on { background: var(--ab-foam-2) }\n.ab-aibtn svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round }\n\n.ab-steps { counter-reset: s; display: flex; flex-direction: column; gap: 12px }\n.ab-step { display: flex; gap: 12px; align-items: flex-start }\n.ab-step::before { counter-increment: s; content: counter(s); flex: none; width: 22px; height: 22px; border-radius: 50%; background: var(--ab-foam-2); color: var(--ab-deep); font-weight: 650; display: flex; align-items: center; justify-content: center; font-size: 12px }\n.ab-step.done::before { content: "✓"; background: var(--ab-ok); color: #fff }\n.ab-step > div { flex: 1; min-width: 0 }\n.ab-kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 12.5px }\n.ab-kv span:nth-child(odd) { color: var(--ab-sub) }\n\n.ab-table { width: 100%; border-collapse: collapse; font-size: 13px }\n.ab-table th { text-align: left; color: var(--ab-dim); font-weight: 500; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--ab-line); white-space: nowrap }\n.ab-table td { padding: 7px 8px; border-bottom: 1px solid var(--ab-line) }\n.ab-table tr:last-child td { border-bottom: 0 }\n.ab-table tr:hover td { background: var(--ab-hover) }\n\n.ab-flex { display: flex; align-items: center; gap: 8px; flex-wrap: wrap }\n.ab-spacer { flex: 1 }\n.ab-muted { color: var(--ab-sub) }\n.ab-small { font-size: 12px }\n.ab-section-title { font-size: 12px; font-weight: 600; color: var(--ab-dim); letter-spacing: .04em; margin: 16px 2px 8px }\n.ab-empty { padding: 28px 12px; text-align: center; color: var(--ab-dim) }\n.ab-empty .big { font-size: 26px; margin-bottom: 4px }\n\n/* 列表行 */\n.ab-list { display: flex; flex-direction: column }\n.ab-li { display: flex; gap: 12px; align-items: flex-start; padding: 10px 4px; border-top: 1px solid var(--ab-line); border-radius: var(--ab-radius-sm) }\n.ab-li:first-child { border-top: 0 }\n.ab-li:hover { background: var(--ab-hover) }\n.ab-li .meta { color: var(--ab-dim); font-size: 11.5px; white-space: nowrap }\n.ab-li .body { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word }\n\n/* 日志 */\n.ab-logs { font-family: var(--dsh-font-family-code, ui-monospace, monospace); font-size: 12px; max-height: 520px; overflow: auto; border-radius: 10px; background: var(--ab-card-2); border: 1px solid var(--ab-line); padding: 8px 0 }\n.ab-log { display: flex; gap: 10px; padding: 2px 12px; align-items: baseline }\n.ab-log:hover { background: var(--ab-hover) }\n.ab-log .t { color: var(--ab-dim); flex: none }\n.ab-log .a { flex: none; color: var(--ab-sea); min-width: 62px }\n.ab-log .m { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word }\n.ab-log.warn .m { color: var(--ab-warn) }\n.ab-log.error .m { color: var(--ab-err) }\n.ab-log.debug .m { color: var(--ab-dim) }\n.ab-mem-item { transition: background .12s; border-radius: 6px; margin: 0 -6px; padding: 6px 6px !important }\n/* memory-privacy 的查看弹窗底色偏暗，hover 高亮两种主题下都要可见 */\n.ab-mem-item:hover { background: rgba(122, 143, 175, .18) }\n.ab-close { transition: opacity .12s }\n.ab-close:hover { opacity: .72 }\n.ab-code { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; background: var(--ab-card-2); border: 1px solid var(--ab-line); border-radius: var(--ab-radius-sm); padding: 8px 10px; white-space: pre-wrap; word-break: break-all; margin: 6px 0 0 }\n\n/* 表情包 / 截图 / 画作 */\n.ab-stickers { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 10px }\n.ab-sticker { border: 1px solid var(--ab-line); border-radius: 10px; padding: 8px; background: var(--ab-card); display: flex; flex-direction: column; gap: 6px; position: relative; transition: transform .12s, box-shadow .12s }\n.ab-sticker:hover { transform: translateY(-2px); box-shadow: var(--ab-shadow) }\n.ab-sticker img { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: var(--ab-radius-sm); background: var(--ab-card-2) }\n.ab-sticker .nm, .ab-sticker .tg { border: 1px dashed transparent; background: transparent; text-align: center; width: 100%; outline: none; padding: 2px 4px; border-radius: 6px; font: inherit }\n.ab-sticker .nm { font-size: 12px; color: var(--ab-text) }\n.ab-sticker .tg { font-size: 11px; color: var(--ab-dim); min-height: 16px }\n.ab-sticker:hover .nm, .ab-sticker:hover .tg { border-color: var(--ab-line) }\n.ab-sticker .nm:focus, .ab-sticker .tg:focus { background: var(--ab-card-2); border-style: solid; border-color: var(--ab-line) }\n.ab-sticker .x, .ab-shot .x { position: absolute; top: 4px; right: 4px; opacity: 0; transition: opacity .15s }\n.ab-sticker:hover .x, .ab-shot:hover .x { opacity: 1 }\n.ab-shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 10px }\n.ab-shot { border: 1px solid var(--ab-line); border-radius: 10px; padding: 6px; background: var(--ab-card); display: flex; flex-direction: column; gap: 6px; position: relative }\n.ab-shot img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: var(--ab-radius-sm); background: var(--ab-card-2); display: block }\n.ab-shot .cap { font-size: 11px; color: var(--ab-dim); line-height: 1.35; max-height: 2.7em; overflow: hidden }\n\n/* 人格页：左列（列表+头像）跟随滚动钉在吸顶导航下方——右侧编辑区很长时，\n * 左列不跟着滚空一大块；列表条目少时视觉上也更完整。\n * 轨道 minmax(0,1fr)：行内「200px 标签 + 240px 固定宽输入」的最小内容宽会把裸 1fr\n * 轨道顶到 ~438px，窄屏整页横向溢出（真机 2026-11-15） */\n.ab-persona { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 12px; align-items: start }\n.ab-plist { position: sticky; top: 124px; display: flex; flex-direction: column; gap: 6px }\n.ab-pitem { text-align: left; border: 1px solid var(--ab-line); background: var(--ab-card); border-radius: 10px; padding: 10px 12px; cursor: pointer; color: var(--ab-text); font: inherit; transition: border-color .12s, box-shadow .12s }\n.ab-pitem:hover { border-color: var(--ab-line-2) }\n.ab-pitem.on { border-color: var(--ab-sea); box-shadow: var(--ab-focus) }\n.ab-pitem .nm { font-weight: 600; display: flex; align-items: center; gap: 6px }\n.ab-pitem .tg { color: var(--ab-dim); font-size: 11.5px; margin-top: 2px }\n.ab-psecs { display: flex; flex-direction: column; gap: 10px; margin-top: 12px }\n.ab-psec { --c: var(--ab-sea); border: 1px solid var(--ab-line); border-radius: var(--ab-radius); background: var(--ab-card); transition: border-color .2s, box-shadow .2s }\n.ab-psec:hover { border-color: color-mix(in srgb, var(--c) 24%, var(--ab-line)) }\n.ab-psec:focus-within { border-color: color-mix(in srgb, var(--c) 40%, var(--ab-line)); box-shadow: 0 0 0 4px color-mix(in srgb, var(--c) 8%, transparent) }\n.ab-psec-head { display: flex; align-items: center; gap: 4px; padding: 10px 8px 0 14px }\n.ab-psec-head::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--c); margin-right: 8px; opacity: .9 }\n.ab-psec-title { flex: 1; min-width: 0; border: 0; background: transparent; font: inherit; font-weight: 600; font-size: 13.5px; letter-spacing: .02em; color: color-mix(in srgb, var(--c) 42%, var(--ab-text)); padding: 4px 0; outline: none }\n.ab-psec-title::placeholder { color: var(--ab-dim); font-weight: 400 }\n.ab-psec-fixed { flex: 1; min-width: 0; font-weight: 620; font-size: 13.5px; padding: 4px 0 }\n.ab-psec-fixed small { font-weight: 400; color: var(--ab-dim); margin-left: 8px; font-size: 11.5px }\n.ab-psec-n { font-size: 11px; color: var(--ab-dim); font-variant-numeric: tabular-nums; margin-right: 4px }\n.ab-psec-act { display: flex; align-items: center; gap: 2px; opacity: .5; transition: opacity .12s }\n.ab-psec:hover .ab-psec-act, .ab-psec:focus-within .ab-psec-act { opacity: 1 }\n.ab-psec textarea { display: block; width: 100%; border: 0; background: transparent; resize: vertical; outline: none; padding: 6px 16px 12px 30px; font: inherit; font-size: 13px; line-height: 1.75; color: var(--ab-text) }\n.ab-psec textarea::placeholder { color: var(--ab-dim) }\n.ab-psec.cmp { border-color: color-mix(in srgb, var(--c) 45%, var(--ab-line)); box-shadow: 0 0 0 4px color-mix(in srgb, var(--c) 10%, transparent) }\n.ab-psec.cmp textarea { cursor: default }\n.ab-psec-add { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 12px }\n.ab-tf-who { margin-top: 8px; font-size: 12px; color: var(--ab-sub); line-height: 1.6 }\n.ab-compare { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 12px 12px; padding: 8px 8px 8px 12px; border-radius: 10px; background: var(--ab-foam) }\n.ab-compare-tag { font-size: 11.5px; font-weight: 600; color: var(--ab-deep); padding: 1px 8px; border-radius: 999px; background: var(--ab-card); border: 1px solid var(--ab-foam-2) }\n\n/* 进度条（token 用量等） */\n.ab-mood { height: 10px; border-radius: 999px; background: var(--ab-card-2); overflow: hidden; border: 1px solid var(--ab-line) }\n.ab-mood > i { display: block; height: 100%; border-radius: 999px; background: var(--ab-sea) }\n.ab-mood > i.hot { background: var(--ab-warn) }\n.ab-mood > i.full { background: var(--ab-err) }\n\n/* 保存条 / toast */\n.ab-savebar { position: sticky; bottom: 14px; margin-top: 16px; display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: var(--ab-radius); background: var(--ab-card); border: 1px solid color-mix(in srgb, var(--ab-sea) 45%, var(--ab-line)); box-shadow: var(--ab-shadow-lg); z-index: 6 }\n.ab-savebar .msg { flex: 1; color: var(--ab-deep); font-weight: 560 }\n@media (max-width: 720px) { .ab-savebar { bottom: calc(64px + env(safe-area-inset-bottom, 0px)) } }\n.ab-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 9px 16px; border-radius: 10px; background: var(--dsw-alias-toast-bg, #1f2328); color: var(--dsw-alias-toast-label, #fff); font-size: 13px; z-index: 50; box-shadow: var(--ab-shadow-lg); max-width: 80vw }\n.ab-toast.ok { background: var(--ab-ok); color: #fff }\n.ab-toast.err { background: var(--ab-err); color: #fff }\n\n/* 向导步骤条 */\n.ab-wiz-bar { display: flex; gap: 6px; margin-top: 12px }\n.ab-wiz-bar .seg { flex: 1; border: 0; background: transparent; padding: 0; cursor: default; text-align: left; font: inherit; color: var(--ab-dim) }\n.ab-wiz-bar .seg::before { content: ""; display: block; height: 4px; border-radius: 999px; background: var(--ab-line-2); margin-bottom: 6px }\n.ab-wiz-bar .seg.done { cursor: pointer; color: var(--ab-sub) }\n.ab-wiz-bar .seg.done::before { background: var(--ab-sky) }\n.ab-wiz-bar .seg.on { color: var(--ab-deep); font-weight: 600 }\n.ab-wiz-bar .seg.on::before { background: var(--ab-sea) }\n.ab-wiz-bar .seg span { font-size: 11.5px }\n\n/* 复查清单 / 驱动 / 安装步骤 */\n.ab-checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(190px, 100%), 1fr)); gap: 8px }\n.ab-check { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--ab-line); background: var(--ab-card-2); color: var(--ab-sub); font-size: 12.5px }\n.ab-check i { font-style: normal; width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; background: var(--ab-line-2); color: #fff; flex: none }\n.ab-check.done { color: var(--ab-text); border-color: color-mix(in srgb, var(--ab-ok) 30%, transparent); background: color-mix(in srgb, var(--ab-ok) 7%, var(--ab-card)) }\n.ab-check.done i { background: var(--ab-ok) }\n.ab-drives { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr)); gap: 8px }\n.ab-drive { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; padding: 9px 12px; border-radius: 10px; border: 1px solid var(--ab-line-2); background: var(--ab-card); color: var(--ab-text); font: inherit; cursor: pointer; transition: border-color .12s, box-shadow .12s }\n.ab-drive:hover { border-color: var(--ab-sky) }\n.ab-drive.on { border-color: var(--ab-sea); box-shadow: var(--ab-focus); background: linear-gradient(var(--ab-foam), var(--ab-foam)), var(--ab-card) }\n.ab-drive b { font-weight: 600 }\n.ab-drive small { color: var(--ab-dim); font-size: 11.5px; word-break: break-all }\n.ab-drive .bar { display: block; width: 100%; height: 4px; border-radius: 999px; background: var(--ab-card-2); overflow: hidden; margin-top: 4px }\n.ab-drive .bar i { display: block; height: 100%; background: var(--ab-sky) }\n.ab-drive.low .bar i { background: var(--ab-warn) }\n.ab-install { margin-top: 12px; padding: 14px 16px; border-radius: var(--ab-radius); border: 1px solid var(--ab-foam-2); background: var(--ab-foam) }\n.ab-install-steps { display: flex; gap: 6px }\n.ab-install-steps .st { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ab-dim); text-align: center; position: relative }\n.ab-install-steps .st::before { content: ""; position: absolute; top: 11px; left: -50%; right: 50%; height: 2px; background: var(--ab-line-2); z-index: 0 }\n.ab-install-steps .st:first-child::before { display: none }\n.ab-install-steps .st.done::before, .ab-install-steps .st.on::before { background: var(--ab-sea) }\n.ab-install-steps .st i { position: relative; z-index: 1; font-style: normal; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; background: var(--ab-card); border: 2px solid var(--ab-line-2); color: var(--ab-dim) }\n.ab-install-steps .st.done i { background: var(--ab-sea); border-color: var(--ab-sea); color: #fff }\n.ab-install-steps .st.on i { border-color: var(--ab-sea); color: var(--ab-sea); box-shadow: var(--ab-focus) }\n.ab-install-steps .st.on { color: var(--ab-deep); font-weight: 600 }\n.ab-install-steps .st span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100% }\n.ab-install-dl { display: flex; flex-wrap: wrap; gap: 10px 24px; align-items: center; margin-top: 10px }\n.ab-install-dl small { display: block; color: var(--ab-dim); font-size: 11px }\n.ab-install-dl b { font-size: 18px; font-variant-numeric: tabular-nums }\n\n/* 模块行 */\n.ab-mod { display: flex; gap: 12px; align-items: flex-start; padding: 12px 0; border-top: 1px solid var(--ab-line) }\n.ab-mod:first-child { border-top: 0 }\n.ab-mod .main { flex: 1; min-width: 0 }\n.ab-mod .nm { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-weight: 600 }\n.ab-mod .nm code { font-weight: 400; font-size: 11.5px; color: var(--ab-dim) }\n.ab-mod .ds { color: var(--ab-sub); font-size: 12.5px; margin-top: 2px }\n.ab-mod .what { color: var(--ab-dim); font-size: 11.5px; margin-top: 4px; word-break: break-word }\n.ab-mod .acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px }\n.ab-mod .side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px }\n\n/* 扩展页：模块分组（按能力折叠）+ 搜索 + 紧凑行 */\n.ab-modgroup { border-top: 1px solid var(--ab-line) }\n.ab-modgroup:first-of-type { border-top: 0 }\n.ab-modgroup-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 0; cursor: pointer; user-select: none; background: none; border: 0; color: inherit; font: inherit; text-align: left; border-radius: var(--ab-radius-sm) }\n.ab-modgroup-head:hover .ab-modgroup-name { color: var(--ab-deep) }\n.ab-modgroup-head:focus-visible { outline: none; box-shadow: var(--ab-focus) }\n.ab-modgroup-chev { color: var(--ab-dim); display: inline-flex; flex: none; transition: transform .15s }\n.ab-modgroup-chev.open { transform: rotate(90deg) }\n.ab-modgroup-name { font-weight: 600 }\n.ab-modgroup-meta { color: var(--ab-dim); font-size: 11.5px; font-variant-numeric: tabular-nums }\n.ab-modgroup-body { padding-bottom: 4px }\n.ab-search { max-width: 200px }\n/* 目录路径 + 操作按钮：窄屏时路径独占一行，别被按钮挤成一字一行 */\n.ab-dirrow { flex-wrap: wrap; row-gap: 8px }\n.ab-dirrow code { flex: 1 1 220px; min-width: 0 }\n.ab-mod.compact { padding: 8px 0 }\n.ab-mod.compact .ds { margin-top: 1px }\n.ab-mod.compact .ds.clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100% }\n.ab-mod.compact .what, .ab-mod.compact .acts { margin-top: 6px }\n\n/* 可折叠的补充说明（长文案收纳用） */\n.ab-more { margin-top: 6px; font-size: 12px; color: var(--ab-dim) }\n.ab-more summary { cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: 4px; user-select: none }\n.ab-more summary::-webkit-details-marker { display: none }\n.ab-more summary::before { content: "›"; display: inline-block; transition: transform .15s; color: var(--ab-dim) }\n.ab-more[open] summary::before { transform: rotate(90deg) }\n.ab-more summary:hover { color: var(--ab-sub) }\n.ab-more .ab-more-body { margin-top: 6px; color: var(--ab-sub); line-height: 1.65; white-space: pre-wrap }\n\n/* 可折叠长卡片（如「改资料与名单」16 行权限）：默认收起，标题行可点 */\n.ab-fold-head { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; cursor: pointer; user-select: none; border-radius: var(--ab-radius-sm) }\n.ab-fold-head h3 { margin: 0 }\n.ab-fold-head:hover h3, .ab-fold-head:focus-visible h3 { color: var(--ab-deep) }\n.ab-fold-chev { color: var(--ab-dim); display: inline-flex; flex: none; transition: transform .15s }\n.ab-fold-chev.open { transform: rotate(90deg) }\n.ab-fold-head:focus-visible { outline: none; box-shadow: var(--ab-focus) }\n\n/* ---------------- 响应式 ---------------- */\n@media (max-width: 720px) {\n  .ab-row { flex-direction: column; gap: 6px; padding: 12px 0 }\n  .ab-row .ab-label { flex: none; padding-top: 0 }\n  .ab-row .ab-label small { max-width: none }\n  .ab-row .ab-ctl { max-width: none }\n  .ab-g2 { grid-template-columns: minmax(0, 1fr) }\n  .ab-card { padding: 14px }\n  .ab-input, .ab-select, .ab-textarea, .ab-sel-btn { font-size: 16px }\n  .ab-btn { min-height: 36px }\n  .ab-range { min-width: 0; width: 100% }\n  .ab-persona { grid-template-columns: minmax(0, 1fr) }\n  .ab-plist { position: static }\n  .ab-finder { left: 6px; right: 6px; width: auto; max-width: none }\n  .ab-wiz-bar .seg span { display: none }\n  .ab-install-steps .st span { display: none }\n  .ab-topbar h1 { font-size: 16px }\n}\n@media (prefers-reduced-motion: reduce) { .ab-root * { transition: none !important; animation: none !important } }\n.ab-root :focus-visible { outline: none; box-shadow: var(--ab-focus) }\n';

// client/src/styles/use-style.js
var CSS = theme_default;
function useStyle() {
  useEffect(() => {
    const existing = document.getElementById("qq-hub-css");
    if (existing) {
      if (existing.textContent === CSS) return;
      existing.textContent = CSS;
      return;
    }
    const s = document.createElement("style");
    s.id = "qq-hub-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }, []);
}

// client/src/ui/primitives.js
function Switch({ on, onChange, disabled, title }) {
  return /* @__PURE__ */ h("button", { type: "button", className: cx("ab-switch", on && "on"), onClick: () => !disabled && onChange(!on), disabled, title, role: "switch", "aria-checked": !!on });
}
function Row({ label, hint, children }) {
  return /* @__PURE__ */ h("div", { className: "ab-row" }, /* @__PURE__ */ h("div", { className: "ab-label" }, /* @__PURE__ */ h("b", null, label), hint ? /* @__PURE__ */ h("small", null, hint) : null), /* @__PURE__ */ h("div", { className: "ab-ctl" }, children));
}
function Card({ title, desc, icon, right, more, collapse, children, className }) {
  const [open, setOpen] = useState(!collapse);
  if (!collapse) {
    return /* @__PURE__ */ h("div", { className: cx("ab-card", className) }, title ? /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginBottom: desc || more ? 0 : 10 } }, /* @__PURE__ */ h("h3", null, icon || null, title), /* @__PURE__ */ h("div", { className: "ab-spacer" }), right || null) : null, desc ? /* @__PURE__ */ h("p", { className: "ab-desc" }, desc) : null, more ? /* @__PURE__ */ h(More, null, more) : null, children);
  }
  return /* @__PURE__ */ h("div", { className: cx("ab-card ab-fold", !open && "closed", className) }, /* @__PURE__ */ h(
    "div",
    {
      className: "ab-fold-head",
      role: "button",
      tabIndex: 0,
      "aria-expanded": open,
      onClick: () => setOpen(!open),
      onKeyDown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(!open);
        }
      }
    },
    /* @__PURE__ */ h("span", { className: cx("ab-fold-chev", open && "open"), "aria-hidden": "true" }, /* @__PURE__ */ h("svg", { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ h("path", { d: "M4.5 3 7.5 6 4.5 9" }))),
    /* @__PURE__ */ h("h3", null, icon || null, title),
    /* @__PURE__ */ h("div", { className: "ab-spacer" }),
    right || null
  ), desc ? /* @__PURE__ */ h("p", { className: "ab-desc" }, desc) : null, open ? children : null, open && more ? /* @__PURE__ */ h(More, null, more) : null);
}
function Btn({ kind, small, onClick, disabled, children, title, className }) {
  const [busy, setBusy] = useState(false);
  return /* @__PURE__ */ h(
    "button",
    {
      type: "button",
      title,
      className: cx("ab-btn", kind, small && "sm", className),
      disabled: disabled || busy,
      onClick: async () => {
        if (!onClick) return;
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }
    },
    busy ? [/* @__PURE__ */ h("i", { key: "s", className: "ab-spin" }), " 处理中"] : children
  );
}
function More({ label = "详细说明", children }) {
  return /* @__PURE__ */ h("details", { className: "ab-more" }, /* @__PURE__ */ h("summary", null, label), /* @__PURE__ */ h("div", { className: "ab-more-body" }, children));
}
function Pill({ kind, title, children }) {
  return /* @__PURE__ */ h("span", { className: cx("ab-pill", kind), title }, children);
}
function Select({ value, options, onChange, placeholder, width }) {
  const [open, setOpen] = useState(false);
  const [act, setAct] = useState(-1);
  const ref = useRef(null);
  const cur = options.find((o) => o.value === value);
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const pick = (o) => {
    onChange(o.value);
    setOpen(false);
  };
  const openAt = () => {
    setOpen(true);
    setAct(Math.max(0, options.indexOf(cur)));
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return openAt();
      setAct((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open && options[act]) pick(options[act]);
      else openAt();
    }
  };
  let lastGroup = null;
  const items = [];
  options.forEach((o, i) => {
    if (o.group && o.group !== lastGroup) items.push(/* @__PURE__ */ h("div", { key: "g" + i, className: "ab-sel-group" }, o.group));
    lastGroup = o.group || lastGroup;
    items.push(
      /* @__PURE__ */ h("div", { key: "o" + i, role: "option", "aria-selected": o.value === value, className: cx("ab-sel-opt", o.value === value && "on", i === act && "act"), onMouseEnter: () => setAct(i), onMouseDown: (e) => {
        e.preventDefault();
        pick(o);
      } }, /* @__PURE__ */ h("span", { className: "ck" }, o.value === value ? "✓" : ""), /* @__PURE__ */ h("span", { className: "tx" }, o.label, o.desc ? /* @__PURE__ */ h("span", { className: "ds" }, o.desc) : null))
    );
  });
  return /* @__PURE__ */ h("div", { className: cx("ab-sel", open && "open"), ref, style: width ? { minWidth: width } : null }, /* @__PURE__ */ h("button", { type: "button", className: "ab-sel-btn", onClick: () => open ? setOpen(false) : openAt(), onKeyDown: onKey, "aria-haspopup": "listbox", "aria-expanded": open }, /* @__PURE__ */ h("span", { className: "v" }, cur ? cur.label : /* @__PURE__ */ h("span", { className: "ab-muted" }, placeholder || "请选择")), /* @__PURE__ */ h("svg", { className: "chev", width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: "1.8" }, /* @__PURE__ */ h("path", { d: "M3 4.5 6 7.5 9 4.5" }))), open ? /* @__PURE__ */ h("div", { className: "ab-sel-pop", role: "listbox" }, items) : null);
}
function Choices({ value, options, onChange }) {
  return /* @__PURE__ */ h("div", { className: "ab-choices", role: "radiogroup" }, options.map((o) => /* @__PURE__ */ h("button", { key: o.value, type: "button", role: "radio", "aria-checked": o.value === value, className: cx("ab-choice", o.value === value && "on"), onClick: () => onChange(o.value) }, /* @__PURE__ */ h("b", null, o.icon || null, o.label), o.desc ? /* @__PURE__ */ h("small", null, o.desc) : null)));
}
function Range({ value, min, max, step, onChange, fmt }) {
  return /* @__PURE__ */ h("div", { className: "ab-range" }, /* @__PURE__ */ h("input", { type: "range", min, max, step: step || 1, value: value ?? min, onChange: (e) => onChange(Number(e.target.value)) }), /* @__PURE__ */ h("span", { className: "val" }, fmt ? fmt(value) : value));
}
function Seg({ value, options, onChange, disabled }) {
  return /* @__PURE__ */ h("div", { className: "ab-seg" + (disabled ? " off" : "") }, options.map((o) => /* @__PURE__ */ h("button", { key: o.value, type: "button", className: value === o.value ? "on" : "", disabled: !!disabled, onClick: () => {
    if (!disabled) onChange(o.value);
  } }, o.label)));
}
function Empty({ icon, text }) {
  return /* @__PURE__ */ h("div", { className: "ab-empty" }, /* @__PURE__ */ h("div", { className: "big" }, icon || "🐋"), text);
}
function ListArea({ value, onChange, placeholder, numbers }) {
  const parse = (t) => t.split(numbers ? /[\n,，;；\s]+/ : /[\n,，;；]+/).map((s) => s.trim()).filter(Boolean);
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => {
    if (parse(text).join("\n") !== value.join("\n")) setText(value.join("\n"));
  }, [value.join("\n")]);
  return /* @__PURE__ */ h(
    "textarea",
    {
      className: "ab-textarea",
      style: { minHeight: 60 },
      placeholder,
      value: text,
      onChange: (e) => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      },
      onBlur: () => setText(parse(text).join("\n"))
    }
  );
}
function ListInput({ value, onChange, placeholder, numbers, style }) {
  const parse = (t, { strict } = {}) => {
    const parts = String(t).split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
    if (!numbers) return parts;
    const cleaned = parts.map((s) => s.replace(/\D/g, ""));
    return strict ? cleaned.filter((s) => s.length >= 4) : cleaned.filter(Boolean);
  };
  const [text, setText] = useState(value.join(", "));
  useEffect(() => {
    if (parse(text, { strict: true }).join(",") !== value.join(",")) setText(value.join(", "));
  }, [value.join(",")]);
  return /* @__PURE__ */ h(
    "input",
    {
      className: "ab-input",
      style: { width: "100%", ...style || {} },
      placeholder,
      value: text,
      onChange: (e) => {
        setText(e.target.value);
        onChange(parse(e.target.value, { strict: true }));
      },
      onBlur: () => {
        const t = parse(text, { strict: true }).join(", ");
        setText(t);
        onChange(parse(t, { strict: true }));
      }
    }
  );
}
function PercentRow({ label, value, fallback, write, remove }) {
  const shown = () => Math.round((Number(value !== void 0 && value !== null && value !== "" ? value : fallback ?? 0) || 0) * 100);
  const [text, setText] = useState(String(shown()));
  useEffect(() => {
    const s = String(shown());
    if (parsePct(text) !== shown()) setText(s);
  }, [shown()]);
  const commit = () => {
    const p = parsePct(text);
    setText(String(p));
    write(p / 100);
  };
  return /* @__PURE__ */ h(Row, { label }, /* @__PURE__ */ h(
    "input",
    {
      className: "ab-input sm",
      type: "number",
      min: 0,
      max: 100,
      value: text,
      onChange: (e) => setText(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }
    }
  ), /* @__PURE__ */ h("span", { className: "ab-muted" }, "% 插话"), remove ? /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: remove }, "移除") : null);
}
function NumInput({ value, onChange, min, max, step, allowEmpty, scale, placeholder, className, style }) {
  const unit = Number(step || 1);
  const toText = (v) => {
    if (v === void 0 || v === null || v === "") return "";
    const n = Number(v) / (scale || 1);
    if (!Number.isFinite(n)) return "";
    return String(unit === 1 ? Math.round(n) : n);
  };
  const external = toText(value);
  const [typed, setTyped] = useState(null);
  const shown = typed !== null ? typed : external;
  const commit = () => {
    const { value: value2, text } = commitNumText(shown, { min, max, step: unit, allowEmpty, scale });
    setTyped(text === "" ? null : text);
    onChange(value2);
  };
  return /* @__PURE__ */ h(
    "input",
    {
      className: cx("ab-input sm", className),
      type: "number",
      min,
      max,
      step: step || 1,
      style,
      value: shown,
      placeholder,
      onChange: (e) => setTyped(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") setTyped(null);
      }
    }
  );
}
function ModOff({ name }) {
  return /* @__PURE__ */ h(Card, { title: name }, /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "「", name, "」模块关着，这部分用不了。要用的话去「扩展」页把它打开。"));
}
var TabBoundary = class extends React.Component {
  constructor(p) {
    super(p);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    try {
      localStorage.setItem("qq-hub.tab", "overview");
    } catch (e) {
    }
  }
  render() {
    if (!this.state.error) return this.props.children;
    return /* @__PURE__ */ h(Card, { title: "这一页出错了" }, /* @__PURE__ */ h("div", { className: "ab-note err" }, String(this.state.error && this.state.error.message || this.state.error)), /* @__PURE__ */ h("div", { className: "ab-small ab-muted", style: { margin: "8px 0" } }, "别的页面不受影响。把这段报错截图发给作者就行。"), /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: () => this.props.onHome && this.props.onHome() }, "回到概览"), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => this.setState({ error: null }) }, "再试一次")));
  }
};

// client/src/domain/tab-keys.js
var TAB_KEYS = {
  connect: ["snowluma", "botQQ", "workspaceDir"],
  access: ["ownerQQ", "ownerName", "ownerLevel", "longTasks", "profilePerms", "allow"],
  // turnTimeoutMs 原来由裸 input 直接写路径，没登记（改了不出现「未保存」）。
  // 2026-11-24 换成 f.num 之后测试当场逮到，补进这张表。
  group: ["group", "merge", "reply", "files", "security", "turnTimeoutMs"],
  model: ["model", "chatModels"],
  voice: ["voice"],
  stickers: ["stickers"],
  imagegen: ["imageGen"],
  diary: ["diary", "qzoneSocial"],
  speakup: ["speakUp"],
  memory: ["memory"],
  bili: ["bili"],
  douyin: ["douyin"],
  heybox: ["heybox"],
  multiParser: ["multiParser"],
  browser: ["browser"],
  local: ["local"]
};

// client/src/domain/nav.js
var TABS = [
  { id: "overview", label: "概览" },
  { id: "connect", label: "连接" },
  { id: "persona", label: "人格" },
  { id: "access", label: "权限" },
  { id: "group", label: "聊天", flag: "group" },
  { id: "model", label: "模型" },
  { id: "token", label: "用量" },
  { id: "voice", label: "语音", flag: "voice.enabled" },
  { id: "stickers", label: "表情包", flag: "stickers.enabled" },
  { id: "imagegen", label: "生图", flag: "imageGen.enabled" },
  { id: "diary", label: "空间日记", flag: "diary.enabled" },
  { id: "speakup", label: "主动搭话", flag: "speakUp.enabled" },
  { id: "memory", label: "记忆" },
  { id: "bili", label: "B站", flag: "bili.enabled" },
  { id: "douyin", label: "抖音", flag: "douyin.enabled" },
  { id: "heybox", label: "小黑盒", flag: "heybox.enabled" },
  { id: "multiParser", label: "内容解析", flag: "multiParser.enabled" },
  { id: "browser", label: "浏览器", flag: "browser.enabled" },
  { id: "local", label: "本地接口" },
  { id: "modules", label: "扩展" },
  { id: "logs", label: "日志" }
];
var TAB_MODS = {
  voice: ["voice"],
  stickers: ["stickers"],
  imagegen: ["imagegen"],
  diary: ["diary", "qzone-social"],
  speakup: ["speakup", "purpose"],
  memory: ["memory", "reflection", "style", "memory-privacy"],
  bili: ["bili"],
  douyin: ["douyin"],
  heybox: ["heybox"],
  multiParser: ["multi-parser"],
  // 用量页：token 系三个模块任一在跑才显示
  token: ["token-billing", "token-guardian", "complete-guard"]
};
var modOn = (st, id) => (st.modules || []).some((m) => m.id === id && m.running);
var NAV_GROUPS = [
  { id: "home", label: "概览", icon: "M3 10.5 12 3l9 7.5M5.5 9v11.5h13V9M10 20.5v-6h4v6", tabs: ["overview"] },
  { id: "self", label: "人设", icon: "M12 12.5a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5zM4.5 20.5c.9-3.6 3.9-5.5 7.5-5.5s6.6 1.9 7.5 5.5", tabs: ["persona", "group", "speakup", "memory"] },
  { id: "express", label: "表达", icon: "M20.5 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.4A8 8 0 1 1 20.5 11.5zM9 13.2s1.1 1.5 3 1.5 3-1.5 3-1.5M9.5 9.6h.01M14.5 9.6h.01", tabs: ["voice", "stickers", "imagegen"] },
  { id: "platform", label: "平台", icon: "M3.5 6.5h17v11h-17zM10.5 9.8v4.4l3.8-2.2z", tabs: ["diary", "bili", "douyin", "heybox", "multiParser"] },
  { id: "system", label: "系统", icon: "M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1M15 5v4M9 10v4M17 15v4", tabs: ["connect", "model", "token", "access", "browser", "local", "modules", "logs"] }
];
var PLATFORM_EXT = /逛|刷|B站|抖音|小红书|闲鱼|淘宝|微博|知乎|贴吧|快手|触站|小黑盒/;
var navGroupOf = (t) => NAV_GROUPS.find((g) => g.tabs.includes(t.id)) || (t.ext && PLATFORM_EXT.test(t.label) ? NAV_GROUPS[3] : NAV_GROUPS[4]);
var navOrder = (g, t) => {
  const i = g.tabs.indexOf(t.id);
  return i >= 0 ? i : g.tabs.length - (g.tabs.includes("logs") ? 1.5 : 0);
};
var NAV_ALIAS = {
  overview: "首页 状态",
  connect: "qq 网关 snowluma onebot 登录 工作区",
  persona: "人设 性格 设定 头像",
  access: "主人 白名单 权限 群管 改资料",
  group: "群聊 插话 合并",
  model: "ai 大模型 视觉 思考强度",
  token: "token 用量 花费 记账 每日预算 配额 熔断 上下文 压缩 守卫 完整性", /* pii-scan:ignore */
  voice: "语音 tts 说话 音色 edge",
  stickers: "表情 小黄脸 gif 商城表情",
  imagegen: "画图 图片",
  diary: "空间 说说 日记",
  speakup: "搭话 主动",
  memory: "记忆 档案 相处经验 黑话 蒸馏",
  bili: "b站 bilibili 视频",
  douyin: "抖音 短视频 私信",
  heybox: "小黑盒 游戏 社区 资讯",
  multiParser: "内容解析 多平台 链接 解析 视频 图文 小红书 微博 知乎 贴吧 b站 抖音 微信",
  local: "本地 接口 sd sovits",
  modules: "扩展 模块 插件",
  logs: "日志 报错"
};

// client/src/shell/nav-bar.js
function NavBar({ tabs, cur, go, mark, dirtyOf, subRef }) {
  const [last, setLast] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("qq-hub.navlast") || "{}") || {};
    } catch (e) {
      return {};
    }
  });
  const [find, setFind] = useState(null);
  const [hi, setHi] = useState(0);
  const box = useRef(null);
  const groups = NAV_GROUPS.map((g) => ({ ...g, list: tabs.filter((t) => navGroupOf(t).id === g.id).sort((a, b) => navOrder(g, a) - navOrder(g, b)) })).filter((g) => g.list.length);
  const curGroup = groups.find((g) => g.list.some((t) => t.id === cur.id)) || groups[0];
  useEffect(() => {
    if (!curGroup || last[curGroup.id] === cur.id) return;
    const next = { ...last, [curGroup.id]: cur.id };
    setLast(next);
    try {
      localStorage.setItem("qq-hub.navlast", JSON.stringify(next));
    } catch (e) {
    }
  }, [cur.id]);
  const openGroup = (g) => go((g.list.find((t) => t.id === last[g.id]) || g.list[0]).id);
  const toggleFind = () => {
    setFind((f) => f === null ? "" : null);
    setHi(0);
  };
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggleFind();
      } else if (e.key === "Escape") setFind(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (find === null) return;
    const onDown = (e) => {
      if (box.current && !box.current.contains(e.target)) setFind(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [find === null]);
  const q = (find || "").trim().toLowerCase();
  const hits = find === null ? [] : groups.flatMap((g) => g.list.map((t) => ({ t, g }))).filter(({ t, g }) => !q || [t.label, g.label, NAV_ALIAS[t.id] || "", t.id].join(" ").toLowerCase().includes(q));
  const pick = (t) => {
    setFind(null);
    go(t.id);
  };
  const tabBtn = (t) => /* @__PURE__ */ h("button", { key: t.id, type: "button", role: "tab", "aria-selected": cur.id === t.id, className: cx("ab-tab", cur.id === t.id && "on"), onClick: () => go(t.id) }, t.label, mark(t));
  return /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h("nav", { className: "ab-nav", ref: box, "aria-label": "QQ Hub 功能" }, /* @__PURE__ */ h("div", { className: "ab-nav-top" }, /* @__PURE__ */ h("div", { className: "ab-nav-groups", role: "tablist", "aria-label": "功能分组" }, groups.map((g) => /* @__PURE__ */ h(
    "button",
    {
      key: g.id,
      type: "button",
      role: "tab",
      "aria-selected": g.id === curGroup.id,
      className: cx("ab-grp", g.id === curGroup.id && "on"),
      title: g.list.map((t) => t.label).join(" · "),
      onClick: () => openGroup(g)
    },
    navIcon(g.icon),
    /* @__PURE__ */ h("span", null, g.label),
    g.list.some((t) => dirtyOf(t.id)) ? /* @__PURE__ */ h("i", { className: "dirty", title: "这组里有没保存的改动", "aria-hidden": "true" }) : null
  ))), /* @__PURE__ */ h("button", { type: "button", className: "ab-find-btn", "aria-expanded": find !== null, title: "查找功能（Alt+K）", onClick: toggleFind }, navIcon("M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.2-4.2"), /* @__PURE__ */ h("span", { className: "t" }, "查找"), /* @__PURE__ */ h("span", { className: "ab-kbd" }, "Alt K"))), curGroup && curGroup.list.length > 1 ? /* @__PURE__ */ h("div", { className: "ab-nav-sub", role: "tablist", "aria-label": curGroup.label, ref: subRef }, curGroup.list.map(tabBtn)) : null, find !== null ? /* @__PURE__ */ h("div", { className: "ab-finder" }, /* @__PURE__ */ h(
    "input",
    {
      className: "ab-input",
      autoFocus: true,
      placeholder: "找功能：语音、抖音、白名单…",
      value: find,
      onChange: (e) => {
        setFind(e.target.value);
        setHi(0);
      },
      onKeyDown: (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHi(Math.min(hi + 1, hits.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setHi(Math.max(hi - 1, 0));
        } else if (e.key === "Enter" && hits[hi]) {
          e.preventDefault();
          pick(hits[hi].t);
        }
      }
    }
  ), /* @__PURE__ */ h("div", { className: "ab-finder-list", role: "listbox" }, hits.length ? hits.map(({ t, g }, i) => /* @__PURE__ */ h("button", { key: t.id, type: "button", role: "option", "aria-selected": i === hi, className: cx("ab-finder-item", i === hi && "on"), onMouseEnter: () => setHi(i), onClick: () => pick(t) }, t.label, /* @__PURE__ */ h("small", null, g.label))) : /* @__PURE__ */ h("div", { className: "ab-finder-empty" }, "没找到，换个说法试试：语音、抖音、白名单"))) : null), curGroup ? /* @__PURE__ */ h("div", { className: "ab-chips", role: "tablist", "aria-label": curGroup.label }, curGroup.list.map(tabBtn)) : null, /* @__PURE__ */ h("div", { className: "ab-mobilebar", role: "tablist", "aria-label": "功能分组" }, groups.map((g) => /* @__PURE__ */ h(
    "button",
    {
      key: g.id,
      type: "button",
      role: "tab",
      "aria-selected": g.id === curGroup.id,
      className: cx("ab-mgrp", g.id === curGroup.id && "on"),
      onClick: () => openGroup(g)
    },
    navIcon(g.icon),
    /* @__PURE__ */ h("span", null, g.label),
    g.list.some((t) => dirtyOf(t.id)) ? /* @__PURE__ */ h("i", { className: "dirty", title: "这组里有没保存的改动", "aria-hidden": "true" }) : null
  ))));
}

// client/src/core/api-base.js
function apiBaseFrom(href) {
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "/qq-hub/api";
    const p = u.pathname.replace(/\/index\.html?$/i, "").replace(/\/+$/, "");
    return (p || "") + "/qq-hub/api";
  } catch (e) {
    return "/qq-hub/api";
  }
}
var API = apiBaseFrom(typeof document !== "undefined" && document.baseURI ? document.baseURI : typeof location !== "undefined" ? location.href : "");

// client/src/core/http.js
var readJson = (r) => r.text().then((text) => {
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object") return data;
  } catch (e) {
  }
  const snippet = String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
  return { ok: false, status: r.status, message: "HTTP " + r.status + "：" + (snippet || "空响应") };
});
var failed = (e) => ({ ok: false, message: "连不上插件：" + (e && e.message ? e.message : e) + "（接口 " + API + "）" });
var get = (p) => fetch(API + p, { cache: "no-store" }).then(readJson).catch(failed);
var post = (p, body) => fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then(readJson).catch(failed);

// client/src/domain/persona.js
function planPersonaRow({ map, id, raw }) {
  const digits = String(raw || "").replace(/\D/g, "");
  const m = map || {};
  const keep = m[id] === void 0 ? "" : m[id];
  if (!digits) return { action: "clear" };
  if (digits === id) return { action: "keep" };
  if (m[digits] !== void 0 && digits !== id) return { action: "clear" };
  return { action: "move", key: digits, value: keep };
}
async function pickAvatar(toast, reload) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/png,image/jpeg,image/gif,image/webp";
  const file = await new Promise((res) => {
    inp.onchange = () => res(inp.files && inp.files[0]);
    inp.click();
  });
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return toast("图片太大了，最多 5MB", "err");
  const data = await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(file);
  });
  const r = await post("/avatar/upload", { data });
  toast(r.message, r.ok ? "ok" : "err");
  reload();
}
var avatarSrc = (st) => API + "/avatar?v=" + (st.avatar && st.avatar.at || 0);
var PSEC_HEAD = /^【([^】\n]{1,30})】\s*$/;
var PSEC_SUGGEST = ["你的样子", "性格", "打字习惯", "情绪是活的", "你的生活", "和主人的关系", "绝对禁止"];
var PSEC_COLORS = ["#4f9a8c", "#8a7bc0", "#c08a4a", "#5f8fc7", "#c47a90", "#6f9f68", "#5c6fae", "#b9775a", "#8d9450", "#a173b5"];
var psecSeq = 0;
var psec = (title, text) => ({ k: ++psecSeq, title, text });
var splitPersona = (body) => {
  const out = [psec(null, "")];
  let cur = out[0];
  let buf = [];
  const flush = () => {
    cur.text = buf.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
    buf = [];
  };
  for (const line of String(body || "").replace(/\r\n/g, "\n").split("\n")) {
    const m = PSEC_HEAD.exec(line.replace(/[​-‍﻿]/g, "").trim());
    if (m) {
      flush();
      cur = psec(m[1].trim(), "");
      out.push(cur);
    } else buf.push(line);
  }
  flush();
  return out;
};
var joinPersona = (secs) => secs.map((s) => s.title === null ? s.text.trim() : "【" + (s.title.trim() || "未命名") + "】\n" + s.text.replace(/\s+$/, "")).filter(Boolean).join("\n\n");
var autoRows = (text) => Math.min(22, Math.max(3, String(text || "").split("\n").length + 1));

// client/src/views/overview.js
function UpdateNotes({ st, toast }) {
  const [upd, setUpd] = useState(null);
  const [notes, setNotes] = useState(null);
  useEffect(() => {
    get("/update/check").then(setUpd).catch(() => {
    });
    let seen = null;
    try {
      seen = localStorage.getItem("qq-hub.seenVersion");
    } catch (e) {
    }
    if (seen && seen !== st.version) get("/changelog").then((r) => r.notes && setNotes(r.notes));
    else if (!seen) {
      try {
        localStorage.setItem("qq-hub.seenVersion", st.version);
      } catch (e) {
      }
    }
  }, [st.version]);
  const dismiss = () => {
    try {
      localStorage.setItem("qq-hub.seenVersion", st.version);
    } catch (e) {
    }
    setNotes(null);
  };
  return /* @__PURE__ */ h(Fragment, null, notes ? /* @__PURE__ */ h("div", { className: "ab-note" }, /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h("b", null, "已更新到 v", st.version), /* @__PURE__ */ h("div", { className: "ab-spacer" }), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: dismiss }, "知道了")), /* @__PURE__ */ h("div", { style: { whiteSpace: "pre-wrap", marginTop: 6 } }, notes)) : null, upd && upd.newer ? /* @__PURE__ */ h("div", { className: "ab-note warn" }, /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("b", null, "有新版本 v", upd.latest), "（现在是 v", upd.current, "）。在 PowerShell 里运行下面这行，然后重启 DSH；设置、人格、记忆都会保留。"), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 6 } }, /* @__PURE__ */ h("code", { style: { flex: "1 1 300px", fontSize: 11.5, wordBreak: "break-all" } }, upd.command), /* @__PURE__ */ h(Btn, { small: true, onClick: () => {
    try {
      navigator.clipboard.writeText(upd.command);
      toast("复制好了", "ok");
    } catch (e) {
      toast("复制失败，手动选中复制吧", "err");
    }
  } }, "复制"))) : null);
}
var STATS = [
  ["今天收到", "received", "📥"],
  ["今天发出", "sent", "📤"],
  ["语音条", "voice", "🎙️"],
  ["表情包", "stickers", "😺"]
];
function Overview({ st, toast, go }) {
  const cfg = st.config;
  const s = st.stats || {};
  const conn = st.onebot.state === "connected";
  const quick = (p, body) => async () => {
    const r = await post(p, body);
    toast(r.message || (r.ok ? "好了" : "没成功"));
  };
  const sessionCount = Object.keys(st.sessions || {}).filter((k) => !k.startsWith("system:")).length;
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(UpdateNotes, { st, toast }), !cfg.enabled ? /* @__PURE__ */ h("div", { className: "ab-note warn" }, "总开关是关着的：她现在不会收也不会发任何 QQ 消息。准备好了就在右上角打开。") : null, cfg.enabled && cfg.dryRun ? /* @__PURE__ */ h("div", { className: "ab-note" }, "现在是试运行：她会照常思考回复，但只写进日志，不会真的发到 QQ。确认没问题后在右上角关掉「试运行」。") : null, cfg.enabled && !conn ? /* @__PURE__ */ h("div", { className: "ab-note err" }, "还没连上 QQ 网关", st.onebot.problem ? "：" + st.onebot.problem + "。" : "。看看 SnowLuma 有没有装好、启动没有。", " ", /* @__PURE__ */ h("a", { href: "#", onClick: (e) => {
    e.preventDefault();
    go("connect");
  } }, "去连接 →")) : null, /* @__PURE__ */ h("div", { className: "ab-grid ab-g4" }, STATS.map(([label, key2, icon]) => /* @__PURE__ */ h("div", { key: label, className: "ab-card ab-stat" }, /* @__PURE__ */ h("span", { className: "ic", "aria-hidden": "true" }, icon), /* @__PURE__ */ h("div", { className: "n" }, s[key2] || 0), /* @__PURE__ */ h("div", { className: "l" }, label)))), /* @__PURE__ */ h("div", { className: "ab-grid ab-g2" }, /* @__PURE__ */ h(Card, { title: "她现在", desc: "表情库、日记、人格与会话的一眼速览。" }, /* @__PURE__ */ h("div", { className: "ab-kv" }, /* @__PURE__ */ h("span", null, "表情库"), /* @__PURE__ */ h("span", null, st.stickers.count, " 张"), /* @__PURE__ */ h("span", null, "下一篇日记"), /* @__PURE__ */ h("span", null, cfg.diary.enabled ? st.diary.next || "今天写完了" : "没开"), /* @__PURE__ */ h("span", null, "人格"), /* @__PURE__ */ h("span", null, (st.personas.find((p) => p.id === cfg.persona.current) || {}).name || cfg.persona.current), /* @__PURE__ */ h("span", null, "QQ 会话"), /* @__PURE__ */ h("span", null, sessionCount, " 个（在侧栏「QQ Hub」工作区里）"))), /* @__PURE__ */ h(Card, { title: "快捷操作", desc: "试一试她是不是活着。这些操作会真的发到 QQ（试运行时只写日志）。" }, /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { kind: "primary", onClick: quick("/test-send") }, "给主人发一条自测"), /* @__PURE__ */ h(Btn, { onClick: quick("/speakup/fire") }, "让她现在来找你"), /* @__PURE__ */ h(Btn, { onClick: quick("/diary/run", { visibility: "self" }) }, "写一篇日记（仅自己可见）")), /* @__PURE__ */ h(More, { label: "怎么看她和谁聊了什么" }, "点 DSH 侧栏「QQ Hub」工作区里对应的会话，可以看到她和每个人聊了什么、调了什么工具，也可以直接在会话里插话。"), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 10 } }, /* @__PURE__ */ h(
    Btn,
    {
      small: true,
      kind: "ghost",
      onClick: async () => {
        if (!confirm("把现在所有 QQ 会话归档、让她从头开始聊？（旧会话在侧栏的归档里还能找到）")) return;
        const r = await post("/sessions/reset");
        toast(r.message);
      }
    },
    "重新开始所有 QQ 会话"
  )))), /* @__PURE__ */ h(RecentLogs, { go }));
}
function RecentLogs({ go }) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => get("/logs?limit=8&level=info").then((r) => alive && setItems(r.entries || []));
    load();
    const t = setInterval(load, 5e3);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return /* @__PURE__ */ h(Card, { title: "最近动态", right: /* @__PURE__ */ h(Btn, { kind: "ghost", small: true, onClick: () => go("logs") }, "全部日志 →") }, items === null ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : items.length === 0 ? /* @__PURE__ */ h(Empty, { text: "还没有动静" }) : /* @__PURE__ */ h("div", { className: "ab-logs", style: { maxHeight: 240 } }, items.slice().reverse().map((e, i) => /* @__PURE__ */ h(LogLine, { key: i, e }))));
}
function LogLine({ e }) {
  return /* @__PURE__ */ h("div", { className: cx("ab-log", e.level) }, /* @__PURE__ */ h("span", { className: "t" }, e.time), /* @__PURE__ */ h("span", { className: "a" }, e.area), /* @__PURE__ */ h("span", { className: "m" }, e.text));
}

// client/src/ui/form.js
function useField(draft, setDraft) {
  return {
    sw: (path, extra) => /* @__PURE__ */ h(Switch, { on: !!getPath(draft, path), onChange: (v) => setDraft(setPath(draft, path, v)), ...extra || {} }),
    text: (path, props) => /* @__PURE__ */ h("input", { className: cx("ab-input", props && props.size), value: getPath(draft, path) ?? "", placeholder: props && props.placeholder, type: props && props.type || "text", onChange: (e) => setDraft(setPath(draft, path, e.target.value)) }),
    // 数字框：**没填就显示空的 + 占位提示「留空 = 沿用 N」**，不把默认值塞进框里。
    //
    // 关键点（2026-11-24 修）：旧实现把 fallback 当成 value 显示，于是用户删光后
    // 立刻又被默认值填回去 —— 「群里一条最长 / 私聊一条最长 / 一轮最多几条」这些框
    // 根本清不掉，看着像输入框坏了。清空要真的能清空，就得让「框里是空的」这个状态
    // 存在，默认值只作为占位提示出现（真正生效的是后端 normalize 的回落值）。
    //
    // 注意 `fallback` 只在**草稿里没有存过值**时才有提示意义：最小值由 min 兜住，
    // 清空后保存的是 ''，后端 num() 把 '' 当「没填」回落默认（见 core/config.js）。
    num: (path, props) => {
      const raw = getPath(draft, path);
      const fallback = props && props.fallback;
      const empty = raw === void 0 || raw === null || raw === "";
      return /* @__PURE__ */ h(
        NumInput,
        {
          value: empty ? "" : raw,
          min: props && props.min,
          max: props && props.max,
          step: props && props.step,
          scale: props && props.scale,
          style: props && props.style,
          allowEmpty: true,
          placeholder: fallback !== void 0 ? "留空 = 沿用 " + fallback : props && props.placeholder,
          onChange: (v) => setDraft(setPath(draft, path, v))
        }
      );
    },
    percent: (path) => /* @__PURE__ */ h(Range, { min: 0, max: 100, value: pct(getPath(draft, path)), onChange: (v) => setDraft(setPath(draft, path, v / 100)), fmt: (v) => v + "%" }),
    range: (path, min, max, step, fmt) => /* @__PURE__ */ h(Range, { min, max, step, value: getPath(draft, path), onChange: (v) => setDraft(setPath(draft, path, v)), fmt }),
    list: (path, props) => /* @__PURE__ */ h(ListArea, { value: getPath(draft, path) || [], placeholder: props && props.placeholder, numbers: props && props.numbers, onChange: (v) => setDraft(setPath(draft, path, v)) }),
    select: (path, options, props) => /* @__PURE__ */ h(Select, { value: getPath(draft, path) ?? "", options, onChange: (v) => setDraft(setPath(draft, path, v)), ...props || {} }),
    area: (path, props) => /* @__PURE__ */ h("textarea", { className: "ab-textarea", style: { minHeight: props && props.rows ? props.rows * 20 : 60 }, placeholder: props && props.placeholder, value: getPath(draft, path) ?? "", onChange: (e) => setDraft(setPath(draft, path, e.target.value)) }),
    choices: (path, options) => /* @__PURE__ */ h(Choices, { value: getPath(draft, path), options, onChange: (v) => setDraft(setPath(draft, path, v)) })
  };
}

// client/src/views/connect.js
function SnowLumaAuth({ running, toast, onChange }) {
  const [s, setS] = useState(null);
  const load = () => get("/snowluma/login-check").then(setS);
  useEffect(() => {
    if (running) load();
  }, [running]);
  if (!running) return /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "启动后插件会自动管理控制台密码，你不用设置。");
  if (!s) return /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, /* @__PURE__ */ h("i", { className: "ab-spin" }), " 检查中…");
  if (s.ok) return /* @__PURE__ */ h(PasswordPeek, { auto: s.passwordAuto });
  return /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "ab-small", style: { color: "var(--ab-warn)" } }, "插件登不上 SnowLuma 控制台：", s.message || "", "。多半是之前手动设过密码。"), /* @__PURE__ */ h("div", { style: { marginTop: 6 } }, /* @__PURE__ */ h(
    Btn,
    {
      small: true,
      kind: "primary",
      onClick: async () => {
        if (!confirm("会先停掉 SnowLuma、清掉它的旧控制台密码，再用插件生成的新密码重新启动。机器人号需要稍后重新接入。继续吗？")) return;
        const r = await post("/snowluma/reset-password");
        toast(r.message);
        load();
        onChange && onChange();
      }
    },
    "重置为自动密码"
  )));
}
function PasswordPeek({ auto }) {
  return /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "ab-small", style: { color: "var(--ab-ok)" } }, auto ? "✓ 控制台密码由插件自动管理" : "✓ 用的是你设的控制台密码"), /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "明文请在本机配置文件中查看，面板不再显示或复制。"));
}
function Agreement({ running, toast, onChange }) {
  const [a, setA] = useState(null);
  const [tab, setTab] = useState(0);
  const [agree, setAgree] = useState(false);
  const load = () => get("/snowluma/agreements").then(setA);
  useEffect(() => {
    if (running) load();
  }, [running]);
  if (!running) return /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "先启动 SnowLuma。");
  if (!a) return /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, /* @__PURE__ */ h("i", { className: "ab-spin" }), " 读取协议…");
  if (!a.ok) return /* @__PURE__ */ h("span", { className: "ab-small", style: { color: "var(--ab-warn)" } }, "读不到协议：", a.message);
  if (!a.consentRequired) return /* @__PURE__ */ h("span", { className: "ab-small", style: { color: "var(--ab-ok)" } }, "✓ 已同意 SnowLuma 的用户协议和隐私说明（版本 ", a.version, "）");
  const doc = a.documents[tab] || a.documents[0];
  return /* @__PURE__ */ h("div", { style: { width: "100%" } }, /* @__PURE__ */ h("div", { className: "ab-seg", style: { marginBottom: 8 } }, a.documents.map((d, i) => /* @__PURE__ */ h("button", { key: d.id, type: "button", className: i === tab ? "on" : "", onClick: () => setTab(i) }, d.title.split("/")[0].trim()))), doc ? /* @__PURE__ */ h("div", { className: "ab-logs", style: { maxHeight: 260, padding: "12px 14px", fontFamily: "inherit", fontSize: 12.5, lineHeight: 1.7, whiteSpace: "pre-wrap" } }, doc.text) : null, /* @__PURE__ */ h("label", { className: "ab-flex", style: { marginTop: 10, cursor: "pointer" } }, /* @__PURE__ */ h("input", { type: "checkbox", checked: agree, onChange: (e) => setAgree(e.target.checked), style: { accentColor: "var(--ab-sea)", width: 16, height: 16 } }), /* @__PURE__ */ h("span", null, "我已阅读并同意以上 SnowLuma 用户协议和隐私说明")), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 8 } }, /* @__PURE__ */ h(
    Btn,
    {
      kind: "primary",
      small: true,
      disabled: !agree,
      onClick: async () => {
        const r = await post("/snowluma/consent", { version: a.version, agree: true });
        toast(r.ok ? "已同意" : r.message, r.ok ? "ok" : "err");
        load();
        onChange && onChange();
      }
    },
    "同意"
  ), /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "SnowLuma 是独立的第三方项目，仅限个人非商业使用；请用小号。")));
}
function GatewayChoice({ draft, setDraft }) {
  return /* @__PURE__ */ h(
    Choices,
    {
      value: draft.gateway || "snowluma",
      onChange: (v) => setDraft(setPath(draft, "gateway", v)),
      options: [
        { value: "snowluma", label: "用 SnowLuma（Windows，推荐）", desc: "插件帮你启动、接入机器人号、断线重连" },
        { value: "onebot", label: "接我已有的 OneBot 机器人", desc: "NapCat、LLOneBot、Lagrange 等；Linux / Docker 部署选这个" }
      ]
    }
  );
}
function OneBotFields({ draft, f }) {
  return /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h(Row, { label: "WebSocket 地址", hint: "正向 WebSocket（OneBot v11），收消息靠它，必填。DSH 在容器里的话，要填容器能访问到的地址" }, f.text("snowluma.wsUrl", { size: "wide", placeholder: "ws://127.0.0.1:3001" })), /* @__PURE__ */ h(Row, { label: "WebSocket 令牌", hint: "对方设了 access_token 就填，没设留空" }, f.text("snowluma.wsToken", { type: "password", placeholder: draft.snowluma.wsTokenSet ? "已保存" : "没有就留空" })), /* @__PURE__ */ h(Row, { label: "HTTP 地址", hint: "可选。填了就用 HTTP 调接口，不填就都走 WebSocket" }, f.text("snowluma.httpUrl", { size: "wide", placeholder: "http://127.0.0.1:3000" })), /* @__PURE__ */ h(Row, { label: "HTTP 令牌" }, f.text("snowluma.httpToken", { type: "password", placeholder: draft.snowluma.httpTokenSet ? "已保存" : "没有就留空" })));
}
var STATE_TEXT = { connected: "已连上", connecting: "连接中", disconnected: "断开了，正在重连", stopped: "没启动（总开关关着）", unconfigured: "还没配置" };
function Connect({ st, draft, setDraft, toast, reload, openWizard }) {
  const f = useField(draft, setDraft);
  const sl = st.snowluma;
  const [procs, setProcs] = useState(null);
  const conn = st.onebot.state === "connected";
  const loadProcs = async () => {
    const r = await get("/snowluma/processes");
    setProcs(r.list || []);
    if (!r.ok) toast(r.message);
  };
  const act = (p) => async () => {
    const r = await post(p);
    toast(r.message || (r.ok ? "好了" : "没成功"));
    reload();
  };
  const login = st.onebot.login;
  const external = draft.gateway === "onebot";
  const testBtns = /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 8 } }, /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
    const r = await get("/onebot/test");
    toast(r.message);
  } }, "测试连接"), /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
    const r = await post("/onebot/reconnect");
    toast(r.message, r.ok ? "ok" : "err");
    reload();
  } }, "重新连接"));
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(Card, { title: "用什么接 QQ", right: openWizard ? /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: openWizard }, "重新走一遍设置向导") : null }, /* @__PURE__ */ h(GatewayChoice, { draft, setDraft })), external ? /* @__PURE__ */ h(Card, { title: "接上 QQ（已有的 OneBot 机器人）", desc: "让 OneBot 服务登录机器人号，把它的正向 WebSocket 地址填在这里，保存后插件就会去连。连上后会先核对登录的是不是机器人号，不是就断开。" }, /* @__PURE__ */ h(OneBotFields, { draft, f }), /* @__PURE__ */ h(Row, { label: "机器人 QQ 号" }, f.text("botQQ")), testBtns) : /* @__PURE__ */ h(Card, { title: "接上 QQ（SnowLuma）", desc: "SnowLuma 是让机器人号上线的 QQ 网关，按协议要你自己下载并同意它的用户协议；启动、密码、接入、断线重连都交给 QQ Hub。" }, /* @__PURE__ */ h("div", { className: "ab-steps" }, /* @__PURE__ */ h("div", { className: cx("ab-step", sl.installed && "done") }, /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("b", null, "下载 SnowLuma"), /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "官方发布页下载 Windows 完整版（名字类似 SnowLuma-v2.x.x-win-x64.zip，不带 lite）。"), /* @__PURE__ */ h("div", { style: { marginTop: 6 } }, /* @__PURE__ */ h(Btn, { small: true, onClick: () => window.open(sl.downloadPage, "_blank") }, "打开下载页 ↗")))), /* @__PURE__ */ h("div", { className: cx("ab-step", sl.installed && "done") }, /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("b", null, "解压到一个纯英文的目录"), /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "推荐 C:\\Aurabot\\snowluma。解压后这个目录里应该直接能看到 index.mjs 和 node.exe。"), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 6 } }, f.text("snowluma.dir", { size: "wide", placeholder: "C:\\Aurabot\\snowluma" })), !sl.installed && sl.reason ? /* @__PURE__ */ h("div", { className: "ab-small", style: { color: "var(--ab-warn)", marginTop: 4 } }, sl.reason) : sl.installed ? /* @__PURE__ */ h("div", { className: "ab-small", style: { color: "var(--ab-ok)", marginTop: 4 } }, "找到了 SnowLuma v", sl.version) : null)), /* @__PURE__ */ h("div", { className: cx("ab-step", sl.running && "done") }, /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("b", null, "启动"), /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "后台运行，不弹窗口；以后会跟着 DSH 自动启动。"), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 6 } }, /* @__PURE__ */ h(Btn, { small: true, kind: "primary", disabled: !sl.installed || sl.running, onClick: act("/snowluma/start") }, sl.running ? "已在运行" : "启动"), sl.owns ? /* @__PURE__ */ h(Btn, { small: true, kind: "danger", onClick: act("/snowluma/stop") }, "停止") : null), /* @__PURE__ */ h("div", { style: { marginTop: 6 } }, /* @__PURE__ */ h(SnowLumaAuth, { running: sl.running, toast, onChange: reload })))), /* @__PURE__ */ h("div", { className: cx("ab-step", sl.consented && "done") }, /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("b", null, "阅读并同意 SnowLuma 的用户协议"), /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginBottom: 6 } }, "同意之前 SnowLuma 不会工作。"), /* @__PURE__ */ h(Agreement, { running: sl.running, toast, onChange: reload }))), /* @__PURE__ */ h("div", { className: cx("ab-step", conn && login && login.uin === draft.botQQ && "done") }, /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("b", null, "登录机器人号并接入"), /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "在电脑上另开一个 QQ 登录机器人号 ", draft.botQQ, "（可以最小化），然后点「接入机器人号」。你的大号照常开着——插件只接机器人号。"), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 6 } }, /* @__PURE__ */ h(Btn, { small: true, kind: "primary", disabled: !sl.running, onClick: act("/snowluma/attach") }, "接入机器人号"), /* @__PURE__ */ h(Btn, { small: true, disabled: !sl.running, onClick: loadProcs }, "看看有哪些 QQ 进程"), /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
    const r = await get("/onebot/test");
    toast(r.message);
  } }, "测试连接")), sl.lastAttach && sl.lastAttach.at ? /* @__PURE__ */ h("div", { className: "ab-small", style: { marginTop: 4, color: sl.lastAttach.ok ? "var(--ab-ok)" : "var(--ab-warn)" } }, timeAgo(sl.lastAttach.at), "：", sl.lastAttach.message) : null))), procs ? /* @__PURE__ */ h("div", { style: { marginTop: 14 } }, procs.length === 0 ? /* @__PURE__ */ h("div", { className: "ab-muted" }, "没找到 QQ 进程。") : /* @__PURE__ */ h("table", { className: "ab-table" }, /* @__PURE__ */ h("thead", null, /* @__PURE__ */ h("tr", null, ["进程", "登录的号", "昵称", "状态", ""].map((x) => /* @__PURE__ */ h("th", { key: x }, x)))), /* @__PURE__ */ h("tbody", null, procs.map((p) => /* @__PURE__ */ h("tr", { key: p.pid }, /* @__PURE__ */ h("td", null, p.pid), /* @__PURE__ */ h("td", null, p.uin || "识别不出"), /* @__PURE__ */ h("td", null, p.nickname || "—"), /* @__PURE__ */ h("td", null, p.injected ? p.connected ? "已接入" : "已注入，连接中" : "未接入"), /* @__PURE__ */ h("td", null, p.isBot ? /* @__PURE__ */ h("span", { className: "ab-badge" }, "机器人号") : /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "不会碰"))))))) : null), /* @__PURE__ */ h(
    Card,
    {
      title: "QQ 会话放在哪",
      desc: "每个 QQ 私聊 / 群都是 DSH 里「QQ Hub」工作区下的一个会话，她在会话里读写文件也在这个文件夹。改了以后新开的会话放到新位置。",
      more: "想把她已有的会话全部挪到新位置：改完保存后去「概览」点「重新开始所有 QQ 会话」（旧会话在 DSH 侧栏的归档里还能找到）。"
    },
    /* @__PURE__ */ h(Row, { label: "工作区文件夹", hint: "填完整路径（比如 D:\\\\QQ Hub\\\\qq-chats）；留空 = 默认位置（用户目录下 QQ Hub/qq-chats）" }, f.text("workspaceDir", { size: "wide", placeholder: st.workspaceDir || "" })),
    /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "现在用的：", st.workspaceDir || "—")
  ), /* @__PURE__ */ h(Card, { title: "连接状态" }, /* @__PURE__ */ h("div", { className: "ab-kv" }, /* @__PURE__ */ h("span", null, "QQ 网关"), /* @__PURE__ */ h("span", null, /* @__PURE__ */ h("span", { className: "ab-flex" }, /* @__PURE__ */ h("i", { className: cx("ab-dot", conn ? "ok" : st.onebot.state === "connecting" ? "warn" : "err") }), STATE_TEXT[st.onebot.state] || st.onebot.state)), /* @__PURE__ */ h("span", null, "登录的号"), /* @__PURE__ */ h("span", null, login ? login.nickname + "（" + login.uin + "）" + (login.uin !== draft.botQQ ? " ⚠ 不是机器人号！" : "") : "—"), /* @__PURE__ */ h("span", null, "HTTP"), /* @__PURE__ */ h("span", null, st.onebot.endpoint.httpUrl || "—"), /* @__PURE__ */ h("span", null, "WebSocket"), /* @__PURE__ */ h("span", null, st.onebot.endpoint.wsUrl || "—")), !conn && st.onebot.problem ? /* @__PURE__ */ h("div", { className: "ab-note warn", style: { marginTop: 10 } }, st.onebot.problem) : null, /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 10 } }, /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
    const r = await post("/onebot/reconnect");
    toast(r.message, r.ok ? "ok" : "err");
    reload();
  } }, "重新连接"))), external ? null : /* @__PURE__ */ h(Card, { title: "高级", desc: "一般不用动：地址和令牌会自动从 SnowLuma 的配置里读。" }, /* @__PURE__ */ h(Row, { label: "机器人 QQ 号" }, f.text("botQQ")), /* @__PURE__ */ h(Row, { label: "控制台端口" }, f.num("snowluma.webuiPort", { min: 1, max: 65535, fallback: 5099 })), /* @__PURE__ */ h(Row, { label: "控制台密码", hint: "默认由插件自动生成。想自己定一个就填在这里，保存后会真的改到 SnowLuma 上（至少 10 位，要有大小写字母和符号）" }, f.text("snowluma.webuiPassword", { type: "password", placeholder: draft.snowluma.webuiPasswordSet ? draft.snowluma.passwordAuto ? "自动管理中（不改就留空）" : "已保存（不改就留空）" : "留空 = 自动" })), /* @__PURE__ */ h(Row, { label: "SnowLuma 自己的控制台", hint: "一般用不到，想看它的原始界面时用" }, /* @__PURE__ */ h(Btn, { small: true, disabled: !sl.running, onClick: () => window.open(sl.webui, "_blank") }, "打开 ↗")), /* @__PURE__ */ h(Row, { label: "随 DSH 自动启动 SnowLuma" }, f.sw("snowluma.autoStart")), /* @__PURE__ */ h(Row, { label: "自动接入机器人号", hint: "断线后自动重新接入，只接机器人号" }, f.sw("snowluma.autoAttach")), /* @__PURE__ */ h(Row, { label: "手动 HTTP 地址", hint: "留空 = 自动" }, f.text("snowluma.httpUrl", { placeholder: "http://127.0.0.1:3000" })), /* @__PURE__ */ h(Row, { label: "手动 WS 地址", hint: "留空 = 自动" }, f.text("snowluma.wsUrl", { placeholder: "ws://127.0.0.1:3001" })), /* @__PURE__ */ h(Row, { label: "手动 HTTP 令牌" }, f.text("snowluma.httpToken", { type: "password", placeholder: draft.snowluma.httpTokenSet ? "已保存" : "留空 = 自动" })), /* @__PURE__ */ h(Row, { label: "手动 WS 令牌" }, f.text("snowluma.wsToken", { type: "password", placeholder: draft.snowluma.wsTokenSet ? "已保存" : "留空 = 自动" }))));
}

// client/src/views/persona.js
function AvatarCard({ st, toast, reload }) {
  const custom = st.avatar && st.avatar.custom;
  return /* @__PURE__ */ h("div", { className: "ab-card", style: { marginTop: 12, padding: 14 } }, /* @__PURE__ */ h("div", { className: "ab-flex", style: { alignItems: "center", gap: 12 } }, /* @__PURE__ */ h("img", { src: avatarSrc(st), alt: "头像", style: { width: 56, height: 56, borderRadius: "50%", objectFit: "cover", objectPosition: "50% 18%", border: "2px solid var(--ab-line)" } }), /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("b", null, "头像"), /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, custom ? "用的是你上传的图片" : "默认的大肥鱼"))), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 10, flexWrap: "wrap" } }, /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: () => pickAvatar(toast, reload) }, "换一张"), custom ? /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: async () => {
    const r = await post("/avatar/reset");
    toast(r.message, "ok");
    reload();
  } }, "恢复默认") : null, /* @__PURE__ */ h(
    Btn,
    {
      small: true,
      kind: "ghost",
      onClick: async () => {
        if (!confirm("把这张图设成机器人号的 QQ 头像？")) return;
        const r = await post("/avatar/sync-qq");
        toast(r.message, r.ok ? "ok" : "err");
      }
    },
    "同步成 QQ 头像"
  )), /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginTop: 6 } }, "这是面板里显示的头像；点「同步成 QQ 头像」才会改机器人号在 QQ 上的头像。"));
}
function PersonaSection({ sec, lead, first, last, onChange, onMove, onDelete, onPolish, pending, onPick, onFlip }) {
  const showing = pending ? pending.view === "new" ? pending.text : sec.text : sec.text;
  const color = lead ? "var(--ab-sea)" : PSEC_COLORS[sec.k % PSEC_COLORS.length];
  return /* @__PURE__ */ h("div", { className: cx("ab-psec", lead && "lead", pending && "cmp"), style: { "--c": color } }, /* @__PURE__ */ h("div", { className: "ab-psec-head" }, lead ? /* @__PURE__ */ h("div", { className: "ab-psec-fixed" }, "开场", /* @__PURE__ */ h("small", null, "她是谁，一两段话")) : /* @__PURE__ */ h("input", { className: "ab-psec-title", value: sec.title, placeholder: "这一节叫什么", maxLength: 30, onChange: (e) => onChange({ title: e.target.value.replace(/[【】\n]/g, "") }) }), /* @__PURE__ */ h("span", { className: "ab-psec-n" }, showing.length, " 字"), /* @__PURE__ */ h("div", { className: "ab-psec-act" }, lead ? null : /* @__PURE__ */ h("button", { type: "button", className: "ab-ibtn", title: "往上移", disabled: first || !!pending, onClick: () => onMove(-1) }, navIcon("M12 19V5M6 11l6-6 6 6")), lead ? null : /* @__PURE__ */ h("button", { type: "button", className: "ab-ibtn", title: "往下移", disabled: last || !!pending, onClick: () => onMove(1) }, navIcon("M12 5v14M6 13l6 6 6-6")), lead ? null : /* @__PURE__ */ h("button", { type: "button", className: "ab-ibtn danger", title: "删掉这一节", disabled: !!pending, onClick: onDelete }, navIcon("M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"))), pending ? null : /* @__PURE__ */ h(AiButton, { onClick: onPolish, empty: !sec.text.trim() })), /* @__PURE__ */ h(
    "textarea",
    {
      value: showing,
      rows: autoRows(showing),
      readOnly: !!pending,
      placeholder: lead ? "你是「…」，一个真实存在的人，正在用手机 QQ 和对面聊天。" : "- 一条一行，短句就好",
      onChange: (e) => onChange({ text: e.target.value })
    }
  ), pending ? /* @__PURE__ */ h("div", { className: "ab-compare" }, /* @__PURE__ */ h("span", { className: "ab-compare-tag" }, pending.view === "new" ? "AI 润色版" : "原版"), /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, pending.view === "new" ? "和原版比：" + (pending.text.length - sec.text.length >= 0 ? "多 " : "少 ") + Math.abs(pending.text.length - sec.text.length) + " 字" : "还没改过的样子"), /* @__PURE__ */ h("div", { className: "ab-spacer" }), /* @__PURE__ */ h("button", { type: "button", className: "ab-chip solid", onClick: onFlip }, pending.view === "new" ? "看原版" : "看润色版"), /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: () => onPick(pending.view) }, pending.view === "new" ? "用润色版" : "保留原版")) : null);
}
function AiButton({ onClick, empty }) {
  const [busy, setBusy] = useState(false);
  return /* @__PURE__ */ h(
    "button",
    {
      type: "button",
      className: "ab-aibtn",
      disabled: busy,
      title: empty ? "让 AI 按这一节的标题先写一版" : "让 AI 把这一节改得更具体、更像真人",
      onClick: async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }
    },
    busy ? /* @__PURE__ */ h("i", { className: "ab-spin" }) : navIcon("M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"),
    /* @__PURE__ */ h("span", null, busy ? "润色中" : empty ? "AI 写一版" : "AI 润色")
  );
}
function PersonaAudit({ toast }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    const r = await get("/persona/audit");
    setBusy(false);
    if (!r.ok) {
      toast(r.message || "自检没成功", "err");
      return;
    }
    setRows(r.rows || []);
  };
  const rebuild = async () => {
    if (!confirm("把挂着旧人设的会话归档、下一条消息重新开始？\n（它们的上下文会清空）")) return;
    setBusy(true);
    const r = await post("/persona/rebuild-stale", { dryRun: false });
    setBusy(false);
    toast(r.message || (r.ok ? "好了" : "没成功"), r.ok ? "ok" : "err");
    load();
  };
  const levelText = (src) => {
    if (!src) return "";
    if (src.level === "group") return "按群指定";
    if (src.level === "private") return "按人指定";
    if (src.level === "groupDefault") return src.emptyRow ? "该群那行是空值 → 跟随群默认" : "群默认";
    if (src.level === "privateDefault") return src.emptyRow ? "该人那行是空值 → 跟随私聊默认" : "私聊默认";
    return "跟随全局";
  };
  const staleCount = (rows || []).filter((r) => r.stale === true).length;
  return /* @__PURE__ */ h(Card, { title: "人设生效自检", right: /* @__PURE__ */ h("div", { className: "ab-flex", style: { gap: 8 } }, /* @__PURE__ */ h(Btn, { small: true, onClick: load, disabled: busy }, busy ? "查…" : rows ? "刷新" : "看一下"), rows && staleCount > 0 ? /* @__PURE__ */ h(Btn, { small: true, kind: "danger", onClick: rebuild, disabled: busy }, "重建 ", staleCount, " 个过期会话") : null) }, /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginBottom: 8 } }, "人设是在建会话那一刻烧进系统提示词的，之后不会自己重算 —— 所以「面板改了」不等于「模型拿到了」。 这里逐聊天列出：按现在的配置**该用哪张卡**、会话里**实际是哪个版本**、下一条消息会不会重建。"), !rows ? /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "点右上角「看一下」。") : rows.length === 0 ? /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "还没有任何会话。") : /* @__PURE__ */ h("div", { className: "ab-table-wrap" }, /* @__PURE__ */ h("table", { className: "ab-table" }, /* @__PURE__ */ h("thead", null, /* @__PURE__ */ h("tr", null, /* @__PURE__ */ h("th", null, "聊天"), /* @__PURE__ */ h("th", null, "该用的卡"), /* @__PURE__ */ h("th", null, "会话里固化的"), /* @__PURE__ */ h("th", null, "状态"), /* @__PURE__ */ h("th", null, "期望来自"))), /* @__PURE__ */ h("tbody", null, rows.map((r) => /* @__PURE__ */ h("tr", { key: r.chatId }, /* @__PURE__ */ h("td", null, r.chatId, r.chatName ? /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, r.chatName) : null), /* @__PURE__ */ h("td", null, r.expected?.name || r.expected?.id || "—", /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, r.expected?.hash || "（无卡）")), /* @__PURE__ */ h("td", null, r.live ? r.live.id || "—" : /* @__PURE__ */ h("span", { className: "ab-muted" }, "还没有会话"), /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, r.live?.hash || "")), /* @__PURE__ */ h("td", null, r.stale === null ? /* @__PURE__ */ h("span", { className: "ab-muted" }, "—") : r.stale ? /* @__PURE__ */ h("span", { style: { color: "#d9534f" } }, "旧人设，会重建") : /* @__PURE__ */ h("span", { style: { color: "#3c9d5d" } }, "是这版")), /* @__PURE__ */ h("td", { className: "ab-small" }, levelText(r.source))))))));
}
function Persona({ st, draft, setDraft, toast, reload }) {
  const [list, setList] = useState(st.personas);
  const [typing, setTyping] = useState({});
  const [current, setCurrent] = useState(st.config.persona.current);
  const [sel, setSel] = useState(st.config.persona.current);
  const [edit, setEdit] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState({});
  const [whole, setWhole] = useState(() => {
    try {
      return localStorage.getItem("qq-hub.persona.whole") === "1";
    } catch (e) {
      return false;
    }
  });
  const load = async (id) => {
    const r = await get("/persona/get?id=" + encodeURIComponent(id));
    if (r.ok) {
      setEdit({ id: r.persona.id, name: r.persona.name, tags: (r.persona.tags || []).join("，"), secs: splitPersona(r.persona.body) });
      setDirty(false);
      setPending({});
    }
  };
  useEffect(() => {
    load(sel);
  }, [sel]);
  const refresh = async () => {
    const r = await get("/personas");
    if (r.ok) {
      setList(r.list);
      setCurrent(r.current);
    }
  };
  const body = edit ? joinPersona(edit.secs) : "";
  const waiting = Object.keys(pending).length;
  const save = async () => {
    const r = await post("/persona/save", { id: edit.id, name: edit.name, tags: edit.tags.split(/[,，\s]+/).filter(Boolean), body });
    toast(r.message || (r.ok ? "保存好了" : "没保存成功"));
    if (r.ok) {
      setDirty(false);
      refresh();
    }
  };
  const patch = (p) => {
    setEdit({ ...edit, ...p });
    setDirty(true);
  };
  const setSecs = (secs) => patch({ secs });
  const updSec = (k, p) => setSecs(edit.secs.map((s) => s.k === k ? { ...s, ...p } : s));
  const moveSec = (i, d) => {
    const n = edit.secs.slice();
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x);
    setSecs(n);
  };
  const delSec = (s) => {
    if (s.text.trim() && !confirm("删掉「" + (s.title || "未命名") + "」这一节？")) return;
    setSecs(edit.secs.filter((x) => x.k !== s.k));
  };
  const addSec = (title) => setSecs([...edit.secs, psec(title, "")]);
  const polish = async (s) => {
    const r = await post("/persona/polish", { name: edit.name, title: s.title === null ? "" : s.title, text: s.text, others: edit.secs.filter((x) => x.k !== s.k).map((x) => x.title === null ? "开场" : x.title) });
    if (!r.ok) {
      toast(r.message || "润色没成功", "err");
      return;
    }
    if (!s.text.trim()) {
      updSec(s.k, { text: r.text });
      toast("写好了，不满意就接着改", "ok");
      return;
    }
    setPending({ ...pending, [s.k]: { text: r.text, view: "new" } });
  };
  const pick = (s, view) => {
    const next = { ...pending };
    delete next[s.k];
    setPending(next);
    if (view === "new") updSec(s.k, { text: pending[s.k].text });
  };
  const flip = (s) => setPending({ ...pending, [s.k]: { ...pending[s.k], view: pending[s.k].view === "new" ? "old" : "new" } });
  const setMode = (w) => {
    if (w && waiting) {
      toast("先把 AI 润色的那几节选定一版", "err");
      return;
    }
    setWhole(w);
    try {
      localStorage.setItem("qq-hub.persona.whole", w ? "1" : "0");
    } catch (e) {
    }
  };
  const titles = edit ? edit.secs.map((s) => s.title) : [];
  const suggest = PSEC_SUGGEST.filter((t) => !titles.includes(t));
  const pm = draft && draft.persona || st.config.persona || {};
  const setPm = (k, v) => {
    setDraft((prev) => prev ? setPath(prev, "persona." + k, v) : prev);
  };
  const personaOpts = (emptyLabel) => [{ value: "", label: emptyLabel }].concat(list.map((p) => ({ value: p.id, label: p.name })));
  const specific = (mapKey, title, hint) => {
    const m = pm[mapKey] || {};
    const wantKind = mapKey === "groups" ? "group" : "private";
    const rows = Object.entries(m).map(([id, pid]) => {
      const isNew = id.startsWith("#new");
      const cur = isNew ? "" : id;
      const fallbackName = (() => {
        const defId = mapKey === "groups" ? pm.groupDefault : pm.privateDefault;
        const hit = list.find((p) => p.id === defId);
        return hit ? hit.name : "";
      })();
      const typed = typing[id];
      const shown = typed !== void 0 ? typed : cur;
      const commitRow = (raw) => {
        const plan = planPersonaRow({ map: m, id, raw });
        setTyping((t) => {
          const n = { ...t };
          delete n[id];
          return n;
        });
        if (plan.action === "keep") return;
        setDraft((prev) => {
          const cur2 = prev && prev.persona && prev.persona[mapKey] || {};
          const m2 = { ...cur2 };
          const keep = m2[id] === void 0 ? "" : m2[id];
          if (plan.action === "clear") {
            if (id.startsWith("#new")) {
              m2[id] = keep;
            } else {
              delete m2[id];
              m2["#new" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)] = keep;
            }
            return setPath(prev, "persona." + mapKey, m2);
          }
          if (plan.key !== id && m2[plan.key] !== void 0) {
            m2[id] = keep;
            return setPath(prev, "persona." + mapKey, m2);
          }
          delete m2[id];
          m2[plan.key] = keep;
          return setPath(prev, "persona." + mapKey, m2);
        });
      };
      return /* @__PURE__ */ h("div", { key: id, className: "ab-flex", style: { marginBottom: 6 } }, /* @__PURE__ */ h(
        "input",
        {
          className: "ab-input",
          style: { width: 240 },
          value: shown,
          placeholder: wantKind === "group" ? "填群号" : "填 QQ 号",
          inputMode: "numeric",
          onChange: (e) => {
            const v = e.target.value.replace(/\D/g, "");
            setTyping((t) => ({ ...t, [id]: v }));
          },
          onKeyDown: (e) => {
            if (e.key === "Enter") commitRow(e.currentTarget.value);
          },
          onBlur: (e) => commitRow(e.currentTarget.value)
        }
      ), /* @__PURE__ */ h(
        Select,
        {
          value: pid,
          width: 200,
          options: personaOpts("选人格"),
          onChange: (v) => {
            setDraft((prev) => {
              const cur2 = prev && prev.persona && prev.persona[mapKey] || {};
              const m2 = { ...cur2 };
              if (v) m2[id] = v;
              else delete m2[id];
              return setPath(prev, "persona." + mapKey, m2);
            });
          }
        }
      ), /* @__PURE__ */ h(
        Btn,
        {
          small: true,
          kind: "danger",
          onClick: () => {
            setTyping((t) => {
              const n = { ...t };
              delete n[id];
              return n;
            });
            setDraft((prev) => {
              const cur2 = prev && prev.persona && prev.persona[mapKey] || {};
              const m2 = { ...cur2 };
              delete m2[id];
              return setPath(prev, "persona." + mapKey, m2);
            });
          }
        },
        "删"
      ), !isNew && !String(cur || "").trim() ? /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "没有选卡 → 跟随", mapKey === "groups" ? "群" : "私聊", "默认", fallbackName ? `（现=${fallbackName}）` : "") : null);
    });
    const noMore = false;
    return /* @__PURE__ */ h(
      Card,
      {
        title,
        desc: hint,
        right: /* @__PURE__ */ h(
          Btn,
          {
            small: true,
            onClick: () => setDraft((prev) => {
              const cur2 = prev && prev.persona && prev.persona[mapKey] || {};
              return setPath(prev, "persona." + mapKey, { ...cur2, ["#new" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)]: "" });
            })
          },
          "＋ 添加"
        )
      },
      rows.length ? rows : /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, noMore ? "机器人还没在" + (wantKind === "group" ? "群里说过话" : "私聊过") + "，点「＋ 添加」手输号码就行。" : "还没单独指定"),
      /* @__PURE__ */ h("div", { style: { marginTop: 10 } }, /* @__PURE__ */ h(Row, { label: "默认" }, /* @__PURE__ */ h(
        Select,
        {
          value: pm[mapKey === "groups" ? "groupDefault" : "privateDefault"] || "",
          width: 200,
          options: personaOpts("跟随全局人设"),
          onChange: (v) => setPm(mapKey === "groups" ? "groupDefault" : "privateDefault", v)
        }
      )))
    );
  };
  return /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "ab-persona" }, /* @__PURE__ */ h("div", { className: "ab-plist" }, list.map((p) => /* @__PURE__ */ h("button", { key: p.id, type: "button", className: cx("ab-pitem", sel === p.id && "on"), onClick: () => setSel(p.id) }, /* @__PURE__ */ h("div", { className: "nm" }, p.name, p.id === current ? /* @__PURE__ */ h("span", { className: "ab-badge" }, "正在用") : null), /* @__PURE__ */ h("div", { className: "tg" }, (p.tags || []).join(" · ") || p.id + " · " + p.chars + " 字"))), /* @__PURE__ */ h(
    Btn,
    {
      kind: "ghost",
      onClick: () => {
        const id = "persona-" + Date.now().toString(36);
        setEdit({ id, name: "新人格", tags: "", secs: splitPersona("你是……\n\n【打字习惯】\n- 短句、口语，一次只说一两句。") });
        setSel(id);
        setDirty(true);
        setPending({});
      }
    },
    "＋ 新建人格"
  ), /* @__PURE__ */ h(AvatarCard, { st, toast, reload })), edit ? /* @__PURE__ */ h(
    Card,
    {
      title: "编辑人格",
      desc: "人格写在系统提示词的最前面，按节写更好改。保存后，下一轮回复起就按新的来。",
      right: /* @__PURE__ */ h("div", { className: "ab-flex" }, edit.id !== current ? /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
        const r = await post("/persona/use", { id: edit.id });
        toast(r.message);
        refresh();
        reload();
      } }, "设为当前") : null, edit.id !== current ? /* @__PURE__ */ h(Btn, { small: true, kind: "danger", onClick: async () => {
        if (!confirm("删掉这个人格？")) return;
        const r = await post("/persona/delete", { id: edit.id });
        if (r.ok) {
          setList(r.list);
          setSel(current);
        } else toast(r.message);
      } }, "删除") : null)
    },
    /* @__PURE__ */ h(Row, { label: "名字" }, /* @__PURE__ */ h("input", { className: "ab-input", value: edit.name, onChange: (e) => patch({ name: e.target.value }) })),
    /* @__PURE__ */ h(Row, { label: "标签", hint: "用逗号隔开" }, /* @__PURE__ */ h("input", { className: "ab-input", value: edit.tags, onChange: (e) => patch({ tags: e.target.value }) })),
    /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 14 } }, /* @__PURE__ */ h(Seg, { value: whole ? "whole" : "secs", onChange: (v) => setMode(v === "whole"), options: [{ value: "secs", label: "分节" }, { value: "whole", label: "整段" }] }), /* @__PURE__ */ h("div", { className: "ab-spacer" }), /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, edit.secs.length - 1 + " 节 · " + body.length + " 字")),
    whole ? /* @__PURE__ */ h("textarea", { className: "ab-textarea", style: { minHeight: 380, marginTop: 12 }, value: body, onChange: (e) => setSecs(splitPersona(e.target.value)) }) : /* @__PURE__ */ h("div", { className: "ab-psecs" }, edit.secs.map((s, i) => /* @__PURE__ */ h(
      PersonaSection,
      {
        key: s.k,
        sec: s,
        lead: s.title === null,
        first: i <= 1,
        last: i === edit.secs.length - 1,
        pending: pending[s.k],
        onChange: (p) => updSec(s.k, p),
        onMove: (d) => moveSec(i, d),
        onDelete: () => delSec(s),
        onPolish: () => polish(s),
        onPick: (v) => pick(s, v),
        onFlip: () => flip(s)
      }
    )), /* @__PURE__ */ h("div", { className: "ab-psec-add" }, /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "加一节："), suggest.map((t) => /* @__PURE__ */ h("button", { key: t, type: "button", className: "ab-chip", onClick: () => addSec(t) }, t)), /* @__PURE__ */ h("button", { type: "button", className: "ab-chip solid", onClick: () => addSec("") }, "＋ 自己起名"))),
    /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 14 } }, waiting ? /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "还有 ", waiting, " 节 AI 润色没选定，选好再保存") : null, /* @__PURE__ */ h("div", { className: "ab-spacer" }), /* @__PURE__ */ h(Btn, { kind: "primary", disabled: !dirty || !!waiting, onClick: save }, dirty ? "保存人格" : "已保存"))
  ) : /* @__PURE__ */ h(Card, null, /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }))), /* @__PURE__ */ h("div", { style: { height: 12 } }), specific("groups", "按群换人设", "指定某个群用哪个人格；没指定的群用「默认」。优先级和聊天模型一致：具体群号 > 群默认 > 全局人设。"), /* @__PURE__ */ h("div", { style: { height: 12 } }), specific("privates", "按人换人设（私聊）", "指定某个人私聊时用哪个人格；没指定的用「默认」。"), /* @__PURE__ */ h("div", { style: { height: 12 } }), /* @__PURE__ */ h(PersonaAudit, { toast }));
}

// client/src/views/access.js
var LEVEL_TEXT = { full: "完整权限", social: "受限（只有 QQ 工具）", chat: "纯聊天" };
function Access({ draft, setDraft }) {
  const privates = draft.allow && draft.allow.private || [];
  const groups = draft.allow && draft.allow.groups || [];
  const perms = draft.profilePerms || {};
  const loosened = Object.values(perms).filter((v) => v && v !== "owner").length;
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(
    Card,
    {
      title: "现在她是谁、能碰什么",
      desc: "一眼看清：主人是谁、给到什么档位、白名单里有谁、改资料类放开了几项。要改去下面对应的卡。"
    },
    /* @__PURE__ */ h("div", { className: "ab-pills" }, /* @__PURE__ */ h(Pill, { title: "主人 QQ 号" }, "主人 ", draft.ownerQQ || "没设"), /* @__PURE__ */ h(Pill, { kind: draft.ownerLevel === "full" ? "warn" : void 0 }, LEVEL_TEXT[draft.ownerLevel] || "完整权限"), /* @__PURE__ */ h(Pill, { title: "只有名单里的人和群她才会理" }, "白名单 私聊 ", privates.length, " / 群 ", groups.length), /* @__PURE__ */ h(Pill, { kind: loosened ? "warn" : void 0, title: "改资料类操作里被放开到「所有人」或显式开启的项数" }, "改资料放开 ", loosened, " 项"), draft.longTasks ? /* @__PURE__ */ h(Pill, { kind: "warn" }, "长任务模式 开") : null)
  ), /* @__PURE__ */ h(OwnerCard, { draft, setDraft }), /* @__PURE__ */ h(Whitelist, { draft, setDraft }), /* @__PURE__ */ h(OwnerPower, { draft, setDraft }), /* @__PURE__ */ h(ProfilePerms, { draft, setDraft }), /* @__PURE__ */ h(GroupRoles, null), /* @__PURE__ */ h(CommandList, null));
}
function OwnerCard({ draft, setDraft }) {
  const f = useField(draft, setDraft);
  return /* @__PURE__ */ h(Card, { title: "主人", desc: "主人的 QQ 号。群管、电脑上的操作只听主人的。" }, /* @__PURE__ */ h(Row, { label: "主人 QQ 号" }, f.text("ownerQQ")), /* @__PURE__ */ h(Row, { label: "她怎么称呼你" }, f.text("ownerName", { placeholder: "主人" })));
}
function Whitelist({ draft, setDraft }) {
  const f = useField(draft, setDraft);
  return /* @__PURE__ */ h(Card, { title: "白名单", desc: "只有名单里的人和群，她才会理。一行一个号码。" }, /* @__PURE__ */ h(Row, { label: "私聊白名单", hint: "主人默认就在里面。" }, f.list("allow.private", { placeholder: "每行一个 QQ 号", numbers: true })), /* @__PURE__ */ h(Row, { label: "群白名单", hint: "把机器人拉进群后，把群号加到这里。" }, f.list("allow.groups", { placeholder: "每行一个群号", numbers: true })));
}
function OwnerPower({ draft, setDraft }) {
  return /* @__PURE__ */ h(
    Card,
    {
      collapse: true,
      title: "她能做到哪一步",
      desc: "主人私聊的权限档位（能不能用电脑上的工具）和长任务模式。默认「完整」；不需要她碰电脑时，降到「受限」或「纯聊天」更安全。",
      more: "群聊永远没有电脑操作权限，这里管不到群。\n切换档位会给主人私聊换一个新的 DSH 会话（旧的还在侧栏里）。\n长任务模式只在「完整」下生效：打开后她能把命令放后台跑、跑完回来告诉你，也能设定时任务；工具多一点，回话会稍慢。"
    },
    /* @__PURE__ */ h(Row, { label: "主人私聊的权限" }, /* @__PURE__ */ h("div", { style: { width: "100%" } }, /* @__PURE__ */ h(
      Choices,
      {
        value: draft.ownerLevel,
        onChange: (v) => setDraft(setPath(draft, "ownerLevel", v)),
        options: [
          { value: "full", label: "完整", desc: "私聊里让她用电脑做事（查文件、跑命令、上网查）也能做" },
          { value: "social", label: "受限", desc: "只有发表情、发说说这类 QQ 工具，碰不到电脑" },
          { value: "chat", label: "纯聊天", desc: "什么工具都没有，只聊天" }
        ]
      }
    ))),
    /* @__PURE__ */ h(Row, { label: "长任务模式", hint: "只在「完整」权限下生效。" }, /* @__PURE__ */ h(
      Choices,
      {
        value: draft.longTasks ? "on" : "off",
        onChange: (v) => setDraft(setPath(draft, "longTasks", v === "on")),
        options: [
          { value: "off", label: "关", desc: "维持现在的速度（默认）" },
          { value: "on", label: "开", desc: "挂上后台任务（jobs）+ 定时任务（schedule）" }
        ]
      }
    ))
  );
}
var PERM_OPTS = [
  { value: "off", label: "关", desc: "谁说都不改" },
  { value: "owner", label: "仅主人私聊", desc: "只有你私聊让她改才改（默认）" },
  { value: "all", label: "所有人", desc: "白名单里的人、群里的人都能让她改" }
];
var PERM_GROUPS = [
  { id: "qq", label: "QQ", keys: ["qqNickname", "qqSignature", "qqAvatar"] },
  { id: "social", label: "好友", keys: ["qqFriendRequest", "whitelist"] },
  { id: "bili", label: "B站", keys: ["biliSign", "biliAvatar"] },
  { id: "douyin", label: "抖音", keys: ["douyinBrowse", "douyinLike", "douyinComment", "douyinShareOwner", "douyinDm"] },
  { id: "heybox", label: "小黑盒", keys: ["heyboxBrowse", "heyboxLike", "heyboxComment", "heyboxPost"] }
];
var PERM_ITEMS = {
  qqNickname: ["QQ 昵称", ""],
  qqSignature: ["QQ 个性签名", ""],
  qqAvatar: ["QQ 头像", "只用网址图片，或「刚才发的那张图」。"],
  qqFriendRequest: ["处理好友申请", "让她通过 / 拒绝别人加她为好友的申请。"],
  whitelist: ["改白名单", "让她把 QQ 号 / 群号加进或移出白名单。主人不会被移出。开成「所有人」前请想清楚。"],
  biliSign: ["B 站签名", "要先在 B 站页登录并打开 B 站。"],
  biliAvatar: ["B 站头像", "要先在 B 站页登录并打开 B 站。图片网址或刚才发的图，最大 2MB。"],
  douyinBrowse: ["刷抖音 / 看视频", "让她去刷推荐、点开别人发来的抖音链接。"],
  douyinLike: ["抖音点赞", "有人让她给某个视频点赞；关掉后她自己刷的时候也不点赞。"],
  douyinComment: ["抖音评论", "有人让她去某个视频下评论；关掉后她自己刷的时候也不评论。"],
  douyinShareOwner: ["分享抖音给主人", "刷到好玩的视频在 QQ 私聊里发给你（她的话 + 链接）。"],
  douyinDm: ["主动发抖音私信", "主人明确让她给某个人发私信时（主页链接或抖音号）。默认仅主人私聊。"],
  heyboxBrowse: ["逛小黑盒 / 看帖子", "让她翻信息流、读帖子正文和热评、看热榜和搜帖子。"],
  heyboxLike: ["小黑盒点赞", "有人让她给某个帖子点赞；关掉后她自己逛的时候也不点赞。"],
  heyboxComment: ["小黑盒评论", "有人让她去某个帖子下评论；关掉后她自己逛的时候也不评论。"],
  heyboxPost: ["小黑盒发帖 / 删帖", "让她发帖（文章模式可带图）和删自己发的帖。发帖会用你的账号公开发布，默认仅主人私聊。"]
};
function ProfilePerms({ draft, setDraft }) {
  const perms = draft.profilePerms || {};
  const [group, setGroup] = useState("qq");
  const cur = PERM_GROUPS.find((g) => g.id === group) || PERM_GROUPS[0];
  const loosened = (keys) => keys.filter((k) => perms[k] && perms[k] !== "owner").length;
  return /* @__PURE__ */ h(
    Card,
    {
      collapse: true,
      title: "改资料与名单",
      desc: "她能不能按别人的要求改自己的昵称、签名、头像，处理好友申请、改白名单，以及在抖音 / 小黑盒上的浏览、点赞、评论。默认都只听主人的，要放开在这里逐项开。",
      more: "说明：\n· QQ 昵称 / 签名 / 头像要 SnowLuma 支持（set_qq_profile / set_self_longnick / set_qq_avatar）。\n· B 站签名 / 头像要先在「B站」页登录。\n· 好友申请：她自己主动加别人暂不支持（SnowLuma 没有这个接口）。\n· 抖音 / 小黑盒的定时自动刷不受「浏览」这项限制；「分享抖音给主人」指刷到好玩的私聊发给你。"
    },
    /* @__PURE__ */ h(Seg, { value: group, onChange: setGroup, options: PERM_GROUPS.map((g) => ({ value: g.id, label: g.label })) }),
    /* @__PURE__ */ h("div", { className: "ab-small ab-muted", style: { marginTop: 8 } }, "这一组（", cur.label, "）共 ", cur.keys.length, " 项 · 放开 ", loosened(cur.keys), " 项（没放开的都是「仅主人私聊」）"),
    /* @__PURE__ */ h("div", { style: { marginTop: 10 } }, cur.keys.map((k) => /* @__PURE__ */ h(Row, { key: k, label: PERM_ITEMS[k][0], hint: PERM_ITEMS[k][1] }, /* @__PURE__ */ h(Choices, { value: perms[k] || "owner", onChange: (v) => setDraft(setPath(draft, "profilePerms." + k, v)), options: PERM_OPTS }))))
  );
}
function CommandList() {
  const [list, setList] = useState([]);
  useEffect(() => {
    get("/commands").then((r) => setList(r.list || []));
  }, []);
  return /* @__PURE__ */ h(Card, { collapse: true, title: "QQ 命令（" + list.length + " 条）", desc: "主人在 QQ 里（私聊或白名单群）直接发这些命令就能管她，别人发了不算。总开关关着时也能用。" }, /* @__PURE__ */ h("table", { className: "ab-table" }, /* @__PURE__ */ h("tbody", null, list.map((c) => /* @__PURE__ */ h("tr", { key: c.name }, /* @__PURE__ */ h("td", { style: { whiteSpace: "nowrap" } }, /* @__PURE__ */ h("code", null, "/", c.name), c.aliases.length ? /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, c.aliases.map((a) => "/" + a).join(" ")) : null), /* @__PURE__ */ h("td", null, c.desc))))));
}
function GroupRoles() {
  const [list, setList] = useState(null);
  const load = () => {
    setList(null);
    get("/groups/roles").then((r) => setList(r.list || []));
  };
  useEffect(load, []);
  return /* @__PURE__ */ h(Card, { collapse: true, title: "群管权限", desc: "她在群里是群主或管理员时，主人才能让她禁言、踢人、发公告；改专属头衔要群主。按已保存的群白名单查。", right: /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: load }, "刷新") }, !list ? /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, /* @__PURE__ */ h("i", { className: "ab-spin" }), " 查询中…") : list.length === 0 ? /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "群白名单是空的。") : /* @__PURE__ */ h("table", { className: "ab-table" }, /* @__PURE__ */ h("thead", null, /* @__PURE__ */ h("tr", null, ["群", "她的身份", "群管"].map((x) => /* @__PURE__ */ h("th", { key: x }, x)))), /* @__PURE__ */ h("tbody", null, list.map((g) => /* @__PURE__ */ h("tr", { key: g.groupId }, /* @__PURE__ */ h("td", null, (g.name && g.name !== g.groupId ? g.name + " " : "") + "(" + g.groupId + ")"), /* @__PURE__ */ h("td", null, g.label), /* @__PURE__ */ h("td", null, g.canManage ? /* @__PURE__ */ h("span", { className: "ab-badge" }, "可以") : /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "不行")))))));
}
function OwnerBrief({ draft, setDraft }) {
  const f = useField(draft, setDraft);
  const ob = draft.group.ownerBrief || { enabled: false, lines: 12, groups: [] };
  const groups = (draft.allow.groups || []).map(String);
  const [info, setInfo] = useState(null);
  useEffect(() => {
    get("/panel/chats").then((r) => {
      if (r && r.ok) setInfo(r);
    }).catch(() => {
    });
  }, []);
  const nameOf = (gid) => {
    const c = (info && info.chats || []).find((x) => x.kind === "group" && String(x.id) === String(gid));
    return c && c.rawName || "";
  };
  const on = (gid) => (ob.groups || []).includes(gid);
  const toggle = (gid) => setDraft(setPath(draft, "group.ownerBrief.groups", on(gid) ? (ob.groups || []).filter((x) => x !== gid) : [...ob.groups || [], gid]));
  return /* @__PURE__ */ h(
    Card,
    {
      title: "主人私聊：群聊摘要",
      right: f.sw("group.ownerBrief.enabled"),
      collapse: true,
      desc: "主人在私聊里问起群里的事时，把最近 24 小时的群聊流水当成「她自己的见闻」补进这一轮上下文。只在主人私聊提到群相关的事时触发，不常驻、不写进记忆；默认关。",
      more: "开启前先在「权限」页把群加进白名单。她只会当成自己最近在群里看到的，不会把群聊原文说成是主人发的。"
    },
    /* @__PURE__ */ h(Row, { label: "每个群给几条", hint: "越少越省上下文；最多 30 条" }, f.range("group.ownerBrief.lines", 1, 30, 1, (v) => v + " 条")),
    /* @__PURE__ */ h(Row, { label: "只取哪些群", hint: "没勾 = 所有白名单群；只列白名单里的群" }, groups.length ? /* @__PURE__ */ h("div", { className: "ab-flex", style: { flexWrap: "wrap" } }, groups.map((gid) => /* @__PURE__ */ h("button", { key: gid, type: "button", className: cx("ab-chip", on(gid) && "on"), onClick: () => toggle(gid) }, (on(gid) ? "✓ " : "") + (nameOf(gid) || "群"), /* @__PURE__ */ h("span", { className: "n" }, gid)))) : /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "群白名单是空的，先在「权限」页加群。"))
  );
}

// client/src/views/group.js
var quietAt = (d, i) => {
  const raw = d && d.group && Array.isArray(d.group.quietHours) ? d.group.quietHours[i] : void 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};
function FoldSection({ title, desc, right, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return /* @__PURE__ */ h("div", { className: "ab-fold-section" }, /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 12 } }, /* @__PURE__ */ h(
    "div",
    {
      className: "ab-fold-head",
      style: { margin: 0, flex: 1 },
      role: "button",
      tabIndex: 0,
      "aria-expanded": open,
      onClick: () => setOpen(!open),
      onKeyDown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(!open);
        }
      }
    },
    /* @__PURE__ */ h("span", { className: cx("ab-fold-chev", open && "open"), "aria-hidden": "true" }, /* @__PURE__ */ h("svg", { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ h("path", { d: "M4.5 3 7.5 6 4.5 9" }))),
    /* @__PURE__ */ h("h3", null, title)
  ), right || null), desc ? /* @__PURE__ */ h("p", { className: "ab-desc", style: { marginTop: 2 } }, desc) : null, open ? /* @__PURE__ */ h("div", null, children) : null);
}
function Group({ draft, setDraft }) {
  const f = useField(draft, setDraft);
  const overrides = draft.group.overrides || {};
  const [newGid, setNewGid] = useState("");
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(Card, { title: "消息节奏", desc: "人常常一口气发好几句：她等对方说完再一起回，而不是一句一回；模型或工具卡住时也不会无限等。" }, /* @__PURE__ */ h(Row, { label: "连发合并", hint: "打开后她会等对方说完再回" }, f.sw("merge.enabled")), /* @__PURE__ */ h(Row, { label: "对方停顿多久算说完" }, f.range("merge.waitSec", 0.5, 10, 0.5, (v) => v + " 秒")), /* @__PURE__ */ h(Row, { label: "最多等多久", hint: "对方一直在发也最多等这么久" }, f.range("merge.maxSec", 2, 30, 1, (v) => v + " 秒")), /* @__PURE__ */ h(Row, { label: "群里停顿多久算一段", hint: "群里你一句我一句，多等一会儿把一段话攒齐再回；她回上一段的时候，新消息也会先攒着" }, f.range("merge.groupWaitSec", 1, 20, 1, (v) => v + " 秒")), /* @__PURE__ */ h(Row, { label: "群里最多等多久" }, f.range("merge.groupMaxSec", 3, 60, 1, (v) => v + " 秒")), /* @__PURE__ */ h(Row, { label: "回合超时", hint: "模型或工具长时间不结束时停止等待并提示你；超时的旧回复不会补发，你发下一条时新建会话。可设 1～120 分钟" }, f.num("turnTimeoutMs", { min: 1, max: 120, scale: 6e4, fallback: 10 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "分钟"))), /* @__PURE__ */ h(
    Card,
    {
      title: "怎么说话（分条）",
      desc: "她写的 ||| 一定断开；空行算段落；句末标点会按下面的上限攒成条。句子太短不会单独成条，攒够一截才断。",
      more: "换行不代表换消息：一行一个要点的排版会攒成一条发；她真的一行一句话（每行都很短）时，换行就是分条。\n清单和汇报（带小标题、编号列表、代码块）整段发出，拆开会散——用下面的开关控制。"
    },
    /* @__PURE__ */ h(Row, { label: "群里一条最长", hint: "攒到这么长就断开；正常聊天她一般写得比这短" }, f.num("reply.groupMaxChars", { min: 10, max: 500, fallback: 40 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "字")),
    /* @__PURE__ */ h(Row, { label: "私聊一条最长", hint: "私聊可以整段说，设大一点更像正常聊天" }, f.num("reply.privateMaxChars", { min: 20, max: 2e3, fallback: 120 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "字")),
    /* @__PURE__ */ h(Row, { label: "一轮最多几条", hint: "超过就均匀合并，不会把剩下的全塞进最后一条" }, f.num("reply.maxBubbles", { min: 1, max: 12, fallback: 6 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "条")),
    /* @__PURE__ */ h(Row, { label: "清单和汇报整段发", hint: "开：带小标题、编号列表、代码块的内容整段发出，拆开会散。关：照样按上面的上限拆" }, f.sw("reply.keepReports"))
  ), /* @__PURE__ */ h(Card, { title: "群聊行为", desc: "群里什么时候必回、什么时候插话、怎么防刷屏。低频的刹车与防 bot 规则默认收起。" }, /* @__PURE__ */ h(FoldSection, { title: "被叫到一定回", defaultOpen: true, desc: "被 @、有人引用回复她的消息、或者提到下面这些名字时，她一定会回。" }, /* @__PURE__ */ h(Row, { label: "唤醒词", hint: "一行一个" }, f.list("group.wakeWords", { placeholder: "大肥鱼\n肥鱼" }))), /* @__PURE__ */ h(FoldSection, { title: "插话", defaultOpen: true, desc: "没人叫她的时候，她也可能自然地插一句；她看完群里在聊什么，也可以决定不说话。" }, /* @__PURE__ */ h(Row, { label: "插话概率", hint: "每条普通消息触发插话的机会" }, f.percent("group.interjectChance")), /* @__PURE__ */ h(Row, { label: "冷却", hint: "两次插话至少隔多久" }, f.range("group.cooldownSec", 0, 600, 10, (v) => v + " 秒")), /* @__PURE__ */ h(Row, { label: "每小时最多说", hint: "这是说话总条数（插话和接着聊都算），不是只看插话次数；额度按小时均摊发放，允许最多三分之一连发" }, f.range("group.maxPerHour", 0, 120, 1, (v) => v + " 条")), /* @__PURE__ */ h(Row, { label: "她感兴趣的话题", hint: "群里在聊这些（或她记得相关的事）时更容易插话；一行一个" }, f.list("group.interests", { placeholder: "白米饭\n游戏\n追剧" })), /* @__PURE__ */ h(Row, { label: "话题相关度门槛", hint: "和她关系不大的话题就不插话；拉到 0 = 不看话题、纯随机" }, f.range("group.minRelevance", 0, 1, 0.05, (v) => v === 0 ? "不看话题" : Math.round(v * 100) + "%")), /* @__PURE__ */ h(Row, { label: "群冷清时不插话", hint: "最近几分钟内消息少于这个数就不插" }, f.num("group.minRecentMessages", { min: 0, fallback: 3 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "条 / "), f.num("group.activeWindowSec", { min: 30, fallback: 300 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "秒")), /* @__PURE__ */ h(Row, { label: "静默时段", hint: "这段时间不插话（被叫到还是会回）" }, /* @__PURE__ */ h(
    NumInput,
    {
      value: quietAt(draft, 0),
      min: 0,
      max: 23,
      step: 1,
      onChange: (v) => setDraft((prev) => setPath(prev, "group.quietHours", [v === "" ? 0 : v, quietAt(prev, 1)]))
    }
  ), /* @__PURE__ */ h("span", { className: "ab-muted" }, "点 到"), /* @__PURE__ */ h(
    NumInput,
    {
      value: quietAt(draft, 1),
      min: 0,
      max: 23,
      step: 1,
      onChange: (v) => setDraft((prev) => setPath(prev, "group.quietHours", [quietAt(prev, 0), v === "" ? 0 : v]))
    }
  ), /* @__PURE__ */ h("span", { className: "ab-muted" }, "点")), /* @__PURE__ */ h(More, { label: "加入话题之后怎么聊" }, "她被叫到或插上话以后算「加入了话题」：话题还和她相关、她刚说过话，就会接着聊下去（每次看完群里新说的一段再回），不受冷却限制 —— 但照样吃上面的每小时说话额度，不会白送。话题跑偏或者她选择不说话就退出。"), /* @__PURE__ */ h(Row, { label: "连聊预算", hint: "一次入场最多连着接几条 / 最多聊多久；填 0 = 关掉连聊通道（只靠插话）" }, f.range("group.engagedMaxReplies", 0, 10, 1, (v) => v === 0 ? "关闭" : v + " 条"), /* @__PURE__ */ h("span", { className: "ab-muted" }, "/"), f.range("group.engagedMaxMs", 0, 30 * 6e4, 6e4, (v) => v === 0 ? "关闭" : Math.round(v / 6e4) + " 分钟"))), /* @__PURE__ */ h(FoldSection, { title: "安全刹车", desc: "只防失控（比如和别的机器人聊停不下来）：她在一个群里短时间说太多就歇一会儿，主人 @ 她除外。平时碰不到。" }, /* @__PURE__ */ h(Row, { label: "最多说几次" }, f.range("group.burstMax", 1, 20, 1, (v) => v + " 次"), /* @__PURE__ */ h("span", { className: "ab-muted" }, "/"), f.range("group.burstWindowSec", 30, 600, 30, (v) => Math.round(v / 6) / 10 + " 分钟"))), /* @__PURE__ */ h(FoldSection, { title: "防同类 bot", desc: "防 bot 对聊刷屏：她和一个对象互相针对地接话，已确认是同类 bot 的 2 个来回就停、看不出身份的 4 个来回才停，停的是这一对 30 分钟。" }, /* @__PURE__ */ h(Row, { label: "启用", hint: "关掉就完全不判定，她照常按插话概率说话。" }, f.sw("group.fishGuard.enabled")), /* @__PURE__ */ h(Row, { label: "按号码认同类 bot", hint: "逗号或空格隔开。名单里的人一律当成同类 bot（哪怕名字看不出）" }, /* @__PURE__ */ h(
    ListInput,
    {
      value: Array.isArray(draft.group && draft.group.fishGuard && draft.group.fishGuard.fishIds) ? draft.group.fishGuard.fishIds : [],
      placeholder: "例如 123456789, 987654321",
      numbers: true,
      onChange: (list) => setDraft((prev) => setPath(prev, "group.fishGuard.fishIds", list))
    }
  )), /* @__PURE__ */ h(Row, { label: "按名字认同类 bot", hint: "在默认的「肥鱼/鲸/fish」之外还要算哪些名字？逗号或空格隔开。名字带「鱼」但其实是真人的别加。" }, /* @__PURE__ */ h(
    ListInput,
    {
      value: Array.isArray(draft.group && draft.group.fishGuard && draft.group.fishGuard.nameSuffixes) ? draft.group.fishGuard.nameSuffixes : [],
      placeholder: "例如 小鱼, 咸鱼罐头",
      onChange: (list) => setDraft((prev) => setPath(prev, "group.fishGuard.nameSuffixes", list))
    }
  ))), /* @__PURE__ */ h(FoldSection, { title: "按群单独设置", desc: "某个群想让她更安静或更活跃，在这里单独设插话概率。" }, Object.keys(overrides).length === 0 ? /* @__PURE__ */ h("div", { className: "ab-muted", style: { marginBottom: 10 } }, "还没有单独设置的群。") : Object.entries(overrides).map(([gid, o]) => /* @__PURE__ */ h(
    PercentRow,
    {
      key: gid,
      label: "群 " + gid,
      value: o.interjectChance,
      fallback: draft.group.interjectChance,
      write: (v) => setDraft((prev) => {
        const cur = (prev.group.overrides || {})[gid] || {};
        return setPath(prev, "group.overrides", { ...prev.group.overrides || {}, [gid]: { ...cur, interjectChance: v } });
      }),
      remove: () => setDraft((prev) => {
        const n = { ...prev.group.overrides || {} };
        delete n[gid];
        return setPath(prev, "group.overrides", n);
      })
    }
  )), /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h("input", { className: "ab-input", placeholder: "群号", value: newGid, onChange: (e) => setNewGid(e.target.value.replace(/\D/g, "")) }), /* @__PURE__ */ h(Btn, { small: true, disabled: !newGid, onClick: () => {
    setDraft((prev) => setPath(prev, "group.overrides", { ...prev.group.overrides || {}, [newGid]: { interjectChance: prev.group.interjectChance } }));
    setNewGid("");
  } }, "添加")))), /* @__PURE__ */ h(Card, { title: "安全与文件", desc: "收发文件与危险命令确认。平时用不到的话保持默认即可。" }, /* @__PURE__ */ h(FoldSection, { title: "发文件", right: f.sw("files.enabled"), desc: "打开后，你在私聊里可以让她把本机文件当文件发到 QQ，也能按你说的发给白名单里的人或群。" }, /* @__PURE__ */ h(Row, { label: "单个文件最大" }, f.num("files.maxMB", { min: 1, max: 2048, fallback: 50 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "MB")), /* @__PURE__ */ h(Row, { label: "额外允许的目录", hint: "一行一个完整路径。QQ 工作区里的文件一直允许，不用写；留空 = 只能发工作区里的" }, f.list("files.dirs", { placeholder: "D:\\Aurabot\\要发的文件" })), /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginTop: 4 } }, "限制：她只能发 QQ 工作区和上面目录里的文件；单个文件有大小上限；发过什么会记在日志里。")), /* @__PURE__ */ h(FoldSection, { title: "收文件", desc: "别人发来的文件，她会下载到 QQ 工作区的 qq-inbox 目录，再把路径告诉她（要看得用工具读）。这里管的是单个文件的大小上限。" }, /* @__PURE__ */ h(Row, { label: "单个文件最大", hint: "文件是整包读进内存的，一条消息最多取 3 个；调大要留意内存，上限 256MB" }, f.num("files.inboundMaxMB", { min: 1, max: 256, fallback: 50 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "MB")), /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginTop: 4 } }, "超过这个大小的文件不会被下载，她只知道有人发了个文件。文本类（txt / md / json 等）下载后直接进上下文，太长只给前 6 万字；其它类型落盘，她要用工具才读得到。")), /* @__PURE__ */ h(FoldSection, { title: "危险命令确认", right: f.sw("security.dangerConfirm"), desc: "她在私聊里要执行终端危险命令之前，先发 QQ 私聊问你；你回复「确认」才执行，回复「取消」或 60 秒没回就拦下。默认关。" }, /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "拦的是真正致命的那几类：删根目录 / 格式化 / 关机重启 / 清空磁盘 / 改注册表关键项 / 下载后直接执行等。普通删除、构建、改文件不受影响。"), /* @__PURE__ */ h("div", { className: "ab-note warn", style: { marginTop: 6 } }, "注意：这是静态规则检测，不是沙箱——动态拼装的命令仍可能绕过，不能替代系统权限隔离。"))), /* @__PURE__ */ h(OwnerBrief, { draft, setDraft }));
}

// client/src/views/browser.js
var fmtMB = (n) => n >= 1024 ? (n / 1024).toFixed(1) + " GB" : Math.round(n) + " MB";
function InstallCard({ st, busy, onInstall, onRefresh, onOpen }) {
  if (!st) return /* @__PURE__ */ h(Card, { title: "浏览器" }, /* @__PURE__ */ h(Empty, { icon: "⏳", text: "读取中…" }));
  if (st.installed) {
    const info = st.info || {};
    return /* @__PURE__ */ h(
      Card,
      {
        title: "浏览器已装好",
        desc: `${info.kind === "chrome" ? "官方 Chrome" : "Debian Chromium"}　占用 ${fmtMB(info.sizeMB || 0)}`,
        right: /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: onOpen }, "打开目录")
      },
      /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { wordBreak: "break-all" } }, info.browser),
      /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginTop: 4 } }, "装在这台机器上，只有插件自己用；没动系统里的东西。")
    );
  }
  if (st.job?.state === "running") {
    return /* @__PURE__ */ h(Card, { title: "正在装…", right: /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: onRefresh }, "刷新") }, /* @__PURE__ */ h("div", { className: "ab-muted" }, "要下几百兆，几分钟很正常。装完这张卡片会自己刷新，不用一直盯着。"), /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginTop: 6 } }, st.job.message));
  }
  const failed2 = st.job?.state === "failed";
  return /* @__PURE__ */ h(
    Card,
    {
      title: failed2 ? "装失败了" : "还没装浏览器",
      desc: "刷抖音、小红书、贴吧这类要开网页的功能，得先有一个浏览器。",
      right: /* @__PURE__ */ h(Btn, { kind: "primary", onClick: onInstall, disabled: busy }, busy ? "开始了…" : "安装")
    },
    /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "会下到插件的数据目录里，", /* @__PURE__ */ h("b", null, "不需要管理员权限"), "，也不动系统里的东西。 优先装官方 Chrome（视频编解码更全），下不动就退回 Debian 的 chromium。"),
    failed2 ? /* @__PURE__ */ h("div", { className: "ab-note warn", style: { marginTop: 8 } }, st.job.message || st.missing) : null,
    !failed2 && st.missing ? /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginTop: 6 } }, st.missing) : null
  );
}
function LiveCard({ st, onShutdown, onVnc, busy }) {
  const live = st?.live;
  if (!live) return null;
  const running = live.state === "ready";
  return /* @__PURE__ */ h(
    Card,
    {
      title: "运行状态",
      desc: running ? "浏览器正在跑（多个模块共用这一个进程）" : "现在没在跑。下次要用时会自动起来。",
      right: running ? /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: onShutdown, disabled: busy }, "立刻关掉") : null
    },
    /* @__PURE__ */ h(Row, { label: "状态" }, /* @__PURE__ */ h("span", null, running ? "运行中" : "休眠"), live.browser ? /* @__PURE__ */ h("span", { className: "ab-muted ab-small", style: { marginLeft: 8 } }, live.browser) : null),
    running ? /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h(Row, { label: "显示" }, live.displayOwned ? /* @__PURE__ */ h("span", null, "虚拟屏 ", live.display, "（没有桌面，看不见）") : /* @__PURE__ */ h("span", null, live.display || "系统显示")), /* @__PURE__ */ h(Row, { label: "标签页" }, /* @__PURE__ */ h("span", null, live.tabs, " 个")), /* @__PURE__ */ h(Row, { label: "正在用" }, live.active.length ? /* @__PURE__ */ h("span", null, live.active.join("、")) : /* @__PURE__ */ h("span", { className: "ab-muted" }, "没人用"))) : null,
    /* @__PURE__ */ h(Row, { label: "可用内存" }, /* @__PURE__ */ h("span", { className: live.freeMB >= 0 && live.freeMB < 600 ? "ab-warn" : "" }, live.freeMB >= 0 ? fmtMB(live.freeMB) : "未知")),
    live.displayOwned ? /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h(Row, { label: "看画面", hint: "虚拟屏没人看得见。要完成短信/人机验证，只能用 VNC 连过来自己点" }, /* @__PURE__ */ h(Btn, { small: true, onClick: () => onVnc("start"), disabled: busy || live.vnc?.running }, "开 VNC"), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => onVnc("stop"), disabled: busy || !live.vnc?.running }, "关")), live.vnc?.running ? /* @__PURE__ */ h(Row, { label: "连接方式" }, /* @__PURE__ */ h("div", { className: "ab-small" }, /* @__PURE__ */ h("div", null, "端口 ", /* @__PURE__ */ h("b", null, live.vnc.port), "　密码 ", /* @__PURE__ */ h("b", null, live.vnc.password)), /* @__PURE__ */ h("div", { className: "ab-muted", style: { marginTop: 4 } }, live.vnc.lan ? `用 VNC 客户端连「NAS地址:${live.vnc.port}」。开给局域网了，验完记得关。` : `只允许本机连：先做隧道 ssh -L ${live.vnc.port}:127.0.0.1:${live.vnc.port} 用户@NAS，再连 127.0.0.1:${live.vnc.port}。`))) : null) : null
  );
}
function Browser({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const r = await get("/browser/status").catch(() => null);
    setSt(r && r.ok ? r : null);
  };
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (st?.job?.state !== "running") return;
    const t = setInterval(load, 3e3);
    return () => clearInterval(t);
  }, [st?.job?.state]);
  const act = async (path, body, okText) => {
    setBusy(true);
    try {
      const r = await post(path, body).catch(() => ({ ok: false, message: "请求失败" }));
      toast(r.message || (r.ok ? okText : "没成功"), r.ok ? "ok" : "err");
      await load();
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h(
    InstallCard,
    {
      st,
      busy,
      onInstall: () => act("/browser/install", {}, "开始安装"),
      onRefresh: load,
      onOpen: () => act("/browser/open-folder", {}, "打开了")
    }
  ), /* @__PURE__ */ h(
    LiveCard,
    {
      st,
      busy,
      onShutdown: () => act("/browser/shutdown", {}, "已关闭"),
      onVnc: (action) => act("/browser/vnc", { action }, "好")
    }
  ), /* @__PURE__ */ h(Card, { title: "设置", desc: "一个浏览器进程给所有网页类模块共用：内存有限，多开必炸。" }, /* @__PURE__ */ h(Row, { label: "总开关", hint: "关掉之后所有要用网页的模块都停（不影响 B站、米家这些纯网络的）" }, f.sw("browser.enabled")), /* @__PURE__ */ h(Row, { label: "浏览器路径", hint: "留空 = 用装好的那份；也可以填系统里已有的 Chrome / Edge 完整路径" }, f.text("browser.chromePath", { size: "wide", placeholder: "留空自动找" })), /* @__PURE__ */ h(Row, { label: "同时用几个", hint: "默认 2。机器内存小就调到 1，超了会立刻报忙而不是排队" }, f.num("browser.maxConcurrent", { min: 1, max: 4, fallback: 2 })), /* @__PURE__ */ h(Row, { label: "没人用多久就关", hint: "默认 10 分钟。0 = 一直开着（不推荐，会一直占内存）" }, f.num("browser.idleMinutes", { min: 0, max: 240, fallback: 10 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "分钟")), /* @__PURE__ */ h(Row, { label: "内存低于多少就不开", hint: "默认 600 MB。可用内存不够时不启动，免得把整机拖垮" }, f.num("browser.minFreeMB", { min: 0, max: 8192, fallback: 600 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "MB")), /* @__PURE__ */ h(Row, { label: "无头模式", hint: "默认关。抖音、小红书会拦无头浏览器，开了可能刷不出内容" }, f.sw("browser.headless")), /* @__PURE__ */ h(Row, { label: "优先官方 Chrome", hint: "开着装 Chrome（视频编解码更全）；关着装 Debian 的 chromium（走 apt 源更快）" }, f.sw("browser.chrome")), /* @__PURE__ */ h(Row, { label: "VNC 开给局域网", hint: "默认关：VNC 只绑本机，跨机器看要先做 SSH 隧道。打开后局域网能直接连（有随机密码），但浏览器等于敞开，验完记得关" }, f.sw("browser.vncLan"))));
}

// client/src/views/model.js
var key = (m) => m.provider + "::" + m.model;
var val = (s) => s && s.provider && s.model ? s.provider + "::" + s.model : "";
var toSel = (v) => {
  const [p, ...m] = v.split("::");
  return v ? { provider: p, model: m.join("::"), reasoningEffort: "" } : { provider: "", model: "", reasoningEffort: "" };
};
var EFFORT = { low: "低", high: "高", max: "最高" };
function nameLabels(list) {
  const count = {};
  for (const m of list || []) count[m.name] = (count[m.name] || 0) + 1;
  return (m) => count[m.name] > 1 ? m.name + "（" + m.model + "）" : m.name;
}
function ChatModels({ draft, setDraft, list }) {
  const cm = draft.chatModels || { privateDefault: {}, groupDefault: {}, privates: {}, groups: {} };
  const [open, setOpen] = useState(false);
  const [add, setAdd] = useState({ kind: "private", id: "", sel: "" });
  const labelOf = nameLabels(list);
  const base = [{ value: "", label: "跟随全局模型", desc: "上面「聊天用的模型」" }].concat((list || []).map((m) => ({ value: key(m), label: labelOf(m), desc: m.provider, group: m.provider })));
  const optsFor = (v) => v && !base.some((o) => o.value === v) ? base.concat([{ value: v, label: v.split("::").slice(1).join("::"), desc: "（DSH 里没找到）" }]) : base;
  const setCm = (patch) => setDraft(setPath(draft, "chatModels", { ...cm, ...patch }));
  const rows = [["private", cm.privates || {}], ["group", cm.groups || {}]].flatMap(([kind, m]) => Object.entries(m).map(([id, sel]) => ({ kind, id, sel })));
  const label = (sel) => {
    const v = val(sel);
    const hit = (list || []).find((m) => key(m) === v);
    return hit ? hit.name : sel.model;
  };
  const addRow = () => {
    if (!add.id || !add.sel) return;
    const field = add.kind === "private" ? "privates" : "groups";
    setCm({ [field]: { ...cm[field] || {}, [add.id]: toSel(add.sel) } });
    setAdd({ ...add, id: "" });
  };
  const remove = (kind, id) => {
    const field = kind === "private" ? "privates" : "groups";
    const n = { ...cm[field] || {} };
    delete n[id];
    setCm({ [field]: n });
  };
  return /* @__PURE__ */ h(
    Card,
    {
      title: "按聊天选模型",
      desc: "顺序：这个私聊 > 这个群 > 所有私聊 / 所有群的默认 > 上面的全局模型。没选的一级就用下一级；选的模型在 DSH 里找不到时也自动退回。",
      more: "只有你能在这里改，聊天里的人换不了。换了之后从那个聊天的下一条消息起生效。"
    },
    /* @__PURE__ */ h(Row, { label: "私聊默认模型" }, /* @__PURE__ */ h(Select, { value: val(cm.privateDefault), width: 280, options: optsFor(val(cm.privateDefault)), onChange: (v) => setCm({ privateDefault: toSel(v) }) })),
    /* @__PURE__ */ h(Row, { label: "群聊默认模型" }, /* @__PURE__ */ h(Select, { value: val(cm.groupDefault), width: 280, options: optsFor(val(cm.groupDefault)), onChange: (v) => setCm({ groupDefault: toSel(v) }) })),
    /* @__PURE__ */ h("div", { style: { marginTop: 8 } }, /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => setOpen(!open) }, (open ? "收起" : "展开") + "单个 QQ / 群的例外（" + rows.length + "）")),
    open ? /* @__PURE__ */ h("div", { style: { marginTop: 8 } }, rows.length === 0 ? /* @__PURE__ */ h("div", { className: "ab-muted", style: { marginBottom: 10 } }, "还没有单独设置的 QQ 或群。") : rows.map((r) => /* @__PURE__ */ h(Row, { key: r.kind + r.id, label: (r.kind === "private" ? "私聊 " : "群 ") + r.id }, /* @__PURE__ */ h("span", { className: "ab-muted" }, label(r.sel)), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => remove(r.kind, r.id) }, "移除"))), /* @__PURE__ */ h("div", { className: "ab-flex", style: { flexWrap: "wrap" } }, /* @__PURE__ */ h(Seg, { value: add.kind, onChange: (v) => setAdd({ ...add, kind: v }), options: [{ value: "private", label: "私聊" }, { value: "group", label: "群" }] }), /* @__PURE__ */ h("input", { className: "ab-input", placeholder: add.kind === "private" ? "QQ 号" : "群号", value: add.id, onChange: (e) => setAdd({ ...add, id: e.target.value.replace(/\D/g, "") }) }), /* @__PURE__ */ h(Select, { value: add.sel, width: 220, options: base.filter((o) => o.value), placeholder: "选模型", onChange: (v) => setAdd({ ...add, sel: v }) }), /* @__PURE__ */ h(Btn, { small: true, disabled: !add.id || !add.sel, onClick: addRow }, "添加"))) : null
  );
}
function ModelSummary({ draft, list, curModel, noReasoning, exceptions }) {
  const modelText = curModel ? nameLabels(list)(curModel) : draft.model.model || "跟随 DSH 默认";
  const effortText = noReasoning ? "这个模型不管思考强度" : "思考 " + (EFFORT[draft.model.reasoningEffort || "low"] || "低");
  const visionText = draft.model.vision === "on" ? "看图 强制支持" : draft.model.vision === "off" ? "看图 强制不支持" : curModel && curModel.vision === true ? "看图 自动（模型支持）" : curModel && curModel.vision === false ? "看图 自动（模型看不了）" : "看图 自动（照发）";
  const helperOn = !!(draft.visionHelper && draft.visionHelper.enabled);
  return /* @__PURE__ */ h(
    Card,
    {
      title: "现在用哪个模型",
      desc: "新建的 QQ 会话按这里的设置来；已有会话可以在 DSH 里单独切。改动都要点底部「保存设置」。"
    },
    /* @__PURE__ */ h("div", { className: "ab-pills" }, /* @__PURE__ */ h(Pill, { title: "全局模型" }, modelText), draft.model.provider ? /* @__PURE__ */ h(Pill, { title: "provider" }, draft.model.provider) : null, /* @__PURE__ */ h(Pill, null, effortText), /* @__PURE__ */ h(Pill, { kind: curModel && curModel.vision === false && draft.model.vision !== "on" ? "warn" : void 0 }, visionText), /* @__PURE__ */ h(Pill, { kind: helperOn ? "ok" : void 0 }, "辅助看图 ", helperOn ? "开" : "关"), /* @__PURE__ */ h(Pill, { title: "按聊天单独指定的数量" }, "例外 ", exceptions, " 处"), /* @__PURE__ */ h(Pill, null, list === null ? "模型列表加载中…" : "可用 " + list.length + " 个"))
  );
}
function Model({ st, draft, setDraft, toast }) {
  const [list, setList] = useState(null);
  const [ping, setPing] = useState({});
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    get("/models").then((r) => setList(r.list || []));
  }, []);
  const labelOf = nameLabels(list);
  const cur = draft.model.provider && draft.model.model ? draft.model.provider + "::" + draft.model.model : "";
  const curModel = cur && list ? list.find((m) => key(m) === cur) : null;
  const noReasoning = Boolean(curModel && curModel.reasoning === null);
  const autoVision = curModel ? curModel.vision : void 0;
  const visionHint = draft.model.vision === "on" ? "强制当「能看图」；模型其实看不了的话，带图的那一轮会报错" : draft.model.vision === "off" ? "强制当「看不懂」：收到图片只给一行文字提示，不会把图塞给模型" : autoVision === true ? "自动：DSH 说这个模型支持看图" : autoVision === false ? "自动：DSH 说这个模型看不了图，会自动降级成文字提示" : "自动：DSH 没声明，默认照发；真看不了就手动选「不支持」";
  const cm = draft.chatModels || {};
  const exceptions = Object.keys(cm.privates || {}).length + Object.keys(cm.groups || {}).length;
  const test = async (m) => {
    setPing({ ...ping, [key(m)]: "测速中…" });
    const r = await post("/model/ping", { provider: m.provider, model: m.model });
    setPing((p) => ({ ...p, [key(m)]: r.ok ? (r.ms / 1e3).toFixed(1) + " 秒" : "失败：" + (r.message || "") }));
  };
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(ModelSummary, { draft, list, curModel, noReasoning, exceptions }), /* @__PURE__ */ h(Card, { title: "聊天用的模型", desc: "她平时回 QQ 用哪个模型。聊天对速度很敏感，可以先点「测速」挑个快的；留空就是跟随你在 DSH 里平时用的模型。" }, /* @__PURE__ */ h(Row, { label: "模型" }, /* @__PURE__ */ h(
    Select,
    {
      value: cur,
      width: 280,
      options: [{ value: "", label: "跟随 DSH 默认", desc: "和你在 DSH 里平时用的一样" }].concat((list || []).map((m) => ({ value: key(m), label: labelOf(m), desc: m.provider, group: m.provider }))),
      onChange: (v) => {
        const [p, ...m] = v.split("::");
        setDraft(setPath(setPath(draft, "model.provider", v ? p : ""), "model.model", v ? m.join("::") : ""));
      }
    }
  ), cur ? /* @__PURE__ */ h(Btn, { small: true, onClick: () => test({ provider: draft.model.provider, model: draft.model.model }) }, "测速") : null, cur && ping[cur] ? /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, ping[cur]) : null), /* @__PURE__ */ h(Row, { label: "思考强度", hint: noReasoning ? "这个模型不支持思考强度，会自动忽略" : "聊天建议「低」，回得快" }, /* @__PURE__ */ h(Seg, { value: draft.model.reasoningEffort || "low", disabled: noReasoning, onChange: (v) => setDraft(setPath(draft, "model.reasoningEffort", v)), options: [{ value: "low", label: "低" }, { value: "high", label: "高" }, { value: "max", label: "最高" }] }))), /* @__PURE__ */ h(
    Card,
    {
      title: "看图",
      desc: "收到图片时怎么处理：直接把图给模型、先让另一个模型转成文字、还是只给一行提示。",
      more: "辅助看图是给「主模型看不了图」准备的：先让一个能看图的模型瞄一眼、写成文字，再交给主模型。主模型自己能看图时不走这条，不额外花钱。"
    },
    /* @__PURE__ */ h(Row, { label: "视觉能力", hint: visionHint }, /* @__PURE__ */ h(
      Seg,
      {
        value: draft.model.vision || "auto",
        onChange: (v) => setDraft(setPath(draft, "model.vision", v)),
        options: [{ value: "auto", label: "自动" }, { value: "on", label: "支持" }, { value: "off", label: "不支持" }]
      }
    )),
    /* @__PURE__ */ h(Row, { label: "辅助看图模型", hint: "主模型看不了图时，先让这个模型看一眼、转成文字再交给主模型。" }, /* @__PURE__ */ h(Switch, { on: !!draft.visionHelper.enabled, onChange: (v) => setDraft(setPath(draft, "visionHelper.enabled", v)) })),
    draft.visionHelper.enabled ? /* @__PURE__ */ h(Row, { label: "用哪个模型看图" }, /* @__PURE__ */ h(
      Select,
      {
        value: draft.visionHelper.provider && draft.visionHelper.model ? draft.visionHelper.provider + "::" + draft.visionHelper.model : "",
        width: 280,
        options: [{ value: "", label: "选一个能看图的模型", desc: "要和聊天用的模型不同" }].concat((list || []).map((m) => ({ value: key(m), label: labelOf(m), desc: m.provider, group: m.provider }))),
        onChange: (v) => {
          const [p, ...m] = v.split("::");
          setDraft(setPath(setPath(draft, "visionHelper.provider", v ? p : ""), "visionHelper.model", v ? m.join("::") : ""));
        }
      }
    )) : null
  ), /* @__PURE__ */ h(ChatModels, { draft, setDraft, list }), /* @__PURE__ */ h(Card, { collapse: true, title: "可用的模型", desc: "DSH 里现在能选的模型。点「测速」会真的问一次（花一点点额度），「用这个」把它填到上面的全局模型。" }, list === null ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : list.length === 0 ? /* @__PURE__ */ h(Empty, { text: "DSH 没有列出模型" }) : /* @__PURE__ */ h("table", { className: "ab-table" }, /* @__PURE__ */ h("tbody", null, list.map((m) => /* @__PURE__ */ h("tr", { key: key(m) }, /* @__PURE__ */ h("td", null, labelOf(m)), /* @__PURE__ */ h("td", { className: "ab-muted" }, m.provider), /* @__PURE__ */ h("td", null, ping[key(m)] || ""), /* @__PURE__ */ h("td", { style: { textAlign: "right" } }, /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => test(m) }, "测速"), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => {
    setDraft(setPath(setPath(draft, "model.provider", m.provider), "model.model", m.model));
    toast("选好了，记得保存");
  } }, "用这个"))))))), /* @__PURE__ */ h(Card, { collapse: true, title: "应用到现有会话", desc: "这里的模型设置默认要等对方发下一条消息才生效（冷群可能几小时都不动）。点这里立刻把所有已有 QQ 会话切过去——保存设置之后点。" }, /* @__PURE__ */ h(
    Btn,
    {
      small: true,
      disabled: applying,
      onClick: async () => {
        setApplying(true);
        try {
          const r = await post("/models/apply", {});
          toast(r?.ok ? r.message || "切好了" : r?.message || "没切成", r?.ok ? "ok" : "err");
        } finally {
          setApplying(false);
        }
      }
    },
    applying ? "切着呢…" : "立刻应用到所有会话"
  ), /* @__PURE__ */ h("div", { className: "ab-small ab-muted", style: { marginTop: 8 } }, "只改这个插件管的 QQ 会话，不动你在 DSH 里其他对话的模型。")));
}

// client/src/views/token.js
var ITEMS = [
  { id: "token-billing", name: "Token 记账", desc: "今天烧了多少、还剩多少、每个会话分到多少；预算在这里改，烧完只熔断主动开口" },
  { id: "token-guardian", name: "预算守门员", desc: "某个会话上下文涨太多时提前压缩历史，省下重复读取的钱" },
  { id: "complete-guard", name: "话说完没", desc: "回复停在「因为」「1.」这种半截上时，提醒她把话说完" }
];
function Token({ st }) {
  const mods = st.modules || [];
  const running = (id) => mods.some((m) => m.id === id && m.running);
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(
    Card,
    {
      title: "Token 用量与守卫",
      desc: "这一页管三件事：今天花了多少 Token、上下文什么时候压缩、回复被截断时怎么补。三件事都在下面各自的卡里改，改完点「保存设置」。",
      more: "说清楚一件事：每日预算烧完，只会熔断「她主动开口」（主动搭话 / 目的引擎），你正常问她不受影响；跨日自动恢复。模块开关在「系统 → 扩展」，这里只给设置。"
    },
    /* @__PURE__ */ h("div", { className: "ab-list" }, ITEMS.map((it) => /* @__PURE__ */ h("div", { key: it.id, className: "ab-li" }, /* @__PURE__ */ h("div", { className: "meta" }, /* @__PURE__ */ h("b", null, it.name)), /* @__PURE__ */ h("div", { className: "body" }, /* @__PURE__ */ h("div", { className: "ab-small" }, it.desc)), /* @__PURE__ */ h("span", { className: cx("ab-badge", !running(it.id) && "dim") }, running(it.id) ? "在跑" : "没在跑"))))
  ));
}

// client/src/views/voice.js
function Voice({ st, draft, setDraft, toast, reload }) {
  const f = useField(draft, setDraft);
  const [txt, setTxt] = useState("晚安啦，今天也辛苦了，明天见～");
  const [src, setSrc] = useState("");
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(
    Card,
    {
      title: "说话（文字转语音）",
      right: f.sw("voice.enabled"),
      desc: "回复里写了 <voice>…</voice> 的部分会变成 QQ 语音条；对方明确要语音时一定发语音；短回复也有一定概率整条变语音。"
    },
    /* @__PURE__ */ h("div", { style: { margin: "4px 0 12px" } }, f.choices("voice.engine", [
      { value: "auto", label: "自动", desc: "edge-tts 优先，不行用 Windows 语音" },
      { value: "edge", label: "微软 edge-tts", desc: st.voice.edgeInstalled ? "在线，音色自然（已装好）" : "在线，音色自然（还没装）" },
      { value: "cosyvoice", label: "本地 CosyVoice", desc: "自己部署的 CosyVoice 服务，可克隆音色" },
      { value: "gptsovits", label: "本地 GPT-SoVITS", desc: "GPT-SoVITS api_v2，用参考音频定音色" },
      { value: "doubao", label: "豆包语音 2.0", desc: "火山引擎豆包 TTS，支持声音复刻 2.0 与自动配语气" },
      { value: "qwentts", label: "阿里百炼 qwen-tts", desc: "DashScope 语音合成，支持语气指令与长文本分段" },
      { value: "mimo", label: "小米 MiMo TTS", desc: "参考音频零训练克隆音色" },
      { value: "http", label: "其他 HTTP 接口", desc: "任意返回音频的地址" },
      { value: "windows", label: "Windows 自带", desc: "离线可用，机械感重一些" }
    ])),
    ["auto", "edge"].includes(draft.voice.engine) ? /* @__PURE__ */ h(Fragment, null, !st.voice.edgeInstalled ? /* @__PURE__ */ h(Row, { label: "edge-tts", hint: "装在插件自己的 Python 环境里，不影响系统" }, /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
      toast("正在安装，可能要一两分钟…");
      const r = await post("/voice/install");
      toast(r.message);
      reload();
    } }, "安装 edge-tts")) : null, /* @__PURE__ */ h(Row, { label: "音色" }, f.select("voice.voice", [
      { value: "zh-CN-XiaoyiNeural", label: "晓伊", desc: "活泼女声", group: "普通话" },
      { value: "zh-CN-XiaoxiaoNeural", label: "晓晓", desc: "温柔女声", group: "普通话" },
      { value: "zh-CN-YunxiNeural", label: "云希", desc: "少年男声", group: "普通话" },
      { value: "zh-CN-liaoning-XiaobeiNeural", label: "晓北", desc: "东北女声", group: "方言" },
      { value: "zh-CN-shaanxi-XiaoniNeural", label: "晓妮", desc: "陕西女声", group: "方言" },
      { value: "zh-TW-HsiaoChenNeural", label: "曉臻", desc: "台湾女声", group: "方言" }
    ], { width: 220 })), /* @__PURE__ */ h(Row, { label: "语速" }, f.select("voice.rate", [
      { value: "-20%", label: "慢一点" },
      { value: "-10%", label: "稍慢" },
      { value: "+0%", label: "正常" },
      { value: "+10%", label: "稍快" },
      { value: "+20%", label: "快一点" }
    ], { width: 140 })), /* @__PURE__ */ h(Row, { label: "音调", hint: "±80Hz 为上限（再往上 edge-tts 服务端会静默夹住）；只对 edge-tts 有效" }, /* @__PURE__ */ h(
      Range,
      {
        min: -80,
        max: 80,
        step: 10,
        value: pitchNum(draft.voice.pitch),
        fmt: pitchLabel,
        onChange: (v) => setDraft(setPath(draft, "voice.pitch", pitchText(v)))
      }
    ))) : null,
    draft.voice.engine === "cosyvoice" ? /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h(Row, { label: "服务地址", hint: "CosyVoice 自带 runtime/python/fastapi/server.py" }, f.text("voice.cosyvoice.url", { size: "wide", placeholder: "http://127.0.0.1:50000" })), /* @__PURE__ */ h(Row, { label: "模式" }, f.select("voice.cosyvoice.mode", [{ value: "sft", label: "预置音色（sft）" }, { value: "instruct", label: "带语气指令（instruct）" }], { width: 220 })), /* @__PURE__ */ h(Row, { label: "音色 ID", hint: "例如 中文女、中文男" }, f.text("voice.cosyvoice.spkId")), draft.voice.cosyvoice.mode === "instruct" ? /* @__PURE__ */ h(Row, { label: "语气指令", hint: "例如：用甜美撒娇的语气说" }, f.text("voice.cosyvoice.instruct", { size: "wide" })) : null, /* @__PURE__ */ h(Row, { label: "采样率", hint: "CosyVoice 1 是 22050，CosyVoice 2 是 24000" }, f.select("voice.cosyvoice.sampleRate", [{ value: 22050, label: "22050 Hz" }, { value: 24e3, label: "24000 Hz" }], { width: 160 }))) : null,
    draft.voice.engine === "gptsovits" ? /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h(Row, { label: "服务地址", hint: "GPT-SoVITS 的 api_v2.py" }, f.text("voice.gptsovits.url", { size: "wide", placeholder: "http://127.0.0.1:9880" })), /* @__PURE__ */ h(Row, { label: "参考音频路径", hint: "服务那台电脑上的路径" }, f.text("voice.gptsovits.refAudio", { size: "wide" })), /* @__PURE__ */ h(Row, { label: "参考音频的文字" }, f.text("voice.gptsovits.promptText", { size: "wide" }))) : null,
    draft.voice.engine === "doubao" ? /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h(Row, { label: "API Key", hint: "火山引擎「豆包语音」控制台创建，请求头 X-Api-Key；只存本机，不会显示出来" }, f.text("voice.doubao.apiKey", { type: "password", placeholder: draft.voice.doubao.apiKeySet ? "已保存（不改就留空）" : "还没有填" })), /* @__PURE__ */ h(Row, { label: "资源 ID", hint: "复刻音色只能用 seed-icl-2.0，用错会报 55000000" }, f.select("voice.doubao.resourceId", [{ value: "seed-icl-2.0", label: "声音复刻 2.0" }, { value: "seed-tts-2.0", label: "预置音色 2.0" }], { width: 200 })), /* @__PURE__ */ h(Row, { label: "音色 Speaker", hint: "复刻音色 ID；预置 2.0 音色以 _uranus_bigtts 结尾" }, f.text("voice.doubao.speaker", { size: "wide", placeholder: "S_1CmxEOek2" })), /* @__PURE__ */ h(Row, { label: "固定语气指令", hint: "一行一条，例如「用温柔、放慢一点的语气说这句话」；留空不加" }, f.area("voice.doubao.contextTexts", { rows: 3 })), /* @__PURE__ */ h(Row, { label: "按文字自动配语气", hint: "按关键词自动追加语气指令（开心/生气/撒娇…），不参与计费" }, f.sw("voice.doubao.autoEmotion")), /* @__PURE__ */ h(Row, { label: "语速", hint: "-50~100，默认 0；觉得快就调 -10 到 -20" }, f.text("voice.doubao.speechRate", { size: "narrow" }))) : null,
    draft.voice.engine === "qwentts" ? /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h(Row, { label: "API Key", hint: "阿里云百炼（DashScope）创建；只存本机，不会显示出来" }, f.text("voice.qwentts.apiKey", { type: "password", placeholder: draft.voice.qwentts.apiKeySet ? "已保存（不改就留空）" : "sk-…" })), /* @__PURE__ */ h(Row, { label: "接口地址", hint: "只填到域名，路径自动拼" }, f.text("voice.qwentts.baseUrl", { size: "wide", placeholder: "https://dashscope.aliyuncs.com" })), /* @__PURE__ */ h(Row, { label: "模型", hint: "百炼语音模型名" }, f.text("voice.qwentts.model", { placeholder: "qwen-audio-3.1-tts-flash" })), /* @__PURE__ */ h(Row, { label: "音色", hint: "官方中文女声兜底是 Cherry" }, f.text("voice.qwentts.voice", { placeholder: "Cherry" })), /* @__PURE__ */ h(Row, { label: "语气基底", hint: "每次合成都带上；正文里的【撒娇】【吐槽】等标记会转成临时语气指令" }, f.area("voice.qwentts.instruction", { rows: 2 })), /* @__PURE__ */ h(Row, { label: "分段上限", hint: "长文本按句末标点切成不超过这个字数的分段，逐段合成后拼成一条" }, f.text("voice.qwentts.maxCharsPerSegment", { size: "narrow" })), /* @__PURE__ */ h(Row, { label: "采样率" }, f.select("voice.qwentts.sampleRate", [{ value: 24e3, label: "24000 Hz" }, { value: 22050, label: "22050 Hz" }, { value: 16e3, label: "16000 Hz" }], { width: 160 }))) : null,
    draft.voice.engine === "mimo" ? /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h(Row, { label: "API Key", hint: "小米 MiMo 开放平台创建，sk- 开头；只存本机，不会显示出来" }, f.text("voice.mimo.apiKey", { type: "password", placeholder: draft.voice.mimo.apiKeySet ? "已保存（不改就留空）" : "sk-…" })), /* @__PURE__ */ h(Row, { label: "API 地址", hint: "一般不用改，要以 /v1 结尾" }, f.text("voice.mimo.apiBase", { size: "wide", placeholder: "https://api.xiaomimimo.com/v1" })), /* @__PURE__ */ h(Row, { label: "模型", hint: "voiceclone 用参考音频克隆；voicedesign 用下面的风格描述" }, f.text("voice.mimo.model", { placeholder: "mimo-v2.5-tts-voiceclone" })), /* @__PURE__ */ h(Row, { label: "参考音频路径", hint: "这台电脑上的一段 mp3/wav（几秒到几十秒都行）；voicedesign 模型不需要" }, f.text("voice.mimo.refAudio", { size: "wide" })), /* @__PURE__ */ h(Row, { label: "风格描述", hint: "例如：元气一点的少女音，语速稍快" }, f.text("voice.mimo.stylePrompt", { size: "wide" })), /* @__PURE__ */ h(Row, { label: "种子文本", hint: "参考音频里说的那句话（复刻模型可选，能更像）" }, f.text("voice.mimo.seedText", { size: "wide" })), /* @__PURE__ */ h(Row, { label: "超时（秒）", hint: "MiMo 生成较慢，默认 180" }, f.text("voice.mimo.timeout", { size: "narrow" }))) : null,
    draft.voice.engine === "http" ? /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h(Row, { label: "请求方式", hint: "GET 把 {text} 拼进地址；POST 配请求头和请求体（可接火山豆包等云 TTS）" }, f.select("voice.http.method", [{ value: "GET", label: "GET" }, { value: "POST", label: "POST" }], { width: 120 }), /* @__PURE__ */ h(Btn, { small: true, onClick: () => {
      let d = setPath(draft, "voice.http.urlTemplate", "https://openspeech.bytedance.com/api/v1/tts");
      d = setPath(d, "voice.http.method", "POST");
      d = setPath(d, "voice.http.headers", "Authorization: Bearer;TOKEN_HERE");
      d = setPath(d, "voice.http.body", '{"app":{"appid":"APPID_HERE","token":"TOKEN_HERE","cluster":"volcano_tts"},"user":{"uid":"dsh-qq-hub"},"audio":{"voice_type":"VOICE_TYPE_HERE","encoding":"mp3","speed_ratio":1.0},"request":{"reqid":"{reqid}","text":"{text}","operation":"query"}}');
      setDraft(d);
      toast("已填入豆包模板：把 APPID_HERE / TOKEN_HERE / VOICE_TYPE_HERE 换成你在火山引擎开通的值，保存后试听");
    } }, "豆包预设")), /* @__PURE__ */ h(Row, { label: "地址模板", hint: draft.voice.http.method === "POST" ? "POST 时 {text} 放请求体里；返回音频或含 base64 音频的 JSON" : "{text} 会换成要念的话，返回 wav/mp3" }, f.text("voice.http.urlTemplate", { size: "wide", placeholder: "http://127.0.0.1:8000/tts?text={text}" })), draft.voice.http.method === "POST" ? /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h(Row, { label: "请求头", hint: "一行一个 Key: Value，# 开头是注释；不填 Content-Type 自动按 JSON。含凭据，保存后面板不再回显原文（留空保存保留原值，整段重填则覆盖）；要看原文去 config.json" }, f.area("voice.http.headers", { rows: 3, placeholder: "Authorization: Bearer;你的token（重新粘贴整段即可替换）" })), /* @__PURE__ */ h(Row, { label: "请求体", hint: "{text} 自动 JSON 转义；{text_raw} 不转义（表单用）；{reqid} 每次换新 UUID" }, f.area("voice.http.body", { rows: 5, placeholder: '{"request":{"reqid":"{reqid}","text":"{text}"}}（同请求头：保存后不回显，留空保留原值）' }))) : null) : null,
    /* @__PURE__ */ h(Row, { label: "短回复变语音的概率" }, f.percent("voice.autoChance")),
    /* @__PURE__ */ h(Row, { label: "多短算短回复" }, f.range("voice.autoMaxChars", 10, 200, 5, (v) => v + " 字")),
    /* @__PURE__ */ h(Row, { label: "试听", hint: "先保存设置再试听" }, /* @__PURE__ */ h("input", { className: "ab-input", value: txt, onChange: (e) => setTxt(e.target.value) }), /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
      const r = await post("/voice/test", { text: txt });
      if (r.ok) setSrc("data:" + r.mime + ";base64," + r.data);
      else toast(r.message);
    } }, "生成"), src ? /* @__PURE__ */ h("audio", { src, controls: true, autoPlay: true, style: { height: 32 } }) : null)
  ), /* @__PURE__ */ h(
    Card,
    {
      title: "听语音（语音转文字）",
      right: f.sw("voice.asr"),
      desc: "别人发来的语音会先转成文字再交给她：优先用 QQ 自带的转文字，不行再用 DSH 自带的语音识别（要在 DSH「插件」里开启「语音输入」）。"
    },
    /* @__PURE__ */ h(AsrStatus, { toast })
  ));
}
function AsrStatus({ toast }) {
  const [s, setS] = useState(null);
  const load = () => get("/voice/asr-status").then(setS);
  useEffect(() => {
    load();
    const t = setInterval(load, 5e3);
    return () => clearInterval(t);
  }, []);
  const phase = s && s.enabled ? { ready: "已就绪", standby: "已就绪（休眠中）", idle: "还没下载模型", preparing: "正在下载模型…", downloading: "正在下载模型…", failed: "下载失败" }[s.phase] || s.phase : null;
  const ready = s && s.enabled && ["ready", "standby"].includes(s.phase);
  return /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h("span", { className: cx("ab-pill", ready ? "ok" : s && s.enabled ? "warn" : "") }, /* @__PURE__ */ h("i", { className: cx("ab-dot", ready ? "ok" : s && s.enabled ? "warn" : "") }), s === null ? "查询中…" : s.enabled ? "DSH 识别：" + phase : "DSH 识别：没开启（DSH「插件」→「语音输入」）"), s && s.enabled && !ready ? /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
    const r = await post("/voice/asr-prepare");
    toast(r.message);
    load();
  } }, "下载识别模型") : null, ready ? /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
    toast("正在测试…");
    const r = await post("/voice/asr-test", { text: "今天想吃白米饭" });
    toast(r.ok ? "念的是「" + r.said + "」，听成了「" + r.heard + "」" : r.message);
  } }, "测试一下") : null);
}

// client/src/views/stickers.js
function Stickers({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  const [items, setItems] = useState(null);
  const fileRef = useRef(null);
  const load = () => get("/stickers").then((r) => setItems(r.items || []));
  useEffect(() => {
    load();
  }, []);
  const [newName, setNewName] = useState("");
  const upload = async (files) => {
    const list = [...files || []];
    if (!list.length) return;
    let ok = 0;
    const errs = [];
    for (const file of list) {
      if (file.size > 5 * 1024 * 1024) {
        errs.push(file.name + " 超过 5MB");
        continue;
      }
      try {
        const data = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = () => rej(new Error("读不了这个文件"));
          fr.readAsDataURL(file);
        });
        const r = await post("/sticker/upload", { data, name: list.length === 1 ? newName.trim().slice(0, 12) : "" });
        if (r.ok) ok++;
        else errs.push(file.name + "：" + (r.reason || r.message || "没加成功"));
      } catch (e) {
        errs.push(file.name + "：" + e.message);
      }
    }
    setNewName("");
    toast(errs.length ? (ok ? `加好 ${ok} 张；` : "") + errs.join("；") : `加好了 ${ok} 张`, errs.length ? "err" : "ok");
    load();
  };
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(
    Card,
    {
      title: "表情包",
      right: f.sw("stickers.enabled"),
      desc: "回复里写 <sticker:名字> 就会发对应的表情；也会按概率自动配一张。"
    },
    /* @__PURE__ */ h(Row, { label: "自动配表情的概率" }, f.percent("stickers.autoChance")),
    /* @__PURE__ */ h(Row, { label: "夹 QQ 小黄脸", hint: "回复里能夹 QQ 自带的系统表情（/捂脸 /斜眼笑 这种），和文字在同一条消息里" }, f.sw("stickers.faces")),
    /* @__PURE__ */ h(Row, { label: "偷表情", hint: "别人发的表情包会被收藏（普通照片不收）。关掉就完全不收。" }, f.sw("stickers.collect")),
    draft.stickers.collect !== false ? /* @__PURE__ */ h(Row, { label: "从哪收", hint: "两个都关等于不偷，只留一个就只从那边收。" }, /* @__PURE__ */ h("span", { className: "ab-muted" }, "群聊"), f.sw("stickers.fromGroups"), /* @__PURE__ */ h("span", { className: "ab-muted", style: { marginLeft: 16 } }, "私聊"), f.sw("stickers.fromPrivate")) : null,
    draft.stickers.collect !== false ? /* @__PURE__ */ h(Row, { label: "怎么偷", hint: "「她挑」只递给她看，喜欢才收；「只听主人的」只在主人私聊 / 这一轮只有主人时她才可自己收，有别人在场要主人发话" }, f.choices("stickers.collectMode", [
      { value: "auto", label: "全都偷", desc: "看到就收，不用她同意（默认）" },
      { value: "ask", label: "她挑", desc: "先记着，给她一句轻提示，喜欢才凭编号收" },
      { value: "owner", label: "只听主人的", desc: "只有主人私聊 / 只有主人时她才可自己收；别人在场要主人发话" }
    ])) : null,
    /* @__PURE__ */ h(Row, { label: "每小时最多收" }, f.num("stickers.maxPerHour", { min: 0, fallback: 20 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "张")),
    /* @__PURE__ */ h(Row, { label: "表情库最多存", hint: "QQ 收藏表情有数量上限，满了就收不进去了。超过这个数会自动清掉最少用的偷来的表情（你自己加的不会动）" }, f.num("stickers.maxLibrary", { min: 20, max: 2e3, fallback: 300 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "张")),
    /* @__PURE__ */ h(Row, { label: "看图起名", hint: "收下后让模型看图起个 12 字以内的备注" }, f.sw("stickers.caption"))
  ), /* @__PURE__ */ h(
    Card,
    {
      title: "表情库" + (items ? "（" + items.length + " 张）" : ""),
      right: /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h("input", { ref: fileRef, type: "file", accept: "image/*", multiple: true, style: { display: "none" }, onChange: (e) => {
        upload(e.target.files);
        e.target.value = "";
      } }), /* @__PURE__ */ h("input", { className: "ab-input sm", style: { width: 140 }, placeholder: "名字（可不填）", value: newName, onChange: (e) => setNewName(e.target.value) }), /* @__PURE__ */ h(Btn, { small: true, onClick: () => fileRef.current && fileRef.current.click() }, "＋ 上传"), /* @__PURE__ */ h(Btn, { small: true, title: "把机器人号 QQ「我喜欢的」里已有的表情导进来", onClick: async () => {
        toast("正在从 QQ 收藏导入…");
        const r = await post("/sticker/import-qq");
        toast(r.message, r.ok === false ? "err" : "ok");
        load();
      } }, "从 QQ 收藏导入"), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: load }, "刷新"))
    },
    items === null ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : items.length === 0 ? /* @__PURE__ */ h(Empty, { icon: "🐳", text: "表情库还是空的。别人发表情包她会自己收；也可以上传，或从 QQ 收藏导入。" }) : /* @__PURE__ */ h("div", { className: "ab-stickers" }, items.map((it) => /* @__PURE__ */ h(StickerCell, { key: it.md5, it, onChanged: load, toast })))
  ));
}
function StickerCell({ it, onChanged, toast }) {
  const [name, setName] = useState(it.name || "");
  const tagText = (it.tags || []).join(" ");
  const [tags, setTags] = useState(tagText);
  const save = async (body, label) => {
    const r = await post("/sticker/rename", { md5: it.md5, ...body });
    toast(r.ok ? label + "改好了" : "没改成：" + (r.message || "找不到这张表情"), r.ok ? "ok" : "err");
    if (r.ok) onChanged();
  };
  return /* @__PURE__ */ h("div", { className: "ab-sticker" }, /* @__PURE__ */ h("img", { src: API + "/sticker/image?md5=" + it.md5, alt: it.name || "表情", loading: "lazy" }), /* @__PURE__ */ h(
    "input",
    {
      className: "nm",
      value: name,
      placeholder: "未命名（点这里改）",
      title: "名字 / 备注，最多 12 字",
      maxLength: 12,
      onChange: (e) => setName(e.target.value),
      onBlur: () => {
        if (name !== (it.name || "")) save({ name }, "名字");
      }
    }
  ), /* @__PURE__ */ h(
    "input",
    {
      className: "tg",
      value: tags,
      placeholder: "加标签，空格隔开",
      title: "标签，空格或逗号隔开，最多 5 个",
      onChange: (e) => setTags(e.target.value),
      onBlur: () => {
        if (tags.trim() !== tagText) save({ tags: tags.split(/[\s,，、#]+/).map((x) => x.trim()).filter(Boolean).slice(0, 5) }, "标签");
      }
    }
  ), /* @__PURE__ */ h(
    "button",
    {
      type: "button",
      className: "ab-btn sm danger x",
      title: "删除",
      onClick: async () => {
        if (!confirm("删掉这张表情？（QQ 收藏里也会删）")) return;
        await post("/sticker/delete", { md5: it.md5 });
        onChanged();
      }
    },
    "✕"
  ));
}

// client/src/views/diary.js
var AUDIENCE_OPTIONS = [
  { value: "all", label: "所有人可见" },
  { value: "friends", label: "好友可见" },
  { value: "selected", label: "部分好友可见" },
  { value: "excluded", label: "部分好友不可见" },
  { value: "self", label: "仅自己可见" }
];
var AUDIENCE_LABEL = Object.fromEntries(AUDIENCE_OPTIONS.map((o) => [o.value, o.label]));
function DiarySources({ draft, setDraft }) {
  const picked = new Set((draft.diary.includeChats || []).map(String));
  const [known, setKnown] = useState(null);
  useEffect(() => {
    get("/panel/chats").then((r) => {
      if (r.ok) setKnown(r.chats || []);
    }).catch(() => setKnown([]));
  }, []);
  const nameOf = (cid) => {
    const hit = (known || []).find((c) => String(c.chatId) === cid);
    if (!hit) return cid;
    const raw = String(hit.name || "").replace(/^QQ 群 · /, "");
    return raw && raw !== hit.id ? `${raw}（${cid}）` : cid;
  };
  const candidates = Array.from(/* @__PURE__ */ new Set([
    ...(draft.allow.groups || []).map((g) => `group:${g}`),
    ...(known || []).map((c) => String(c.chatId)),
    ...picked
  ])).sort();
  const toggle = (cid) => {
    const next = new Set(picked);
    if (next.has(cid)) next.delete(cid);
    else next.add(cid);
    setDraft(setPath(draft, "diary.includeChats", Array.from(next)));
  };
  return /* @__PURE__ */ h(
    Row,
    {
      label: "素材来源",
      hint: "勾选哪些聊天的内容可以进日记素材。不勾选 = 日记只写她自己的事（今天画了什么、在想什么），不引用任何聊天记录。配图同理：她自己画的永远可用，别人会话里收的表情要在对应聊天勾选后才会被配上。"
    },
    candidates.length ? /* @__PURE__ */ h("div", { className: "ab-flex", style: { flexWrap: "wrap" } }, candidates.map((cid) => /* @__PURE__ */ h("button", { key: cid, type: "button", className: cx("ab-chip", picked.has(cid) && "on"), onClick: () => toggle(cid) }, (picked.has(cid) ? "✓ " : "") + nameOf(cid)))) : /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "还没有聊过天的会话；先在「权限」页把群加进白名单。"),
    picked.size === 0 ? /* @__PURE__ */ h("div", { className: "ab-note ab-small", style: { marginTop: 6 } }, "当前不引用任何聊天：日记只写她自己的事。") : null
  );
}
function DiaryAudience({ draft, setDraft, toast }) {
  const mode = draft.diary.visibility;
  const partial = mode === "selected" || mode === "excluded";
  const [friends, setFriends] = useState(null);
  const [query, setQuery] = useState("");
  const qqText = draft.diary.audienceQQs || "";
  const selected = Array.from(new Set(String(qqText).split(/[\s,，;；]+/).filter(Boolean)));
  const setList = (list) => setDraft(setPath(draft, "diary.audienceQQs", Array.from(new Set(list)).join("\n")));
  const toggle = (qq) => setList(selected.includes(qq) ? selected.filter((q) => q !== qq) : [...selected, qq]);
  return /* @__PURE__ */ h("div", null, /* @__PURE__ */ h(Row, { label: "谁能看", hint: "和 QQ 空间的可见范围一致" }, /* @__PURE__ */ h(Select, { value: mode, options: AUDIENCE_OPTIONS, width: 170, onChange: (v) => setDraft(setPath(draft, "diary.visibility", v)) })), partial ? /* @__PURE__ */ h("div", { style: { marginTop: 10 } }, /* @__PURE__ */ h("div", { className: "ab-flex", style: { gap: 8, marginBottom: 8 } }, /* @__PURE__ */ h(
    Btn,
    {
      small: true,
      kind: "ghost",
      onClick: async () => {
        try {
          const r = await get("/diary/friends");
          if (!r.ok) return toast(r.message || "读取好友失败");
          setFriends(r.friends);
        } catch (e) {
          toast(e.message);
        }
      }
    },
    "从好友列表选择"
  ), /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "已选 ", selected.length, " 人，只对之后发的说说生效")), friends ? /* @__PURE__ */ h("div", { style: { marginBottom: 8 } }, /* @__PURE__ */ h("input", { className: "ab-input", placeholder: "搜索昵称或 QQ 号", value: query, onChange: (e) => setQuery(e.target.value) }), /* @__PURE__ */ h("div", { style: { maxHeight: 220, overflow: "auto", marginTop: 6 } }, friends.filter((f) => (f.name + f.qq).toLowerCase().includes(query.toLowerCase())).map((f) => /* @__PURE__ */ h("label", { key: f.qq, style: { display: "block", padding: "4px 2px" } }, /* @__PURE__ */ h("input", { type: "checkbox", checked: selected.includes(f.qq), onChange: () => toggle(f.qq) }), " " + (f.name || "（无备注）") + "（" + f.qq + "）")))) : null, /* @__PURE__ */ h(
    "textarea",
    {
      className: "ab-textarea",
      style: { minHeight: 64 },
      placeholder: "也可以直接填 QQ 号，一行一个",
      value: qqText,
      onChange: (e) => setDraft(setPath(draft, "diary.audienceQQs", e.target.value))
    }
  ), /* @__PURE__ */ h("div", { className: "ab-small ab-muted", style: { marginTop: 6 } }, mode === "selected" ? "名单为空时不会发布，也不会退回公开。" : "这些好友看不到之后的说说。")) : null);
}
function Diary({ st, draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  const [data, setData] = useState(null);
  const on = modOn(st, "diary");
  const load = () => on ? get("/diary/history").then((r) => {
    setData(r);
    if (r.warning) toast(r.warning);
  }).catch((e) => toast("日记状态刷新失败：" + e.message)) : null;
  useEffect(() => {
    load();
  }, [on]);
  const social = modOn(st, "qzone-social") ? /* @__PURE__ */ h(QzoneSocial, { draft, setDraft, toast }) : /* @__PURE__ */ h(ModOff, { name: "空间互动" });
  if (!on) return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(ModOff, { name: "空间日记" }), social);
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(
    Card,
    {
      title: "空间日记",
      right: f.sw("diary.enabled"),
      desc: "她每天会在 QQ 空间发几条说说，结合当天聊过的事，用自己的口吻写。写日记那一轮不会发到聊天里。"
    },
    /* @__PURE__ */ h(Row, { label: "每天写几次" }, f.num("diary.timesPerDay", { min: 0, max: 6, fallback: 2 })),
    /* @__PURE__ */ h(Row, { label: "时间段", hint: "在这段时间里随机挑时间" }, f.text("diary.windowStart", { size: "sm" }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "到"), f.text("diary.windowEnd", { size: "sm" })),
    /* @__PURE__ */ h(Row, { label: "两篇至少隔" }, f.num("diary.minGapMinutes", { min: 0, fallback: 180 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "分钟")),
    /* @__PURE__ */ h(Row, { label: "字数" }, f.num("diary.minChars", { min: 10, fallback: 60 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "到"), f.num("diary.maxChars", { min: 20, fallback: 140 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "字")),
    /* @__PURE__ */ h(Row, { label: "日记配图", hint: "开着时每篇会从「今天她画的图 / 今天收的表情包」里挑一张配上去；没有合适的就只发文字" }, f.sw("diary.attachImage")),
    /* @__PURE__ */ h(DiarySources, { draft, setDraft }),
    /* @__PURE__ */ h(DiaryAudience, { draft, setDraft, toast })
  ), /* @__PURE__ */ h(
    Card,
    {
      title: "写过的日记",
      right: /* @__PURE__ */ h("div", { className: "ab-flex" }, data && data.next ? /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "下一篇大约 ", data.next) : null, /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", title: "刷新空间状态", onClick: load }, /* @__PURE__ */ h("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", "aria-hidden": "true" }, /* @__PURE__ */ h("path", { d: "M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" }))), /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: async () => {
        toast("她在写了…");
        try {
          const r = await post("/diary/run", {});
          toast(r.ok ? r.dryRun ? "写好了（试运行，没真发）" : "发出去了" : r.message);
        } catch (e) {
          toast(e.message);
        } finally {
          await load();
        }
      } }, "现在写一篇"))
    },
    !data ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : !data.items || data.items.length === 0 ? /* @__PURE__ */ h(Empty, { icon: "📔", text: "还没写过日记。" }) : /* @__PURE__ */ h("div", { className: "ab-list" }, data.items.map((d, i) => /* @__PURE__ */ h("div", { key: i, className: "ab-li" }, /* @__PURE__ */ h("div", { className: "meta" }, new Date(d.at).toLocaleString(), /* @__PURE__ */ h("br", null), d.deletedAt ? "已从空间删除" : d.dryRun ? "试运行" : d.ok ? AUDIENCE_LABEL[d.visibility] || "已发布" : "失败"), /* @__PURE__ */ h("div", { className: "body" }, d.text, d.error ? /* @__PURE__ */ h("div", { className: "ab-small", style: { color: "var(--ab-err)" } }, d.error) : null), d.tid && !d.deletedAt ? /* @__PURE__ */ h(
      Btn,
      {
        small: true,
        kind: "ghost",
        onClick: async () => {
          if (!confirm("从 QQ 空间删除这条说说？")) return;
          try {
            const r = await post("/qzone/delete", { tid: d.tid });
            toast(r.message);
          } catch (e) {
            toast(e.message);
          } finally {
            await load();
          }
        }
      },
      "从空间删除"
    ) : null)))
  ), social);
}
var SOCIAL_KIND = { reply: "回复评论", comment: "评论", like: "点赞" };
function QzoneSocial({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  const [s, setS] = useState(null);
  const load = () => get("/qzone/social/state").then(setS);
  useEffect(() => {
    load();
  }, []);
  return /* @__PURE__ */ h(
    Card,
    {
      title: "空间互动",
      right: f.sw("qzoneSocial.enabled"),
      desc: "她会定期逛 QQ 空间：有人评论她的说说就回一句；刷到好友的说说，偶尔点个赞、评一句（你的说说她更爱评）。评论按她的人格现写；试运行时只记日志不发。"
    },
    /* @__PURE__ */ h(Row, { label: "回复自己说说下的评论" }, f.sw("qzoneSocial.replyOwn")),
    /* @__PURE__ */ h(Row, { label: "评论好友的说说" }, f.sw("qzoneSocial.commentFriends")),
    /* @__PURE__ */ h(Row, { label: "顺手点赞" }, f.sw("qzoneSocial.like")),
    /* @__PURE__ */ h(Row, { label: "好友说说互动概率", hint: "每条说说只判断一次" }, f.percent("qzoneSocial.friendChance")),
    /* @__PURE__ */ h(Row, { label: "你的说说互动概率" }, f.percent("qzoneSocial.ownerChance")),
    /* @__PURE__ */ h(Row, { label: "每天最多评论", hint: "点赞不算" }, f.range("qzoneSocial.maxPerDay", 0, 30, 1, (v) => v + " 条")),
    /* @__PURE__ */ h(Row, { label: "多久逛一次", hint: "只在「主动搭话」里设的醒着时间内" }, f.range("qzoneSocial.intervalMin", 10, 240, 10, (v) => v + " 分钟")),
    /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 10 } }, /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, s ? "今天评论了 " + s.count + " 条" + (s.lastRun ? "，上次逛是 " + timeAgo(s.lastRun) : "") : ""), /* @__PURE__ */ h("div", { className: "ab-spacer" }), /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
      toast("她去逛空间了…");
      const r = await post("/qzone/social/run");
      toast(r.message, r.ok ? "ok" : "err");
      load();
    } }, "现在逛一次")),
    s && s.history && s.history.length ? /* @__PURE__ */ h("div", { className: "ab-list", style: { marginTop: 10 } }, s.history.map((x, i) => /* @__PURE__ */ h("div", { key: i, className: "ab-li" }, /* @__PURE__ */ h("div", { className: "meta" }, timeAgo(x.at), /* @__PURE__ */ h("br", null), SOCIAL_KIND[x.kind] || x.kind), /* @__PURE__ */ h("div", { className: "body" }, /* @__PURE__ */ h("b", null, x.who), x.post ? /* @__PURE__ */ h("span", { className: "ab-muted" }, " 的「", x.post, "」") : null, x.text ? /* @__PURE__ */ h("div", null, x.text) : null)))) : null
  );
}

// client/src/views/speakup.js
function SpeakUp({ st, draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(
    Card,
    {
      title: "主动搭话",
      right: f.sw("speakUp.enabled"),
      desc: "只在和你的私聊里：你一阵子没理她，她会主动来找你说一句——每次由头不一样（分享小事、接着上次的话题、想起你的事、按时间问候……），内容是她现想的，不是模板。群里不会这样。"
    },
    /* @__PURE__ */ h(Row, { label: "追问", hint: "她问了你一句、你 15~40 分钟没回，偶尔轻轻追一句（「人呢」之类），每句最多追一次" }, f.sw("speakUp.nudge")),
    /* @__PURE__ */ h(Row, { label: "多久没聊才找你" }, f.num("speakUp.idleMinutes", { min: 5, fallback: 40 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "分钟")),
    /* @__PURE__ */ h(Row, { label: "两次之间隔", hint: "在这个范围里随机" }, f.num("speakUp.minIntervalMinutes", { min: 5, fallback: 60 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "到"), f.num("speakUp.maxIntervalMinutes", { min: 5, fallback: 180 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "分钟")),
    /* @__PURE__ */ h(Row, { label: "每天最多" }, f.num("speakUp.maxPerDay", { min: 0, fallback: 4 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "次")),
    /* @__PURE__ */ h(Row, { label: "她醒着的时间", hint: "这段时间外不打扰你" }, f.num("speakUp.awakeFrom", { min: 0, max: 23, fallback: 8 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "点到"), f.num("speakUp.awakeTo", { min: 1, max: 24, fallback: 23 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "点")),
    /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 10 } }, /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "今天已经找过你 ", st.speakUp.count || 0, " 次"), /* @__PURE__ */ h("div", { className: "ab-spacer" }), /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
      const r = await post("/speakup/fire");
      toast(r.message);
    } }, "现在就让她来找我"))
  ));
}

// client/src/views/modules.js
function LocalApi({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState("");
  const [img, setImg] = useState("");
  const load = () => get("/local/status").then(setSt);
  useEffect(() => {
    load();
  }, []);
  const act = async (path, slot, label) => {
    setBusy(slot + label);
    const r = await post(path, { slot });
    setBusy("");
    toast(r.message, r.ok ? "ok" : "err");
    if (r.image) setImg(r.image);
    load();
  };
  const list = st && st.list || [];
  const taken = list.filter((x) => x.active).length;
  const failed2 = list.filter((x) => x.last && !x.last.ok).length;
  const missing = list.filter((x) => !x.exists).length;
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(
    Card,
    {
      title: "本地接口",
      desc: "用自己电脑上的模型或服务（本地语音、画图、识别）：生成脚本模板，照注释改，或者复制那段话让 DSH 帮你改。",
      more: "脚本放在插件数据目录的 local 文件夹里，插件升级不会覆盖；改完保存就生效，不用重启。每一项要打开开关才会用，出错时语音和识别会自动退回内置方式。"
    },
    /* @__PURE__ */ h("div", { className: "ab-pills" }, /* @__PURE__ */ h("span", { className: cx("ab-pill", taken && "ok") }, taken ? "本地接管 " + taken + " 项" : "全部走内置方式"), failed2 ? /* @__PURE__ */ h("span", { className: "ab-pill err" }, "出错 " + failed2 + " 项") : null, missing ? /* @__PURE__ */ h("span", { className: "ab-pill" }, "还没生成 " + missing + " 项") : null),
    /* @__PURE__ */ h("div", { className: "ab-dirrow", style: { marginTop: 10 } }, /* @__PURE__ */ h("code", { className: "ab-small", style: { flex: "1 1 220px", minWidth: 0, wordBreak: "break-all" } }, st ? st.dir : "…"), /* @__PURE__ */ h(Btn, { small: true, onClick: () => post("/local/open").then((r) => toast(r.message)) }, "打开文件夹"))
  ), !st ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : list.map((x) => /* @__PURE__ */ h(Card, { key: x.slot, title: x.title + "（" + x.file + "）", right: f.sw("local." + x.slot) }, /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginBottom: 8, flexWrap: "wrap" } }, /* @__PURE__ */ h("span", { className: "ab-small", style: { color: x.active ? "var(--ab-ok)" : "var(--ab-dim)" } }, x.active ? "● 正在由本地脚本接管" : !x.exists ? "还没有这个脚本" : !x.enabled ? "脚本已经有了，开关没开（用内置方式）" : "用内置方式"), x.last ? /* @__PURE__ */ h("span", { className: "ab-small", style: { color: x.last.ok ? "var(--ab-ok)" : "var(--ab-err)" } }, " · 上次", x.last.ok ? "成功，" + x.last.message : "出错：" + x.last.message) : null), /* @__PURE__ */ h("div", { className: "ab-flex", style: { flexWrap: "wrap", gap: 6 } }, x.exists ? null : /* @__PURE__ */ h(Btn, { small: true, kind: "primary", disabled: !!busy, onClick: () => act("/local/template", x.slot, "t") }, "生成模板"), /* @__PURE__ */ h(Btn, { small: true, onClick: () => {
    navigator.clipboard.writeText(x.prompt);
    toast("复制好了，粘给 DSH，再把【】里那句换成你的情况", "ok");
  } }, "复制给 DSH 的话"), x.exists && (x.slot === "tts" || x.slot === "image") ? /* @__PURE__ */ h(Btn, { small: true, disabled: !!busy, onClick: () => act("/local/test", x.slot, "x") }, busy === x.slot + "x" ? "正在试…" : "试一下") : null), x.slot === "image" && img ? /* @__PURE__ */ h("img", { src: "data:image/png;base64," + img, style: { marginTop: 10, maxWidth: 240, borderRadius: 8 } }) : null)));
}
var MOD_STATE = (m) => {
  if (m.safeSkipped) return { cls: "dim", text: "安全模式，没加载" };
  if (!m.enabled) return { cls: "dim", text: "关着" };
  if (m.running === "user" && m.builtin) return { cls: "mine", text: "用的是你的版本" };
  if (m.running === "user") return { cls: "mine", text: "在跑" };
  if (m.running === "builtin" && m.fallback) return { cls: "warn", text: "你的版本没加载成功，先用内置的" };
  if (m.running === "builtin") return { cls: "", text: "在跑" };
  return { cls: "err", text: m.error ? "没加载成功" : "没在跑" };
};
function ModuleRow({ m, draft, setModules, toast, reload, compact = false }) {
  const s = MOD_STATE(m);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(!compact);
  const setMod = async (patch) => {
    const r = await post("/save", { modules: { [m.id]: { ...(draft.modules || {})[m.id] || {}, ...patch } } });
    if (r.ok === false) return toast(r.message, "err");
    toast(patch.enabled === false ? `「${m.name}」关掉了` : patch.enabled ? `「${m.name}」打开了` : "好了", "ok");
    setModules(r.modules);
    reload();
  };
  const act = async (path, body, okMsg) => {
    const r = await post(path, body);
    toast(r.message || okMsg, r.ok === false ? "err" : "ok");
    if (r.list) setModules(r.list);
    if (r.prompt && r.ok) copy(r.prompt, toast);
    reload();
    return r;
  };
  const tools = m.tools || [];
  const commands = m.commands || [];
  const what = [tools.length ? "工具：" + tools.join("、") : "", commands.length ? "命令：" + commands.map((c) => "/" + c).join(" ") : ""].filter(Boolean).join("　");
  const errs = (m.error ? [{ label: "加载", message: m.error }] : []).concat(m.errors || []);
  return /* @__PURE__ */ h("div", { className: cx("ab-mod", compact && "compact") }, /* @__PURE__ */ h("div", { className: "main" }, /* @__PURE__ */ h("div", { className: "nm" }, m.name, /* @__PURE__ */ h("code", null, m.id), /* @__PURE__ */ h("span", { className: cx("ab-badge", s.cls) }, s.text), m.market ? /* @__PURE__ */ h("span", { className: "ab-badge mine", title: "从模块市场安装（.qqhub-source.json）" }, "市场") : null, m.outdated ? /* @__PURE__ */ h("span", { className: "ab-badge warn", title: "你复制 / 替换时内置的是 " + m.forkedFrom + "，现在是 " + m.builtinVersion }, "内置版本更新了") : null, compact ? /* @__PURE__ */ h("span", { style: { marginLeft: "auto" } }, /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => setDetail(!detail) }, detail ? "收起" : "详情")) : null), m.description ? /* @__PURE__ */ h("div", { className: cx("ds", compact && !detail && "clip") }, m.description) : null, detail && what ? /* @__PURE__ */ h("div", { className: "what" }, what) : null, errs.length ? /* @__PURE__ */ h("div", { className: "ab-note err", style: { marginTop: 6 } }, /* @__PURE__ */ h("div", { style: { cursor: "pointer" }, onClick: () => setOpen(!open) }, (open ? "▾ " : "▸ ") + errs.length + " 条报错：" + String(errs[0].message).split("\n")[0].slice(0, 120)), open ? /* @__PURE__ */ h("div", { className: "ab-code" }, errs.map((e) => (e.at ? new Date(e.at).toLocaleTimeString() + " " : "") + (e.label || "") + "：" + e.message).join("\n\n")) : null) : null, detail ? /* @__PURE__ */ h("div", { className: "acts" }, m.builtin && !m.hasUser ? /* @__PURE__ */ h(Btn, { small: true, onClick: () => act("/modules/fork", { id: m.id }, "复制好了"), title: "把这个内置模块的源码复制到 modules/" + m.id + "/，改了就替换内置的" }, "复制一份来改") : null, m.hasUser ? /* @__PURE__ */ h(Btn, { small: true, onClick: () => post("/modules/open?id=" + encodeURIComponent(m.id)).then((r) => toast(r.message)) }, "打开文件夹") : null, m.hasUser ? /* @__PURE__ */ h(Btn, { small: true, onClick: () => get("/modules/prompt?id=" + encodeURIComponent(m.id)).then((r) => copy(r.prompt, toast, "复制好了，粘给 DSH，把【】里那句换成你想要的")) }, "复制给 DSH 的话") : null, m.hasUser && !m.safeSkipped ? /* @__PURE__ */ h(Btn, { small: true, onClick: () => act("/modules/reload", { id: m.id }, "重新加载好了") }, "重新加载") : null) : null), /* @__PURE__ */ h("div", { className: "side" }, /* @__PURE__ */ h(Switch, { on: m.enabled, onChange: (v) => setMod({ enabled: v }), title: m.enabled ? "关掉这个模块" : "打开这个模块" }), m.builtin && m.hasUser ? /* @__PURE__ */ h("label", { className: "ab-small ab-muted", style: { display: "flex", alignItems: "center", gap: 6 } }, "用内置的", /* @__PURE__ */ h(Switch, { on: m.useBuiltin, onChange: (v) => setMod({ useBuiltin: v }) })) : null));
}
function Simulate({ toast }) {
  const [open, setOpen] = useState(false);
  const [as, setAs] = useState("owner");
  const [kind, setKind] = useState("private");
  const [text, setText] = useState("");
  const [reply, setReply] = useState("");
  const [out, setOut] = useState(null);
  const [tools, setTools] = useState([]);
  const [tool, setTool] = useState("");
  const [args, setArgs] = useState("{}");
  const [tout, setTout] = useState(null);
  useEffect(() => {
    get("/modules/tools?as=" + as + "&kind=" + kind).then((r) => {
      const l = r.list || [];
      setTools(l);
      if (!l.some((t) => t.name === tool)) setTool(l[0] ? l[0].name : "");
    });
  }, [as, kind]);
  const cur = tools.find((t) => t.name === tool);
  const run = async () => {
    const r = await post("/modules/simulate", { as, kind, text, reply });
    if (r.ok === false) return toast(r.message, "err");
    setOut(r);
  };
  const call = async () => {
    let a;
    try {
      a = JSON.parse(args || "{}");
    } catch (e) {
      return toast('参数要是 JSON，比如 {"city":"北京"}', "err");
    }
    const r = await post("/modules/tool", { as, kind, name: tool, args: a });
    if (r.ok === false) return toast(r.message, "err");
    setTout(r);
  };
  const sentList = (sent) => sent && sent.length ? /* @__PURE__ */ h("div", { className: "ab-code" }, sent.map((s) => "→ " + s.chatId + "：" + s.text).join("\n")) : /* @__PURE__ */ h("div", { className: "ab-small ab-muted", style: { marginTop: 6 } }, "没有发出任何消息");
  return /* @__PURE__ */ h(Card, { title: "模拟测试", desc: "不上 QQ 就能试模块：这里发出去的消息只截下来显示，不会真发到 QQ。", right: /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => setOpen(!open) }, open ? "收起" : "展开") }, open ? /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h(More, { label: "哪些副作用是真的" }, "模块直接调 api.onebot 的操作（比如禁言、发空间）是真的会执行的；会改设置的内置命令不执行。"), /* @__PURE__ */ h(Row, { label: "假装是", hint: "谁在说话、在哪儿说" }, /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Seg, { value: as, options: [{ value: "owner", label: "主人" }, { value: "other", label: "别人" }], onChange: setAs }), /* @__PURE__ */ h(Seg, { value: kind, options: [{ value: "private", label: "私聊" }, { value: "group", label: "群聊" }], onChange: setKind }))), /* @__PURE__ */ h(Row, { label: "发一条消息", hint: "看哪个模块接管、命令回什么（/开头是命令）" }, /* @__PURE__ */ h("input", { className: "ab-input", value: text, placeholder: "比如：早安，或 /weather 北京", onChange: (e) => setText(e.target.value) })), /* @__PURE__ */ h(Row, { label: "她的回复", hint: "可选：假设她这样回，看经过各个模块改写后最后发出去什么（可以用 ||| 分条、<voice>…</voice>）" }, /* @__PURE__ */ h("input", { className: "ab-input", value: reply, placeholder: "比如：早呀|||今天也要加油", onChange: (e) => setReply(e.target.value) })), /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { kind: "primary", small: true, disabled: !text.trim() && !reply.trim(), onClick: run }, "模拟")), out ? /* @__PURE__ */ h("div", { style: { marginTop: 8 } }, out.steps.map((s, i) => /* @__PURE__ */ h("div", { key: i, className: "ab-small" }, "· ", s)), sentList(out.sent)) : null, /* @__PURE__ */ h("div", { className: "ab-section-title" }, "调用工具"), tools.length ? /* @__PURE__ */ h("div", null, /* @__PURE__ */ h(Row, { label: "工具", hint: cur ? cur.description : "" }, /* @__PURE__ */ h(Select, { value: tool, options: tools.map((t) => ({ value: t.name, label: t.name })), onChange: (v) => {
    setTool(v);
    setArgs("{}");
    setTout(null);
  } })), cur && cur.parameters && Object.keys(cur.parameters.properties || {}).length ? /* @__PURE__ */ h("div", { className: "ab-small ab-muted", style: { margin: "0 0 6px" } }, "参数：", Object.entries(cur.parameters.properties).map(([k, v]) => k + (v.description ? "（" + v.description + "）" : "")).join("；")) : null, /* @__PURE__ */ h("textarea", { className: "ab-textarea", style: { minHeight: 50 }, value: args, onChange: (e) => setArgs(e.target.value) }), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 6 } }, /* @__PURE__ */ h(Btn, { small: true, onClick: call, disabled: !tool }, "调用")), tout ? /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "ab-code" }, JSON.stringify(tout.result, null, 2)), sentList(tout.sent)) : null) : /* @__PURE__ */ h("div", { className: "ab-small ab-muted" }, "这个场合没有工具")) : null);
}
function Market({ st, toast, reload }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");
  const [prog, setProg] = useState(null);
  const [httpProxy, setHttpProxy] = useState(st.config?.modules?.market?.httpProxy || "");
  const [indexText, setIndexText] = useState((st.config?.modules?.market?.indexUrls || []).join("\n"));
  const load = () => get("/modules/market").then(setData).catch(() => setData({ ok: false, message: "市场加载失败", list: [] }));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!busy) return void 0;
    const t = setInterval(() => get("/modules/market/progress").then((r) => setProg(r.progress)).catch(() => {
    }), 700);
    return () => clearInterval(t);
  }, [busy]);
  const enabled = st.config?.modules?.market?.enabled === true;
  const toggle = async (v) => {
    const r = await post("/save", { modules: { market: { enabled: v } } });
    toast(v ? "模块市场开了" : "模块市场关了", "ok");
    reload();
    load();
    return r;
  };
  const saveProxy = async () => {
    const wanted = httpProxy.trim();
    const r = await post("/save", { modules: { market: { httpProxy: wanted } } });
    const saved = r.config?.modules?.market?.httpProxy || "";
    setHttpProxy(saved);
    toast(wanted && !saved ? "代理地址不合法，已清空" : "市场代理已保存", wanted && !saved ? "err" : "ok");
    reload();
    setData(null);
    await load();
  };
  const saveSources = async () => {
    const wanted = indexText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const r = await post("/save", { modules: { market: { indexUrls: wanted } } });
    const saved = r.config?.modules?.market?.indexUrls || [];
    setIndexText(saved.join("\n"));
    const filtered = wanted.length !== saved.length;
    const message = filtered ? "含非 HTTPS 地址，已过滤；其余加速源已保存" : wanted.length ? "加速源已保存" : "已恢复默认索引源";
    toast(message, filtered ? "err" : "ok");
    reload();
    setData(null);
    await load();
  };
  const install = async (e, confirmReplace = false) => {
    setBusy(e.id);
    try {
      let r = await post("/modules/market/install", { id: e.id, confirmReplace });
      if (r.needConfirm && window.confirm(r.message + "\n\n装模块等于装进程内代码，确认替换内置模块？")) {
        r = await post("/modules/market/install", { id: e.id, confirmReplace: true });
      }
      toast(r.message, r.ok ? "ok" : "err");
      if (r.ok) {
        load();
        reload();
      }
    } finally {
      setBusy("");
      setProg(null);
    }
  };
  const remove = async (e, purge) => {
    if (!window.confirm(purge ? `卸载「${e.name || e.id}」并清掉它的数据和设置？` : `卸载「${e.name || e.id}」？数据和设置会留着。`)) return;
    setBusy(e.id);
    try {
      const r = await post("/modules/market/remove", { id: e.id, purge });
      toast(r.message, r.ok ? "ok" : "err");
      if (r.ok) {
        load();
        reload();
      }
    } finally {
      setBusy("");
    }
  };
  const stageText = { index: "读索引…", download: "下载中", install: "校验安装…", start: "启动模块…" };
  return /* @__PURE__ */ h(
    Card,
    {
      title: "模块市场",
      desc: "从社区模块库安装新本事。装模块等于装进程内代码：看清作者、许可和校验和再装；默认不自动更新。",
      more: "索引支持多源（GitHub raw → jsdelivr 镜像），也可在配置 modules.market.indexUrls 里填自建/内网源。\\n市场模块和内置一样：发送必经 Outbox 台账，记忆按会话隔离。",
      right: /* @__PURE__ */ h(Switch, { on: enabled, onChange: toggle })
    },
    !enabled ? /* @__PURE__ */ h("div", { className: "ab-note" }, "市场没开。打开右上角开关后刷新列表。") : null,
    /* @__PURE__ */ h("div", { style: { marginBottom: 10 } }, /* @__PURE__ */ h("div", { className: "ab-small ab-muted", style: { marginBottom: 4 } }, "索引/加速源：每行一个完整 HTTPS 索引地址，按顺序尝试；清空后保存可恢复默认双源。"), /* @__PURE__ */ h("textarea", { className: "ab-textarea", rows: 3, value: indexText, placeholder: "例如 https://ghfast.top/https://raw.githubusercontent.com/lecheng2018/dsh-qq-hub-mods/registry/index.json", onChange: (e) => setIndexText(e.target.value) }), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 4, justifyContent: "flex-end" } }, /* @__PURE__ */ h(Btn, { small: true, onClick: saveSources }, "保存加速源"))),
    /* @__PURE__ */ h("div", { style: { marginBottom: 10 } }, /* @__PURE__ */ h("div", { className: "ab-small ab-muted", style: { marginBottom: 4 } }, "市场 HTTP 代理（可选）：只影响索引和安装包，不影响模型等其他请求。"), /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h("input", { className: "ab-input", style: { flex: 1 }, value: httpProxy, placeholder: "例如 http://192.168.10.1:7890，留空直连", onChange: (e) => setHttpProxy(e.target.value) }), /* @__PURE__ */ h(Btn, { small: true, onClick: saveProxy }, "保存代理"))),
    enabled && !data ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : null,
    enabled && data && !data.ok ? /* @__PURE__ */ h("div", { className: "ab-note err" }, data.message || "索引读不到", "（已装模块不受影响）") : null,
    enabled && data && data.ok ? /* @__PURE__ */ h(Fragment, null, data.revoked && data.revoked.length ? /* @__PURE__ */ h("div", { className: "ab-note warn" }, "已装版本被撤回：", data.revoked.map((r) => `${r.id} ${r.version}（${r.reason}）`).join("；"), "。建议卸载或更新。") : null, prog && busy ? /* @__PURE__ */ h("div", { className: "ab-note" }, prog.name || prog.id, "：", stageText[prog.stage] || prog.stage, prog.stage === "download" && prog.total ? ` ${Math.round(prog.received / 1024)} / ${Math.round(prog.total / 1024)} KB` : "") : null, (data.list || []).length === 0 ? /* @__PURE__ */ h(Empty, { icon: "📦", text: "索引里还没有模块" }) : null, (data.list || []).map((e) => /* @__PURE__ */ h("div", { key: e.id, style: { padding: "8px 0", borderBottom: "1px solid var(--ab-line, rgba(127,127,127,.15))" } }, /* @__PURE__ */ h("div", { className: "ab-flex", style: { alignItems: "center", gap: 8 } }, /* @__PURE__ */ h("b", null, e.name || e.id), /* @__PURE__ */ h("span", { className: "ab-small ab-muted" }, e.version, e.installed ? `（已装 ${e.installed}）` : ""), e.update ? /* @__PURE__ */ h("span", { className: "ab-pill ok" }, "可更新") : null, e.delisted ? /* @__PURE__ */ h("span", { className: "ab-pill warn" }, "已下架") : null, e.foreign ? /* @__PURE__ */ h("span", { className: "ab-pill warn" }, "同名自有文件夹") : null, /* @__PURE__ */ h("span", { style: { flex: 1 } }), e.installed ? /* @__PURE__ */ h(Fragment, null, e.update && !e.blocked ? /* @__PURE__ */ h(Btn, { small: true, kind: "primary", disabled: busy === e.id, onClick: () => install(e) }, "更新") : null, /* @__PURE__ */ h(Btn, { small: true, disabled: busy === e.id, onClick: () => remove(e, false) }, "卸载"), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", disabled: busy === e.id, onClick: () => remove(e, true) }, "卸载并清数据")) : /* @__PURE__ */ h(Btn, { small: true, kind: "primary", disabled: busy === e.id || Boolean(e.blocked) || e.foreign, onClick: () => install(e) }, "安装")), e.description ? /* @__PURE__ */ h("div", { className: "ab-small", style: { marginTop: 4 } }, e.description) : null, /* @__PURE__ */ h("div", { className: "ab-small ab-muted", style: { marginTop: 4 } }, [e.author && `作者 ${e.author}`, e.license && `许可 ${e.license}`, e.category, e.minPluginVersion && `需插件 ≥${e.minPluginVersion}`, Array.isArray(e.capabilities) && e.capabilities.length && `能力声明：${e.capabilities.join("、")}（仅展示，不是安全边界）`].filter(Boolean).join(" · ")), e.sha256 ? /* @__PURE__ */ h("div", { className: "ab-small ab-muted", style: { marginTop: 2, wordBreak: "break-all" } }, "sha256: ", e.sha256, e.commit ? ` · commit ${String(e.commit).slice(0, 8)}` : "") : null, e.blocked ? /* @__PURE__ */ h("div", { className: "ab-note warn", style: { marginTop: 4 } }, e.blocked) : null)), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 8 } }, /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: async () => {
      setData(null);
      await load();
    } }, "刷新列表"), data.source ? /* @__PURE__ */ h("span", { className: "ab-small ab-muted" }, "索引源：", data.source) : null)) : null
  );
}
var EXT_GROUPS = [
  { id: "express", label: "表达与内容", ids: ["voice", "stickers", "imagegen", "diary", "qzone-social"] },
  { id: "platform", label: "平台", ids: ["bili", "douyin", "heybox", "multi-parser"] },
  { id: "memory", label: "记忆与主动", ids: ["memory", "reflection", "style", "memory-privacy", "speakup", "purpose"] },
  { id: "govern", label: "治理与工具", ids: ["token-guardian", "token-billing", "complete-guard", "group-admin", "qq-tools", "profile", "contacts", "affective-graph"] }
];
var EXT_OTHER = { id: "other", label: "其他", ids: [] };
var CORE_PAGES = ["连接", "权限", "人格", "聊天", "模型", "记忆", "本地接口"];
var GROUP_OPEN_KEY = "qq-hub:ext-groups:v1";
var groupBuiltins = (list) => {
  const buckets = new Map([...EXT_GROUPS, EXT_OTHER].map((g) => [g.id, []]));
  for (const m of list) {
    const g = EXT_GROUPS.find((x) => x.ids.includes(m.id));
    buckets.get(g ? g.id : EXT_OTHER.id).push(m);
  }
  return [...EXT_GROUPS, EXT_OTHER].map((g) => ({ ...g, list: buckets.get(g.id) })).filter((g) => g.list.length);
};
var groupNeedsAttention = (g) => g.list.some((m) => m.error || (m.errors || []).length || m.outdated);
var loadGroupOpen = () => {
  try {
    return JSON.parse(localStorage.getItem(GROUP_OPEN_KEY) || "{}") || {};
  } catch {
    return {};
  }
};
function Modules({ st, draft, toast, reload }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [openGroups, setOpenGroups] = useState(loadGroupOpen);
  const [marketUpdates, setMarketUpdates] = useState(0);
  const load = () => get("/modules").then(setData);
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (data && st.modules) setData((d) => ({ ...d, list: st.modules }));
  }, [JSON.stringify(st.modules)]);
  const setModules = (list2) => list2 && setData((d) => ({ ...d, list: list2 }));
  const marketOn = st.config?.modules?.market?.enabled === true;
  useEffect(() => {
    if (!marketOn) {
      setMarketUpdates(0);
      return void 0;
    }
    let alive = true;
    get("/modules/market").then((r) => {
      if (alive && r?.ok) setMarketUpdates((r.list || []).filter((e) => e.update).length);
    }).catch(() => {
    });
    return () => {
      alive = false;
    };
  }, [marketOn]);
  if (!data) return /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" });
  const list = data.list || [];
  const builtin = list.filter((m) => m.builtin);
  const mine = list.filter((m) => !m.builtin);
  const running = builtin.filter((m) => m.running).length;
  const off = builtin.filter((m) => !m.enabled).length;
  const errCount = list.filter((m) => m.error || (m.errors || []).length).length;
  const groups = groupBuiltins(builtin);
  const qn = q.trim().toLowerCase();
  const hit = (m) => !qn || [m.name, m.id, m.description, ...m.tools || [], ...m.commands || []].some((x) => String(x || "").toLowerCase().includes(qn));
  const isOpen = (g) => qn ? true : openGroups[g.id] === void 0 ? groupNeedsAttention(g) : openGroups[g.id] === true;
  const toggleGroup = (g) => {
    const next = { ...loadGroupOpen(), [g.id]: !isOpen(g) };
    setOpenGroups(next);
    try {
      localStorage.setItem(GROUP_OPEN_KEY, JSON.stringify(next));
    } catch {
    }
  };
  const props = { draft, setModules, toast, reload: () => {
    reload();
    load();
  } };
  const create = async () => {
    const r = await post("/modules/create", { id: newId.trim(), name: newName.trim() });
    if (!r.ok) return toast(r.message, "err");
    setNewId("");
    setNewName("");
    setCreating(false);
    setModules(r.list);
    copy(r.prompt, toast, "建好了，「复制给 DSH 的话」已经复制好，粘给 DSH 让它帮你写");
    reload();
  };
  const matched = groups.some((g) => g.list.some(hit));
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(
    Card,
    {
      title: "扩展",
      desc: "她的每项本事都是一个模块：能单独关掉；能复制一份来改，改了就替换内置的；也能自己写新模块。",
      more: "自己写的东西放在下面这个文件夹，插件升级不会动；改完保存几秒内自动生效，不用重启。\n不会写代码？点「复制给 DSH 的话」，粘给 DSH，说你想要什么。"
    },
    /* @__PURE__ */ h("div", { className: "ab-pills", style: { marginTop: 0, marginBottom: 8 } }, /* @__PURE__ */ h("span", { className: "ab-pill" }, "内置 ", builtin.length), /* @__PURE__ */ h("span", { className: "ab-pill ok" }, "运行 ", running), off ? /* @__PURE__ */ h("span", { className: "ab-pill warn" }, "关闭 ", off) : null, errCount ? /* @__PURE__ */ h("span", { className: "ab-pill err" }, "异常 ", errCount) : null, /* @__PURE__ */ h("span", { className: "ab-pill" }, "扩展 ", mine.length), marketOn && marketUpdates ? /* @__PURE__ */ h("span", { className: "ab-pill ok" }, "市场可更新 ", marketUpdates) : null),
    /* @__PURE__ */ h("div", { className: "ab-flex ab-dirrow" }, /* @__PURE__ */ h("code", { className: "ab-small", style: { wordBreak: "break-all", flex: "1 1 220px", minWidth: 0 } }, data.dir), /* @__PURE__ */ h(Btn, { small: true, onClick: () => post("/modules/open").then((r) => toast(r.message)) }, "打开文件夹"), /* @__PURE__ */ h(Btn, { small: true, onClick: () => copy(data.prompt, toast, "复制好了，粘给 DSH，把【】里那句换成你想要的") }, "复制给 DSH 的话"), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: async () => {
      const r = await post("/modules/reload", {});
      setModules(r.list);
      toast(r.message);
    } }, "重新检查")),
    /* @__PURE__ */ h(Row, { label: "安全模式", hint: "打开后你写的模块一个都不加载，内置的全部恢复。出了问题先开它，看是不是你的模块引起的。" }, /* @__PURE__ */ h(Switch, { on: st.config.safeMode, onChange: async (v) => {
      const r = await post("/save", { safeMode: v });
      toast(v ? "安全模式开了：只跑内置模块" : "安全模式关了", "ok");
      setModules(r.modules);
      reload();
    } })),
    st.config.safeMode ? /* @__PURE__ */ h("div", { className: "ab-note warn" }, "安全模式开着：你写的模块现在都没加载。") : null
  ), /* @__PURE__ */ h(Card, { title: "核心页面", desc: "这些页面是插件本体，始终显示、不能关；模块开关只影响它自己的标签页。" }, /* @__PURE__ */ h("div", { className: "ab-pills", style: { marginTop: 0 } }, CORE_PAGES.map((t) => /* @__PURE__ */ h("span", { key: t, className: "ab-pill" }, t)))), /* @__PURE__ */ h(Market, { st, toast, reload }), /* @__PURE__ */ h(
    Card,
    {
      title: "已安装的扩展（" + mine.length + "）",
      desc: "自己写的或从模块市场安装的模块；和内置一样走统一发送出口，数据和设置按模块隔离。",
      right: /* @__PURE__ */ h(Btn, { small: true, onClick: () => setCreating((v) => !v) }, creating ? "取消" : "＋ 新建")
    },
    creating ? /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginBottom: 8 } }, /* @__PURE__ */ h("input", { className: "ab-input", style: { maxWidth: 180 }, placeholder: "id，如 weather", value: newId, onChange: (e) => setNewId(e.target.value.toLowerCase()) }), /* @__PURE__ */ h("input", { className: "ab-input", placeholder: "名字，如 查天气", value: newName, onChange: (e) => setNewName(e.target.value) }), /* @__PURE__ */ h(Btn, { kind: "primary", small: true, disabled: !newId.trim(), onClick: create }, "新建")) : null,
    mine.length ? mine.map((m) => /* @__PURE__ */ h(ModuleRow, { key: m.id, m, ...props })) : /* @__PURE__ */ h(Empty, { icon: "🧩", text: "还没有自己写的或从市场安装的扩展" })
  ), /* @__PURE__ */ h(
    Card,
    {
      title: "内置模块（" + builtin.length + "）",
      desc: "关掉的模块：她就没有这项本事，相关的标签页也会藏起来；核心页面不受影响。",
      right: /* @__PURE__ */ h("input", { className: "ab-input ab-search", placeholder: "搜索模块…", value: q, onChange: (e) => setQ(e.target.value) })
    },
    groups.map((g) => {
      const items = g.list.filter(hit);
      if (qn && !items.length) return null;
      const open = isOpen(g);
      return /* @__PURE__ */ h("div", { key: g.id, className: "ab-modgroup" }, /* @__PURE__ */ h("button", { type: "button", className: "ab-modgroup-head", onClick: () => toggleGroup(g), "aria-expanded": open }, /* @__PURE__ */ h("span", { className: cx("ab-modgroup-chev", open && "open") }, "›"), /* @__PURE__ */ h("span", { className: "ab-modgroup-name" }, g.label), /* @__PURE__ */ h("span", { className: "ab-modgroup-meta" }, "（", g.list.length, "）· 运行 ", g.list.filter((m) => m.running).length), groupNeedsAttention(g) ? /* @__PURE__ */ h("span", { className: "ab-badge warn" }, "有情况") : null, /* @__PURE__ */ h("span", { style: { flex: 1 } }), /* @__PURE__ */ h("span", { className: "ab-modgroup-meta" }, open ? "收起" : "展开")), open ? /* @__PURE__ */ h("div", { className: "ab-modgroup-body" }, items.map((m) => /* @__PURE__ */ h(ModuleRow, { key: m.id, m, ...props, compact: true }))) : null);
    }),
    qn && !matched ? /* @__PURE__ */ h(Empty, { icon: "🔍", text: "没有匹配「" + q.trim() + "」的模块" }) : null
  ), /* @__PURE__ */ h(Simulate, { toast }));
}
var PanelBoundary = class extends React.Component {
  constructor(p) {
    super(p);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    return this.state.error ? /* @__PURE__ */ h("div", { className: "ab-note err" }, "这个模块的面板出错了：", String(this.state.error && this.state.error.message || this.state.error)) : this.props.children;
  }
};
function ExtPanel({ m, settings, draftSettings, setSettings, toast, reload, draft, setDraft }) {
  const [Comp, setComp] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    fetch(API + "/modules/panel?id=" + encodeURIComponent(m.id) + "&t=" + Date.now(), { cache: "no-store" }).then((r) => r.ok ? r.text() : Promise.reject(new Error("读不到 panel.js"))).then((src) => {
      const base = m.builtin && m.running === "builtin" ? "" : "/ext/" + m.id;
      const call = (p, body) => body === void 0 ? get(base + p) : post(base + p, body);
      const ui = { Card, Btn, Switch, Row, Empty, Select, Seg, Range, ListInput, NumInput };
      const C = new Function("React", "h", "ui", "call", src)(React, h, ui, call);
      if (typeof C !== "function") throw new Error("panel.js 最后要 return 一个组件（函数）");
      if (alive) setComp(() => C);
    }).catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [m.id, m.startedAt]);
  if (err) return /* @__PURE__ */ h("div", { className: "ab-note err" }, "面板加载失败：", err);
  if (!Comp) return /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" });
  const save = async (patch) => {
    const r = await post("/save", { ext: { [m.id]: patch } });
    toast(r.ok === false ? r.message : "保存好了", r.ok === false ? "err" : "ok");
    reload();
  };
  return /* @__PURE__ */ h(PanelBoundary, null, /* @__PURE__ */ h(Comp, { settings, draftSettings, setSettings, save, toast, reload, draft, setDraft }));
}
function ExtPage({ st, draft, setDraft, toast, reload, mod, embedded }) {
  const m = (st.modules || []).find((x) => x.id === mod);
  const f = useField(draft, setDraft);
  if (!m) return /* @__PURE__ */ h(Empty, { icon: "🧩", text: "这个模块没在跑了" });
  const base = "ext." + m.id + ".";
  const settings = { ...m.defaults || {}, ...(st.config.ext || {})[m.id] || {} };
  const draftSettings = { ...m.defaults || {}, ...(draft.ext || {})[m.id] || {} };
  const setSettings = (patch) => setDraft((previous) => ({ ...previous, ext: { ...previous.ext, [m.id]: { ...(previous.ext || {})[m.id], ...patch } } }));
  const field = (s) => {
    const p = base + s.key;
    if (s.type === "switch") return f.sw(p);
    if (s.type === "number") return f.num(p, { min: s.min, max: s.max, step: s.step, fallback: (m.defaults || {})[s.key] });
    if (s.type === "select") return f.select(p, (s.options || []).map((o) => typeof o === "string" ? { value: o, label: o } : o));
    if (s.type === "textarea") return /* @__PURE__ */ h("textarea", { className: "ab-textarea", value: getPath(draft, p) ?? "", placeholder: s.placeholder, onChange: (e) => setDraft(setPath(draft, p, e.target.value)) });
    if (s.type === "password") return f.text(p, { type: "password", placeholder: getPath(draft, p + "Set") ? "已保存（不改就留空）" : s.placeholder || "" });
    return f.text(p, { placeholder: s.placeholder });
  };
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, (m.settings || []).length || (m.errors || []).length || !m.panel ? /* @__PURE__ */ h(Card, { title: m.name, desc: m.description, right: /* @__PURE__ */ h("span", { className: "ab-badge mine" }, embedded ? "扩展模块 · " + m.id : m.id) }, (m.settings || []).map((s) => /* @__PURE__ */ h(Row, { key: s.key, label: s.label || s.key, hint: s.hint }, field(s))), (m.settings || []).length ? /* @__PURE__ */ h("div", { className: "ab-small ab-muted" }, "改完点下面的「保存设置」。") : null, (m.errors || []).length ? /* @__PURE__ */ h("div", { className: "ab-note err", style: { marginTop: 8 } }, "最近的报错：", m.errors[0].message) : null) : null, m.panel ? /* @__PURE__ */ h(ExtPanel, { m, settings, draftSettings, setSettings, toast, reload, draft, setDraft }) : null);
}

// client/src/views/mood.js
var SOURCE = { tool: "她自己记的", auto: "每日整理", diary: "空间日记", panel: "你加的", event: "她的经历", import: "导入的" };
function Mood({ st, draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  const [mem, setMem] = useState(null);
  const [stats, setStats] = useState(null);
  const [q, setQ] = useState("");
  const [ins, setIns] = useState(null);
  const [adding, setAdding] = useState({ text: "", aboutName: "", importance: 0.6 });
  const [addOpen, setAddOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [personaTab, setPersonaTab] = useState("profiles");
  const [health, setHealth] = useState(null);
  const [reloading, setReloading] = useState(false);
  const [vec, setVec] = useState(null);
  const [vecBusy, setVecBusy] = useState(false);
  const [rerank, setRerank] = useState(null);
  const load = (query) => get("/memories?q=" + encodeURIComponent(query ?? q)).then((r) => {
    setMem(r.items || []);
    setStats(r.stats || null);
    setHealth(r.health || null);
  });
  const loadVec = () => get("/memory/vector").then((r) => {
    setVec(r.status || { enabled: false });
    setRerank(r.rerank || { enabled: false });
  }).catch(() => {
    setVec({ enabled: false });
    setRerank({ enabled: false });
  });
  const [styles, setStyles] = useState({});
  const loadIns = () => get("/insights").then((r) => {
    setIns(r.items || []);
    setStyles(r.styles || {});
  });
  const times = draft.memory.consolidateTimes || [];
  const setTime = (i, v) => {
    const t = times.slice();
    t[i] = v;
    setDraft(setPath(draft, "memory.consolidateTimes", t));
  };
  const memOn = modOn(st, "memory");
  useEffect(() => {
    if (memOn) {
      load("");
      loadIns();
      loadVec();
    }
  }, [memOn]);
  useEffect(() => {
    if (!memOn) return;
    const t = setTimeout(() => load(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const last = st.memory && st.memory.lastConsolidate;
  if (!memOn) return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(ModOff, { name: "记忆" }));
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(Card, { title: "记忆概览", desc: "她记得多少、上次整理是什么时候；档案有问题会在这里冒红条。" }, /* @__PURE__ */ h("div", { className: "ab-pills", style: { marginTop: 0, marginBottom: 10 } }, /* @__PURE__ */ h("span", { className: "ab-pill" }, stats ? stats.count : "–", " 条长期记忆"), /* @__PURE__ */ h("span", { className: "ab-pill" }, stats ? stats.auto : "–", " 条来自每日整理", stats && stats.outdated ? " · 另有 " + stats.outdated + " 条已过时" : ""), /* @__PURE__ */ h("span", { className: "ab-pill" }, "上次整理：", last ? new Date(last.at).toLocaleString() : "还没整理过")), health && !health.ok ? /* @__PURE__ */ h("div", { className: "ab-note err", role: "alert" }, /* @__PURE__ */ h("b", null, "档案异常，自动整理已暂停。修复文件后点击「重新载入档案」。"), health.stateError ? /* @__PURE__ */ h("div", null, health.stateError) : null, (health.brokenScopes || []).map((item) => /* @__PURE__ */ h("div", { key: item.file }, item.file, "：", item.error))) : null, /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: async () => {
    toast("正在整理，可能要一两分钟…");
    const r = await post("/memory/extract", {});
    toast(r.message);
    load();
    loadIns();
  } }, "现在整理一次"), /* @__PURE__ */ h(
    Btn,
    {
      small: true,
      disabled: reloading,
      onClick: async () => {
        setReloading(true);
        try {
          const r = await post("/memory/reload", {});
          setHealth(r.health || null);
          toast(r.message, r.ok ? "ok" : "err");
          await Promise.all([load(), loadIns()]);
        } catch (error) {
          toast(error.message, "err");
        } finally {
          setReloading(false);
        }
      }
    },
    reloading ? "正在载入…" : "重新载入档案"
  ))), /* @__PURE__ */ h(Card, { title: "记忆库", right: f.sw("memory.enabled"), desc: "她聊天时自己记的、每天从聊天里整理出来的、你手动加的。每轮回复前，她会按对方正在说的话翻出最相关的几条。" }, /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h("input", { className: "ab-input", style: { flex: "2 1 260px" }, placeholder: "搜索记忆，例如：白米饭、游戏、约定…", value: q, onChange: (e) => {
    setQ(e.target.value);
    if (e.target.value) setBrowseOpen(true);
  } }), /* @__PURE__ */ h(Btn, { small: true, onClick: () => setAddOpen(!addOpen) }, addOpen ? "收起" : "＋ 手动加一条")), addOpen ? /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 8 } }, /* @__PURE__ */ h("input", { className: "ab-input", style: { flex: "2 1 260px" }, placeholder: "要她记住的事，例如：主人不吃香菜", value: adding.text, onChange: (e) => setAdding({ ...adding, text: e.target.value }) }), /* @__PURE__ */ h("input", { className: "ab-input", style: { flex: "1 1 120px" }, placeholder: "关于谁（可选）", value: adding.aboutName, onChange: (e) => setAdding({ ...adding, aboutName: e.target.value }) }), /* @__PURE__ */ h(Select, { value: adding.importance, width: 120, onChange: (v) => setAdding({ ...adding, importance: v }), options: [{ value: 0.3, label: "随口一提" }, { value: 0.6, label: "比较重要" }, { value: 0.9, label: "非常重要" }] }), /* @__PURE__ */ h(Btn, { small: true, kind: "primary", disabled: !adding.text.trim(), onClick: async () => {
    const r = await post("/memory/add", adding);
    toast(r.ok ? "记住了" : r.message);
    setAdding({ text: "", aboutName: "", importance: 0.6 });
    setAddOpen(false);
    load();
  } }, "记住")) : null, /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 10, cursor: "pointer" }, onClick: () => setBrowseOpen(!browseOpen) }, /* @__PURE__ */ h("div", { className: "ab-section-title", style: { margin: 0 } }, (browseOpen ? "▾" : "▸") + " 全部记忆"), /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, mem ? mem.length + " 条" : "")), !browseOpen ? null : mem === null ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : mem.length === 0 ? /* @__PURE__ */ h(Empty, { icon: "🫧", text: q ? "没找到相关的记忆" : "还没有记住什么。" }) : /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginBottom: 6 } }, /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, mem.length + " 条" + (mem.length >= 300 ? "（只显示最近 300 条，可搜索）" : ""))), (() => {
    const secOf = (m) => {
      const t = new Date(m.invalidAt || m.at);
      const now = /* @__PURE__ */ new Date();
      const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const diff = (day(now) - day(t)) / 864e5;
      if (diff <= 0) return "今天";
      if (diff === 1) return "昨天";
      if (diff <= 3) return "近几天";
      if (diff <= 7) return "本周";
      if (diff <= 31) return "本月";
      return "更早";
    };
    const order = ["今天", "昨天", "近几天", "本周", "本月", "更早"];
    const groups = /* @__PURE__ */ new Map();
    for (const m of mem) {
      const k = secOf(m);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    return /* @__PURE__ */ h("div", { className: "ab-list", style: { marginTop: 8 } }, order.filter((k) => groups.has(k)).flatMap((k) => [
      /* @__PURE__ */ h("div", { key: "s:" + k, className: "ab-section-title", style: { margin: "10px 0 4px" } }, k, /* @__PURE__ */ h("span", { className: "ab-muted ab-small", style: { marginLeft: 6 } }, groups.get(k).length + " 条")),
      ...groups.get(k).map((m) => /* @__PURE__ */ h(MemoryRow, { key: m.id, m, onChanged: () => load(), toast }))
    ]));
  })())), /* @__PURE__ */ h(Card, { title: "人物与相处", desc: "她对每个人的印象、总结出的相处之道，以及潜移默化学到的说话方式。点开某一项才编辑。" }, /* @__PURE__ */ h(Seg, { value: personaTab, onChange: setPersonaTab, options: [{ value: "profiles", label: "人物档案" }, { value: "insights", label: "相处经验" }, { value: "style", label: "说话方式" }] }), /* @__PURE__ */ h("div", { style: { marginTop: 10 } }, personaTab === "profiles" ? /* @__PURE__ */ h(ProfilesList, { toast }) : null, personaTab === "insights" ? ins === null ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : ins.length === 0 ? /* @__PURE__ */ h(Empty, { icon: "🌱", text: "还没有总结出经验。多聊几天，整理记忆时她会慢慢总结。" }) : ins.map((p) => /* @__PURE__ */ h(InsightRow, { key: p.key, p, toast, onSaved: loadIns, style: styles[p.key] || [] })) : null, personaTab === "style" ? /* @__PURE__ */ h("div", null, /* @__PURE__ */ h(StyleEditor, { k: "self", label: "她自己养成的说法", list: styles.self || [], toast, onSaved: loadIns }), /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginTop: 6 } }, "每个人的说话习惯跟着上面的「相处经验」一起显示和编辑。")) : null)), /* @__PURE__ */ h(Card, { title: "整理与检索", desc: "每天什么时候整理、每轮想起几条；向量与精排的接口配置也在这一张卡里。" }, /* @__PURE__ */ h(Row, { label: "每天自动整理两次", hint: "把聊天流水提炼成长期记忆、相处经验和说话方式；第二次只处理新增部分。" }, f.sw("memory.dailyConsolidate"), /* @__PURE__ */ h("span", { className: "ab-muted" }, "每天"), /* @__PURE__ */ h("input", { className: "ab-input sm", type: "time", value: times[0] || "", onChange: (e) => setTime(0, e.target.value) }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "和"), /* @__PURE__ */ h("input", { className: "ab-input sm", type: "time", value: times[1] || "", onChange: (e) => setTime(1, e.target.value) })), /* @__PURE__ */ h(Row, { label: "每轮最多想起几条" }, f.range("memory.recallCount", 0, 12, 1, (v) => v + " 条")), /* @__PURE__ */ h(Row, { label: "语义召回（向量通道）", hint: "BM25 检不出「没有共同字词」的提问时，用 embedding 语义兜底并融合排序。" }, vec ? vec.enabled ? /* @__PURE__ */ h("span", { className: "ab-flex" }, /* @__PURE__ */ h("span", { className: "ab-small", style: { color: "var(--ab-ok)", flex: 1 } }, "● ", vec.model || "?", "（", vec.dim, " 维）· 已向量 ", vec.vectors || 0, " 条", vec.pending ? "，待补全 " + vec.pending + " 个作用域" : ""), /* @__PURE__ */ h(Btn, { small: true, disabled: !!vecBusy, onClick: async () => {
    setVecBusy(true);
    try {
      const r = await post("/memory/vector/backfill", {});
      toast(r.message || "存量补全完成，这次向量化 " + (r.embedded || 0) + " 条", r.ok ? "ok" : "err");
      loadVec();
    } catch (error) {
      toast(error.message, "err");
    } finally {
      setVecBusy(false);
    }
  } }, vecBusy ? "补全中…" : "补全存量向量")) : /* @__PURE__ */ h("span", { className: "ab-small", style: { color: "var(--ab-dim)" } }, "未开启 —— 在下面「接口与阈值」里填 Embeddings 接口地址、API Key，打开「语义召回」") : "…"), /* @__PURE__ */ h(Row, { label: "记忆精排（reranker）", hint: "RRF 融合后用 cross-encoder 对候选精排，只重排、不扩可见性；失败自动退回 RRF 顺序。" }, rerank ? rerank.enabled ? /* @__PURE__ */ h("span", { className: "ab-small", style: { color: "var(--ab-ok)" } }, "● ", rerank.model || "?", " · 精排前 ", rerank.topN || 20, " 条", rerank.lastError ? " · 上次失败已退回 RRF：" + rerank.lastError : "") : /* @__PURE__ */ h("span", { className: "ab-small", style: { color: "var(--ab-dim)" } }, "未开启 —— 需先开启语义召回，再在下面「接口与阈值」里填 Rerank API Key 并打开开关") : "…"), /* @__PURE__ */ h("div", { className: "ab-section-title" }, "接口与阈值"), /* @__PURE__ */ h(ExtPage, { st, draft, setDraft, toast, reload: loadVec, mod: "memory", embedded: true })), /* @__PURE__ */ h(RecallLog, null), /* @__PURE__ */ h(Card, { title: "导入与迁移", desc: "一次性操作：导入旧档案，或主人换号后把旧号名下的记忆整体搬过来。", collapse: true }, /* @__PURE__ */ h(MemoryImport, { toast, onDone: () => load() }), /* @__PURE__ */ h(OwnerMigrate, { toast, onChanged: () => load() })));
}
/** 人物小档案：她对每个人的一小段印象，聊天时常驻。 */
function ProfilesList({ toast }) {
  const [list, setList] = useState(null);
  const load = () => get("/profiles").then((r) => setList(r.list || []));
  useEffect(() => {
    load();
  }, []);
  if (list === null) return /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" });
  if (list.length === 0) return /* @__PURE__ */ h(Empty, { icon: "🌱", text: "还没有。关于一个人记住 3 条以上的事后，整理记忆时会写出来。" });
  return /* @__PURE__ */ h("div", { className: "ab-list" }, list.map((p) => /* @__PURE__ */ h(ProfileRow, { key: p.key || `${p.qq}@${p.scope}`, p, toast, onChanged: load })));
}
function ProfileRow({ p, toast, onChanged }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(p.text);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setText(p.text);
  }, [p.text]);
  const del = async () => {
    const r = await post("/profiles/delete", { qq: p.qq, scope: p.scope });
    toast(r.message, r.ok ? "ok" : "err");
    onChanged();
  };
  const scopeLabel = p.scope === "global" ? "通用" : p.scope.startsWith("group:") ? "群 " + p.scope.slice(6) : "私聊";
  return /* @__PURE__ */ h("div", { className: "ab-li", style: { alignItems: "flex-start" } }, /* @__PURE__ */ h("div", { className: "meta" }, /* @__PURE__ */ h("b", null, p.name || p.qq), /* @__PURE__ */ h("br", null), /* @__PURE__ */ h("span", { className: "ab-small" }, p.qq), /* @__PURE__ */ h("br", null), /* @__PURE__ */ h("span", { className: "ab-pill", style: { padding: "0 6px", fontSize: 11, background: p.scope === "global" ? "var(--ab-sea, #35506b)" : "rgba(0,0,0,.18)", color: p.scope === "global" ? "#fff" : "var(--ab-sub)" } }, scopeLabel), /* @__PURE__ */ h("br", null), /* @__PURE__ */ h("span", { className: "ab-small" }, timeAgo(p.at))), open ? /* @__PURE__ */ h("textarea", { className: "ab-input wide", rows: 3, value: text, onChange: (e) => setText(e.target.value), style: { flex: 1 } }) : /* @__PURE__ */ h("div", { className: "body ab-small", style: { flex: 1, whiteSpace: "pre-wrap", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } }, p.text), /* @__PURE__ */ h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, /* @__PURE__ */ h(Btn, { small: true, onClick: () => setOpen(!open) }, open ? "收起" : "编辑"), open ? /* @__PURE__ */ h(Btn, { small: true, kind: "primary", disabled: text === p.text, onClick: async () => {
    const r = await post("/profiles/save", { qq: p.qq, text, scope: p.scope });
    toast(r.message, "ok");
    onChanged();
  } }, "保存") : null, open ? /* @__PURE__ */ h(
    Btn,
    {
      small: true,
      kind: "ghost",
      disabled: busy,
      onClick: async () => {
        setBusy(true);
        const r = await post("/profiles/rebuild", { qq: p.qq, scope: p.scope });
        setBusy(false);
        toast(r.message, r.ok ? "ok" : "err");
        onChanged();
      }
    },
    busy ? "重写中…" : "按记忆重写"
  ) : null, open ? confirming ? /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => {
    setConfirming(false);
    del();
  } }, "确认删除") : /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => setConfirming(true) }, "删除") : null));
}
function RecallLog() {
  const [list, setList] = useState(null);
  const load = () => get("/memory/recalls").then((r) => setList(r.list || []));
  useEffect(() => {
    load();
  }, []);
  return /* @__PURE__ */ h(Card, { title: "最近想起了什么", desc: "每次回复前她会按对方说的话翻记忆。这里能看到最近几次想起了哪几条、是因为哪几个词；想不起来的那次也会列出来。", right: /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: load }, "刷新"), collapse: true }, !list ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : list.length === 0 ? /* @__PURE__ */ h(Empty, { icon: "🫧", text: "还没有记录（重启后从头记）。" }) : /* @__PURE__ */ h("div", { className: "ab-list" }, list.slice(0, 10).map((r, i) => /* @__PURE__ */ h("div", { key: i, className: "ab-li" }, /* @__PURE__ */ h("div", { className: "meta" }, timeAgo(r.at), /* @__PURE__ */ h("br", null), /* @__PURE__ */ h("span", { className: "ab-small" }, String(r.where || "").replace(/^private:/, "私聊 ").replace(/^group:/, "群 "))), /* @__PURE__ */ h("div", { className: "body" }, /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "「", r.query.slice(0, 60), r.query.length > 60 ? "…" : "", "」"), r.hits.length ? r.hits.map((x) => /* @__PURE__ */ h("div", { key: x.id, style: { marginTop: 3 } }, "· ", x.text, /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "  ← ", x.why.join("、") || "—", " · ", x.score))) : /* @__PURE__ */ h("div", { className: "ab-muted", style: { marginTop: 3 } }, "这次什么都没想起来"))))));
}
function OwnerMigrate({ toast, onChanged }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const doMove = async () => {
    if (!/^\d{5,}$/.test(from) || !/^\d{5,}$/.test(to)) {
      toast("两边都要填 QQ 号");
      return;
    }
    if (!confirm("把 " + from + " 名下的私聊记忆全部搬给 " + to + "？")) return;
    const r = await post("/memory/reassign-owner", { from, to });
    toast(r.message || (r.ok ? "搬好了" : "没搬成"));
    if (r.ok) {
      setFrom("");
      setTo("");
      onChanged();
    }
  };
  return /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "ab-section-title" }, "主人换号迁移"), /* @__PURE__ */ h("div", { className: "ab-flex", style: { alignItems: "center" } }, /* @__PURE__ */ h("input", { className: "ab-input sm", placeholder: "旧 QQ 号", value: from, onChange: (e) => setFrom(e.target.value) }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "→"), /* @__PURE__ */ h("input", { className: "ab-input sm", placeholder: "新 QQ 号", value: to, onChange: (e) => setTo(e.target.value) }), /* @__PURE__ */ h(Btn, { small: true, disabled: !from || !to, onClick: doMove }, "迁移记忆")), /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginTop: 4 } }, "换了 QQ 号用这个：旧号私聊里的记忆（包括记在你名下的小档案）会整体搬到新号，一次就好。"));
}
function MemoryImport({ toast, onDone }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [cands, setCands] = useState(null);
  const [pick, setPick] = useState({});
  const [scope, setScope] = useState("private");
  const readFile = () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".txt,.md,.markdown,.json";
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => setText(String(fr.result || "").slice(0, 3e4));
      fr.readAsText(f);
    };
    inp.click();
  };
  const scan = async () => {
    setBusy(true);
    setCands(null);
    const r = await post("/memory/import", { text });
    setBusy(false);
    if (!r.ok) return toast(r.message, "err");
    setCands(r.list);
    setPick(Object.fromEntries(r.list.map((_, i) => [i, true])));
  };
  const commit = async () => {
    const items = cands.filter((_, i) => pick[i]);
    const r = await post("/memory/import/commit", { items, scope });
    toast(r.message, "ok");
    setCands(null);
    setText("");
    onDone();
  };
  return /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "ab-section-title" }, "导入旧档案"), /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginBottom: 8 } }, "以前写过的设定、聊天笔记、别的机器人的记忆文件，贴进来或上传。她会挑出值得记的，你勾选后再存；和已有记忆重复的会自动去掉。"), /* @__PURE__ */ h("textarea", { className: "ab-textarea", style: { minHeight: 110 }, placeholder: "把旧档案的文字粘贴到这里（最多 3 万字）", value: text, onChange: (e) => setText(e.target.value) }), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 8 } }, /* @__PURE__ */ h(Btn, { small: true, onClick: readFile }, "选择文件"), /* @__PURE__ */ h(Btn, { small: true, kind: "primary", disabled: busy || !text.trim(), onClick: scan }, busy ? /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h("i", { className: "ab-spin" }), " 正在挑…") : "挑出值得记的"), /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, text ? text.length + " 字" : "")), cands ? cands.length === 0 ? /* @__PURE__ */ h("div", { className: "ab-muted", style: { marginTop: 10 } }, "没挑出新的可记的东西（或者都已经记过了）。") : /* @__PURE__ */ h("div", { style: { marginTop: 10 } }, /* @__PURE__ */ h("div", { className: "ab-list" }, cands.map((c, i) => /* @__PURE__ */ h("label", { key: i, className: "ab-li", style: { cursor: "pointer" } }, /* @__PURE__ */ h("input", { type: "checkbox", checked: !!pick[i], onChange: (e) => setPick({ ...pick, [i]: e.target.checked }), style: { accentColor: "var(--ab-sea)", marginTop: 3 } }), /* @__PURE__ */ h("div", { className: "body" }, c.aboutName ? /* @__PURE__ */ h("b", null, "[", c.aboutName, "] ") : null, c.text, c.importance >= 0.8 ? " ★" : "")))), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 8 } }, /* @__PURE__ */ h("label", { className: "ab-small", style: { cursor: "pointer" } }, /* @__PURE__ */ h("input", { type: "radio", checked: scope === "private", onChange: () => setScope("private"), style: { accentColor: "var(--ab-sea)" } }), " 只在她的私聊里想起（默认）"), /* @__PURE__ */ h("label", { className: "ab-small", style: { cursor: "pointer", marginLeft: 12 } }, /* @__PURE__ */ h("input", { type: "radio", checked: scope === "global", onChange: () => setScope("global"), style: { accentColor: "var(--ab-sea)" } }), " 所有聊天都能想起（她自己的设定选这个）")), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 8 } }, /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: commit, disabled: !Object.values(pick).some(Boolean) }, "存进记忆库（", Object.values(pick).filter(Boolean).length, " 条）"), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => setCands(null) }, "取消"))) : null);
}
function StyleEditor({ k, label, list, toast, onSaved }) {
  const [text, setText] = useState(list.join("\n"));
  useEffect(() => setText(list.join("\n")), [list.join("\n")]);
  const changed = text !== list.join("\n");
  return /* @__PURE__ */ h("div", { style: { marginTop: 8 } }, /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginBottom: 4 } }, /* @__PURE__ */ h("span", { className: "ab-small", style: { color: "var(--ab-sub)" } }, label), /* @__PURE__ */ h("div", { className: "ab-spacer" }), changed ? /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: async () => {
    const r = await post("/style/save", { key: k, list: text.split("\n") });
    toast(r.message, "ok");
    onSaved();
  } }, "保存") : null), /* @__PURE__ */ h("textarea", { className: "ab-textarea", style: { minHeight: 50, fontFamily: "inherit" }, value: text, onChange: (e) => setText(e.target.value), placeholder: "一行一条，例如：消息很短，常一句话分几条发" }));
}
function InsightRow({ p, toast, onSaved, style }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(p.list.map((x) => x.text).join("\n"));
  const joined = p.list.map((x) => x.text).join("\n");
  useEffect(() => setText(joined), [joined]);
  const changed = text !== joined;
  const who = p.key.startsWith("group:") ? "群 " + p.key.slice(6) : p.name ? p.name + "（" + p.key.slice(3) + "）" : p.key.slice(3);
  const delOne = async (lineIdx) => {
    const item = p.list[lineIdx];
    if (!item) return;
    const r = await post("/insights/delete", { key: p.key, id: item.id });
    toast(r.message, r.ok ? "ok" : "err");
    onSaved();
  };
  return /* @__PURE__ */ h("div", { style: { marginBottom: open ? 12 : 4, borderTop: "1px solid var(--ab-line)", paddingTop: 8 } }, /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginBottom: open ? 6 : 0 } }, /* @__PURE__ */ h("b", null, who), /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, p.list.length + " 条"), /* @__PURE__ */ h("div", { className: "ab-spacer" }), open && changed ? /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: async () => {
    const r = await post("/insights/save", { key: p.key, list: text.split("\n") });
    toast(r.message, "ok");
    onSaved();
  } }, "保存") : null, /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => setOpen(!open) }, open ? "收起" : "编辑")), open ? /* @__PURE__ */ h(Fragment, null, p.list.length ? /* @__PURE__ */ h("div", { className: "ab-list", style: { marginBottom: 6 } }, p.list.map((x, i) => /* @__PURE__ */ h("div", { key: x.id || i, className: "ab-li", style: { padding: "4px 0" } }, /* @__PURE__ */ h("div", { className: "body ab-small" }, x.text), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => {
    if (window.confirm("删掉这条相处经验？\n\n" + x.text.slice(0, 60))) delOne(i);
  } }, "删")))) : null, /* @__PURE__ */ h("textarea", { className: "ab-textarea", style: { minHeight: 70, fontFamily: "inherit" }, value: text, onChange: (e) => setText(e.target.value), placeholder: "一行一条经验" }), /* @__PURE__ */ h(StyleEditor, { k: p.key, label: "说话方式", list: style || [], toast, onSaved })) : null);
}
function MemoryRow({ m, onChanged, toast }) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(m.text);
  if (m.invalidAt) {
    return /* @__PURE__ */ h("div", { className: "ab-li", style: { opacity: 0.6 } }, /* @__PURE__ */ h("div", { className: "meta" }, timeAgo(m.invalidAt), /* @__PURE__ */ h("br", null), /* @__PURE__ */ h("span", { className: "ab-pill", style: { padding: "0 6px", fontSize: 11 } }, "已过时")), /* @__PURE__ */ h("div", { className: "body" }, /* @__PURE__ */ h("s", null, (m.aboutName ? "[" + m.aboutName + "] " : "") + m.text), m.supersededText ? /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "→ 现在是：", m.supersededText) : null), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: async () => {
      await post("/memory/restore", { id: m.id });
      toast("恢复了", "ok");
      onChanged();
    } }, "恢复"), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: async () => {
      await post("/memory/delete", { id: m.id });
      onChanged();
    } }, "删掉"));
  }
  return /* @__PURE__ */ h("div", { className: "ab-li" }, /* @__PURE__ */ h("div", { className: "meta" }, timeAgo(m.at), /* @__PURE__ */ h("br", null), /* @__PURE__ */ h("span", { className: "ab-pill", style: { padding: "0 6px", fontSize: 11 } }, SOURCE[m.source] || "记忆")), edit ? /* @__PURE__ */ h(
    "input",
    {
      className: "ab-input wide",
      value: text,
      onChange: (e) => setText(e.target.value),
      onKeyDown: async (e) => {
        if (e.key === "Enter") {
          await post("/memory/update", { id: m.id, text });
          setEdit(false);
          toast("改好了", "ok");
          onChanged();
        }
        if (e.key === "Escape") setEdit(false);
      }
    }
  ) : /* @__PURE__ */ h("div", { className: "body" }, m.aboutName ? /* @__PURE__ */ h("b", null, "[", m.aboutName, "] ") : null, m.text, m.importance >= 0.8 ? /* @__PURE__ */ h("span", { title: "很重要" }, " ★") : null), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => setEdit(!edit) }, edit ? "取消" : "改一下"), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: async () => {
    await post("/memory/delete", { id: m.id });
    onChanged();
  } }, "忘掉"));
}

// client/src/views/platforms/bili.js
function BiliCookie({ draft, setDraft }) {
  const [show, setShow] = useState(false);
  const b = draft.bili;
  const field = (key2, prefix, setKey, hintKey, ph) => /* @__PURE__ */ h("div", { className: "ab-flex", style: { flexWrap: "nowrap", marginBottom: 6 } }, /* @__PURE__ */ h("code", { className: "ab-small", style: { minWidth: 82, textAlign: "right" } }, prefix), /* @__PURE__ */ h(
    "input",
    {
      className: "ab-input wide",
      type: show ? "text" : "password",
      autoComplete: "off",
      spellCheck: false,
      value: b[key2] || "",
      placeholder: b[setKey] ? "已保存（结尾 " + (b[hintKey] || "…") + "），不改就留空" : ph,
      onChange: (e) => setDraft(setPath(draft, "bili." + key2, e.target.value.trim()))
    }
  ));
  return /* @__PURE__ */ h(
    Row,
    {
      label: "B 站 Cookie",
      hint: "浏览器登录 bilibili.com 后从 F12 里复制 SESSDATA 和 bili_jct；也可以直接粘整串 Cookie，会自动拆开。不填也能看视频，但不能评论和回复。建议用小号",
      more: "取 Cookie 的路径：电脑浏览器登录 bilibili.com → F12 → 「应用」（Application）→ Cookie → bilibili.com，分别复制 SESSDATA 和 bili_jct 这两行的「值」。只存在本机；没有 AI 字幕、评论、回复这些登录能力。"
    },
    /* @__PURE__ */ h("div", { style: { flex: 1 } }, field("sessdata", "SESSDATA=", "sessdataSet", "sessdataHint", "粘贴 SESSDATA 的值"), field("biliJct", "bili_jct=", "biliJctSet", "biliJctHint", "粘贴 bili_jct 的值"), /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { small: true, onClick: () => setShow(!show) }, show ? "隐藏" : "显示"), b.sessdataSet || b.biliJctSet ? /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => {
      if (confirm("清空保存的 B 站 Cookie？")) setDraft(setPath(setPath(setPath(draft, "bili.sessdata", null), "bili.biliJct", null), "bili.cookie", null));
    } }, "清空") : null, /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "「显示」看的是正在填的内容；保存过的出于安全不回传，只显示结尾几位")))
  );
}
var BILI_KIND = { watch: "看了", comment: "评论", reply: "回复", share: "分享给你", shot: "发你截图", error: "没成功" };
function BiliModel({ draft, setDraft }) {
  const [list, setList] = useState(null);
  useEffect(() => {
    get("/models").then((r) => setList(r.list || [])).catch(() => setList([]));
  }, []);
  const m = draft.bili && draft.bili.model || {};
  const cur = m.provider && m.model ? m.provider + "::" + m.model : "";
  const labelOf = (x) => (x.name && x.name !== x.model ? x.name : x.model) + (x.model && x.name !== x.model ? "（" + x.model + "）" : "");
  const options = [{ value: "", label: "跟随全局模型", desc: "和聊天用的一样" }].concat((list || []).map((x) => ({ value: x.provider + "::" + x.model, label: labelOf(x), desc: x.provider, group: x.provider })));
  if (cur && !options.some((o) => o.value === cur)) options.push({ value: cur, label: m.model, desc: m.provider + "（DSH 里没找到）" });
  return /* @__PURE__ */ h(
    Card,
    {
      title: "B 站用的模型",
      desc: "B 站自己单独用一个模型：定时刷（挑关键词、决定评论 / 回复 / 分享）和抽帧看画面都走它，聊天还是用全局模型。留空就跟随全局。",
      more: "需要商店里的「B站」模块 1.2.0 以上。看画面要选能看图的模型，选了个不能看图的会自动跳过看画面、只读文字。切换从下一轮刷 B 站起生效。"
    },
    /* @__PURE__ */ h(Row, { label: "刷 B 站用什么" }, /* @__PURE__ */ h(
      Select,
      {
        value: cur,
        width: 280,
        options,
        onChange: (v) => {
          const [provider, ...model] = v.split("::");
          setDraft(setPath(draft, "bili.model", v ? { ...m, provider, model: model.join("::") } : { ...m, provider: "", model: "" }));
        }
      }
    )),
    list === null ? /* @__PURE__ */ h("div", { className: "ab-small ab-muted" }, "模型列表加载中…") : null
  );
}
function Bili({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState("");
  const [shots, setShots] = useState(null);
  const load = () => get("/bili/state").then(setS).catch((e) => toast(e.message, "err"));
  const loadShots = () => get("/bili/shots").then((r) => setShots(r.items || [])).catch((e) => {
    setShots([]);
    toast(e.message, "err");
  });
  useEffect(() => {
    load();
    loadShots();
  }, []);
  const act = (path, label) => async () => {
    setBusy(label);
    const r = await post(path);
    setBusy("");
    toast(r.message, r.ok ? "ok" : "err");
    load();
    loadShots();
  };
  const acct = s && s.account;
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(
    Card,
    {
      title: "刷 B 站",
      right: f.sw("bili.enabled"),
      desc: "她会定时去 B 站刷几个视频：从她的兴趣、记忆里你喜欢的东西和下面的关键词里挑方向，读简介、字幕和热评，再决定评不评论、要不要私聊分享给你、记住什么。",
      more: "看过的、评过的都记成她的经历，聊天时会自然提起。你在 QQ 里发 B 站链接或分享卡片，她也能点进去看完再聊。"
    },
    /* @__PURE__ */ h(BiliCookie, { draft, setDraft }),
    /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 4 } }, /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
      const r = await get("/bili/account");
      setS({ ...s || {}, account: r });
    } }, "检查登录"), acct ? /* @__PURE__ */ h("span", { className: "ab-small", style: { color: acct.isLogin ? "var(--ab-ok)" : "var(--ab-warn)" } }, acct.isLogin ? "已登录：" + acct.uname : "没登录（只能看，不能评论）") : null)
  ), /* @__PURE__ */ h(Card, { title: "怎么刷", desc: "只在「主动搭话」里设的醒着时间内刷。" }, /* @__PURE__ */ h(Row, { label: "定时自己去刷" }, f.sw("bili.autoBrowse")), /* @__PURE__ */ h(Row, { label: "多久刷一轮" }, f.range("bili.intervalHours", 1, 24, 1, (v) => v + " 小时")), /* @__PURE__ */ h(Row, { label: "每天最多刷" }, f.range("bili.maxRunsPerDay", 0, 12, 1, (v) => v + " 轮")), /* @__PURE__ */ h(Row, { label: "一轮看几个视频" }, f.range("bili.perRun", 1, 6, 1, (v) => v + " 个")), /* @__PURE__ */ h(Row, { label: "额外想看的方向", hint: "一行一个；另外还会参考她的兴趣和记忆" }, f.list("bili.keywords", { placeholder: "白米饭 做法\n猫咪\n游戏解说" })), /* @__PURE__ */ h(Row, { label: "播放量门槛" }, f.num("bili.minViews", { min: 0, fallback: 5e3 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "次以上")), /* @__PURE__ */ h(Row, { label: "只看最近" }, f.num("bili.maxAgeDays", { min: 0, fallback: 60 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "天内发的（0 = 不限）"))), /* @__PURE__ */ h(BiliModel, { draft, setDraft }), /* @__PURE__ */ h(
    Card,
    {
      title: "看画面（抽帧 + 视觉）",
      desc: "默认只读标题、简介、字幕和热评。打开后用 ffmpeg 抽帧交给视觉模型，截图保存到本机，可以在 QQ 聊天里让她挑一张发送。",
      more: "没有 ffmpeg、模型明确不支持图片或处理失败时，自动继续文字阅读，不会卡住。"
    },
    /* @__PURE__ */ h(Row, { label: "让她看画面", hint: "需要视觉模型 + ffmpeg；关掉就退回只看文字" }, f.sw("bili.vision")),
    /* @__PURE__ */ h(Row, { label: "每个视频抽几帧" }, f.range("bili.visionFrames", 2, 12, 1, (v) => v + " 帧")),
    /* @__PURE__ */ h(Row, { label: "刷完顺手发张截图", hint: "概率；默认 35%，0 = 从不。截图都存在本机，你让她发她也能挑" }, f.range("bili.shotChance", 0, 1, 0.05, (v) => Math.round(v * 100) + "%")),
    /* @__PURE__ */ h(Row, { label: "截图库最多存", hint: "超过就自动删最旧的；下面的截图库里也能一张张手动删" }, f.num("bili.shotLibrary", { min: 20, max: 2e3, fallback: 300 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "张")),
    /* @__PURE__ */ h(Row, { label: "ffmpeg 路径", hint: "留空就自己在 PATH 里找；找不到就填绝对路径" }, f.text("bili.ffmpegPath", { placeholder: "C:\\ffmpeg\\bin\\ffmpeg.exe" })),
    s && s.vision ? /* @__PURE__ */ h("div", { className: "ab-small", style: { marginTop: 4, color: s.vision.ffmpeg ? "var(--ab-ok)" : "var(--ab-warn)" } }, (s.vision.ffmpeg ? "✓ 已找到 ffmpeg：" + s.vision.ffmpeg : "✗ 没找到 ffmpeg：抽帧会被跳过，装一个或者在上面填路径") + (s.shots ? "　·　手上存了 " + s.shots.count + " 张截图" : "")) : null
  ), /* @__PURE__ */ h(Card, { title: "截图库" + (shots ? "（" + shots.length + " / " + (draft.bili && draft.bili.shotLibrary || 300) + "）" : ""), right: /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: loadShots }, "刷新")) }, !shots ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : (shots || []).length === 0 ? /* @__PURE__ */ h(Empty, { icon: "🎬", text: "还没有截图。打开上面的「让她看画面」刷一轮 B 站，就会开始截。" }) : /* @__PURE__ */ h("div", { className: "ab-shots" }, (shots || []).map((it) => /* @__PURE__ */ h(ShotCell, { key: it.file, it, onChanged: () => {
    loadShots();
    load();
  }, toast })))), /* @__PURE__ */ h(Card, { title: "评论、回复和分享", desc: "评论和回复要登录。试运行开着时只记日志不发。" }, /* @__PURE__ */ h(Row, { label: "自己发评论" }, f.sw("bili.comment"), /* @__PURE__ */ h("span", { className: "ab-muted" }, "每天最多"), f.num("bili.maxCommentsPerDay", { min: 0, max: 50, fallback: 3 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "条")), /* @__PURE__ */ h(Row, { label: "回别人回她的评论" }, f.sw("bili.reply"), /* @__PURE__ */ h("span", { className: "ab-muted" }, "每天最多"), f.num("bili.maxRepliesPerDay", { min: 0, max: 100, fallback: 6 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "条")), /* @__PURE__ */ h(Row, { label: "看到好玩的分享给你", hint: "私聊发给主人，带视频链接" }, f.sw("bili.shareToOwner")), /* @__PURE__ */ h(Row, { label: "顺手点赞" }, f.sw("bili.like"))), /* @__PURE__ */ h(
    Card,
    {
      title: "她刷过什么",
      right: /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { small: true, onClick: act("/bili/replies", "replies"), disabled: !!busy }, busy === "replies" ? "正在看…" : "看看有没有人回她"), /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: act("/bili/run", "run"), disabled: !!busy }, busy === "run" ? /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h("i", { className: "ab-spin" }), " 正在刷…") : "现在刷一轮"))
    },
    s && s.pauseReason ? /* @__PURE__ */ h("div", { className: "ab-note warn", style: { marginBottom: 8 } }, "今天先不发评论和回复了：", s.pauseReason, "（明天自动恢复；Cookie 过期的话重新复制一份填上）") : null,
    s ? /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginBottom: 8 } }, "今天自动刷了 ", s.runs, " 轮 · 评论 ", s.comments, " 条 · 回复 ", s.replies, " 条", s.lastRun ? " · 上次 " + timeAgo(s.lastRun) : "", "（手动刷不占次数）") : null,
    !s ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : (s.history || []).length === 0 ? /* @__PURE__ */ h(Empty, { icon: "📺", text: "还没刷过。点「现在刷一轮」试试。" }) : /* @__PURE__ */ h("div", { className: "ab-list" }, (s.history || []).map((x, i) => /* @__PURE__ */ h("div", { key: i, className: "ab-li" }, /* @__PURE__ */ h("div", { className: "meta" }, timeAgo(x.at), /* @__PURE__ */ h("br", null), BILI_KIND[x.kind] || x.kind), /* @__PURE__ */ h("div", { className: "body" }, x.bvid ? /* @__PURE__ */ h("a", { href: "https://www.bilibili.com/video/" + x.bvid, target: "_blank", rel: "noreferrer" }, "《", x.title, "》") : /* @__PURE__ */ h("b", null, "《", x.title, "》"), x.text ? /* @__PURE__ */ h("div", { className: "ab-muted" }, x.text) : null))))
  ));
}
function ShotCell({ it, onChanged, toast }) {
  const src = API + "/bili/shot/image?file=" + encodeURIComponent(it.file);
  const cap = (it.title ? "《" + it.title + "》" : "截图") + (it.clock ? "　" + it.clock : "");
  return /* @__PURE__ */ h("div", { className: "ab-shot" }, /* @__PURE__ */ h("a", { href: src, target: "_blank", rel: "noreferrer" }, /* @__PURE__ */ h("img", { src, alt: cap, loading: "lazy" })), /* @__PURE__ */ h("div", { className: "cap", title: it.note || "" }, cap), /* @__PURE__ */ h(
    "button",
    {
      type: "button",
      className: "ab-btn sm danger x",
      title: "删除",
      onClick: async () => {
        if (!confirm("删掉这张截图？\n" + cap)) return;
        const r = await post("/bili/shot/delete", { file: it.file });
        toast(r.message || "删掉了", r.ok ? "ok" : "err");
        onChanged();
      }
    },
    "✕"
  ));
}

// client/src/views/platforms/douyin.js
var DOUYIN_KIND = { watch: "看了", look: "点开看", like: "点赞", comment: "评论", share: "分享给你", dm: "回你私信", "dry:dm": "试运行·私信", "dry:like": "试运行·点赞", "dry:comment": "试运行·评论", error: "没成功" };
function Douyin({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState("");
  const [login, setLogin] = useState(null);
  const load = () => get("/douyin/state").then(setS);
  useEffect(() => {
    load();
  }, []);
  const act = (path, label, body) => async () => {
    setBusy(label);
    const r = await post(path, body);
    setBusy("");
    toast(r.message || (r.ok ? "好了" : "没成功"), r.ok ? "ok" : "err");
    load();
  };
  useEffect(() => {
    if (!login) return void 0;
    const t = setInterval(async () => {
      const r = await get("/douyin/login/status");
      if (r.loggedIn) {
        setLogin(null);
        toast(r.message, "ok");
        load();
      } else if (r.ok) setLogin(r);
    }, 2500);
    return () => clearInterval(t);
  }, [Boolean(login)]);
  const startLogin = async () => {
    setBusy("login");
    const r = await post("/douyin/login");
    setBusy("");
    if (r.loggedIn) {
      toast(r.message, "ok");
      load();
    } else if (r.ok) setLogin(r);
    else toast(r.message || "打不开浏览器", "err");
  };
  const acct = s && s.account;
  const acctText = !acct || acct.unknown ? /* @__PURE__ */ h("span", { className: "ab-small ab-muted" }, "还没检查过") : /* @__PURE__ */ h("span", { className: "ab-small", style: { color: acct.loggedIn ? "var(--ab-ok)" : "var(--ab-warn)" } }, acct.loggedIn ? "已登录：" + (acct.nickname || "") : acct.message || acct.error || "还没登录", acct.at ? /* @__PURE__ */ h("span", { className: "ab-muted" }, " · ", timeAgo(acct.at), "查的") : null);
  const caps = s && s.caps || {};
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(
    Card,
    {
      title: "刷抖音",
      right: f.sw("douyin.enabled"),
      desc: "她用一个专用浏览器（独立的登录资料，不碰你平时用的浏览器）刷抖音：定时打开推荐，一个个点开看，读标题、分类、内容摘要和热评，再决定点不点赞、评不评论（特别想让你看的会在评论里 @你）、要不要分享给你。总开关默认关：先扫码登录，再打开。",
      more: "浏览器窗口放在屏幕外，不抢前台。你在 QQ 里发抖音链接，她也能点开看完再聊。"
    },
    /* @__PURE__ */ h(Row, { label: "抖音账号", hint: "建议用小号。扫一次码就行，登录状态存在专用浏览器里" }, /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: startLogin, disabled: !!busy || !!login }, busy === "login" ? "正在打开浏览器…" : login ? "等你扫码…" : "扫码登录"), /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
      setBusy("check");
      const r = await get("/douyin/account");
      setBusy("");
      setS({ ...s || {}, account: r });
    }, disabled: !!busy }, busy === "check" ? "检查中…" : "检查登录"), acctText), login ? /* @__PURE__ */ h("div", { style: { marginTop: 10, display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" } }, login.shot ? /* @__PURE__ */ h("img", { src: login.shot, alt: "抖音登录", style: { maxWidth: 360, width: "100%", borderRadius: 10, border: "1px solid var(--ab-line)", background: "#fff" } }) : /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "二维码还没出来，稍等…"), /* @__PURE__ */ h("div", { className: "ab-small", style: { flex: 1, minWidth: 160 } }, /* @__PURE__ */ h("div", null, login.message || "用抖音 App 扫码"), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 8 } }, /* @__PURE__ */ h(Btn, { small: true, onClick: act("/douyin/window", "win", { visible: true }) }, "显示浏览器窗口"), /* @__PURE__ */ h(Btn, { small: true, onClick: () => setLogin(null) }, "先不登了")))) : null)),
    /* @__PURE__ */ h(Row, { label: "浏览器窗口", hint: "遇到验证码、扫码后要短信验证时，挪到屏幕上处理" }, /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { small: true, onClick: act("/douyin/window", "win", { visible: true }), disabled: !!busy }, "显示浏览器窗口"), /* @__PURE__ */ h(Btn, { small: true, onClick: act("/douyin/window", "win", { visible: false }), disabled: !!busy }, "收起窗口"))),
    /* @__PURE__ */ h(Row, { label: "浏览器路径", hint: "留空 = 自动找 Edge（找不到再找 Chrome / Chromium）" }, f.text("douyin.browserPath", { size: "wide", placeholder: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" }))
  ), /* @__PURE__ */ h(
    Card,
    {
      title: "主人抖音号",
      desc: "填你的抖音号或主页链接，点「核对」。核对过之后，她刷到特别想让你看的视频，会在评论里真的 @你（你会收到抖音通知；认不出你就不发，不会发假 @）。改了输入要重新核对。"
    },
    /* @__PURE__ */ h(Row, { label: "你的抖音号 / 主页链接" }, f.text("douyin.owner.input", { size: "wide", placeholder: "抖音号，或 https://www.douyin.com/user/…" })),
    /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 4 } }, /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: act("/douyin/confirm-owner", "confirm", { input: ((draft.douyin || {}).owner || {}).input || "" }), disabled: !!busy }, busy === "confirm" ? "核对中…" : "核对"), s && s.owner ? /* @__PURE__ */ h("span", { className: "ab-small", style: { color: "var(--ab-ok)" } }, "已核对：", s.owner.nickname) : /* @__PURE__ */ h("span", { className: "ab-small ab-muted" }, "还没核对（不核对就不会 @你）"))
  ), /* @__PURE__ */ h(
    Card,
    {
      title: "抖音私信",
      desc: "你在抖音上私信她，她会用自己的口气回（只认上面核对过的你，别人的私信不理）。让她找视频的话，她会尝试刷一轮再私信分享给你。",
      more: "这条流程仍需实际环境验证。只在「主动搭话」里设的醒着时间内回。"
    },
    /* @__PURE__ */ h(Row, { label: "回你的抖音私信" }, f.sw("douyin.ownerDm")),
    /* @__PURE__ */ h(Row, { label: "评论区接着聊", hint: "她在评论里 @ 过你、你回复那条评论之后，她会看到并用自己的口气接一句（新评论里真 @ 你）。默认关。" }, f.sw("douyin.commentReply")),
    /* @__PURE__ */ h(Row, { label: "多久看一次评论回复" }, f.num("douyin.commentReplyPollMinutes", { min: 1, max: 60, fallback: 5 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "分钟")),
    /* @__PURE__ */ h(Row, { label: "分享卡片后补一句", hint: "抖音私信里发完视频卡片，再跟一句她自己想说的话（有概率触发，默认关）" }, f.sw("douyin.shareDmText")),
    /* @__PURE__ */ h(Row, { label: "多久看一次" }, f.num("douyin.dmPollMinutes", { min: 1, max: 60, fallback: 3 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "分钟"), /* @__PURE__ */ h(Btn, { small: true, onClick: act("/douyin/dms", "dms"), disabled: !!busy }, busy === "dms" ? "正在看…" : "现在看一次"))
  ), /* @__PURE__ */ h(Card, { title: "怎么刷", desc: "只在「主动搭话」里设的醒着时间内自己刷。主人在 QQ 里让她「去刷会儿抖音」也行。" }, /* @__PURE__ */ h(Row, { label: "定时自己去刷" }, f.sw("douyin.autoBrowse")), /* @__PURE__ */ h(Row, { label: "多久刷一轮" }, f.range("douyin.intervalHours", 1, 24, 1, (v) => v + " 小时")), /* @__PURE__ */ h(Row, { label: "每天最多刷" }, f.range("douyin.maxRunsPerDay", 0, 12, 1, (v) => v + " 轮")), /* @__PURE__ */ h(Row, { label: "一轮看几个" }, f.range("douyin.perRun", 1, 10, 1, (v) => v + " 个")), /* @__PURE__ */ h(Row, { label: "每天最多看" }, f.num("douyin.maxWatchPerDay", { min: 0, max: 200, fallback: 30 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "个（含手动）")), /* @__PURE__ */ h(Row, { label: "每个视频停留", hint: "真的在播放；停得越短越不像真人" }, f.num("douyin.dwellMin", { min: 3, fallback: 8 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "～"), f.num("douyin.dwellMax", { min: 3, fallback: 40 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "秒")), /* @__PURE__ */ h(Row, { label: "分享到哪", hint: "抖音私信要先核对你的抖音号；没核对或者发不出去时会改发 QQ" }, f.choices("douyin.shareTo", [
    { value: "douyin", label: "抖音私信", desc: "在抖音里把视频分享给你（只有视频卡片）" },
    { value: "qq", label: "QQ 私聊", desc: "她的话 + 视频链接" },
    { value: "both", label: "两边都发", desc: "抖音里收视频卡片，QQ 上看她说了什么" }
  ])), /* @__PURE__ */ h(Row, { label: "分享给你", hint: "刷到好看的视频，分享给你的积极程度" }, f.choices("douyin.shareBias", [
    { value: "proactive", label: "积极", desc: "好看有趣就分享" },
    { value: "normal", label: "适中", desc: "觉得你会喜欢才分享" },
    { value: "stingy", label: "少分享", desc: "拿不准就不发" }
  ]))), /* @__PURE__ */ h(Card, { title: "每天上限", desc: "刚登录的号前几天上限自动减半（新号猛点赞最容易被风控）。遇到验证码 / 操作频繁当天就停手，看还能看。权限在「权限」页单独设（默认仅主人）。" }, /* @__PURE__ */ h(Row, { label: "点赞" }, f.num("douyin.caps.like", { min: 0, max: 300, fallback: 30 })), /* @__PURE__ */ h(Row, { label: "评论" }, f.num("douyin.caps.comment", { min: 0, max: 30, fallback: 3 })), /* @__PURE__ */ h(Row, { label: "分享给你" }, f.num("douyin.caps.share", { min: 0, max: 30, fallback: 5 })), /* @__PURE__ */ h(Row, { label: "评论里 @你", hint: "也算在评论次数里" }, f.num("douyin.caps.atOwner", { min: 0, max: 30, fallback: 3 })), /* @__PURE__ */ h(Row, { label: "点赞 + 评论合计" }, f.num("douyin.gate.maxWritesPerDay", { min: 1, max: 500, fallback: 30 })), /* @__PURE__ */ h(Row, { label: "两次点赞 / 评论间隔" }, f.num("douyin.gate.minWriteGapSec", { min: 0, max: 600, fallback: 20 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "秒")), /* @__PURE__ */ h(Row, { label: "新号减半" }, f.num("douyin.gate.newAccountDays", { min: 0, max: 30, fallback: 7 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "天"))), /* @__PURE__ */ h(
    Card,
    {
      title: "她刷过什么",
      right: /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { small: true, onClick: load }, "刷新"), /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: act("/douyin/run", "run"), disabled: !!busy || Boolean(s && s.busy) }, s && s.busy ? /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h("i", { className: "ab-spin" }), " 正在刷…") : "现在刷一轮"))
    },
    s && s.pauseReason ? /* @__PURE__ */ h("div", { className: "ab-note warn", style: { marginBottom: 8 } }, "今天先不点赞评论了：", s.pauseReason, "。要验证的话点上面「显示浏览器窗口」处理，明天自动恢复。") : null,
    s ? /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginBottom: 8 } }, "今天自动刷了 " + s.runs + " 轮 · 看了 " + s.watched + " · 赞 " + s.like + "/" + caps.like + " · 评 " + s.comment + "/" + caps.comment + " · 分享 " + s.share + "/" + caps.share + (s.atOwner ? " · @你 " + s.atOwner + "/" + caps.atOwner : ""), s.newAccount ? "（新号，上限减半）" : "", s.lastRun ? " · 上次 " + timeAgo(s.lastRun) : "", s.lastSkipReason ? " · 上次没刷成：" + s.lastSkipReason : "") : null,
    !s ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : (s.history || []).length === 0 ? /* @__PURE__ */ h(Empty, { icon: "📱", text: "还没刷过。先扫码登录、打开开关，再点「现在刷一轮」。" }) : /* @__PURE__ */ h("div", { className: "ab-list" }, (s.history || []).map((x, i) => /* @__PURE__ */ h("div", { key: i, className: "ab-li" }, /* @__PURE__ */ h("div", { className: "meta" }, timeAgo(x.at), /* @__PURE__ */ h("br", null), DOUYIN_KIND[x.kind] || x.kind), /* @__PURE__ */ h("div", { className: "body" }, x.awemeId ? /* @__PURE__ */ h("a", { href: "https://www.douyin.com/video/" + x.awemeId, target: "_blank", rel: "noreferrer" }, x.title || (x.author ? x.author + " 的视频" : x.awemeId)) : null, x.author && x.title ? /* @__PURE__ */ h("span", { className: "ab-muted" }, " · ", x.author) : null, x.text ? /* @__PURE__ */ h("div", { className: "ab-muted" }, (x.atOwner ? "@你 " : "") + (x.via ? "（" + x.via.map((w) => w === "douyin" ? "抖音私信" : "QQ").join(" + ") + "）" : "") + x.text) : null))))
  ));
}

// client/src/views/platforms/heybox.js
var HEYBOX_KIND = { browse: "逛了一圈", like: "点了赞", comment: "发了评论", post: "发了帖", delete: "删了帖" };
var TOPIC_FALLBACK = [
  { value: 7214, label: "盒友杂谈", desc: "最常用，什么都能聊" },
  { value: 18745, label: "数码硬件", desc: "显卡、笔记本、外设" },
  { value: 806933, label: "AI", desc: "AI 相关，容易涨浏览" }
];
function Heybox({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState("");
  const [hot, setHot] = useState(null);
  const [cookieText, setCookieText] = useState("");
  const [topics, setTopics] = useState(null);
  const load = () => get("/heybox/state").then(setS);
  const loadTopics = () => get("/heybox/topics").then(setTopics).catch(() => {
  });
  useEffect(() => {
    load();
    loadTopics();
  }, []);
  const refreshTopics = async () => {
    setBusy("topics");
    try {
      const r = await post("/heybox/topics/refresh");
      toast(r.message || "已刷新", r.ok === false ? "err" : "ok");
      if (r.ok !== false) setTopics(r);
    } catch {
      toast("刷新失败", "err");
    }
    setBusy("");
  };
  const act = (path, label, body) => async () => {
    setBusy(label);
    const r = await post(path, body);
    setBusy("");
    toast(r.message || (r.ok ? "好了" : "没成功"), r.ok === false ? "err" : "ok");
    load();
  };
  const checkAccount = async () => {
    setBusy("account");
    const r = await get("/heybox/account");
    setBusy("");
    toast(r.message || (r.loggedIn ? "已登录：" + (r.nickname || "") : "没登录"), r.loggedIn ? "ok" : "err");
    load();
  };
  const loadHot = async () => {
    setBusy("hot");
    const r = await post("/heybox/hot");
    setBusy("");
    if (r.ok === false) {
      toast(r.message || "拉不到热榜", "err");
      return;
    }
    setHot(r);
    load();
  };
  const saveCookie = async () => {
    if (!cookieText.trim()) {
      toast("先把 Cookie 粘进来", "err");
      return;
    }
    setBusy("cookie");
    const r = await post("/heybox/login-cookie", { cookie: cookieText });
    setBusy("");
    toast(r.message || (r.ok ? "存好了" : "没成功"), r.ok === false ? "err" : "ok");
    if (r.ok) setCookieText("");
    load();
  };
  const acct = s && s.account;
  const acctText = !acct || !acct.checkedAt ? /* @__PURE__ */ h("span", { className: "ab-small ab-muted" }, "还没检查过") : /* @__PURE__ */ h("span", { className: "ab-small", style: { color: acct.loggedIn ? "var(--ab-ok)" : "var(--ab-warn)" } }, acct.loggedIn ? "已登录：" + (acct.nickname || "") + (acct.heyboxId ? "（id " + acct.heyboxId + "）" : "") : acct.message || "还没登录", acct.checkedAt ? /* @__PURE__ */ h("span", { className: "ab-muted" }, " · ", timeAgo(acct.checkedAt), "查的") : null);
  const quota = s && s.quota || {};
  const limits = s && s.limits || {};
  const topicOptions = (() => {
    const live = topics && Array.isArray(topics.list) && topics.list.length && topics.live !== false;
    const opts = live ? topics.list.map((t) => ({ value: Number(t.id) || t.id, label: String(t.name || t.id) })) : TOPIC_FALLBACK.slice();
    const cur = draft && draft.heybox && draft.heybox.defaultTopic;
    if (cur !== void 0 && cur !== null && cur !== "" && !opts.some((o) => o.value === cur)) {
      opts.unshift({ value: cur, label: "当前分区（" + cur + "）" });
    }
    return opts;
  })();
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(
    Card,
    {
      title: "刷小黑盒",
      right: f.sw("heybox.enabled"),
      desc: "用你的小黑盒账号逛游戏社区：定时看信息流、读帖子正文和热评，按性格决定点不点赞、评不评论；她自己会写帖子（先看热榜找角度，再看社区高赞帖在聊什么）。配图她自己准备：本机图片最多 4 张，传小黑盒图床插进正文，哪张传不上就跳过哪张、不影响发帖，发完把链接报给你。写操作各有权限（「权限」页，默认仅主人），每天有额度上限。"
    },
    /* @__PURE__ */ h(Row, { label: "小黑盒账号", hint: "从浏览器登录后把整串 Cookie 粘到下面。pkey 必须有；想让它能点赞评论发帖，还要有 x_xhh_tokenid（F12 → Application → Cookies 里能复制到）" }, /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { small: true, onClick: checkAccount, disabled: !!busy }, busy === "account" ? "检查中…" : "检查登录"), acctText), /* @__PURE__ */ h("div", { style: { marginTop: 10, display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" } }, /* @__PURE__ */ h(
      "textarea",
      {
        className: "ab-input",
        rows: 3,
        spellCheck: false,
        style: { flex: 1, minWidth: 260, fontFamily: "monospace", fontSize: 12 },
        placeholder: "pkey=…; heybox_id=…; x_xhh_tokenid=…",
        value: cookieText,
        onChange: (e) => setCookieText(e.target.value)
      }
    ), /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: saveCookie, disabled: !!busy }, busy === "cookie" ? "保存中…" : "保存 Cookie")), s && s.hasCookie ? /* @__PURE__ */ h("div", { className: "ab-small", style: { marginTop: 6, color: s.hasToken ? "var(--ab-ok)" : "var(--ab-warn)" } }, s.hasToken ? "✓ 有 pkey 和 x_xhh_tokenid，读写都能用" : "⚠ 只有 pkey，没有 x_xhh_tokenid：点赞 / 评论 / 发帖大概率会被拒") : null))
  ), /* @__PURE__ */ h(Card, { title: "她的逛法", desc: "只在「主动搭话」里设的醒着时间内自己逛。主人在 QQ 里让她「去逛逛小黑盒」也行。逛是只读的，不会乱点赞评论。" }, /* @__PURE__ */ h(Row, { label: "定时自己去逛" }, f.sw("heybox.autoBrowse")), /* @__PURE__ */ h(Row, { label: "多久逛一圈" }, f.range("heybox.intervalHours", 1, 24, 1, (v) => v + " 小时")), /* @__PURE__ */ h(Row, { label: "一圈看几条" }, f.range("heybox.perRun", 1, 10, 1, (v) => v + " 条")), /* @__PURE__ */ h(Row, { label: "每天最多逛" }, f.range("heybox.maxRunsPerDay", 0, 12, 1, (v) => v + " 轮"))), /* @__PURE__ */ h(
    Card,
    {
      title: "每天上限",
      desc: "小黑盒的帖详情和搜索接口查太勤会弹验证码（还可能连坐浏览器登录态），所以额度别设太大。搜索被挡时她会自动降级去翻信息流，不会反复硬试。"
    },
    /* @__PURE__ */ h(Row, { label: "点赞" }, f.num("heybox.likeDaily", { min: 0, max: 60, fallback: 10 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "次/天")),
    /* @__PURE__ */ h(Row, { label: "评论" }, f.num("heybox.commentDaily", { min: 0, max: 30, fallback: 3 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "条/天")),
    /* @__PURE__ */ h(Row, { label: "发帖" }, f.num("heybox.maxPostsPerDay", { min: 0, max: 5, fallback: 3 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "篇/天（建议别超过 3）")),
    /* @__PURE__ */ h(Row, { label: "发帖风格", hint: "她写帖时按这个口吻来。也可以让她单次换：跟她说「用日记风格发一篇」" }, f.select("heybox.postStyle", [
      { value: "diary", label: "大肥鱼日记", desc: "第一人称随手记，跟空间日记一个味，120-300字" },
      { value: "news", label: "热搜文", desc: "报道新闻体，摆具体数字，200-800字" },
      { value: "mix", label: "肥鱼热搜", desc: "用日记口吻写热搜，150-500字" }
    ], { width: 220 })),
    /* @__PURE__ */ h(Row, { label: "发帖默认分区", hint: "文章帖必须挂分区，否则会报「请添加分区」。分区全表每天自动拉一次；拉不到就用内置的三个保底" }, /* @__PURE__ */ h("div", { className: "ab-flex" }, f.select("heybox.defaultTopic", topicOptions, { width: 200 }), /* @__PURE__ */ h(Btn, { small: true, onClick: refreshTopics, disabled: !!busy }, busy === "topics" ? "刷新中…" : "刷新分区"), topics ? /* @__PURE__ */ h("span", { className: "ab-small ab-muted" }, topics.live === false ? "接口没返回，用内置保底" : (topics.count || (topics.list || []).length) + " 个分区 · " + (topics.cached ? "今天已更新" : "刚更新")) : null)),
    s ? /* @__PURE__ */ h(Row, { label: "今天已经用掉", hint: "到 0 就等明天，或者手动清零（重启一次会话不会重置）" }, /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h("span", { className: "ab-small ab-muted" }, "逛 " + (quota.browse || 0) + "/" + (limits.maxRunsPerDay || 0) + " · 赞 " + (quota.like || 0) + "/" + (limits.likeDaily || 0) + " · 评 " + (quota.comment || 0) + "/" + (limits.commentDaily || 0) + " · 帖 " + (quota.post || 0) + "/" + (limits.maxPostsPerDay || 0)), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: act("/heybox/clear-quota", "quota") }, busy === "quota" ? "清零中…" : "清零"))) : null
  ), /* @__PURE__ */ h(
    Card,
    {
      title: "热榜预览",
      right: /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { small: true, onClick: load }, "刷新"), /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: loadHot, disabled: !!busy }, busy === "hot" ? "拉取中…" : "看热榜")),
      desc: "她写帖前会先看这个（热榜 → 搜社区 → 找具体素材）。这里只是让你看看现在有什么题，热榜里电竞和商业新闻不适合这个号。"
    },
    !hot ? /* @__PURE__ */ h(Empty, { icon: "🔥", text: "点右上角「看热榜」，看看现在小黑盒在热议什么。" }) : (hot.list || []).length === 0 ? /* @__PURE__ */ h(Empty, { icon: "🔥", text: "热榜是空的，可能接口变了。" }) : /* @__PURE__ */ h("div", { className: "ab-list" }, (hot.list || []).map((x, i) => /* @__PURE__ */ h("div", { key: i, className: "ab-li" }, /* @__PURE__ */ h("div", { className: "meta" }, String(i + 1)), /* @__PURE__ */ h("div", { className: "body" }, x.text, x.tag ? /* @__PURE__ */ h("span", { className: "ab-muted" }, "  [", x.tag, "]") : null))))
  ), /* @__PURE__ */ h(Card, { title: "发帖自检（她发之前自己过一遍）", desc: "这几条写在她的规则里，不满足就不发。你也可以照着看，她要发的帖哪条对不上就让改。" }, /* @__PURE__ */ h("div", { className: "ab-note", style: { marginBottom: 8, whiteSpace: "pre-line" } }, [
    "① 先看热榜挑题（不许跳过），挑不出来就说今天没合适的，别硬凑。",
    "② 再看社区高赞帖在聊什么角度，可以借角度但用自己的话。",
    "③ 素材里必须有具体的东西：价格、销量、时长、机制名、star 增速——没具体信息就是水文。",
    "④ 标题别和正文第一行重复；不编造第一人称经历；正文符合所选风格的字数（日记 120-300 / 热搜文 200-800 / 肥鱼热搜 150-500）；配图最多 4 张，至少 3 张更好。",
    "⑤ 不碰政治、医疗法律建议、评价真人、判断价格是否合理；读一遍像不像人话（转折词堆砌就是 AI 腔）。"
  ].join("\n")), /* @__PURE__ */ h("div", { className: "ab-note warn" }, "格式上的坑（已修在内核里）：帖子类型必须是「文章」(link_tag=11) 才能解析 HTML 并把图插在文字中间；分区 id 必须真实存在（上面下拉里列出来的都行，内置保底 7214 / 18745 / 806933），乱填会一直报「错误的帖子类型」。")), /* @__PURE__ */ h(
    Card,
    {
      title: "她逛过什么",
      right: /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { small: true, onClick: load }, "刷新"), /* @__PURE__ */ h(Btn, { small: true, kind: "primary", onClick: act("/heybox/run", "run"), disabled: !!busy }, busy === "run" ? "正在逛…" : "现在逛一圈"))
    },
    s && s.lastSkipReason ? /* @__PURE__ */ h("div", { className: "ab-note warn", style: { marginBottom: 8 } }, "上次没逛成：", s.lastSkipReason) : null,
    s ? /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginBottom: 8 } }, s.lastRun ? "上次逛：" + timeAgo(s.lastRun) : "还没逛过") : null,
    !s ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : (s.history || []).length === 0 ? /* @__PURE__ */ h(Empty, { icon: "📭", text: "还没逛过。先填 Cookie、打开开关，再点「现在逛一圈」。" }) : /* @__PURE__ */ h("div", { className: "ab-list" }, (s.history || []).map((x, i) => /* @__PURE__ */ h("div", { key: i, className: "ab-li" }, /* @__PURE__ */ h("div", { className: "meta" }, timeAgo(x.at), /* @__PURE__ */ h("br", null), HEYBOX_KIND[x.kind] || x.kind), /* @__PURE__ */ h("div", { className: "body" }, x.linkId ? /* @__PURE__ */ h("a", { href: "https://www.xiaoheihe.cn/app/bbs/link/" + x.linkId, target: "_blank", rel: "noreferrer" }, x.title || x.linkId) : null, x.text ? /* @__PURE__ */ h("div", { className: "ab-muted" }, x.text) : null, x.count ? /* @__PURE__ */ h("div", { className: "ab-muted" }, "看了 ", x.count, " 条") : null))))
  ));
}

// client/src/views/platforms/multiparser.js
function MultiParser({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  const [testUrl, setTestUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [status, setStatus] = useState(null);
  const loadStatus = () => get("/multi-parser/status").then((r) => r.ok && setStatus(r)).catch(() => {
  });
  useEffect(() => {
    loadStatus();
  }, []);
  const doTest = async () => {
    if (!testUrl.trim()) return toast("请先输入要测试的平台链接", "err");
    setBusy(true);
    setTestResult(null);
    try {
      const r = await post("/multi-parser/test", { url: testUrl.trim() });
      setBusy(false);
      if (!r.ok) return toast(r.message || "解析失败", "err");
      setTestResult(r.result);
      toast("解析成功！", "ok");
    } catch (e) {
      setBusy(false);
      toast("请求失败：" + e.message, "err");
    }
  };
  const platforms = [
    { key: "bilibili", label: "Bilibili 视频 / 动态 / 专栏 / 短链" },
    { key: "douyin", label: "抖音视频 / 汽水音乐" },
    { key: "redbook", label: "小红书笔记 / 视频 / 图集" },
    { key: "weibo", label: "微博博文 / 高清大图 / 视频" },
    { key: "zhihu", label: "知乎问答 / 专栏文章 / 想法" },
    { key: "wechat", label: "微信公众号文章" },
    { key: "tieba", label: "百度贴吧帖子 / 楼主正文与配图" },
    { key: "fanqie", label: "番茄小说书名 / 简介 / 封面" },
    { key: "github", label: "GitHub 公开仓库卡片 / Star" },
    { key: "xiaoheihe", label: "小黑盒社区资讯" }
  ];
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(
    Card,
    {
      title: "多平台内容解析",
      right: f.sw("multiParser.enabled"),
      desc: "自动识别聊天中的多平台链接（B站、小红书、微博、知乎、抖音、公众号等），提取无水印视频、高清图集与摘要；可自动发送媒体，并可作为上下文喂给她。"
    },
    /* @__PURE__ */ h(Row, { label: "群聊里提供解析", hint: "关掉后群里发链接完全不管（不发卡片、不下载视频）。只想在私聊用就关掉它。" }, f.sw("multiParser.inGroups")),
    /* @__PURE__ */ h(Row, { label: "私聊里提供解析", hint: "关掉后私聊发链接也不解析，只有群聊生效。" }, f.sw("multiParser.inPrivate")),
    /* @__PURE__ */ h(Row, { label: "这些群不解析", hint: "群号用逗号或空格隔开。列在这里的群即使「群聊里提供解析」开着也不解析。" }, /* @__PURE__ */ h(
      ListInput,
      {
        value: Array.isArray(draft.multiParser?.disabledGroups) ? draft.multiParser.disabledGroups : [],
        numbers: true,
        style: { width: "100%" },
        placeholder: "例如 123456789, 987654321",
        onChange: (list) => setDraft((prev) => setPath(prev, "multiParser.disabledGroups", list))
      }
    )),
    /* @__PURE__ */ h(Row, { label: "大模型上下文注入", hint: "开启后，自动将解析出的标题、作者、正文摘要喂给她，让她能看懂群友分享并自然接话讨论；关闭则仅作为纯工具运行。" }, f.sw("multiParser.feedToAi")),
    /* @__PURE__ */ h(Row, { label: "纯解析：解析后不让她接话", hint: "开启后，只要解析成功就只发卡片和媒体，不再唤醒她回复这条消息。适合视频类内容——她看不到画面，硬接话只能靠标题和分享口令里的字去编。" }, f.sw("multiParser.muteAi")),
    /* @__PURE__ */ h(Row, { label: "发送解析媒体到 QQ", hint: "开启后将解析出的无水印视频或高清图集直接发送到聊天中。" }, f.sw("multiParser.sendMedia")),
    /* @__PURE__ */ h(Row, { label: "图文发送策略", hint: "多图时是否打包为 QQ 聊天记录合并转发卡片（防刷屏）。" }, f.select("multiParser.forwardMode", [
      { value: "threshold", label: "超过图片阈值时合并转发 (推荐)" },
      { value: "always", label: "总是使用合并转发卡片" },
      { value: "never", label: "逐条发送普通图片消息" }
    ], { width: 220 })),
    /* @__PURE__ */ h(Row, { label: "合并转发图片张数门槛", hint: "达到此图片张数时自动转为合并转发卡片。" }, f.num("multiParser.imageThreshold", { min: 1, max: 20, fallback: 2 }))
  ), /* @__PURE__ */ h(Card, { title: "视频发送策略", desc: "探测到视频链接时的直接发送上限与体积超限处理动作。" }, /* @__PURE__ */ h(Row, { label: "单视频直接发送上限 (MB)", hint: "低于此体积直接在聊天中发送原生播放视频气泡，超过则执行超限动作。" }, f.num("multiParser.maxVideoMB", { min: 5, max: 200, step: 5, fallback: 100 })), /* @__PURE__ */ h(Row, { label: "视频超限处理动作", hint: "当视频体积超出上限时采取的动作。" }, f.select("multiParser.videoOverLimit", [
    { value: "direct_link", label: "发送高速下载直链" },
    { value: "group_file", label: "上传至群文件 (群聊有效)" },
    { value: "notice", label: "仅发送超限文字通知" }
  ], { width: 200 }))), /* @__PURE__ */ h(Card, { title: "支持平台独立开关", desc: "单独控制是否响应特定平台的链接。" }, /* @__PURE__ */ h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "8px 16px", padding: "6px 0" } }, platforms.map((p) => /* @__PURE__ */ h("div", { key: p.key, style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--ab-line)" } }, /* @__PURE__ */ h("span", { style: { fontSize: 13 } }, p.label), f.sw(`multiParser.platforms.${p.key}`))))), /* @__PURE__ */ h(Card, { title: "平台 Cookies 配置（可选）", desc: "为部分平台提供登录后的 Cookie，以获取更高清晰度媒体、避免接口风控或解除未登录限制。留空的平台将走免登录公开接口。" }, [
    { key: "bilibili", label: "B站 Cookie", hint: "用于解析高清视频流及动态；留空自动复用「B站」页已配 Cookie", fallback: (d) => Boolean(d.bili?.cookie || d.bili?.sessdata) },
    { key: "weibo", label: "微博 Cookie", hint: "填写包含 SUB 的 Cookie，可避免微博移动端接口触发 403/418 风控" },
    { key: "redbook", label: "小红书 Cookie", hint: "填写包含 a1、web_session 的 Cookie，提升笔记图集提取稳定性" },
    { key: "zhihu", label: "知乎 Cookie", hint: "填写包含 z_c0 的 Cookie，用于获取知乎完整回答与文章" },
    { key: "tieba", label: "百度贴吧 Cookie", hint: "填写包含 BDUSS 的 Cookie，用于获取贴吧高清原图" },
    { key: "xiaoheihe", label: "小黑盒 Cookie", hint: "留空自动复用「小黑盒」页已配 Cookie", fallback: (d) => Boolean(d.heybox?.cookie) },
    { key: "douyin", label: "抖音 Cookie", hint: "选填，用于抖音网页端接口鉴权" }
  ].map((cp) => {
    const isSet = Boolean(getPath(draft, `multiParser.cookies.${cp.key}Set`));
    const isFallback = !isSet && cp.fallback && cp.fallback(draft);
    const statusBadge = isSet ? /* @__PURE__ */ h("span", { className: "ab-small", style: { color: "var(--ab-ok)", marginLeft: 8 } }, "✓ 已专属配置") : isFallback ? /* @__PURE__ */ h("span", { className: "ab-small", style: { color: "var(--ab-sea)", marginLeft: 8 } }, "✓ 自动复用全局") : null;
    return /* @__PURE__ */ h(Row, { key: cp.key, label: /* @__PURE__ */ h("span", null, cp.label, statusBadge), hint: cp.hint }, f.text(`multiParser.cookies.${cp.key}`, {
      type: "password",
      placeholder: isSet || isFallback ? "●●●●●●（已生效，留空保持不变）" : "粘贴整串 Cookie 或关键字段"
    }));
  })), /* @__PURE__ */ h(Card, { title: "在线测试解析", desc: "粘贴任意受支持的链接，实时测试解析效果并预览结果卡片。" }, /* @__PURE__ */ h("div", { style: { display: "flex", gap: 8, alignItems: "center" } }, /* @__PURE__ */ h(
    "input",
    {
      className: "ab-input",
      style: { flex: 1 },
      placeholder: "例如 https://www.bilibili.com/video/BV... 或 微博/知乎/小红书链接",
      value: testUrl,
      onChange: (e) => setTestUrl(e.target.value)
    }
  ), /* @__PURE__ */ h(Btn, { kind: "primary", disabled: busy, onClick: doTest }, busy ? "解析中…" : "测试解析")), testResult ? /* @__PURE__ */ h("div", { style: { marginTop: 12, padding: 12, background: "var(--ab-card-2)", borderRadius: 8, border: "1px solid var(--ab-line)" } }, /* @__PURE__ */ h("div", { style: { fontWeight: 600, color: "var(--ab-deep)", marginBottom: 4 } }, "[", testResult.platformName, "] ", testResult.title), testResult.author ? /* @__PURE__ */ h("div", { className: "ab-small ab-muted" }, "作者：", testResult.author) : null, testResult.summary ? /* @__PURE__ */ h("div", { className: "ab-small", style: { margin: "6px 0", whiteSpace: "pre-wrap" } }, testResult.summary) : null, testResult.stat ? /* @__PURE__ */ h("div", { className: "ab-small ab-muted" }, testResult.stat) : null, testResult.videoUrl ? /* @__PURE__ */ h("div", { className: "ab-small", style: { color: "var(--ab-ok)", margin: "4px 0" } }, "📹 已嗅探到视频直链") : null, testResult.images && testResult.images.length ? /* @__PURE__ */ h("div", { className: "ab-small ab-muted", style: { marginTop: 4 } }, "🖼️ 共提取到 ", testResult.images.length, " 张图片") : null) : null));
}

// client/src/views/imagegen.js
function PaintGallery({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  const shown = Math.min(50, Math.max(1, Number(draft.imageGen && draft.imageGen.galleryShown) || 20));
  const [data, setData] = useState(null);
  const load = async () => {
    const r = await get("/image/gallery?limit=" + shown).catch(() => null);
    setData(r && r.ok ? r : { items: [], total: 0, dir: "" });
  };
  useEffect(() => {
    load();
  }, [shown]);
  const del = async (file) => {
    if (!confirm("删掉这张画？\n" + file)) return;
    const r = await post("/image/gallery/delete", { file }).catch(() => ({ ok: false }));
    toast(r.message || (r.ok ? "删掉了" : "删除失败"), r.ok ? "ok" : "err");
    load();
  };
  return /* @__PURE__ */ h(
    Card,
    {
      title: "她的画作" + (data ? "（显示最近 " + data.items.length + " 张 / 共 " + data.total + " 张）" : ""),
      desc: "画过的图都存在本机（不会自动删），这里只控制面板显示多少张。",
      right: /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: load }, "刷新"), /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: () => post("/image/open-folder").then((r) => toast(r.message, r.ok ? "ok" : "err")).catch(() => toast("打不开文件夹", "err")) }, "打开文件夹"))
    },
    /* @__PURE__ */ h(Row, { label: "面板显示最近", hint: "最多 50 张；只影响面板显示，不删文件" }, f.num("imageGen.galleryShown", { min: 1, max: 50, fallback: 20 }), /* @__PURE__ */ h("span", { className: "ab-muted" }, "张")),
    data && data.dir ? /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { margin: "4px 0 8px", wordBreak: "break-all" } }, "存图目录：", data.dir) : null,
    !data ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : data.items.length === 0 ? /* @__PURE__ */ h(Empty, { icon: "🎨", text: "她还没画过图。在聊天里说「画一张……」，画好的图会出现在这里。" }) : /* @__PURE__ */ h("div", { className: "ab-shots" }, data.items.map((it) => /* @__PURE__ */ h(PaintCell, { key: it.file, it, onDelete: () => del(it.file) })))
  );
}
function PaintCell({ it, onDelete }) {
  const src = API + "/image/gallery/image?file=" + encodeURIComponent(it.file);
  const cap = it.prompt ? "「" + it.prompt + "」" : "画作";
  const when = it.at ? timeAgo(it.at) : "";
  return /* @__PURE__ */ h("div", { className: "ab-shot" }, /* @__PURE__ */ h("a", { href: src, target: "_blank", rel: "noreferrer" }, /* @__PURE__ */ h("img", { src, alt: cap, loading: "lazy" })), /* @__PURE__ */ h("div", { className: "cap", title: cap }, cap, when ? "　" + when : ""), /* @__PURE__ */ h("button", { type: "button", className: "ab-btn sm danger x", title: "删除", onClick: onDelete }, "✕"));
}
function CodexSub({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  const [status, setStatus] = useState(null);
  const [waiting, setWaiting] = useState(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => get("/image/codex/status").then(setStatus).catch(() => setStatus({ loggedIn: false }));
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    if (!waiting) return void 0;
    let active = true;
    const timer = setInterval(async () => {
      const r = await get("/image/codex/login/status").catch(() => null);
      if (!active || !r) return;
      if (r.state === "done" || r.state === "error") {
        clearInterval(timer);
        setWaiting(null);
        setInput("");
        refresh();
        toast(r.state === "done" ? "登录成功" : r.error || "登录失败");
      }
    }, 2e3);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [Boolean(waiting)]);
  const act = (path, body = {}) => async () => {
    setBusy(true);
    const r = await post(path, body).catch(() => ({ ok: false, message: "请求失败" }));
    setBusy(false);
    if (!r.ok) {
      toast(r.message || "操作失败");
      return;
    }
    setInput("");
    if (path.endsWith("/login")) setWaiting({ url: r.url, needPaste: r.needPaste });
    else {
      setWaiting(null);
      refresh();
      toast(path.endsWith("/logout") ? "已退出 ChatGPT" : path.endsWith("/cancel") ? "已取消登录" : "登录成功");
    }
  };
  return /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "ab-note", style: { margin: "8px 0" } }, "实验性订阅接法：使用非公开图片端点，可用性和额度由账号、工作区及服务端决定。登录信息仅存本机。"), /* @__PURE__ */ h(Row, { label: "ChatGPT 账号" }, /* @__PURE__ */ h("span", { className: "ab-small" }, status === null ? "读取登录状态…" : status.loggedIn ? "已登录：" + (status.email || status.accountId) : "尚未登录"), /* @__PURE__ */ h(Btn, { small: true, onClick: act("/image/codex/login"), disabled: busy || Boolean(waiting) }, "登录 ChatGPT"), status?.loggedIn ? /* @__PURE__ */ h(Btn, { small: true, onClick: act("/image/codex/logout"), disabled: busy }, "退出") : null), waiting ? /* @__PURE__ */ h("div", { className: "ab-note" }, /* @__PURE__ */ h("div", null, waiting.needPaste ? "端口 1455 被占用：打开授权链接登录，再粘贴完整回调地址。" : "请在浏览器完成登录。回调成功后自动刷新，也可以手动粘贴完整回调地址。"), /* @__PURE__ */ h("a", { href: waiting.url, target: "_blank", rel: "noreferrer", style: { display: "block", wordBreak: "break-all" } }, "打开 ChatGPT 授权页"), /* @__PURE__ */ h("input", { className: "ab-input", value: input, type: "password", autoComplete: "off", placeholder: "粘贴完整回调地址", onChange: (e) => setInput(e.target.value) }), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 8 } }, /* @__PURE__ */ h(Btn, { small: true, onClick: act("/image/codex/complete", { input }), disabled: busy || !input.trim() }, "完成登录"), /* @__PURE__ */ h(Btn, { small: true, onClick: act("/image/codex/cancel"), disabled: busy }, "取消登录"))) : null, /* @__PURE__ */ h(Row, { label: "模型", hint: "可用模型由服务端决定" }, f.select("imageGen.codex.model", [
    { value: "gpt-image-2", label: "gpt-image-2" },
    { value: "gpt-image-2.5-flare", label: "gpt-image-2.5-flare" },
    { value: "gpt-image-2.5-sunburst", label: "gpt-image-2.5-sunburst" }
  ], { width: 260 })), /* @__PURE__ */ h(Row, { label: "质量", hint: "所选模型需支持该选项" }, f.select("imageGen.codex.quality", ["auto", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })), { width: 180 })), /* @__PURE__ */ h(Row, { label: "背景" }, f.select("imageGen.codex.background", ["auto", "opaque", "transparent"].map((value) => ({ value, label: value })), { width: 180 })), /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "订阅接法通过构图提示引导，实际尺寸由服务端选择。"));
}
function ImageGen({ draft, setDraft, toast }) {
  const f = useField(draft, setDraft);
  const c = draft.imageGen;
  const custom = c.custom || {};
  const isCustom = c.provider === "custom";
  const isCodex = c.provider === "codex";
  const isPost = custom.method === "POST";
  const params = Array.isArray(custom.params) ? custom.params : [];
  const setParams = (next) => setDraft(setPath(draft, "imageGen.custom.params", next));
  const setP = (i, k, v) => setParams(params.map((p, j) => j === i ? { ...p, [k]: v } : p));
  return /* @__PURE__ */ h("div", { className: "ab-grid" }, /* @__PURE__ */ h(
    Card,
    {
      title: "让她画图",
      right: f.sw("imageGen.enabled"),
      desc: "接上生图服务后，让她「画一张……」就会画好发出来。",
      more: "可选 OpenAI 兼容接口、自定义接口，或登录 ChatGPT 使用实验性 Codex 订阅接法。\n本机 SD WebUI / ComfyUI 请到「本地接口」页接「生图」。"
    },
    /* @__PURE__ */ h(Row, { label: "接口格式", hint: "「自定义接口」适合 pollinations 这类「GET 一个地址就出图」的服务" }, /* @__PURE__ */ h(
      Seg,
      {
        value: isCodex ? "codex" : isCustom ? "custom" : "openai",
        onChange: (v) => setDraft(setPath(draft, "imageGen.provider", v)),
        options: [{ value: "openai", label: "OpenAI 格式" }, { value: "custom", label: "自定义接口" }, { value: "codex", label: "Codex 订阅（实验性）" }]
      }
    )),
    isCodex ? /* @__PURE__ */ h(CodexSub, { draft, setDraft, toast }) : isCustom ? /* @__PURE__ */ h("div", null, /* @__PURE__ */ h(Row, { label: "请求方式", hint: "GET 把参数都拼在地址上；POST 放进请求体" }, /* @__PURE__ */ h(Seg, { value: isPost ? "POST" : "GET", onChange: (v) => setDraft(setPath(draft, "imageGen.custom.method", v)), options: [{ value: "GET", label: "GET" }, { value: "POST", label: "POST" }] })), /* @__PURE__ */ h(Row, { label: "接口地址", hint: "可以用 {prompt} {model} {size} {width} {height}" }, f.text("imageGen.custom.url", { size: "wide", placeholder: "https://image.pollinations.ai/prompt/{prompt}" })), /* @__PURE__ */ h(Row, { label: "API Key", hint: "会以 Authorization: Bearer 发出；不需要就留空" }, f.text("imageGen.apiKey", { type: "password", placeholder: c.apiKeySet ? "已保存（不改就留空）" : "没有就留空" })), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 12 } }, /* @__PURE__ */ h("b", { className: "ab-small" }, isPost ? "请求体参数" : "URL 参数"), /* @__PURE__ */ h("small", { className: "ab-muted" }, "参数名和值都自己填；值里可以用 ", "{prompt}")), params.length ? params.map((p, i) => /* @__PURE__ */ h("div", { key: i, className: "ab-flex", style: { gap: 6, marginBottom: 6 } }, /* @__PURE__ */ h("input", { className: "ab-input", style: { width: 170 }, value: p.key || "", placeholder: "参数名，如 model", onChange: (e) => setP(i, "key", e.target.value) }), /* @__PURE__ */ h("input", { className: "ab-input", style: { flex: 1 }, value: p.value || "", placeholder: "值，可以用 {prompt}", onChange: (e) => setP(i, "value", e.target.value) }), /* @__PURE__ */ h(Btn, { small: true, onClick: () => setParams(params.filter((_, j) => j !== i)) }, "删"))) : /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginBottom: 6 } }, "还没有参数 —— 比如 model=flux-anime、width=1080、height=1920、nologo=true"), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginBottom: 10 } }, /* @__PURE__ */ h(Btn, { small: true, onClick: () => setParams([...params, { key: "", value: "" }]) }, "＋ 加一个参数")), isPost ? /* @__PURE__ */ h(Row, { label: "请求体格式" }, /* @__PURE__ */ h(Seg, { value: custom.bodyType === "form" ? "form" : "json", onChange: (v) => setDraft(setPath(draft, "imageGen.custom.bodyType", v)), options: [{ value: "json", label: "JSON" }, { value: "form", label: "表单" }] })) : null, /* @__PURE__ */ h(Row, { label: "取值路径", hint: "接口直接回图片就留空；回 JSON 时填地址字段" }, f.text("imageGen.custom.responsePath", { size: "wide", placeholder: "如 data.0.url（留空自动找）" }))) : /* @__PURE__ */ h("div", null, /* @__PURE__ */ h(Row, { label: "服务地址", hint: "一般以 /v1 结尾" }, f.text("imageGen.baseUrl", { size: "wide", placeholder: "https://api.siliconflow.cn/v1" })), /* @__PURE__ */ h(Row, { label: "API Key", hint: "只存在本机，不会显示出来" }, f.text("imageGen.apiKey", { type: "password", placeholder: c.apiKeySet ? "已保存（不改就留空）" : "没有就留空" })), /* @__PURE__ */ h(Row, { label: "模型" }, f.text("imageGen.model", { size: "wide", placeholder: "例如 Kwai-Kolors/Kolors" }))),
    /* @__PURE__ */ h(Row, { label: "默认构图", hint: isCodex ? "通过构图提示引导，实际尺寸由服务端选择，不保证严格比例" : "聊天工具可指定本次构图。服务不支持所选尺寸时会报告失败，请换一种构图；自定义接口需使用尺寸占位符" }, f.select("imageGen.shape", [
      { value: "her", label: "让她选择", desc: isCodex ? "未指定时由服务端选择" : "未指定时沿用图片尺寸" },
      { value: "square", label: isCodex ? "方图 1:1" : "方图 1:1（1024 × 1024）" },
      { value: "portrait", label: isCodex ? "竖图 2:3" : "竖图 2:3（1024 × 1536）" },
      { value: "landscape", label: isCodex ? "横图 3:2" : "横图 3:2（1536 × 1024）" },
      { value: "wide", label: isCodex ? "宽幅 16:9" : "宽幅 16:9（1536 × 864）" }
    ], { width: 260 })),
    !isCodex && (!c.shape || c.shape === "her") ? /* @__PURE__ */ h(Row, { label: "图片尺寸", hint: isCustom ? "接口地址 / 参数里可以用 {size} 或 {width}/{height}" : "未指定构图时沿用这个尺寸" }, f.select("imageGen.size", [
      { value: "1024x1024", label: "1024 × 1024", desc: "方图" },
      { value: "768x1024", label: "768 × 1024", desc: "竖图" },
      { value: "1024x768", label: "1024 × 768", desc: "横图" },
      { value: "512x512", label: "512 × 512", desc: "小图，更快" }
    ], { width: 200 })) : null,
    /* @__PURE__ */ h(Row, { label: "固定风格", hint: "每次画都会加在描述前面" }, f.text("imageGen.stylePrompt", { size: "wide", placeholder: "例如：日系二次元，柔和光线，蓝白配色" })),
    /* @__PURE__ */ h(Row, { label: "只给主人画", hint: "关掉后群友也能让她画（会花你的额度）" }, f.sw("imageGen.ownerOnly")),
    /* @__PURE__ */ h(Row, { label: "让她画完自己看一眼", hint: "开着才把画好的图传给她看（模型不支持看图时自动不传）；关掉就只回一句「画好了」，不传图" }, f.sw("imageGen.seeOwn")),
    isCustom ? /* @__PURE__ */ h("div", { className: "ab-note", style: { marginTop: 10 } }, "例子：地址填 https://image.pollinations.ai/prompt/", "{prompt}", "，再加 model=flux-anime、width=1080、height=1920、nologo=true 四个参数，GET 就会请求 …/prompt/提示词?model=flux-anime&…") : null,
    !c.enabled ? /* @__PURE__ */ h("div", { className: "ab-note", style: { marginTop: 10 } }, "还没开启。填好接口信息、打开右上角开关并保存后，她就会多一个「画图」能力。") : null
  ), /* @__PURE__ */ h(PaintGallery, { draft, setDraft, toast }));
}

// client/src/views/logs.js
function Logs() {
  const [items, setItems] = useState(null);
  const [level, setLevel] = useState("info");
  const [area, setArea] = useState("");
  const [auto, setAuto] = useState(true);
  const load = useCallback(() => get("/logs?limit=400&level=" + level + "&area=" + area).then((r) => setItems(r.entries || [])), [level, area]);
  useEffect(() => {
    load();
    if (!auto) return;
    const t = setInterval(load, 3e3);
    return () => clearInterval(t);
  }, [load, auto]);
  return /* @__PURE__ */ h(
    Card,
    {
      title: "日志",
      desc: "所有后台动作都在这里，令牌和密码已自动打码。完整日志文件在 %USERPROFILE%\\\\.dsh\\\\plugins-data\\\\dsh-qq-hub\\\\logs\\\\（老安装为 aurabot\\\\）。",
      right: /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Select, { value: level, onChange: setLevel, width: 110, options: [["debug", "全部"], ["info", "一般"], ["warn", "警告"], ["error", "错误"]].map(([value, label]) => ({ value, label })) }), /* @__PURE__ */ h(
        Select,
        {
          value: area,
          onChange: setArea,
          width: 130,
          options: [["", "所有模块"], ["core", "核心"], ["chat", "聊天"], ["onebot", "QQ 网关"], ["snowluma", "SnowLuma"], ["sticker", "表情"], ["qzone", "空间"], ["voice", "语音"], ["imagegen", "生图"], ["speakup", "搭话"]].map(([value, label]) => ({ value, label }))
        }
      ), /* @__PURE__ */ h("span", { className: "ab-switch-row" }, /* @__PURE__ */ h(Switch, { on: auto, onChange: setAuto }), /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "自动刷新")))
    },
    items === null ? /* @__PURE__ */ h(Empty, { icon: "⏳", text: "加载中…" }) : items.length === 0 ? /* @__PURE__ */ h(Empty, { text: "没有符合条件的日志" }) : /* @__PURE__ */ h("div", { className: "ab-logs" }, items.slice().reverse().map((e, i) => /* @__PURE__ */ h(LogLine, { key: i, e })))
  );
}

// client/src/views/wizard.js
var WIZ_STEPS = ["你们的 QQ 号", "接 QQ 网关", "启动并同意协议", "连上机器人号", "完成"];
function Wizard({ st, draft, setDraft, save, toast, reload, onClose }) {
  const [step, setStep] = useState(() => {
    try {
      return Number(localStorage.getItem("qq-hub.wiz") || 0);
    } catch (e) {
      return 0;
    }
  });
  const go = (i) => {
    setStep(i);
    try {
      localStorage.setItem("qq-hub.wiz", String(i));
    } catch (e) {
    }
  };
  const f = useField(draft, setDraft);
  const sl = st.snowluma;
  const conn = st.onebot.state === "connected";
  const login = st.onebot.login;
  const [procs, setProcs] = useState(null);
  const [live, setLive] = useState("dry");
  const qqOk = /^\d{5,11}$/.test(draft.botQQ || "") && /^\d{5,11}$/.test(draft.ownerQQ || "") && draft.botQQ !== draft.ownerQQ;
  const external = draft.gateway === "onebot";
  const verified = conn && login && String(login.uin) === String(st.config.botQQ) && !st.onebot.problem;
  const canNext = [qqOk, external ? Boolean(draft.snowluma.wsUrl || st.config.snowluma.wsUrl) : sl.installed, external || sl.running && sl.consented, verified, true][step];
  const next = async () => {
    if ((step === 0 || step === 1) && !await save({ ...draft, enabled: true })) return;
    go(Math.min(step + 1, WIZ_STEPS.length - 1));
    reload();
  };
  const useExisting = async () => {
    const r = await post("/setup/done", { existingConnection: true });
    toast(r.message, r.ok ? "ok" : "err");
    if (r.ok) {
      try {
        localStorage.removeItem("qq-hub.wiz");
      } catch (e) {
      }
      reload();
      onClose && onClose();
    }
  };
  const body = [
    // 0. QQ 号
    /* @__PURE__ */ h("div", { key: "s0" }, /* @__PURE__ */ h("p", { className: "ab-desc" }, "大肥鱼需要一个自己的 QQ 号（机器人号），还要知道谁是她的主人。"), /* @__PURE__ */ h(Row, { label: "机器人 QQ 号", hint: "强烈建议用小号：非官方 QQ 工具有被限制的风险" }, f.text("botQQ", { placeholder: "例如 123456789" })), /* @__PURE__ */ h(Row, { label: "你的 QQ 号（主人）", hint: "群管、操作电脑这些只听主人的" }, f.text("ownerQQ", { placeholder: "你的大号" })), /* @__PURE__ */ h(Row, { label: "她怎么称呼你" }, f.text("ownerName", { placeholder: "主人" })), draft.botQQ && draft.ownerQQ && draft.botQQ === draft.ownerQQ ? /* @__PURE__ */ h("div", { className: "ab-note err" }, "机器人号和主人号不能是同一个。") : null),
    // 1. SnowLuma，或接已有的 OneBot 机器人
    external ? /* @__PURE__ */ h("div", { key: "s1" }, /* @__PURE__ */ h(GatewayChoice, { draft, setDraft }), /* @__PURE__ */ h("p", { className: "ab-desc", style: { marginTop: 10 } }, "让你的 OneBot 服务（NapCat、LLOneBot、Lagrange、Docker 里的 SnowLuma……）登录机器人号，把它的正向 WebSocket 地址填在下面。插件只连接，不会启动或注入任何东西。"), /* @__PURE__ */ h(OneBotFields, { draft, f })) : /* @__PURE__ */ h("div", { key: "s1" }, /* @__PURE__ */ h(GatewayChoice, { draft, setDraft }), /* @__PURE__ */ h("p", { className: "ab-desc", style: { marginTop: 10 } }, "SnowLuma 是让机器人号上线的 QQ 网关。它的协议不允许别的程序自动下载安装，所以这一步要你自己来（只用做一次）。"), /* @__PURE__ */ h("div", { className: "ab-steps" }, /* @__PURE__ */ h("div", { className: "ab-step" }, /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("b", null, "下载"), /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "下载 Windows 完整版，文件名类似 SnowLuma-v2.x.x-win-x64.zip（不带 lite）。"), /* @__PURE__ */ h("div", { style: { marginTop: 6 } }, /* @__PURE__ */ h(Btn, { small: true, onClick: () => window.open(sl.downloadPage, "_blank") }, "打开下载页 ↗")))), /* @__PURE__ */ h("div", { className: cx("ab-step", sl.installed && "done") }, /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("b", null, "解压到纯英文目录"), /* @__PURE__ */ h("div", { className: "ab-muted ab-small" }, "推荐 C:\\Aurabot\\snowluma，解压后目录里能直接看到 index.mjs。"), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 6 } }, f.text("snowluma.dir", { size: "wide", placeholder: "C:\\Aurabot\\snowluma" }), /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
      await save(draft);
      reload();
    } }, "检查")), /* @__PURE__ */ h("div", { className: "ab-small", style: { marginTop: 4, color: sl.installed ? "var(--ab-ok)" : "var(--ab-warn)" } }, sl.installed ? "✓ 找到了 SnowLuma v" + sl.version : sl.reason))))),
    // 2. 启动 + 协议（接自己的 OneBot 时不用）
    external ? /* @__PURE__ */ h("div", { key: "s2" }, /* @__PURE__ */ h("p", { className: "ab-desc" }, "用的是你自己的 OneBot 服务，这一步不用做，直接下一步。")) : /* @__PURE__ */ h("div", { key: "s2" }, /* @__PURE__ */ h("p", { className: "ab-desc" }, "点启动后它在后台运行（不弹窗口），控制台密码由插件自动生成和保存，你不用记。"), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginBottom: 10 } }, /* @__PURE__ */ h(Btn, { kind: "primary", small: true, disabled: sl.running, onClick: async () => {
      toast("正在启动…");
      const r = await post("/snowluma/start");
      toast(r.message);
      reload();
    } }, sl.running ? "✓ 已在运行" : "启动 SnowLuma"), /* @__PURE__ */ h(SnowLumaAuth, { running: sl.running, toast, onChange: reload })), /* @__PURE__ */ h(Agreement, { running: sl.running, toast, onChange: reload })),
    // 3. 接入
    /* @__PURE__ */ h("div", { key: "s3" }, external ? /* @__PURE__ */ h("p", { className: "ab-desc" }, "确认你的 OneBot 服务登录的是机器人号 ", st.config.botQQ || "", "，然后点「测试连接」。插件连上后会先核对登录的号，不是机器人号就断开。") : /* @__PURE__ */ h("p", { className: "ab-desc" }, "在这台电脑上另开一个 QQ，登录机器人号 ", st.config.botQQ || "", "（可以最小化）。你的大号 QQ 照常开着就行——插件只会接入机器人号，绝不碰别的号。"), external ? /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { kind: "primary", small: true, onClick: async () => {
      const r = await post("/onebot/reconnect");
      toast(r.message, r.ok ? "ok" : "err");
      reload();
    } }, "连接"), /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
      const r = await get("/onebot/test");
      toast(r.message);
    } }, "测试连接")) : /* @__PURE__ */ h("div", { className: "ab-flex" }, /* @__PURE__ */ h(Btn, { kind: "primary", small: true, onClick: async () => {
      const r = await post("/snowluma/attach");
      toast(r.message);
      setTimeout(reload, 1500);
    } }, "接入机器人号"), /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
      const r = await get("/snowluma/processes");
      setProcs(r.list || []);
      if (!r.ok) toast(r.message);
    } }, "看看有哪些 QQ 进程"), /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
      const r = await get("/onebot/test");
      toast(r.message);
    } }, "测试连接")), sl.lastAttach && sl.lastAttach.at ? /* @__PURE__ */ h("div", { className: "ab-small", style: { marginTop: 8, color: sl.lastAttach.ok ? "var(--ab-ok)" : "var(--ab-warn)" } }, sl.lastAttach.message) : null, conn && login ? /* @__PURE__ */ h("div", { className: "ab-note", style: { marginTop: 10 } }, login.uin === st.config.botQQ ? "✓ 连上了：" + login.nickname + "（" + login.uin + "）" : "⚠ 连上的是 " + login.uin + "，不是机器人号") : /* @__PURE__ */ h("div", { className: "ab-muted ab-small", style: { marginTop: 10 } }, "接入后需要十几秒识别登录状态，稍等一下会自动刷新。"), procs ? /* @__PURE__ */ h("table", { className: "ab-table", style: { marginTop: 10 } }, /* @__PURE__ */ h("tbody", null, procs.map((p) => /* @__PURE__ */ h("tr", { key: p.pid }, /* @__PURE__ */ h("td", null, p.pid), /* @__PURE__ */ h("td", null, p.uin || "识别不出"), /* @__PURE__ */ h("td", null, p.nickname || ""), /* @__PURE__ */ h("td", null, p.isBot ? /* @__PURE__ */ h("span", { className: "ab-badge" }, "机器人号") : /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "不会碰")))))) : null),
    // 4. 完成
    /* @__PURE__ */ h("div", { key: "s4" }, /* @__PURE__ */ h("p", { className: "ab-desc" }, "都准备好了！最后选一下她怎么上线："), /* @__PURE__ */ h(
      Choices,
      {
        value: live,
        onChange: setLive,
        options: [
          { value: "dry", label: "先试运行", desc: "她会照常思考，但只写进日志、不真的发出去。看几条没问题再在右上角关掉试运行" },
          { value: "live", label: "直接上线", desc: "马上开始真的回 QQ 消息" }
        ]
      }
    ), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 12 } }, /* @__PURE__ */ h(Btn, { small: true, onClick: async () => {
      await save({ ...draft, enabled: true, dryRun: false });
      const r = await post("/test-send");
      toast(r.message);
      await save({ ...draft, enabled: true, dryRun: live === "dry" });
    } }, "给我发一条自测消息")))
  ][step];
  return /* @__PURE__ */ h("div", { className: "ab-card", style: { padding: "20px 22px" } }, /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginBottom: 6 } }, /* @__PURE__ */ h("h3", { style: { margin: 0, fontSize: 16 } }, "设置向导"), /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, "第 ", step + 1, " / ", WIZ_STEPS.length, " 步 · ", WIZ_STEPS[step]), /* @__PURE__ */ h("div", { className: "ab-spacer" }), st.config.setupDone && onClose ? /* @__PURE__ */ h(Btn, { small: true, kind: "ghost", onClick: onClose }, "关闭向导") : null), /* @__PURE__ */ h("div", { className: "ab-wiz-bar" }, WIZ_STEPS.map((s, i) => /* @__PURE__ */ h("button", { key: s, type: "button", className: cx("seg", i < step && "done", i === step && "on"), onClick: () => i <= step && go(i), title: s }, /* @__PURE__ */ h("span", null, s)))), verified && !st.config.setupDone ? /* @__PURE__ */ h("div", { className: "ab-note", style: { marginTop: 12 } }, "机器人号已经连接并核对通过。", " ", /* @__PURE__ */ h(Btn, { small: true, onClick: useExisting }, "使用现有连接，进入面板")) : null, /* @__PURE__ */ h("div", { style: { minHeight: 220, marginTop: 14 } }, body), /* @__PURE__ */ h("div", { className: "ab-flex", style: { marginTop: 16, borderTop: "1px solid var(--ab-line)", paddingTop: 12 } }, step > 0 ? /* @__PURE__ */ h(Btn, { kind: "ghost", onClick: () => go(step - 1) }, "上一步") : null, /* @__PURE__ */ h("div", { className: "ab-spacer" }), step < WIZ_STEPS.length - 1 ? /* @__PURE__ */ h(Btn, { kind: "primary", disabled: !canNext, onClick: next }, "下一步") : /* @__PURE__ */ h(
    Btn,
    {
      kind: "primary",
      onClick: async () => {
        if (!await save({ ...draft, enabled: true, dryRun: live === "dry" })) return;
        const r = await post("/setup/done");
        toast(r.message, r.ok ? "ok" : "err");
        if (r.ok) {
          try {
            localStorage.removeItem("qq-hub.wiz");
          } catch (e) {
          }
          reload();
          onClose && onClose();
        }
      }
    },
    "完成，让大肥鱼上线"
  )));
}

// client/src/shell/page.js
function QQHubPage() {
  useStyle();
  const [st, setSt] = useState(null);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState(null);
  const [tab, setTab] = useState(() => {
    try {
      return localStorage.getItem("qq-hub.tab") || "overview";
    } catch (e) {
      return "overview";
    }
  });
  const [toastMsg, setToastMsg] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const toastTimer = useRef(null);
  const dirtyRef = useRef(false);
  const saveRef = useRef(null);
  const stJsonRef = useRef(null);
  const toast = (m, kind) => {
    const text = String(m || "");
    const k = kind || (/失败|出错|没成功|不能|读不到|连不上/.test(text) ? "err" : "");
    setToastMsg({ text, kind: k });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3200);
  };
  const reload = useCallback(async () => {
    const r = await get("/state");
    if (!r || r.ok === false) {
      setErr(r && r.message ? r.message : "读不到插件状态");
      return;
    }
    setErr("");
    const json = JSON.stringify(r);
    if (stJsonRef.current === json) return;
    stJsonRef.current = json;
    setSt(r);
    if (!dirtyRef.current) setDraft(clone(r.config));
  }, []);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 5e3);
    return () => clearInterval(t);
  }, [reload]);
  const go = (id) => {
    setTab(id);
    try {
      localStorage.setItem("qq-hub.tab", id);
    } catch (e) {
    }
  };
  const tabsRef = useRef(null);
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });
  useEffect(() => {
    tabsRef.current?.querySelector(".ab-tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);
  const dirty = useMemo(() => !!(st && draft) && JSON.stringify(draft) !== JSON.stringify(st.config), [st, draft]);
  dirtyRef.current = dirty;
  const setD = (d) => setDraft(d);
  const save = async (override) => {
    const body2 = override || draft;
    const r = await post("/save", body2);
    if (r.ok === false) {
      toast(r.message || "保存失败", "err");
      return false;
    }
    dirtyRef.current = false;
    stJsonRef.current = JSON.stringify(r);
    setSt(r);
    setDraft(clone(r.config));
    toast(r.message || "保存好了", "ok");
    return true;
  };
  saveRef.current = save;
  const quickToggle = async (path, v) => {
    await save(setPath(dirtyRef.current ? draft : clone(st.config), path, v));
  };
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && dirtyRef.current) {
        e.preventDefault();
        saveRef.current && saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!st || !draft) {
    return /* @__PURE__ */ h("div", { className: "ab-root" }, /* @__PURE__ */ h("div", { className: "ab-wrap" }, err ? /* @__PURE__ */ h("div", { className: "ab-note err" }, "面板读不到插件：", err, "。如果刚装好插件，重启一次 DSH 试试。") : /* @__PURE__ */ h(Empty, { icon: "🐋", text: "大肥鱼正在游过来…" })));
  }
  const cfg = st.config;
  const conn = st.onebot.state === "connected";
  const status = !cfg.enabled ? { cls: "", text: "休息中（总开关关着）" } : !conn ? { cls: "err", text: "QQ 没连上" } : cfg.dryRun ? { cls: "warn", text: "在线 · 试运行" } : { cls: "ok", text: "在线" };
  const persona = st.personas.find((p) => p.id === cfg.persona.current);
  const props = { st, draft, setDraft: setD, toast, reload, go, openWizard: () => setWizardOpen(true) };
  const showWizard = !cfg.setupDone || wizardOpen;
  const mods = st.modules || [];
  const running = (id) => {
    const m = mods.find((x) => x.id === id);
    return Boolean(m && m.running);
  };
  const hasUi = (m) => Boolean(m.running) && ((m.settings || []).length > 0 || m.panel);
  const TAB_ALIAS = { mood: "memory" };
  const tabOf = (m) => TAB_ALIAS[m.tab] || m.tab;
  const intoTab = (m) => Boolean(m.tab && TABS.some((t) => t.id === tabOf(m)));
  const extTabs = mods.filter((m) => hasUi(m) && !intoTab(m)).map((m) => ({ id: "ext:" + m.id, label: m.name, ext: m.id }));
  const tabs = TABS.filter((t) => !TAB_MODS[t.id] || TAB_MODS[t.id].some(running));
  tabs.splice(tabs.findIndex((t) => t.id === "logs"), 0, ...extTabs);
  const curTab = tabs.find((t) => t.id === tab) || tabs[0];
  const body = curTab.ext ? ExtPage : {
    overview: Overview,
    connect: Connect,
    persona: Persona,
    access: Access,
    group: Group,
    model: Model,
    voice: Voice,
    stickers: Stickers,
    imagegen: ImageGen,
    diary: Diary,
    speakup: SpeakUp,
    memory: Mood,
    bili: Bili,
    douyin: Douyin,
    heybox: Heybox,
    multiParser: MultiParser,
    browser: Browser,
    token: Token,
    local: LocalApi,
    modules: Modules,
    logs: Logs
  }[curTab.id] || Overview;
  const tabDirty = (id) => {
    if (!dirty) return false;
    if (id.startsWith("ext:")) {
      const k = id.slice(4);
      return JSON.stringify((draft.ext || {})[k]) !== JSON.stringify((cfg.ext || {})[k]);
    }
    return (TAB_KEYS[id] || []).some((k) => JSON.stringify(draft[k]) !== JSON.stringify(cfg[k]));
  };
  const mark = (t) => {
    if (tabDirty(t.id)) return /* @__PURE__ */ h("i", { className: "dirty", title: "有没保存的改动", "aria-hidden": "true" });
    if (!t.flag) return null;
    const flag = t.flag === "group" ? cfg.allow.groups.length > 0 : getPath(cfg, t.flag);
    return /* @__PURE__ */ h("i", { className: cx("ab-dot", flag && "ok"), title: flag ? "开着" : "关着", "aria-hidden": "true" });
  };
  return /* @__PURE__ */ h("div", { className: "ab-root" }, /* @__PURE__ */ h("div", { className: "ab-wrap" }, /* @__PURE__ */ h("header", { className: "ab-topbar" }, /* @__PURE__ */ h("button", { type: "button", className: "ab-avatar-btn", title: "点击换头像", onClick: () => pickAvatar(toast, reload) }, /* @__PURE__ */ h("img", { className: "ab-avatar", src: avatarSrc(st), alt: "头像" }), /* @__PURE__ */ h("span", { className: "ab-avatar-tip" }, "换头像")), /* @__PURE__ */ h("div", { className: "ab-topbar-main" }, /* @__PURE__ */ h("h1", null, st.onebot.login && st.onebot.login.nickname || "大肥鱼"), /* @__PURE__ */ h("div", { className: "ab-meta" }, "QQ ", cfg.botQQ, " · ", persona ? persona.name : "默认人格"), /* @__PURE__ */ h("div", { className: "ab-pills" }, /* @__PURE__ */ h(Pill, { kind: status.cls }, /* @__PURE__ */ h("i", { className: cx("ab-dot", status.cls) }), status.text), /* @__PURE__ */ h(Pill, null, "SnowLuma ", st.snowluma.installed ? st.snowluma.running ? "运行中" : "没启动" : "未安装"), /* @__PURE__ */ h(Pill, null, "QQ Hub v", st.version))), /* @__PURE__ */ h("div", { className: "ab-topbar-side" }, /* @__PURE__ */ h("div", { className: "ab-switch-row" }, /* @__PURE__ */ h("span", null, "总开关"), /* @__PURE__ */ h(Switch, { on: cfg.enabled, onChange: (v) => quickToggle("enabled", v) })), /* @__PURE__ */ h("div", { className: "ab-switch-row" }, /* @__PURE__ */ h("span", { className: "ab-muted" }, "试运行"), /* @__PURE__ */ h(Switch, { on: cfg.dryRun, onChange: (v) => quickToggle("dryRun", v), title: "开着时只写日志，不真的发到 QQ" })))), showWizard ? /* @__PURE__ */ h(Wizard, { st, draft, setDraft: setD, save, toast, reload, onClose: () => setWizardOpen(false) }) : null, showWizard ? null : /* @__PURE__ */ h(NavBar, { tabs, cur: curTab, go, mark, dirtyOf: tabDirty, subRef: tabsRef }), showWizard ? null : /* @__PURE__ */ h(TabBoundary, { key: curTab.id, onHome: () => go("overview") }, h(body, { ...props, mod: curTab.ext })), showWizard || curTab.ext ? null : mods.filter((m) => hasUi(m) && tabOf(m) === curTab.id && m.id !== "multi-parser" && !(curTab.id === "memory" && m.id === "memory")).map((m) => /* @__PURE__ */ h("div", { key: "embed-" + m.id, style: { marginTop: 14 } }, /* @__PURE__ */ h(ExtPage, { ...props, mod: m.id, embedded: true }))), dirty && !showWizard ? /* @__PURE__ */ h("div", { className: "ab-savebar" }, /* @__PURE__ */ h("span", { className: "msg" }, "有改动还没保存"), /* @__PURE__ */ h("span", { className: "ab-muted ab-small" }, /* @__PURE__ */ h("span", { className: "ab-kbd" }, "Ctrl"), " + ", /* @__PURE__ */ h("span", { className: "ab-kbd" }, "S")), /* @__PURE__ */ h(Btn, { kind: "ghost", onClick: () => setDraft(clone(st.config)) }, "撤销"), /* @__PURE__ */ h(Btn, { kind: "primary", onClick: () => save() }, "保存设置")) : null), toastMsg ? /* @__PURE__ */ h("div", { className: cx("ab-toast", toastMsg.kind), role: "status" }, toastMsg.text) : null);
}

// client/src/entry.js
var inject = ["slots"];
var PANEL_ID = "qq-hub";
function apply(ctx) {
  ctx.effect(() => installInnerFold(), "qq-hub: 正文里的 <inner> 独白折成一行");
  const slots = ctx.get("slots");
  if (slots === void 0) return;
  slots.inject("main", () => slots.register({ name: "main", key: PANEL_ID }, QQHubPage));
  slots.inject("sidebar.panellist", () => slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 20, label: () => "QQ Hub" }, WhaleIcon));
}

    exports.apply = apply
    exports.inject = inject
    exports.QQHubPage = QQHubPage
    exports.WhaleIcon = WhaleIcon
    return module.exports
  },
})

