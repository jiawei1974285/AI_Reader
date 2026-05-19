import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ipc,
  isTauriRuntime,
  type Book,
  type ClassifyProgress,
} from "@/lib/ipc";
import { BookCard } from "./BookCard";
import { RecommendPanel } from "./RecommendPanel";

type SortKey = "added_desc" | "read_desc" | "title_asc" | "author_asc";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "added_desc", label: "最近添加" },
  { value: "read_desc", label: "最近阅读" },
  { value: "title_asc", label: "标题 A-Z" },
  { value: "author_asc", label: "作者 A-Z" },
];

const CATEGORY_ORDER = [
  "文学小说",
  "历史",
  "哲学",
  "科技",
  "经管",
  "心理",
  "艺术",
  "诗歌散文",
  "教材工具书",
  "传记",
  "其他",
];

const FORMAT_ORDER: Book["format"][] = ["epub", "pdf", "mobi", "docx", "txt"];
const FORMAT_LABEL: Record<Book["format"], string> = {
  epub: "EPUB",
  pdf: "PDF",
  mobi: "MOBI",
  docx: "DOCX",
  txt: "TXT",
};

type Props = {
  onOpenBook: (book: Book) => void;
  onOpenNotes: () => void;
  onOpenMusic: () => void;
  onOpenStats: () => void;
  onOpenAiSettings: () => void;
};

