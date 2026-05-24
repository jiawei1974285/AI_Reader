import { useEffect, useMemo, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ipc, isTauriRuntime, type Book, type HighlightWithBook } from "@/lib/ipc";
import {
  buildAllBooksMarkdown,
  buildAnkiCsv,
  buildBookMarkdown,
  downloadTextFile,
} from "./markdown";

const COLOR_HEX: Record<string, string> = {
  yellow: "#facc15",
  green: "#84cc5a",
  blue: "#60a5fa",
  red: "#fc645a",
};

type Props = {
  onBack: () => void;
  onOpenBookAtHighlight: (book: Book, spineIdx: number, hlId: number) => void;
};

export function NotesView({ onBack, onOpenBookAtHighlight }: Props) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<HighlightWithBook[]>([]);
  const [books, setBooks] = useState<Map<number, Book>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load all highlights (with debouncing for the search box)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(() => {
      ipc
        .listAllHighlights(query || null)
        .then((rows) => {
          if (!cancelled) setItems(rows);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query]);

  // Load Book objects for the items we have (so we can re-open them)
  useEffect(() => {
    ipc
      .listBooks()
      .then((bs) => {
        const m = new Map<number, Book>();
        for (const b of bs) m.set(b.id, b);
        setBooks(m);
      })
      .catch(() => {});
  }, []);

  // Group items by book
  const grouped = useMemo(() => {
    const m = new Map<number, HighlightWithBook[]>();
    for (const it of items) {
      const list = m.get(it.book_id) ?? [];
      list.push(it);
      m.set(it.book_id, list);
    }
    return Array.from(m.entries());
  }, [items]);

  return (
    <div className="app-frame flex flex-col">
      <header className="studio-header px-6 py-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="studio-title text-2xl leading-tight">
            笔记
          </h2>
          <p className="text-xs studio-subtle mt-0.5">
            {loading ? "搜索中…" : `${items.length} 条标注，跨 ${grouped.length} 本书`}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs flex-shrink-0">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标注或笔记…"
            className="studio-input text-sm w-64"
          />
          {/* C10: 导出当前可见结果。Markdown 适合手动阅读 / 二次编辑；
              CSV 适合直接灌进 Anki 当卡片用。 */}
          <button
            onClick={() => {
              if (items.length === 0) return;
              const md = buildAllBooksMarkdown(items);
              const ts = new Date()
                .toISOString()
                .slice(0, 10)
                .replace(/-/g, "");
              downloadTextFile(
                `aireader-标注-${ts}.md`,
                md,
                "text/markdown;charset=utf-8",
              );
            }}
            disabled={items.length === 0}
            className="studio-button disabled:opacity-50 disabled:cursor-not-allowed"
            title="导出当前可见的所有标注为 Markdown"
          >
            导出 .md
          </button>
          <button
            onClick={() => {
              if (items.length === 0) return;
              const csv = buildAnkiCsv(items);
              const ts = new Date()
                .toISOString()
                .slice(0, 10)
                .replace(/-/g, "");
              downloadTextFile(
                `aireader-anki-${ts}.csv`,
                csv,
                "text/csv;charset=utf-8",
              );
            }}
            disabled={items.length === 0}
            className="studio-button disabled:opacity-50 disabled:cursor-not-allowed"
            title="导出当前可见的所有标注为 Anki 卡片 (CSV)"
          >
            导出 Anki
          </button>
          <button
            onClick={onBack}
            className="studio-button"
          >
            返回书架
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-8 py-6">
        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

        {!loading && items.length === 0 && (
          <div className="text-center py-24 text-sm text-[var(--color-muted)]">
            {query
              ? `「${query}」没有匹配的标注`
              : "你还没有任何标注。打开一本书，选中文字试试看。"}
          </div>
        )}

        <div className="space-y-8 max-w-3xl mx-auto">
          {grouped.map(([bookId, hls]) => (
            <section key={bookId}>
              <div className="flex items-baseline justify-between mb-4 pb-2 border-b border-[var(--color-paper-edge)]">
                <h3 className="font-serif text-xl text-[var(--color-ink)]">
                  {hls[0].book_title}
                </h3>
                <div className="flex items-center gap-3 text-xs text-[var(--color-muted)]">
                  <span>
                    {hls[0].book_author || "—"} · {hls.length} 条
                  </span>
                  {/* C10: 单本导出 */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const md = buildBookMarkdown(
                        {
                          title: hls[0].book_title,
                          author: hls[0].book_author,
                        },
                        hls,
                        [],
                      );
                      const safeTitle =
                        hls[0].book_title.replace(/[<>:"/\\|?*]/g, "_") ||
                        "book";
                      downloadTextFile(
                        `${safeTitle}-标注.md`,
                        md,
                        "text/markdown;charset=utf-8",
                      );
                    }}
                    className="studio-chip text-[10px] px-2 py-0.5"
                    title="导出本书所有标注为 Markdown"
                  >
                    ↓ .md
                  </button>
                  {/* C10: 单本 EPUB 导出（走后端 zip 打包，可用 Calibre / Apple Books 打开） */}
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!isTauriRuntime()) return;
                      const safeTitle =
                        hls[0].book_title.replace(/[<>:"/\\|?*]/g, "_") ||
                        "book";
                      const picked = await saveDialog({
                        defaultPath: `${safeTitle}-标注.epub`,
                        filters: [{ name: "EPUB", extensions: ["epub"] }],
                      });
                      if (!picked) return;
                      try {
                        await ipc.exportHighlightsEpub(
                          Number(bookId),
                          String(picked),
                        );
                      } catch (err) {
                        // eslint-disable-next-line no-alert
                        alert(`导出 EPUB 失败：${String(err)}`);
                      }
                    }}
                    className="studio-chip text-[10px] px-2 py-0.5"
                    title="导出本书所有标注为 EPUB"
                  >
                    ↓ .epub
                  </button>
                </div>
              </div>
              <ul className="space-y-3">
                {hls.map((h) => {
                  const book = books.get(h.book_id);
                  return (
                    <li key={h.id}>
                      <button
                        onClick={() =>
                          book &&
                          onOpenBookAtHighlight(book, h.spine_index, h.id)
                        }
                        disabled={!book}
                        className="studio-card w-full text-left p-4 flex gap-4 items-start disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <span
                          className="block w-1 self-stretch rounded-full flex-shrink-0"
                          style={{
                            background: COLOR_HEX[h.color] ?? "#facc15",
                          }}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="font-serif text-base text-[var(--color-ink)] leading-snug">
                            {h.selected_text}
                          </p>
                          {h.note && (
                            <p className="text-sm text-[var(--color-ink-soft)] mt-2 italic leading-snug">
                              {h.note}
                            </p>
                          )}
                          <p className="text-[10px] text-[var(--color-muted)] mt-2 tracking-[0.2em] uppercase">
                            第 {h.spine_index + 1} 章 ·{" "}
                            {new Date(h.updated_at).toLocaleDateString("zh-CN")}
                          </p>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
