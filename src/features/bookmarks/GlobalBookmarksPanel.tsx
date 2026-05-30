import { useEffect, useMemo, useState } from "react";
import { ipc, type Book, type BookmarkWithBook } from "@/lib/ipc";

type Props = {
  open: boolean;
  onClose: () => void;
  onOpenBook: (book: Book, spineIndex: number, scrollY: number) => void;
};

export function GlobalBookmarksPanel({ open, onClose, onOpenBook }: Props) {
  const [bookmarks, setBookmarks] = useState<BookmarkWithBook[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    ipc
      .listRecentBookmarks(500)
      .then(setBookmarks)
      .catch(() => setBookmarks([]))
      .finally(() => setLoading(false));
  }, [open]);

  const filteredBookmarks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bookmarks;
    return bookmarks.filter((bookmark) => {
      const haystack = [
        bookmark.book_title,
        bookmark.book_author,
        bookmark.label,
        bookmark.excerpt,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [bookmarks, query]);

  function openBookmark(bookmark: BookmarkWithBook) {
    const book: Book = {
      id: bookmark.book_id,
      file_path: bookmark.book_path,
      format: bookmark.book_format as Book["format"],
      title: bookmark.book_title,
      author: bookmark.book_author,
      added_at: bookmark.created_at,
      file_size: 0,
      file_modified: 0,
      category: "",
      last_read_at: bookmark.created_at,
      cover_path: null,
      read_time_ms: 0,
      user_rating: null,
    };
    onClose();
    onOpenBook(book, bookmark.spine_index, bookmark.scroll_y);
  }

  if (!open) return null;

  return (
    <div className="global-drawer-backdrop">
      <button
        className="global-drawer-scrim"
        aria-label="关闭书签"
        onClick={onClose}
      />
      <aside className="global-drawer">
        <div className="global-drawer-head">
          <div className="min-w-0">
            <h2 className="studio-title text-xl leading-tight">书签</h2>
            <p className="text-xs studio-subtle mt-1">
              {bookmarks.length} 个保存的位置
            </p>
          </div>
          <button
            onClick={onClose}
            className="studio-icon-button"
            aria-label="关闭书签"
          >
            x
          </button>
        </div>

        <div className="global-drawer-search">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索书名、章节、摘录"
            className="studio-input text-sm w-full"
            autoFocus
          />
        </div>

        <div className="global-drawer-body">
          {loading ? (
            <div className="text-sm studio-subtle text-center py-12">
              正在读取书签...
            </div>
          ) : filteredBookmarks.length === 0 ? (
            <div className="text-sm studio-subtle text-center py-12">
              {bookmarks.length === 0 ? "还没有书签" : "没有匹配的书签"}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredBookmarks.map((bookmark) => (
                <button
                  key={bookmark.id}
                  onClick={() => openBookmark(bookmark)}
                  className="global-bookmark-card"
                  title={`${bookmark.book_title} · ${bookmark.label}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-serif text-sm text-[var(--color-ink)] truncate">
                        {bookmark.book_title || "(无题)"}
                      </div>
                      <div className="mt-1 text-[11px] text-[var(--color-accent)] truncate">
                        {bookmark.label || `位置 ${bookmark.spine_index + 1}`}
                      </div>
                    </div>
                    <span className="text-[10px] studio-subtle tabular-nums flex-shrink-0 pt-0.5">
                      {formatRelativeTime(bookmark.created_at)}
                    </span>
                  </div>
                  {bookmark.excerpt && (
                    <div className="mt-2 text-[11px] studio-subtle line-clamp-2">
                      {bookmark.excerpt}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function formatRelativeTime(ts: number): string {
  if (!ts) return "";
  const delta = Date.now() - ts * 1000;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return new Date(ts * 1000).toLocaleDateString();
}
