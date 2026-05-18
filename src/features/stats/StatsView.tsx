import { useEffect, useMemo, useState } from "react";
import { ipc, type Book, type HighlightWithBook } from "@/lib/ipc";

type Props = {
  onBack: () => void;
  onOpenBook: (book: Book) => void;
};

/**
 * Reading statistics page. Aggregates whatever the DB already gives us:
 *   - per-book reading time (books.read_time_ms)
 *   - last-read timestamp (books.last_read_at, from reading_progress JOIN)
 *   - total annotations across the library
 *   - per-category totals
 *
 * Daily / weekly time-series isn't here yet — we don't bucket read
 * heartbeats by day in the DB. Could be added later by extending the
 * `add_read_time` command to also write into a `read_time_daily` table.
 */
export function StatsView({ onBack, onOpenBook }: Props) {
  const [books, setBooks] = useState<Book[]>([]);
  const [highlights, setHighlights] = useState<HighlightWithBook[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([ipc.listBooks(), ipc.listAllHighlights(null)])
      .then(([b, h]) => {
        if (cancelled) return;
        setBooks(b);
        setHighlights(h);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = useMemo(() => {
    const totalMs = books.reduce((acc, b) => acc + (b.read_time_ms ?? 0), 0);
    const startedBooks = books.filter((b) => (b.read_time_ms ?? 0) > 60_000);
    const finishedSinceLastWeek = books.filter((b) => {
      if (!b.last_read_at) return false;
      const week = 7 * 86_400_000;
      return Date.now() - b.last_read_at < week;
    });

    // Per-book ranking (top 10 by time)
    const topByTime = books
      .filter((b) => (b.read_time_ms ?? 0) > 0)
      .slice()
      .sort((a, b) => (b.read_time_ms ?? 0) - (a.read_time_ms ?? 0))
      .slice(0, 10);

    // Per-category aggregation
    const byCategory = new Map<string, { ms: number; count: number }>();
    for (const b of books) {
      const k = b.category && b.category.trim() ? b.category : "未分类";
      const cur = byCategory.get(k) ?? { ms: 0, count: 0 };
      cur.ms += b.read_time_ms ?? 0;
      cur.count += 1;
      byCategory.set(k, cur);
    }
    const categoryList = Array.from(byCategory.entries())
      .map(([cat, v]) => ({ cat, ...v }))
      .sort((a, b) => b.ms - a.ms);

    // Annotations distribution
    const annotationsByBook = new Map<number, number>();
    for (const h of highlights) {
      annotationsByBook.set(h.book_id, (annotationsByBook.get(h.book_id) ?? 0) + 1);
    }
    const topAnnotated = books
      .map((b) => ({ book: b, count: annotationsByBook.get(b.id) ?? 0 }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalMs,
      bookCount: books.length,
      startedCount: startedBooks.length,
      recentCount: finishedSinceLastWeek.length,
      highlightCount: highlights.length,
      topByTime,
      categoryList,
      topAnnotated,
    };
  }, [books, highlights]);

  if (loading) {
    return (
      <div className="app-frame flex items-center justify-center text-sm studio-subtle">
        正在汇总数据…
      </div>
    );
  }

  return (
    <div className="app-frame flex flex-col overflow-hidden">
      <header className="studio-header px-6 py-4 flex items-center justify-between gap-4 flex-shrink-0">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="studio-button">
            ← 返回书架
          </button>
          <h1 className="studio-title text-2xl leading-tight">阅读统计</h1>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-7 py-7 max-w-5xl mx-auto w-full">
        {/* Top-line metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          <MetricCard label="总阅读时长" value={formatDuration(stats.totalMs)} />
          <MetricCard label="书库总数" value={`${stats.bookCount}`} sub="本" />
          <MetricCard
            label="已开读"
            value={`${stats.startedCount}`}
            sub={`本 · 最近 7 天 ${stats.recentCount}`}
          />
          <MetricCard
            label="批注总数"
            value={`${stats.highlightCount}`}
            sub="条"
          />
        </div>

        {/* Top by reading time */}
        <Section title="阅读时长榜单">
          {stats.topByTime.length === 0 ? (
            <EmptyHint>还没有累计的阅读时间。打开任一本书读 1 分钟以上就会出现。</EmptyHint>
          ) : (
            <ul className="space-y-2">
              {stats.topByTime.map((b, i) => (
                <li
                  key={b.id}
                  className="flex items-center gap-3 py-2 px-3 rounded border border-[var(--color-paper-edge)] hover:bg-[var(--color-paper-edge)]/20 cursor-pointer transition"
                  onClick={() => onOpenBook(b)}
                >
                  <span className="w-6 text-right text-xs studio-subtle tabular-nums">
                    {i + 1}
                  </span>
                  <span className="flex-1 truncate text-sm text-[var(--color-ink)]">
                    {b.title || "(无题)"}
                  </span>
                  <span className="text-xs studio-subtle truncate max-w-[8rem]">
                    {b.author || "—"}
                  </span>
                  <span className="text-xs text-[var(--color-accent)] tabular-nums w-16 text-right">
                    {formatDuration(b.read_time_ms)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Per-category */}
        <Section title="分类分布">
          {stats.categoryList.length === 0 ? (
            <EmptyHint>还没有分类。在书架点「AI 整理」可自动分类。</EmptyHint>
          ) : (
            <ul className="space-y-1.5">
              {stats.categoryList.map((c) => {
                const ratio =
                  stats.totalMs === 0 ? 0 : c.ms / stats.totalMs;
                return (
                  <li key={c.cat} className="flex items-center gap-3">
                    <span className="w-20 text-xs text-[var(--color-ink-soft)] truncate flex-shrink-0">
                      {c.cat}
                    </span>
                    <div className="flex-1 h-2 bg-[var(--color-paper-edge)]/40 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--color-accent)]"
                        style={{ width: `${Math.max(2, ratio * 100)}%` }}
                      />
                    </div>
                    <span className="text-[11px] studio-subtle tabular-nums w-20 text-right">
                      {c.count} 本 · {formatDuration(c.ms)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {/* Top annotated */}
        <Section title="批注最多">
          {stats.topAnnotated.length === 0 ? (
            <EmptyHint>还没有批注。读书时选中文字 → 涂色即可记一条。</EmptyHint>
          ) : (
            <ul className="space-y-2">
              {stats.topAnnotated.map(({ book, count }) => (
                <li
                  key={book.id}
                  className="flex items-center gap-3 py-2 px-3 rounded border border-[var(--color-paper-edge)] hover:bg-[var(--color-paper-edge)]/20 cursor-pointer transition"
                  onClick={() => onOpenBook(book)}
                >
                  <span className="flex-1 truncate text-sm text-[var(--color-ink)]">
                    {book.title}
                  </span>
                  <span className="text-xs text-[var(--color-accent)] tabular-nums">
                    {count} 条
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </main>
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="studio-panel py-4 px-4 flex flex-col">
      <span className="text-[10px] studio-subtle tracking-[0.18em] uppercase">
        {label}
      </span>
      <span className="font-serif text-2xl text-[var(--color-ink)] mt-1 tabular-nums">
        {value}
      </span>
      {sub && <span className="text-[10px] studio-subtle mt-0.5">{sub}</span>}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="font-serif text-base text-[var(--color-ink)] mb-3 tracking-wider">
        {title}
      </h2>
      {children}
    </section>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs studio-subtle leading-relaxed py-3 px-4 rounded border border-dashed border-[var(--color-paper-edge)]">
      {children}
    </p>
  );
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return "0m";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}
