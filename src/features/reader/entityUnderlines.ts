import type { ChapterEntity } from "@/lib/ipc";

export type EntityWithKey = ChapterEntity & {
  key: string;
};

export function entityKey(entity: ChapterEntity): string {
  return `${entity.kind}:${entity.name}`;
}

/**
 * 把 AI 返回的原始 entities 清洗成内部用的 EntityWithKey 列表：
 *   - trim name/summary
 *   - 丢空 name 或空 summary 的
 *   - kind 收敛到 "person" / "place"（LLM 偶尔返 "human" 之类的别名）
 *   - 按 entityKey 去重（同名同 kind 只留第一条）
 */
export function normalizeEntities(entities: ChapterEntity[]): EntityWithKey[] {
  const seen = new Set<string>();
  const out: EntityWithKey[] = [];
  for (const entity of entities) {
    const name = entity.name.trim();
    const summary = entity.summary.trim();
    if (!name || !summary) continue;
    const kind = entity.kind === "person" ? "person" : "place";
    const normalized = { name, summary, kind };
    const key = entityKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...normalized, key });
  }
  return out;
}

export function applyEntityUnderlines(
  root: HTMLElement,
  entities: EntityWithKey[],
  activeKey: string | null,
) {
  root.querySelectorAll("span.ai-entity").forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  });
  root.normalize();

  const sorted = [...entities]
    .filter((e) => e.name.trim().length >= 2)
    .sort((a, b) => b.name.length - a.name.length);

  for (const entity of sorted) {
    wrapEntityOccurrences(root, entity, activeKey);
  }
}

function wrapEntityOccurrences(
  root: HTMLElement,
  entity: EntityWithKey,
  activeKey: string | null,
) {
  const name = entity.name.trim();
  const fullText = root.textContent ?? "";
  let from = 0;
  let count = 0;
  while (count < 60) {
    const idx = fullText.indexOf(name, from);
    if (idx < 0) break;
    const end = idx + name.length;
    const range = rangeFromOffsets(root, idx, end);
    if (range && !rangeIntersectsEntity(range)) {
      wrapRange(range, entity, activeKey === entity.key);
      count++;
    }
    from = end;
  }
}

function rangeIntersectsEntity(range: Range): boolean {
  let node: Node | null = range.commonAncestorContainer;
  while (node) {
    if (node instanceof HTMLElement && node.classList.contains("ai-entity")) {
      return true;
    }
    node = node.parentNode;
  }
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
  if (root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let curr: Node | null;
    while ((curr = walker.nextNode())) {
      if (
        curr instanceof HTMLElement &&
        curr.classList.contains("ai-entity") &&
        range.intersectsNode(curr)
      ) {
        return true;
      }
    }
  }
  return false;
}

function wrapRange(range: Range, entity: EntityWithKey, active: boolean) {
  const span = document.createElement("span");
  span.className = `ai-entity ai-entity-${entity.kind === "person" ? "person" : "place"}${
    active ? " ai-entity-active" : ""
  }`;
  span.dataset.entityKey = entity.key;
  span.dataset.entityName = entity.name;
  span.dataset.entityKind = entity.kind;
  span.title = entity.summary;
  try {
    range.surroundContents(span);
  } catch {
    wrapTextNodesPiecewise(range, entity, active);
  }
}

function wrapTextNodesPiecewise(range: Range, entity: EntityWithKey, active: boolean) {
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
  if (!root) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const pieces: Array<{ node: Text; start: number; end: number }> = [];
  let curr: Node | null;
  while ((curr = walker.nextNode())) {
    if (!range.intersectsNode(curr)) continue;
    const node = curr as Text;
    let start = 0;
    let end = node.length;
    if (node === range.startContainer) start = range.startOffset;
    if (node === range.endContainer) end = range.endOffset;
    if (start < end) pieces.push({ node, start, end });
  }

  for (let i = pieces.length - 1; i >= 0; i--) {
    const { node, start, end } = pieces[i];
    const r = document.createRange();
    try {
      r.setStart(node, start);
      r.setEnd(node, end);
      const span = document.createElement("span");
      span.className = `ai-entity ai-entity-${entity.kind === "person" ? "person" : "place"}${
        active ? " ai-entity-active" : ""
      }`;
      span.dataset.entityKey = entity.key;
      span.dataset.entityName = entity.name;
      span.dataset.entityKind = entity.kind;
      span.title = entity.summary;
      r.surroundContents(span);
    } catch {
      // Keep the original book DOM intact if a pathological text node refuses wrapping.
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
