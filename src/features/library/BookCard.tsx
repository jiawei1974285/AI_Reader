import { convertFileSrc } from "@tauri-apps/api/core";
import { useState } from "react";
import { ipc, type Book, type DoubanMetadata } from "@/lib/ipc";

type Props = {
  book: Book;
  onClick: () => void;
  onRemove?: () => void;
};

const PLACEHOLDER_HUES = [
  ["#c2a878", "#8a6e4a"],
  ["#a8b89a", "#5e7050"],
  ["#b89aa8", "#705066"],
  ["#9aa8b8", "#506b80"],
  ["#c89866", "#7a5230"],
  ["#a89ab8", "#5e4d70"],
  ["#9ab8a8", "#506e62"],
];

const FORMAT_LABELS: Record<Book["format"], string> = {
  epub: "EPUB",
  txt: "TXT",
  pdf: "PDF",
  docx: "DOCX",
  mobi: "MOBI",
  azw: "AZW",
  azw3: "AZW3",
};

// Each format gets its own tinted background so users can scan a grid
// and pick out formats at a glance. Picked to read on both light and
// dark covers (semi-transparent over a dark backdrop).
const FORMAT_COLORS: Record<Book["format"], string> = {
  epub: "bg-emerald-700/85",
  pdf: "bg-rose-700/85",
  mobi: "bg-amber-700/85",
  azw: "bg-orange-700/85",
  azw3: "bg-yellow-700/85",
  docx: "bg-sky-700/85",
  txt: "bg-stone-700/85",
};

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function placeholderColors(title: string): [string, string] {
  const idx = hashString(title) % PLACEHOLDER_HUES.length;
  return PLACEHOLDER_HUES[idx] as [string, string];
}

export function BookCard({ book, onClick, onRemove }: Props) {
  const [douban, setDouban] = useState<DoubanMetadata | null>(null);
  const [doubanLoaded, setDoubanLoaded] = useState(false);
  const hasCover = !!book.cover_path;
  const coverSrc = hasCover ? convertFileSrc(book.cover_path as string) : "";
  const [c1, c2] = placeholderColors(book.title || book.file_path);
  const firstChar = (book.title || "?").trim().charAt(0) || "?";

  function loadDoubanMetadata() {
    if (doubanLoaded) return;
    setDoubanLoaded(true);
    ipc
      .getDoubanMetadata(book.id)
      .then((metadata) => setDouban(metadata))
      .catch(() => setDouban(null));
  }

  const hasDoubanInfo =
    douban?.status === "ok" &&
    (douban.rating || douban.rating_count || douban.summary || douban.douban_url);

  // Wrap the whole card in a div so we can host the hover-revealed
  // remove button as a sibling rather than nested inside the <button>
  // (nesting buttons is invalid HTML and would propagate clicks).
  return (
    <div className="relative group" onMouseEnter={loadDoubanMetadata}>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (
              confirm(
                `从书架移除《${book.title || book.file_path}》？\n（不删除原文件，下次扫描会重新加入）`,
              )
            ) {
              onRemove();
            }
          }}
          aria-label="从书架移除"
          title="从书架移除（不删除文件）"
          // Bottom-right corner of the card so it doesn't collide with
          // format badge (top-left) or category badge (top-right).
          // Higher z than badges so we always click through.
          className="absolute bottom-[88px] right-2 z-20 w-6 h-6 rounded-full bg-[var(--color-ink)]/80 text-[var(--color-paper)] text-sm opacity-0 group-hover:opacity-100 hover:bg-red-700 hover:scale-110 transition flex items-center justify-center shadow-md"
        >
          ×
        </button>
      )}
      <button
        onClick={onClick}
        className="studio-card text-left flex flex-col overflow-hidden relative w-full"
      >
      {/* Format badge — always shown, top-left */}
      <span
        className={`absolute top-2 left-2 z-10 px-1.5 py-0.5 text-[10px] rounded ${FORMAT_COLORS[book.format]} text-white tracking-[0.08em] font-medium backdrop-blur-sm`}
        title={`格式：${FORMAT_LABELS[book.format]}`}
      >
        {FORMAT_LABELS[book.format]}
      </span>

      {/* Category badge — only when categorised, top-right */}
      {book.category && book.category.trim() !== "" && (
        <span
          className="absolute top-2 right-2 z-10 px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-ink)]/70 text-[var(--color-paper-soft)] backdrop-blur-sm"
          title={book.category}
        >
          {book.category}
        </span>
      )}
      <div className="aspect-[3/4] w-full overflow-hidden bg-[var(--color-paper-edge)]/40 flex items-center justify-center">
        {hasCover ? (
          <img
            src={coverSrc}
            alt={book.title}
            className="w-full h-full object-cover transition duration-300 group-hover:scale-[1.025]"
            loading="lazy"
            draggable={false}
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{
              background: `linear-gradient(135deg, ${c1} 0%, ${c2} 100%)`,
            }}
          >
            <span className="font-serif text-5xl text-white/85 select-none">
              {firstChar}
            </span>
          </div>
        )}
      </div>
      <div className="px-3 py-2.5 flex flex-col gap-1 min-h-[82px]">
        <h3 className="font-serif text-sm leading-tight line-clamp-2 text-[var(--color-ink)]">
          {book.title}
        </h3>
        <p className="text-[11px] text-[var(--color-ink-soft)] line-clamp-1 min-w-0">
          {book.author || "佚名"}
        </p>
        <div className="mt-auto flex items-center justify-end gap-2 pt-1">
          <p className="text-[10px] text-[var(--color-muted)] tabular-nums flex-shrink-0">
            {book.read_time_ms > 60_000
              ? formatDuration(book.read_time_ms)
              : "未读"}
          </p>
        </div>
      </div>
      </button>
      <div className="pointer-events-none absolute left-2 right-2 top-3 z-30 translate-y-2 opacity-0 transition duration-150 group-hover:translate-y-0 group-hover:opacity-100">
        <div className="pointer-events-auto rounded-md border border-[var(--color-paper-edge)] bg-[var(--color-paper)]/95 px-3 py-2 shadow-xl backdrop-blur">
          {hasDoubanInfo ? (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium text-[var(--color-ink)]">
                  豆瓣
                </span>
                <span className="text-[11px] tabular-nums text-[var(--color-accent)]">
                  {douban.rating ? `★ ${douban.rating}` : "暂无评分"}
                  {douban.rating_count
                    ? ` · ${douban.rating_count.toLocaleString()}人`
                    : ""}
                </span>
              </div>
              {douban.summary && (
                <p className="text-[11px] leading-relaxed text-[var(--color-ink-soft)] line-clamp-4">
                  {douban.summary}
                </p>
              )}
              {douban.douban_url && (
                <a
                  href={douban.douban_url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex text-[11px] text-[var(--color-accent)] hover:underline"
                >
                  打开豆瓣
                </a>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-[var(--color-muted)]">
              {doubanLoaded ? "暂无豆瓣信息" : "读取豆瓣信息..."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
