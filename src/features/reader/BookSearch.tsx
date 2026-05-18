import { useEffect, useRef, useState } from "react";

type Props = {
  /** Element to search within. Counts are computed from its textContent. */
  rootEl: HTMLElement | null;
  onClose: () => void;
};

/**
 * Floating in-book search bar. Triggered by Ctrl/Cmd + F in the reader.
 *
 * Navigation reuses the browser's native `window.find()` because it
 * handles Unicode / normalisation correctly, plays nice with existing
 * `<mark>` highlights, scrolls the match into view, and creates a
 * visual selection — all things our custom highlight system would have
 * to re-implement. The native API has no notion of total matches, so we
 * walk the text content separately to display "current / total".
 *
 * Limitations:
 *  - Only searches already-rendered chapters (EPUB lazy-loads next
 *    chapter on scroll). To search the whole book the user can scroll to
 *    the end first, or open the chapter directly via TOC.
 *  - Case insensitive only; advanced patterns deferred to a follow-up.
 */
export function BookSearch({ rootEl, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Recount whenever query or rootEl content changes.
  useEffect(() => {
    if (!rootEl || query.trim() === "") {
      setTotal(0);
      setCurrent(0);
      return;
    }
    setTotal(countOccurrences(rootEl, query));
    setCurrent(0);
  }, [rootEl, query]);

  function find(backwards: boolean) {
    if (query.trim() === "" || total === 0) return;
    // window.find is non-standard but supported in WebView2 / Chromium.
    // Args: (text, caseSensitive, backwards, wrapAround, ...)
    // @ts-expect-error - window.find is non-standard
    const found: boolean = window.find(query, false, backwards, true);
    if (found) {
      // Move counter — wrap at boundaries to match the wrapAround flag.
      setCurrent((c) => {
        const next = backwards ? c - 1 : c + 1;
        if (next < 1) return total;
        if (next > total) return 1;
        return next;
      });
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    find(false);
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
              find(e.shiftKey);
            } else if (e.key === "F3" || (e.key === "g" && (e.ctrlKey || e.metaKey))) {
              e.preventDefault();
              find(e.shiftKey);
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
          onClick={() => find(true)}
          disabled={total === 0}
          aria-label="上一个匹配 (Shift+Enter)"
          className="studio-icon-button w-7 h-7 text-xs disabled:opacity-30"
          title="上一个 (Shift+Enter)"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => find(false)}
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

/**
 * Count case-insensitive occurrences of `q` in the text content of
 * `root`, walking every text node. Skips inside `<script>` / `<style>`
 * (which shouldn't exist in our rendered chapters anyway).
 */
function countOccurrences(root: HTMLElement, q: string): number {
  const needle = q.toLowerCase();
  if (needle === "") return 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const parent = n.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let total = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.textContent ?? "").toLowerCase();
    if (text.length < needle.length) continue;
    let idx = 0;
    while ((idx = text.indexOf(needle, idx)) !== -1) {
      total++;
      idx += needle.length;
    }
  }
  return total;
}
