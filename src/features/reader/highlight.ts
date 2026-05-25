import type { Highlight } from "@/lib/ipc";

export const PREFIX_LEN = 30;

/**
 * Capture the current Selection inside `root` as a fingerprintable
 * highlight (selected text + 30 chars context on each side).
 *
 * Returns null when there's no selection, or the selection is collapsed,
 * empty, or lives outside `root`.
 */
export function captureSelection(
  root: HTMLElement,
): {
  selectedText: string;
  prefix: string;
  suffix: string;
  rect: DOMRect;
} | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const selectedText = sel.toString();
  if (!selectedText.trim()) return null;

  const startOffset = charOffsetWithin(
    root,
    range.startContainer,
    range.startOffset,
  );
  const endOffset = charOffsetWithin(
    root,
    range.endContainer,
    range.endOffset,
  );
  if (startOffset < 0 || endOffset < 0 || endOffset <= startOffset) {
    return null;
  }

  const fullText = root.textContent ?? "";
  const prefix = fullText.slice(Math.max(0, startOffset - PREFIX_LEN), startOffset);
  const suffix = fullText.slice(endOffset, endOffset + PREFIX_LEN);

  return {
    selectedText,
    prefix,
    suffix,
    rect: range.getBoundingClientRect(),
  };
}

/**
 * Replace any existing <mark.ai-hl> elements inside `root` with their text,
 * then wrap each highlight by locating prefix+text+suffix in the plain text
 * and creating a Range over the inner selected_text portion.
 *
 * The prefix+suffix anchor makes the lookup robust against the same text
 * appearing multiple times in one chapter — and lets us re-anchor if the
 * EPUB's content shifts slightly between versions.
 */
export function applyHighlights(root: HTMLElement, highlights: Highlight[]) {
  // Unwrap existing marks first to start from a clean slate.
  root.querySelectorAll("mark.ai-hl").forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  root.normalize();

  for (const hl of highlights) {
    wrapOne(root, hl);
  }
}

function wrapOne(root: HTMLElement, hl: Highlight) {
  const target = hl.prefix + hl.selected_text + hl.suffix;
  const fullText = root.textContent ?? "";

  // Tier 1: exact match with context.
  let idx = fullText.indexOf(target);
  if (idx >= 0) {
    const start = idx + hl.prefix.length;
    const end = start + hl.selected_text.length;
    const range = rangeFromOffsets(root, start, end);
    if (range) wrapRange(range, hl);
    return;
  }

  // Tier 2: bare selected_text exact match.
  idx = fullText.indexOf(hl.selected_text);
  if (idx >= 0) {
    const range = rangeFromOffsets(root, idx, idx + hl.selected_text.length);
    if (range) wrapRange(range, hl);
    return;
  }

  // Tier 3: whitespace-tolerant match. Selections that span paragraph
  // boundaries get extra newlines inserted into textContent (HTML <p>s
  // join with "\n" in textContent, but sel.toString() doesn't include
  // them). NBSP / zero-width chars also bite us. Walk char-by-char and
  // treat any whitespace as equivalent.
  const located = findIgnoringWhitespace(fullText, hl.selected_text);
  if (located) {
    // Guard: refuse to wrap a range whose actual visible content is
    // mostly whitespace. Without this, when haystack has a big block of
    // newlines between two chars that happen to match the query's
    // first/last visible chars, fallback would wrap that whole gap and
    // paint the bg as one tall colored bar with no visible text — bug
    // reported in the "空白竖线" screenshot.
    const sliceText = fullText.slice(located.start, located.end);
    const nonWS = sliceText.replace(/[\s ​-‍﻿]/g, "").length;
    const queryNonWS = hl.selected_text.replace(
      /[\s ​-‍﻿]/g,
      "",
    ).length;
    // Require we recovered at least 80% of the original visible chars.
    if (queryNonWS > 0 && nonWS >= Math.max(1, Math.floor(queryNonWS * 0.8))) {
      const range = rangeFromOffsets(root, located.start, located.end);
      if (range) wrapRange(range, hl);
      return;
    }
  }

  // Tier 4: layout-character-insensitive match. Some EPUB/MOBI renderers
  // inject line breaks, NBSPs, or zero-width chars differently between
  // selection capture and rerender. Build a compact string while preserving
  // original offsets, then map the match back to the DOM.
  const compact = findIgnoringLayoutChars(fullText, hl.selected_text);
  if (compact) {
    const range = rangeFromOffsets(root, compact.start, compact.end);
    if (range) wrapRange(range, hl);
  }
}

/**
 * Find `query` in `haystack` allowing whitespace differences anywhere on
 * either side: a run of whitespace in haystack can match zero or one
 * whitespace in query, and vice versa. NBSP ( ), zero-width chars
 * are treated as whitespace too.
 *
 * Returns the [start, end) offsets in haystack where the match starts /
 * ends, or null if no match.
 */
