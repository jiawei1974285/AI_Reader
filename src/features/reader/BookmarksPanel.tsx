import { useEffect, useMemo, useState } from "react";
import type { Bookmark, TocEntry } from "@/lib/ipc";

type Props = {
  bookmarks: Bookmark[];
  toc: TocEntry[];
  loading: boolean;
  onJump: (bookmark: Bookmark) => void;
  onDelete: (bookmark: Bookmark) => void;
  onClose: () => void;
};

export function BookmarksPanel({
  bookmarks,
  toc,
  loading,
  onJump,
  onDelete,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const labelFor = useMemo(() => {
    const m = new Map<number, string>();
    for (const entry of toc) {
      if (!m.has(entry.spine_index)) m.set(entry.spine_index, entry.label);
    }
    return (idx: number) => m.get(idx) ?? `第 ${idx + 1} 章`;
  }, [toc]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bookmarks;
    return bookmarks.filter((bookmark) => {
      const haystack = [
        bookmark.label,
        bookmark.excerpt,
        labelFor(bookmark.spine_index),
        String(bookmark.spine_index + 1),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [bookmarks, labelFor, query]);

  return (
    <div className="absolute inset-0 z-30 flex justify-end">
      <div className="absolute inset-0 bg-[var(--color-ink)]/10 backdrop-blur-[2px]" />
      <aside className="studio-drawer relative h-full w-80 md:w-96 flex flex-col">
        <div className="px-6 py-5 border-b border-[var(--color-paper-edge)] flex items-center justify-between flex-shrink-0 gap-3">
          <div className="min-w-0">
            <h3 className="studio-title text-lg">书签列表</h3>
            <p className="text-xs text-[var(--color-muted)] mt-0.5">
              共 {bookmarks.length} 条
            </p>
          </div>
          <button
            onClick={onClose}
            className="studio-icon-button flex-shrink-0"
            aria-label="Close"
          >
            x
          </button>
        </div>

        {bookmarks.length > 0 && (
          <div className="px-6 py-3 border-b border-[var(--color-paper-edge)] bg-[var(--color-paper)]/30 flex flex-col gap-2 flex-shrink-0">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索书签 / 摘录 / 章节"
              className="studio-input text-xs"
            />
            <span className="text-[10px] studio-subtle tabular-nums">
              {query.trim() ? `${filtered.length} / ${bookmarks.length} 条` : `共 ${bookmarks.length} 条`}
            </span>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {loading && (
            <div className="px-6 py-12 text-center text-sm text-[var(--color-muted)]">
              正在加载书签...
            </div>
          )}
          {!loading && bookmarks.length === 0 && (
            <div className="px-6 py-12 text-center text-sm text-[var(--color-muted)]">
              当前书还没有书签
            </div>
          )}
          {!loading && bookmarks.length > 0 && filtered.length === 0 && (
            <div className="px-6 py-12 text-center text-sm text-[var(--color-muted)]">
              没有匹配的书签
              <br />
              <button
                onClick={() => setQuery("")}
                className="mt-2 text-xs text-[var(--color-accent)] underline underline-offset-4"
              >
                清空搜索
              </button>
            </div>
          )}
          <ul>
            {filtered.map((bookmark) => (
              <li
                key={bookmark.id}
                className="group relative hover:bg-[var(--color-paper-edge)]/25 transition"
              >
                <button
                  onClick={() => onJump(bookmark)}
                  className="w-full text-left px-6 py-3 flex gap-3 items-start"
                >
                  <span className="block w-1 self-stretch rounded-full flex-shrink-0 mt-0.5 bg-[var(--color-accent)]" />
                  <div className="min-w-0 flex-1 pr-6">
                    <p className="text-[10px] tracking-[0.22em] uppercase text-[var(--color-muted)]">
                      {bookmark.label || labelFor(bookmark.spine_index)}
                    </p>
                    {bookmark.excerpt && (
                      <p className="font-serif text-sm text-[var(--color-ink)] leading-snug line-clamp-3 mt-1.5">
                        {bookmark.excerpt}
                      </p>
                    )}
                    <p className="text-[10px] text-[var(--color-muted)] mt-2 tabular-nums">
                      位置 {bookmark.spine_index + 1}
                      {bookmark.scroll_y > 0 ? ` / ${Math.round(bookmark.scroll_y)}px` : ""}
                    </p>
                  </div>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(bookmark);
                  }}
                  className="absolute top-2 right-3 w-6 h-6 flex items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper-edge)]/60 hover:text-red-600 opacity-0 group-hover:opacity-100 transition"
                  aria-label="删除这条书签"
                  title="删除这条书签"
                >
                  x
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
