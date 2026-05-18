import type { TocEntry } from "@/lib/ipc";

type Props = {
  toc: TocEntry[];
  activeSpineIndex: number;
  loading: boolean;
  onJump: (spineIndex: number) => void;
  onClose: () => void;
};

export function TocPanel({
  toc,
  activeSpineIndex,
  loading,
  onJump,
  onClose,
}: Props) {
  return (
    <aside className="studio-sidebar h-full w-72 lg:w-80 flex-shrink-0 flex flex-col">
      <div className="px-5 py-4 border-b border-[var(--color-paper-edge)] flex items-center justify-between flex-shrink-0">
        <div>
          <h3 className="studio-title text-base">目录</h3>
          <p className="text-[11px] studio-subtle mt-0.5">
            {toc.length > 0 ? `${toc.length} 个位置` : "阅读导航"}
          </p>
        </div>
        <button
          onClick={onClose}
          className="studio-icon-button"
          aria-label="隐藏目录"
          title="隐藏目录"
        >
          x
        </button>
      </div>
      <nav className="flex-1 overflow-auto py-2">
        {loading && (
          <div className="px-5 py-4 text-sm studio-subtle">加载目录...</div>
        )}
        {!loading && toc.length === 0 && (
          <div className="px-5 py-4 text-sm studio-subtle leading-relaxed">
            这本书没有提供目录。
          </div>
        )}
        <ul>
          {toc.map((e, i) => {
            const active = e.spine_index === activeSpineIndex;
            return (
              <li key={`${i}-${e.spine_index}`}>
                <button
                  onClick={() => onJump(e.spine_index)}
                  className={`w-full text-left px-5 py-2 text-sm transition flex items-baseline gap-2.5 ${
                    active
                      ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium"
                      : "text-[var(--color-ink-soft)] hover:bg-[var(--color-paper-edge)]/28"
                  }`}
                  style={{ paddingLeft: `${1.25 + e.depth * 1.25}rem` }}
                  title={e.label}
                >
                  <span className="text-[10px] studio-subtle tabular-nums flex-shrink-0 w-7 text-right">
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
