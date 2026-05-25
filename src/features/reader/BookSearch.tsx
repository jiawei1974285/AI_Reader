import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  /** Element to search within. Counts are computed from its textContent. */
  rootEl: HTMLElement | null;
  onClose: () => void;
};

/**
 * Floating in-book search bar. Triggered by Ctrl/Cmd + F in the reader.
 *
 * 问题 3 之前的实现用 `window.find()`，在 WebView2 + 分页 (CSS column) 模式
 * 下经常不能正确滚到匹配处——浏览器原生 selection 在 column 布局里和 reader
 * 的 scrollLeft 没绑定，看上去就是"7/18 但屏幕没动"。
 *
 * 新实现：自己用 TreeWalker 找匹配 + 把每段命中包成 `<mark class="search-hit">`,
 * 当前命中加 `.search-hit-current` 醒目色 + scrollIntoView(block: center) —
 * 在分页模式下 scrollIntoView 会自动调 column 容器的 scrollLeft 到对应列。
 *
 * 关闭面板时把所有 `<mark.search-hit>` unwrap 干净，不留 DOM 污染。
 * 已有的 `<mark.ai-hl>` 用户高亮不受影响 (类名不同, 嵌套也允许)。
 */
export function BookSearch({ rootEl, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(0); // 1-based; 0 = 未定位
  const inputRef = useRef<HTMLInputElement>(null);
  const marksRef = useRef<HTMLElement[]>([]); // wrap 后的所有 mark 元素，按命中顺序

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // 关闭面板时清掉所有 mark
  useEffect(() => {
    return () => {
      if (rootEl) clearSearchMarks(rootEl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // query 或 rootEl 变化 → 清旧 + scan + wrap + 跳第一个
  useEffect(() => {
    if (!rootEl) return;
    clearSearchMarks(rootEl);
    marksRef.current = [];
    setCurrent(0);
    const q = query.trim();
    if (q === "") {
      setTotal(0);
      return;
    }
    const matches = scanMatches(rootEl, q);
    if (matches.length === 0) {
      setTotal(0);
      return;
    }
    const marks = wrapMatches(matches, 0);
    marksRef.current = marks;
    setTotal(marks.length);
    setCurrent(1);
    // 等 layout 稳定后 scroll
    requestAnimationFrame(() => {
      marks[0]?.scrollIntoView({ block: "center", inline: "center" });
    });
  }, [rootEl, query]);

  const goTo = useCallback(
    (backwards: boolean) => {
      const marks = marksRef.current;
      if (marks.length === 0) return;
      setCurrent((c) => {
        let next = backwards ? c - 1 : c + 1;
        if (next < 1) next = marks.length;
        if (next > marks.length) next = 1;
        // 切 class: 旧的去掉, 新的加上
        const prevMark = marks[c - 1];
        const nextMark = marks[next - 1];
        prevMark?.classList.remove("search-hit-current");
        nextMark?.classList.add("search-hit-current");
        nextMark?.scrollIntoView({ block: "center", inline: "center" });
        return next;
      });
    },
    [],
  );

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    goTo(false);
  }

  return (
    <div
      className="fixed top-20 right-6 z-40 bg-[var(--color-paper-soft)] border border-[var(--color-paper-edge)] rounded-md shadow-lg px-2 py-2 flex items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      <form onSubmit={onSubmit} className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Enter") {
              e.preventDefault();
              goTo(e.shiftKey);
            } else if (e.key === "F3" || (e.key === "g" && (e.ctrlKey || e.metaKey))) {
              e.preventDefault();
              goTo(e.shiftKey);
            }
          }}
          placeholder="本书内查找…"
          className="studio-input text-xs w-48"
        />
        <span className="text-[10px] studio-subtle tabular-nums min-w-[3.5rem] text-right">
          {query.trim() === "" ? "—" : total === 0 ? "0" : `${current || 1} / ${total}`}
        </span>
        <button
          type="button"
          onClick={() => goTo(true)}
          disabled={total === 0}
          aria-label="上一个匹配 (Shift+Enter)"
          className="studio-icon-button w-7 h-7 text-xs disabled:opacity-30"
          title="上一个 (Shift+Enter)"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => goTo(false)}
          disabled={total === 0}
          aria-label="下一个匹配 (Enter)"
          className="studio-icon-button w-7 h-7 text-xs disabled:opacity-30"
          title="下一个 (Enter / F3)"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          title="关闭 (ESC)"
          className="studio-icon-button w-7 h-7 text-xs"
        >
          ×
        </button>
      </form>
    </div>
  );
}

type Match = { textNode: Text; start: number; end: number };

/**
 * 在 root 内 walk 所有 text node 找 query 的 case-insensitive 匹配。
 * 跳过 `<script>` / `<style>` / 已有的 `mark.search-hit` (防 re-wrap 死循环).
 */
function scanMatches(root: HTMLElement, q: string): Match[] {
  const needle = q.toLowerCase();
  if (needle === "") return [];
  const out: Match[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const parent = n.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      if (parent.classList.contains("search-hit"))
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.textContent ?? "").toLowerCase();
    if (text.length < needle.length) continue;
    let idx = 0;
    while ((idx = text.indexOf(needle, idx)) !== -1) {
      out.push({ textNode: node as Text, start: idx, end: idx + needle.length });
      idx += needle.length;
    }
  }
  return out;
}

/**
 * 把每个匹配包成 `<mark.search-hit>`. 当前 currentIdx 那条加
 * `.search-hit-current`. 返回按 matches 原序的 mark 元素数组。
 *
 * 注意：同一 textNode 多个匹配要从后往前 wrap，否则前面的 wrap 会让后面的
 * offsets 失效。
 */
function wrapMatches(matches: Match[], currentIdx: number): HTMLElement[] {
  const out: HTMLElement[] = new Array(matches.length);
  // 按 textNode 分组保留原 index 映射
  const groups = new Map<
    Text,
    Array<{ origIdx: number; match: Match }>
  >();
  matches.forEach((m, i) => {
    const arr = groups.get(m.textNode) ?? [];
    arr.push({ origIdx: i, match: m });
    groups.set(m.textNode, arr);
  });
  for (const arr of groups.values()) {
    // 同 textNode 内倒序 wrap
    arr.sort((a, b) => b.match.start - a.match.start);
    for (const { origIdx, match } of arr) {
      const range = document.createRange();
      try {
        range.setStart(match.textNode, match.start);
        range.setEnd(match.textNode, match.end);
        const mark = document.createElement("mark");
        mark.className =
          origIdx === currentIdx ? "search-hit search-hit-current" : "search-hit";
        // inline style 兜底，不依赖外部 CSS 一定被加载
        mark.style.cssText = `background:${
          origIdx === currentIdx
            ? "rgba(255,140,0,0.85)"
            : "rgba(255,210,90,0.45)"
        };color:inherit;border-radius:2px;`;
        range.surroundContents(mark);
        out[origIdx] = mark;
      } catch {
        // 跨边界等极少数情况下 surroundContents 抛错——跳过这条
      }
    }
  }
  return out;
}

/** 卸载所有 mark.search-hit, 把 textContent 还原。 */
function clearSearchMarks(root: HTMLElement) {
  const marks = root.querySelectorAll("mark.search-hit");
  marks.forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  root.normalize();
}
