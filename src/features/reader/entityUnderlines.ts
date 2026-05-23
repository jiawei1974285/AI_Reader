import type { ChapterEntity } from "@/lib/ipc";

export type EntityWithKey = ChapterEntity & {
  key: string;
};

export function entityKey(entity: ChapterEntity): string {
  return `${entity.kind}:${entity.name}`;
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
    const fragment = range.extractContents();
    span.appendChild(fragment);
    range.insertNode(span);
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
