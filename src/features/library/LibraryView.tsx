import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ipc, type Book, type ClassifyProgress } from "@/lib/ipc";
import { BookCard } from "./BookCard";
import { RecommendPanel } from "./RecommendPanel";

type SortKey = "added_desc" | "read_desc" | "title_asc" | "author_asc";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "added_desc", label: "最近添加" },
  { value: "read_desc", label: "最近阅读" },
  { value: "title_asc", label: "标题 A-Z" },
  { value: "author_asc", label: "作者 A-Z" },
];

type Props = {
  onOpenBook: (book: Book) => void;
  onOpenNotes: () => void;
  onOpenMusic: () => void;
};

export function LibraryView({ onOpenBook, onOpenNotes, onOpenMusic }: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<string | null>(null);
  const [recommendOpen, setRecommendOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [classifying, setClassifying] = useState(false);
  const [classifyProgress, setClassifyProgress] =
    useState<ClassifyProgress | null>(null);
  // Persisted across sessions
  const [searchQuery, setSearchQuery] = useState<string>(
    () => localStorage.getItem("library_search") ?? "",
  );
  const [sortKey, setSortKey] = useState<SortKey>(
    () => (localStorage.getItem("library_sort") as SortKey) || "added_desc",
  );
  // Persist on change
  useEffect(() => {
    localStorage.setItem("library_search", searchQuery);
  }, [searchQuery]);
  useEffect(() => {
    localStorage.setItem("library_sort", sortKey);
  }, [sortKey]);

  useEffect(() => {
    (async () => {
      try {
        const r = await ipc.getLibraryRoot();
        setRoot(r);
        if (r) {
          const list = await ipc.listBooks();
          setBooks(list);
          // Kick off the file-system watcher so newly added books in the
          // library root appear without a manual scan. Best-effort: if it
          // fails (e.g. root deleted), the user can still scan manually.
          ipc.startLibraryWatcher().catch(() => {});
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Auto-refresh the book grid when the watcher detects file changes.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<{ scanned: number; added_or_updated: number; removed: number }>(
      "library-changed",
      async (event) => {
        const p = event.payload;
        // Show a brief, unobtrusive notice instead of overwriting the
        // user's last manual scan report.
        if (p.added_or_updated > 0 || p.removed > 0) {
          setLastReport(
            `自动同步 · 新增/更新 ${p.added_or_updated}${
              p.removed > 0 ? ` · 移除 ${p.removed}` : ""
            }`,
          );
        }
        try {
          const list = await ipc.listBooks();
          setBooks(list);
        } catch {
          /* swallow */
        }
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  async function pickRoot() {
    setError(null);
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") return;
    await ipc.setLibraryRoot(selected);
    setRoot(selected);
    await rescan();
    // (Re)start the watcher against the new root.
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
      const list = await ipc.listBooks();
      setBooks(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  // Listen for classification progress events
  useEffect(() => {
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
      const list = await ipc.listBooks();
      setBooks(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setClassifying(false);
    }
  }

  // Build category counts (over the full library, ignoring filters)
  // + apply: category filter → search filter → sort
  const { displayedBooks, categoryCounts } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of books) {
      const k = b.category && b.category.trim() ? b.category : "未分类";
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }

    // 1. Category filter
    let result =
      activeCategory === null
        ? books.slice()
        : books.filter((b) => {
            const k = b.category && b.category.trim() ? b.category : "未分类";
            return k === activeCategory;
          });

    // 2. Search filter (book title OR author, case-insensitive)
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter((b) => {
        const t = b.title?.toLowerCase() ?? "";
        const a = b.author?.toLowerCase() ?? "";
        return t.includes(q) || a.includes(q);
      });
    }

    // 3. Sort
    result.sort((a, b) => {
      switch (sortKey) {
        case "title_asc":
          return (a.title || "").localeCompare(b.title || "", "zh-Hans-CN");
        case "author_asc":
          return (a.author || "").localeCompare(b.author || "", "zh-Hans-CN");
        case "read_desc": {
          const av = a.last_read_at ?? 0;
          const bv = b.last_read_at ?? 0;
          // Never-read books fall to the bottom
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

    return { displayedBooks: result, categoryCounts: counts };
  }, [books, activeCategory, searchQuery, sortKey]);

  // Sort categories: known list order first, then "未分类" last
  const orderedCategories = useMemo(() => {
    const known = [
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
    const out: string[] = [];
    for (const c of known) {
      if (categoryCounts.has(c)) out.push(c);
    }
    // Any LLM-emitted oddballs
    for (const [k, _] of categoryCounts) {
      if (!known.includes(k) && k !== "未分类" && !out.includes(k)) {
        out.push(k);
      }
    }
    if (categoryCounts.has("未分类")) out.push("未分类");
    return out;
  }, [categoryCounts]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-[var(--color-muted)]">
        Loading library…
      </div>
    );
  }

  if (!root) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-8 px-6">
        <div className="text-center">
          <h1 className="font-serif text-5xl mb-3 text-[var(--color-ink)] tracking-wider">
            AI Reader
          </h1>
          <p className="text-sm text-[var(--color-muted)] tracking-widest">
            选一个文件夹作为你的书库
          </p>
        </div>
        <button
          onClick={pickRoot}
          className="px-6 py-2.5 rounded-full border border-[var(--color-paper-edge)] bg-[var(--color-paper-soft)] hover:bg-white hover:border-[var(--color-ink)]/30 text-sm font-medium transition"
        >
          选择书库目录
        </button>
        {error && (
          <p className="text-sm text-red-600 max-w-md text-center">{error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col">
      <header className="border-b border-[var(--color-paper-edge)] px-8 py-4 flex items-center justify-between bg-[var(--color-paper-soft)]/60 backdrop-blur-sm gap-4">
        <div className="min-w-0">
          <h2 className="font-serif text-lg leading-tight text-[var(--color-ink)]">
            书库
          </h2>
          <p
            className="text-xs text-[var(--color-muted)] truncate max-w-xl mt-0.5"
            title={root}
          >
            {root} · {books.length} 本
            {lastReport ? ` · ${lastReport}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-[var(--color-muted)] flex-shrink-0">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索书名 / 作者"
            className="px-3 py-1.5 rounded-md border border-[var(--color-paper-edge)] bg-[var(--color-paper)] text-sm text-[var(--color-ink)] placeholder:text-[var(--color-muted)] focus:outline-none focus:border-[var(--color-ink)]/40 w-48"
          />
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="px-2 py-1.5 rounded-md border border-[var(--color-paper-edge)] bg-[var(--color-paper)] text-xs text-[var(--color-ink)] focus:outline-none focus:border-[var(--color-ink)]/40"
            title="排序"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => setRecommendOpen(true)}
            className="hover:text-[var(--color-ink)] transition"
          >
            推荐
          </button>
          <button
            onClick={onOpenNotes}
            className="hover:text-[var(--color-ink)] transition"
          >
            笔记
          </button>
          <button
            onClick={onOpenMusic}
            className="hover:text-[var(--color-ink)] transition"
          >
            音乐
          </button>
          <button
            onClick={rescan}
            disabled={scanning}
            className="hover:text-[var(--color-ink)] disabled:opacity-50 transition"
          >
            {scanning ? "扫描中…" : "重新扫描"}
          </button>
          <button
            onClick={classify}
            disabled={classifying || books.length === 0}
            className="hover:text-[var(--color-ink)] disabled:opacity-50 transition"
            title="给未分类的书批量打分类标签"
          >
            {classifying
              ? classifyProgress
                ? `AI 整理中… ${classifyProgress.current}/${classifyProgress.total}`
                : "AI 整理中…"
              : "AI 整理"}
          </button>
          <button
            onClick={pickRoot}
            className="hover:text-[var(--color-ink)] transition"
          >
            更换目录
          </button>
        </div>
      </header>
      {orderedCategories.length > 0 && (
        <div className="border-b border-[var(--color-paper-edge)] px-8 py-2.5 bg-[var(--color-paper-soft)]/40 flex items-center gap-2 overflow-x-auto flex-shrink-0">
          <button
            onClick={() => setActiveCategory(null)}
            className={`px-3 py-1 rounded-full text-xs tabular-nums transition whitespace-nowrap ${
              activeCategory === null
                ? "bg-[var(--color-ink)] text-[var(--color-paper)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-edge)]/40"
            }`}
          >
            全部 · {books.length}
          </button>
          {orderedCategories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-3 py-1 rounded-full text-xs tabular-nums transition whitespace-nowrap ${
                activeCategory === cat
                  ? "bg-[var(--color-ink)] text-[var(--color-paper)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-edge)]/40"
              }`}
            >
              {cat} · {categoryCounts.get(cat) ?? 0}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto px-8 py-8">
        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}
        {books.length === 0 && !scanning && (
          <div className="text-center py-16 text-sm text-[var(--color-muted)]">
            这个目录里还没有 EPUB / TXT / PDF / DOCX。
            <br />
            放几本书进去，然后点「重新扫描」。
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
          {displayedBooks.map((b) => (
            <BookCard key={b.id} book={b} onClick={() => onOpenBook(b)} />
          ))}
        </div>
      </div>

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