function findIgnoringWhitespace(
  haystack: string,
  query: string,
): { start: number; end: number } | null {
  const q = query.trim();
  if (q === "") return null;
  const isWS = (ch: string): boolean =>
    ch === " " || ch === "\t" || ch === "\n" || ch === "\r" ||
    ch === " " || ch === "​" || ch === "‌" ||
    ch === "‍" || ch === "﻿";

  for (let i = 0; i < haystack.length; i++) {
    let hi = i;
    let qi = 0;
    while (qi < q.length && hi < haystack.length) {
      const hc = haystack[hi];
      const qc = q[qi];
      if (hc === qc) {
        hi++;
        qi++;
        continue;
      }
      const hWS = isWS(hc);
      const qWS = isWS(qc);
      if (hWS && qWS) {
        hi++;
        qi++;
        continue;
      }
      if (hWS) {
        // Haystack has extra whitespace — skip it.
        hi++;
        continue;
      }
      if (qWS) {
        // Query has extra whitespace — skip it.
        qi++;
        continue;
      }
      break;
    }
    // Consume any trailing whitespace in the query that hasn't matched
    // anything yet — common when query ends with " " and haystack didn't.
    while (qi < q.length && isWS(q[qi])) qi++;
    if (qi === q.length) {
      return { start: i, end: hi };
    }
  }
  return null;
}

function findIgnoringLayoutChars(
  haystack: string,
  query: string,
): { start: number; end: number } | null {
  const h = compactWithMap(haystack);
  const q = compactWithMap(query);
  if (q.text.length === 0) return null;
  const idx = h.text.indexOf(q.text);
  if (idx < 0) return null;
  const start = h.map[idx];
  const end = h.map[idx + q.text.length - 1] + 1;
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

function compactWithMap(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/[\s\u00a0\u200b\u200c\u200d\ufeff]/.test(ch)) continue;
    text += ch;
    map.push(i);
  }
  return { text, map };
}

function wrapRange(range: Range, hl: Highlight) {
  const mark = document.createElement("mark");
  mark.className = `ai-hl ai-hl-${hl.color}`;
  mark.dataset.hlId = String(hl.id);
  try {
    range.surroundContents(mark);
    return;
  } catch {
    // 跨多个元素 (例如选区跨两个段落): surroundContents 抛 InvalidStateError.
    //
    // 问题 2 之前 fallback 是 extractContents + 单个 mark 包整个 fragment,
    // 结果一个 mark 里同时含两段文字 + 它们之间的段落分隔 (br / p 边界),
    // 渲染出来段落间出现一根竖线、看不到明显高亮.
    //
    // 改为「分段 wrap」: 走 range 跨过的每一个 text node, 每段单独包一个 mark,
    // 段落边界不被破坏, 视觉上每段都正常涂色.
    wrapRangePiecewise(range, hl);
  }
}

/**
 * 把 range 跨过的所有 text node 各包一个 `<mark.ai-hl>`. 段落边界保留.
 * 多个 mark 共享同一个 hl.id (前端 mark click 反查仍按 id 找到一组).
 */
function wrapRangePiecewise(range: Range, hl: Highlight) {
  const root: Node = range.commonAncestorContainer;
  // common ancestor 可能是 text node (range 在单个 text 节点内) — 这种情况
  // 早就被 surroundContents 处理了, 进 fallback 必然不是 text node.
  const walkRoot =
    root.nodeType === Node.TEXT_NODE
      ? (root.parentNode as Node | null) ?? root
      : root;
  const walker = document.createTreeWalker(walkRoot, NodeFilter.SHOW_TEXT);
  const toWrap: Array<{ node: Text; start: number; end: number }> = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (!range.intersectsNode(n)) continue;
    const t = n as Text;
    let start = 0;
    let end = t.length;
    if (t === range.startContainer) start = range.startOffset;
    if (t === range.endContainer) end = range.endOffset;
    if (start < end) toWrap.push({ node: t, start, end });
  }
  // 倒序 wrap: surroundContents 会 split text node, 影响后面节点的 offset.
  // 倒序处理同一节点内多片段时安全; 跨节点则各自独立, 顺序无关.
  for (let i = toWrap.length - 1; i >= 0; i--) {
    const { node, start, end } = toWrap[i];
    const r = document.createRange();
    try {
      r.setStart(node, start);
      r.setEnd(node, end);
      const m = document.createElement("mark");
      m.className = `ai-hl ai-hl-${hl.color}`;
      m.dataset.hlId = String(hl.id);
      r.surroundContents(m);
    } catch {
      // 单段内 surroundContents 仍报错 (空白节点 / 极端情况) — 跳过该段, 不致命
    }
  }
}

function rangeFromOffsets(
  root: Node,
  start: number,
  end: number,
): Range | null {
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let startSet = false;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const len = n.textContent?.length ?? 0;
    if (!startSet && seen + len >= start) {
      range.setStart(n, start - seen);
      startSet = true;
    }
    if (startSet && seen + len >= end) {
      range.setEnd(n, end - seen);
      return range;
    }
    seen += len;
  }
  return null;
}

function charOffsetWithin(
  root: Node,
  target: Node,
  targetOffset: number,
): number {
  if (target === root) {
    // targetOffset is a child index — sum up text of children before it
    let off = 0;
    for (let i = 0; i < targetOffset; i++) {
      off += root.childNodes[i].textContent?.length ?? 0;
    }
    return off;
  }
  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n === target) return offset + targetOffset;
    offset += n.textContent?.length ?? 0;
  }
  return -1;
}
