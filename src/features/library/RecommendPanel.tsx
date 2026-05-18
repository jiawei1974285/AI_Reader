import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ipc, type Book, type Recommendation } from "@/lib/ipc";

type Props = {
  onOpenBook: (book: Book) => void;
  onClose: () => void;
};

export function RecommendPanel({ onOpenBook, onClose }: Props) {
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    ipc
      .aiRecommendBooks({ anchorBookId: null, topK: 5 })
      .then((r) => {
        if (!cancelled) setRecs(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="absolute inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-[var(--color-ink)]/10 backdrop-blur-[2px]" />
      <aside
        onClick={(e) => e.stopPropagation()}
        className="studio-drawer relative h-full w-96 lg:w-[420px] flex flex-col"
      >
        <div className="px-6 py-5 border-b border-[var(--color-paper-edge)] flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="studio-title text-lg">下一本读什么</h3>
            <p className="text-xs studio-subtle mt-0.5">
              基于阅读记录和内容相似度
            </p>
          </div>
          <button onClick={onClose} className="studio-icon-button" aria-label="Close">
            x
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5">
          {loading && <p className="text-sm studio-subtle">正在计算...</p>}
          {error && !loading && (
            <div className="studio-panel p-4 text-sm leading-relaxed">
              <p className="text-[var(--color-ink)] mb-2">暂时无法推荐</p>
              <p className="text-xs studio-subtle">{error}</p>
              <p className="text-xs studio-subtle mt-3">
                先在阅读视图里索引几本书，推荐会更准确。
              </p>
            </div>
          )}
          {!loading && !error && recs.length === 0 && (
            <p className="text-sm studio-subtle">还没有推荐。</p>
          )}
          {!loading && !error && recs.length > 0 && (
            <ul className="space-y-3">
              {recs.map((r, i) => (
                <li key={r.book.id}>
                  <button
                    onClick={() => onOpenBook(r.book)}
                    className="studio-card w-full text-left p-3 flex gap-3 items-start"
                  >
                    <div className="w-12 h-16 flex-shrink-0 rounded overflow-hidden bg-[var(--color-paper-edge)]/50">
                      {r.book.cover_path ? (
                        <img
                          src={convertFileSrc(r.book.cover_path)}
                          alt=""
                          className="w-full h-full object-cover"
                          loading="lazy"
                          draggable={false}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center font-serif text-lg studio-subtle">
                          {(r.book.title || "?").charAt(0)}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="studio-subtle tabular-nums text-xs flex-shrink-0">
                          {i + 1}.
                        </span>
                        <h4 className="font-serif text-sm text-[var(--color-ink)] leading-snug line-clamp-2">
                          {r.book.title}
                        </h4>
                      </div>
                      {r.book.author && r.book.author !== "Unknown" && (
                        <p className="text-xs text-[var(--color-ink-soft)] mt-1">
                          {r.book.author}
                        </p>
                      )}
                      {r.reason && (
                        <p className="text-xs text-[var(--color-ink-soft)] italic mt-1.5 leading-snug">
                          {r.reason}
                        </p>
                      )}
                      <p className="text-[10px] studio-subtle mt-1.5 tracking-[0.2em] uppercase tabular-nums">
                        {r.book.format} · 相似度 {(r.score * 100).toFixed(0)}%
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
