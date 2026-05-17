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
  let idx = fullText.indexOf(target);
  if (idx < 0) {
    // Fall back to bare selected_text if context doesn't match (book changed)
    idx = fullText.indexOf(hl.selected_text);
    if (idx < 0) return;
    const range = rangeFromOffsets(root, idx, idx + hl.selected_text.length);
    if (range) wrapRange(range, hl);
    return;
  }
  const start = idx + hl.prefix.length;
  const end = start + hl.selected_text.length;
  const range = rangeFromOffsets(root, start, end);
  if (range) wrapRange(range, hl);
}

function wrapRange(range: Range, hl: Highlight) {
  const mark = document.createElement("mark");
  mark.className = `ai-hl ai-hl-${hl.color}`;
  mark.dataset.hlId = String(hl.id);
  try {
    range.surroundContents(mark);
  } catch {
    // Range crosses element boundaries (e.g. spans two paragraphs).
    // Fall back to extract + insert.
    const fragment = range.extractContents();
    mark.appendChild(fragment);
    range.insertNode(mark);
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