export function LibraryView({
  onOpenBook,
  onOpenNotes,
  onOpenMusic,
  onOpenStats,
  onOpenAiSettings,
}: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<string | null>(null);
  const [recommendOpen, setRecommendOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(
    () => localStorage.getItem("library_category") || null,
  );
  const [activeFormat, setActiveFormat] = useState<Book["format"] | null>(
    () => (localStorage.getItem("library_format") as Book["format"]) || null,
  );

  // Library scroll position is preserved across navigations (reader →
  // back) for the session. We use sessionStorage (not localStorage) so
  // reopening the app resets to the top, which matches the user's mental
  // model of a "fresh start" vs. "I was here a moment ago".
  const scrollRef = useRef<HTMLElement | null>(null);
  const restoredScrollRef = useRef(false);
  const [classifying, setClassifying] = useState(false);
  const [classifyProgress, setClassifyProgress] =
    useState<ClassifyProgress | null>(null);
  const [searchQuery, setSearchQuery] = useState(
    () => localStorage.getItem("library_search") ?? "",
  );
  const [sortKey, setSortKey] = useState<SortKey>(
    () => (localStorage.getItem("library_sort") as SortKey) || "added_desc",
  );

  useEffect(() => {
    localStorage.setItem("library_search", searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    localStorage.setItem("library_sort", sortKey);
  }, [sortKey]);

  useEffect(() => {
    if (activeCategory) localStorage.setItem("library_category", activeCategory);
    else localStorage.removeItem("library_category");
  }, [activeCategory]);

  useEffect(() => {
    if (activeFormat) localStorage.setItem("library_format", activeFormat);
    else localStorage.removeItem("library_format");
  }, [activeFormat]);

  // After the first list of books is rendered, restore the saved scroll
  // position once. Subsequent renders (filter changes, etc.) don't reset
  // the scroll — only this initial mount cares about it.
  useEffect(() => {
    if (restoredScrollRef.current) return;
    if (books.length === 0) return;
    const saved = sessionStorage.getItem("library_scroll");
    if (saved && scrollRef.current) {
      // Defer one frame so the grid layout has settled before we jump.
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = Number(saved) || 0;
      });
    }
    restoredScrollRef.current = true;
  }, [books]);

  useEffect(() => {
    (async () => {
      try {
        const r = await ipc.getLibraryRoot();
        setRoot(r);
        if (r) {
          const list = await ipc.listBooks();
          setBooks(list);
          ipc.startLibraryWatcher().catch(() => {});
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: UnlistenFn | null = null;
    listen<{ scanned: number; added_or_updated: number; removed: number }>(
      "library-changed",
      async (event) => {
        const p = event.payload;
        if (p.added_or_updated > 0 || p.removed > 0) {
          setLastReport(
            `自动同步 · 新增/更新 ${p.added_or_updated}${
              p.removed > 0 ? ` · 移除 ${p.removed}` : ""
            }`,
          );
        }
        try {
          setBooks(await ipc.listBooks());
        } catch {
          /* best effort */
        }
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: UnlistenFn | null = null;
    listen<ClassifyProgress>("classify-progress", (event) => {
      setClassifyProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  async function pickRoot() {
    setError(null);
    let selected = "浏览器预览书库";
    if (isTauriRuntime()) {
      const picked = await openDialog({ directory: true, multiple: false });
      if (!picked || typeof picked !== "string") return;
      selected = picked;
    }
    await ipc.setLibraryRoot(selected);
    setRoot(selected);
    await rescan();
    ipc.startLibraryWatcher().catch(() => {});
  }

  async function rescan() {
    setScanning(true);
    setError(null);
    try {
      const report = await ipc.scanLibrary();
      const parts = [
        `扫描 ${report.scanned}`,
        `新增/更新 ${report.added_or_updated}`,
      ];
      if (report.removed > 0) parts.push(`移除 ${report.removed}`);
      setLastReport(parts.join(" · "));
      setBooks(await ipc.listBooks());
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function classify() {
    setClassifying(true);
    setClassifyProgress(null);
    setError(null);
    try {
      const report = await ipc.aiClassifyBooks(false);
      const parts = [`分类 ${report.total} 本`];
      if (report.classified > 0) parts.push(`新分类 ${report.classified}`);
      if (report.skipped > 0) parts.push(`跳过 ${report.skipped}`);
      if (report.failed > 0) parts.push(`失败 ${report.failed}`);
      setLastReport(parts.join(" · "));
      setBooks(await ipc.listBooks());
    } catch (e) {
      setError(String(e));
    } finally {
      setClassifying(false);
    }
  }

  const {
    displayedBooks,
    categoryCounts,
    formatCounts,
    totalsAfterSearch,
  } = useMemo(() => {
    // First apply the search filter (shared across both facets), so counts
    // shown on each facet's chip reflect "matches if I click this".
    const q = searchQuery.trim().toLowerCase();
    const searched = q
      ? books.filter((b) => {
          const t = b.title?.toLowerCase() ?? "";
          const a = b.author?.toLowerCase() ?? "";
          return t.includes(q) || a.includes(q);
        })
      : books.slice();

    // Dependent counts (facet aware): each facet's counts are computed
    // *after* the OTHER facet has been applied, so the number on each chip
    // is honest about what clicking it would yield.
    const catFiltered =
      activeFormat === null
        ? searched
        : searched.filter((b) => b.format === activeFormat);
    const fmtFiltered =
      activeCategory === null
        ? searched
        : searched.filter((b) => {
            const k = b.category && b.category.trim() ? b.category : "未分类";
            return k === activeCategory;
          });

    const catCounts = new Map<string, number>();
    for (const b of catFiltered) {
      const k = b.category && b.category.trim() ? b.category : "未分类";
      catCounts.set(k, (catCounts.get(k) ?? 0) + 1);
    }
    const fmtCounts = new Map<Book["format"], number>();
    for (const b of fmtFiltered) {
      fmtCounts.set(b.format, (fmtCounts.get(b.format) ?? 0) + 1);
    }

    // Then both filters together for the actual grid.
    let result = searched;
    if (activeCategory !== null) {
      result = result.filter((b) => {
        const k = b.category && b.category.trim() ? b.category : "未分类";
        return k === activeCategory;
      });
    }
    if (activeFormat !== null) {
      result = result.filter((b) => b.format === activeFormat);
    }

    result.sort((a, b) => {
      switch (sortKey) {
        case "title_asc":
          return (a.title || "").localeCompare(b.title || "", "zh-Hans-CN");
        case "author_asc":
          return (a.author || "").localeCompare(b.author || "", "zh-Hans-CN");
        case "read_desc": {
          const av = a.last_read_at ?? 0;
          const bv = b.last_read_at ?? 0;
          if (av === 0 && bv === 0) return b.added_at - a.added_at;
          if (av === 0) return 1;
          if (bv === 0) return -1;
          return bv - av;
        }
        case "added_desc":
        default:
          return b.added_at - a.added_at;
      }
    });

    return {
      displayedBooks: result,
      categoryCounts: catCounts,
      formatCounts: fmtCounts,
      totalsAfterSearch: searched.length,
    };
  }, [books, activeCategory, activeFormat, searchQuery, sortKey]);

  const orderedCategories = useMemo(() => {
    const out: string[] = [];
    for (const c of CATEGORY_ORDER) {
      if (categoryCounts.has(c)) out.push(c);
    }
    for (const [k] of categoryCounts) {
      if (!CATEGORY_ORDER.includes(k) && k !== "未分类" && !out.includes(k)) {
        out.push(k);
      }
    }
    if (categoryCounts.has("未分类")) out.push("未分类");
    return out;
  }, [categoryCounts]);

  const orderedFormats = useMemo(() => {
    return FORMAT_ORDER.filter((f) => (formatCounts.get(f) ?? 0) > 0);
  }, [formatCounts]);

  // Top N recently-opened books for the "continue reading" rail.
  // Independent of the user's current sort/filter so it's always
  // available as a shortcut. Skip books never opened.
  const recentBooks = useMemo(() => {
    return books
      .filter((b) => b.last_read_at && b.last_read_at > 0)
      .slice()
      .sort((a, b) => (b.last_read_at ?? 0) - (a.last_read_at ?? 0))
      .slice(0, 6);
  }, [books]);

  if (loading) {
    return (
      <div className="app-frame flex items-center justify-center text-sm studio-subtle">
        正在打开书房...
      </div>
    );
  }

  if (!root) {
    return (
      <div className="app-frame flex flex-col items-center justify-center gap-8 px-6">
        <div className="text-center">
          <h1 className="studio-title text-5xl mb-3">AIreader</h1>
          <p className="text-sm studio-subtle tracking-widest">
            选择一个文件夹作为你的本地书库
          </p>
        </div>
        <button onClick={pickRoot} className="studio-button studio-button-primary">
          导入书库
        </button>
        {error && (
          <p className="text-sm text-red-600 max-w-md text-center">{error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="app-frame relative flex flex-col">
      <header className="studio-header px-6 py-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="studio-title text-2xl leading-tight">AIreader</h1>
            <span className="px-2 py-1 rounded border border-[var(--color-accent)]/30 text-[10px] text-[var(--color-accent)]">
              本地优先
            </span>
          </div>
          <p className="text-xs studio-subtle truncate max-w-2xl mt-1" title={root}>
            {root} · {books.length} 本{lastReport ? ` · ${lastReport}` : ""}
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs flex-shrink-0">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索书名、作者、标签"
            className="studio-input text-sm w-56"
          />
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="studio-select text-xs"
            title="排序"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button onClick={() => setRecommendOpen(true)} className="studio-button">
            推荐
          </button>
          <button onClick={onOpenNotes} className="studio-button">
            笔记
          </button>
          <button onClick={onOpenMusic} className="studio-button">
            音乐
          </button>
          <button onClick={onOpenStats} className="studio-button">
            统计
          </button>
          <button onClick={onOpenAiSettings} className="studio-button">
            AI 设置
          </button>
          <button onClick={rescan} disabled={scanning} className="studio-button">
            {scanning ? "扫描中" : "重新扫描"}
          </button>
          <button
            onClick={classify}
            disabled={classifying || books.length === 0}
            className="studio-button studio-button-primary"
            title="批量整理书籍分类"
          >
            {classifying
              ? classifyProgress
                ? `AI 整理 ${classifyProgress.current}/${classifyProgress.total}`
                : "AI 整理中"
              : "AI 整理"}
          </button>
          <button onClick={pickRoot} className="studio-button">
            换目录
          </button>
        </div>
      </header>

      {recentBooks.length > 0 && (
        <div className="px-6 py-3 border-b border-[var(--color-paper-edge)] bg-[var(--color-paper)]/30">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[10px] studio-subtle tracking-[0.18em] uppercase">
              继续阅读
            </span>
            <span className="text-[10px] text-[var(--color-muted)]">
              · 上次离开的位置
            </span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {recentBooks.map((b) => (
              <button
                key={b.id}
                onClick={() => onOpenBook(b)}
                className="flex-shrink-0 flex items-center gap-2 px-3 py-2 rounded border border-[var(--color-paper-edge)] bg-[var(--color-paper-soft)] hover:border-[var(--color-accent)]/60 hover:shadow-sm transition max-w-[16rem]"
                title={`${b.title} · ${b.author || "—"}`}
              >
                <span
                  className="font-serif text-sm truncate text-[var(--color-ink)]"
                  style={{ maxWidth: "11rem" }}
                >
                  {b.title || "(无题)"}
                </span>
                <span className="text-[10px] studio-subtle tabular-nums flex-shrink-0">
                  {formatRelativeTime(b.last_read_at ?? 0)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {(orderedFormats.length > 0 || orderedCategories.length > 0) && (
        <div className="border-b border-[var(--color-paper-edge)] bg-[var(--color-paper-soft)]/45">
          {/* Format row */}
          {orderedFormats.length > 0 && (
            <div className="px-6 pt-3 pb-1.5 flex items-center gap-2 overflow-x-auto">
              <span className="text-[10px] studio-subtle tracking-[0.18em] uppercase mr-1 flex-shrink-0">
                格式
              </span>
              <button
                onClick={() => setActiveFormat(null)}
                className={`studio-chip ${activeFormat === null ? "studio-chip-active" : ""}`}
              >
                全部 · {totalsAfterSearch}
              </button>
              {orderedFormats.map((f) => (
                <button
                  key={f}
                  onClick={() =>
                    setActiveFormat((prev) => (prev === f ? null : f))
                  }
                  className={`studio-chip ${activeFormat === f ? "studio-chip-active" : ""}`}
                >
                  {FORMAT_LABEL[f]} · {formatCounts.get(f) ?? 0}
                </button>
              ))}
            </div>
          )}
          {/* Category row */}
          {orderedCategories.length > 0 && (
            <div className="px-6 pt-1.5 pb-3 flex items-center gap-2 overflow-x-auto">
              <span className="text-[10px] studio-subtle tracking-[0.18em] uppercase mr-1 flex-shrink-0">
                分类
              </span>
              <button
                onClick={() => setActiveCategory(null)}
                className={`studio-chip ${activeCategory === null ? "studio-chip-active" : ""}`}
              >
                全部
              </button>
              {orderedCategories.map((cat) => (
                <button
                  key={cat}
                  onClick={() =>
                    setActiveCategory((prev) => (prev === cat ? null : cat))
                  }
                  className={`studio-chip ${activeCategory === cat ? "studio-chip-active" : ""}`}
                >
                  {cat} · {categoryCounts.get(cat) ?? 0}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <main
        ref={scrollRef}
        onScroll={(e) => {
          // throttle is unnecessary at this size — sessionStorage write is
          // microseconds. Single writer, no contention.
          sessionStorage.setItem(
            "library_scroll",
            String(e.currentTarget.scrollTop),
          );
        }}
        className="flex-1 overflow-auto px-7 py-7"
      >
        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}
        {books.length === 0 && !scanning && (
          <div className="studio-panel text-center py-16 text-sm studio-subtle">
            这个目录里还没有可阅读的书籍。
            <br />
            放入 EPUB / PDF / TXT / DOCX / MOBI 后重新扫描。
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(156px,1fr))] gap-4">
          {displayedBooks.map((b) => (
            <BookCard
              key={b.id}
              book={b}
              onClick={() => onOpenBook(b)}
              onRemove={async () => {
                try {
                  await ipc.removeBook(b.id);
                  setBooks((prev) => prev.filter((x) => x.id !== b.id));
                } catch (e) {
                  setError(String(e));
                }
              }}
            />
          ))}
        </div>
      </main>

      {recommendOpen && (
        <RecommendPanel
          onOpenBook={(book) => {
            setRecommendOpen(false);
            onOpenBook(book);
          }}
          onClose={() => setRecommendOpen(false)}
        />
      )}
    </div>
  );
}

function formatRelativeTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon} 月前`;
  return `${Math.floor(mon / 12)} 年前`;
}
