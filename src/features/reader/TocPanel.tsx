import type { TocEntry } from "@/lib/ipc";

type Props = {
  toc: TocEntry[];
  activeSpineIndex: number;
  loading: boolean;
  onJump: (spineIndex: number) => void;
  onClose: () => void;
};

/**
 * Persistent left-rail TOC. Rendered inline as a sibling of the reading
 * area (not an overlay). The hosting view controls visibility via the
 * `toc_sidebar_open` reader setting; the × button here just sets that flag
 * to false through the supplied `onClose`.
 */
export function TocPanel({
  toc,
  activeSpineIndex,
  loading,
  onJump,
  onClose,
}: Props) {
  return (
    <aside className="h-full w-72 lg:w-80 flex-shrink-0 bg-[var(--color-paper-soft)] border-r border-[var(--color-paper-edge)] flex flex-col">
      <div className="px-5 py-4 border-b border-[var(--color-paper-edge)] flex items-center justify-between flex-shrink-0">
        <h3 className="font-serif text-base text-[var(--color-ink)] tracking-wider">
          目录
        </h3>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper-edge)]/40 hover:text-[var(--color-ink)] transition"
          aria-label="隐藏目录"
          title="隐藏目录"
        >
          ×
        </button>
      </div>
      <nav className="flex-1 overflow-auto py-2">
        {loading && (
          <div className="px-5 py-4 text-sm text-[var(--color-muted)]">
            加载目录…
          </div>
        )}
        {!loading && toc.length === 0 && (
          <div className="px-5 py-4 text-sm text-[var(--color-muted)] leading-relaxed">
            本书未提供目录信息
          </div>
        )}
        <ul>
          {toc.map((e, i) => {
            const active = e.spine_index === activeSpineIndex;
            return (
              <li key={`${i}-${e.spine_index}`}>
                <button
                  onClick={() => onJump(e.spine_index)}
                  className={`w-full text-left px-5 py-1.5 text-sm transition flex items-baseline gap-2.5 ${
                    active
                      ? "bg-[var(--color-paper-edge)]/50 text-[var(--color-ink)] font-medium"
                      : "text-[var(--color-ink-soft)] hover:bg-[var(--color-paper-edge)]/25"
                  }`}
                  style={{ paddingLeft: `${1.25 + e.depth * 1.25}rem` }}
                  title={e.label}
                >
                  <span className="text-[10px] text-[var(--color-muted)] tabular-nums flex-shrink-0 w-7 text-right">
                    {e.spine_index + 1}
                  </span>
                  <span className="line-clamp-2 leading-snug">{e.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
