import { convertFileSrc } from "@tauri-apps/api/core";
import type { Book } from "@/lib/ipc";

type Props = {
  book: Book;
  onClick: () => void;
};

// Stable pseudo-random gradient per book for cover placeholders.
// Uses title hash so the same book always gets the same color.
const PLACEHOLDER_HUES = [
  ["#c2a878", "#8a6e4a"],
  ["#a8b89a", "#5e7050"],
  ["#b89aa8", "#705066"],
  ["#9aa8b8", "#506b80"],
  ["#c89866", "#7a5230"],
  ["#a89ab8", "#5e4d70"],
  ["#9ab8a8", "#506e62"],
];

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

export function BookCard({ book, onClick }: Props) {
  const hasCover = !!book.cover_path;
  const coverSrc = hasCover ? convertFileSrc(book.cover_path as string) : "";
  const [c1, c2] = placeholderColors(book.title || book.file_path);
  const firstChar = (book.title || "?").trim().charAt(0) || "?";

  return (
    <button
      onClick={onClick}
      className="text-left bg-[var(--color-paper-soft)] border border-[var(--color-paper-edge)] rounded-md hover:shadow-md hover:border-[var(--color-ink)]/20 hover:-translate-y-0.5 transition flex flex-col overflow-hidden relative"
    >
      {book.category && book.category.trim() !== "" && (
        <span
          className="absolute top-2 right-2 z-10 px-1.5 py-0.5 text-[10px] rounded bg-black/40 text-white/90 backdrop-blur-sm"
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
            className="w-full h-full object-cover"
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
      <div className="px-3 py-2.5 flex flex-col gap-1 min-h-[64px]">
        <h3 className="font-serif text-sm leading-tight line-clamp-2 text-[var(--color-ink)]">
          {book.title}
        </h3>
        <div className="mt-auto flex items-baseline justify-between gap-2">
          <p className="text-[11px] text-[var(--color-ink-soft)] line-clamp-1 min-w-0">
            {book.author || "—"}
          </p>
          {book.read_time_ms > 60_000 && (
            <p
              className="text-[10px] text-[var(--color-muted)] tabular-nums flex-shrink-0"
              title="累计阅读时长"
            >
              {formatDuration(book.read_time_ms)}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}
