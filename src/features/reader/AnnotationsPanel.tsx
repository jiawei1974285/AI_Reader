import { useMemo, useState } from "react";
import { ipc, type Highlight, type TocEntry } from "@/lib/ipc";
import { buildBookMarkdown, copyToClipboard } from "@/features/notes/markdown";

const COLOR_HEX: Record<string, string> = {
  yellow: "#facc15",
  green: "#84cc5a",
  blue: "#60a5fa",
  red: "#fc645a",
};

type Props = {
  bookId: number;
  bookTitle: string;
  bookAuthor: string;
  highlights: Highlight[];
  toc: TocEntry[];
  onJump: (spineIndex: number, hlId: number) => void;
  onDelete: (hlId: number) => void;
  onClose: () => void;
};

export function AnnotationsPanel({
  bookId,
  bookTitle,
  bookAuthor,
  highlights,
  toc,
  onJump,
  onDelete,
  onClose,
}: Props) {
  const [exportFlash, setExportFlash] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  async function summarize() {
    setSummarizing(true);
    setSummaryError(null);
    setSummary(null);
    try {
      const result = await ipc.aiSummarizeHighlights(bookId);
      setSummary(result);
    } catch (e) {
      setSummaryError(String(e));
    } finally {
      setSummarizing(false);
    }
  }

  async function exportMd() {
    const md = buildBookMarkdown(
      { title: bookTitle, author: bookAuthor },
      highlights,
      toc,
    );
    const ok = await copyToClipboard(md);
    setExportFlash(ok ? "已复制" : "复制失败");
    window.setTimeout(() => setExportFlash(null), 1800);
  }
  // Map spine_index → chapter label (fallback to "第 N 章")
  const labelFor = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of toc) {
      if (!m.has(e.spine_index)) m.set(e.spine_index, e.label);
    }
    return (idx: number) => m.get(idx) ?? `第 ${idx + 1} 章`;
  }, [toc]);

  // Group highlights by spine_index, preserve spine ordering
  const groups = useMemo(() => {
    const map = new Map<number, Highlight[]>();
    for (const h of highlights) {
      const list = map.get(h.spine_index) ?? [];
      list.push(h);
      map.set(h.spine_index, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [highlights]);

  return (
    <div
      className="absolute inset-0 z-30 flex justify-end"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/10" />
      <aside
        onClick={(e) => e.stopPropagation()}
        className="relative h-full w-80 md:w-96 bg-[var(--color-paper-soft)] border-l border-[var(--color-paper-edge)] shadow-xl flex flex-col"
      >
        <div className="px-6 py-5 border-b border-[var(--color-paper-edge)] flex items-center justify-between flex-shrink-0 gap-3">
          <div className="min-w-0">
            <h3 className="font-serif text-lg text-[var(--color-ink)]">
              本书标注
            </h3>
            <p className="text-xs text-[var(--color-muted)] mt-0.5">
              共 {highlights.length} 条
            </p>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              onClick={summarize}
              disabled={summarizing || highlights.length === 0}
              className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)] disabled:opacity-30 disabled:cursor-not-allowed transition underline underline-offset-4"
              title="让 AI 把你的标注提炼成关键观点和主线"
            >
              {summarizing ? "汇总中…" : "AI 汇总"}
            </button>
            <button
              onClick={exportMd}
              disabled={highlights.length === 0}
              className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)] disabled:opacity-30 disabled:cursor-not-allowed transition underline underline-offset-4"
              title="复制 Markdown"
            >
              {exportFlash ?? "导出 MD"}
            </button>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper-edge)]/40 transition"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {highlights.length === 0 && (
            <div className="px-6 py-12 text-center text-sm text-[var(--color-muted)]">
              还没有标注
              <br />
              选中文字会浮出色块工具栏
            </div>
          )}
          {(summary || summarizing || summaryError) && (
            <div className="mx-6 mt-4 mb-2 p-4 rounded-md bg-[var(--color-paper)] border border-[var(--color-paper-edge)]">
              <div className="flex items-baseline justify-between mb-2">
                <h4 className="text-xs tracking-[0.3em] uppercase text-[var(--color-muted)]">
                  AI 汇总
                </h4>
                {summary && (
                  <button
                    onClick={() => setSummary(null)}
                    className="text-[10px] text-[var(--color-muted)] hover:text-[var(--color-ink)] underline underline-offset-4"
                  >
                    收起
                  </button>
                )}
              </div>
              {summarizing && (
                <p className="text-sm text-[var(--color-muted)] italic">
                  正在提炼要点…
                </p>
              )}
              {summaryError && (
                <p className="text-xs text-red-600 leading-relaxed">
                  {summaryError}
                </p>
              )}
              {summary && (
                <div className="text-sm text-[var(--color-ink)] leading-relaxed whitespace-pre-wrap font-serif">
                  {summary}
                </div>
              )}
            </div>
          )}
          {groups.map(([spineIdx, hls]) => (
            <div key={spineIdx} className="py-2">
              <div className="px-6 pt-3 pb-2 text-[10px] tracking-[0.3em] uppercase text-[var(--color-muted)]">
                {labelFor(spineIdx)} · {hls.length}
              </div>
              <ul>
                {hls.map((h) => (
                  <li
                    key={h.id}
                    className="group relative hover:bg-[var(--color-paper-edge)]/25 transition"
                  >
                    <button
                      onClick={() => onJump(h.spine_index, h.id)}
                      className="w-full text-left px-6 py-3 flex gap-3 items-start"
                    >
                      <span
                        className="block w-1 self-stretch rounded-full flex-shrink-0 mt-0.5"
                        style={{ background: COLOR_HEX[h.color] ?? "#facc15" }}
                      />
                      <div className="min-w-0 flex-1 pr-6">
                        <p className="font-serif text-sm text-[var(--color-ink)] leading-snug line-clamp-3">
                          {h.selected_text}
                        </p>
                        {h.note && (
                          <p className="text-xs text-[var(--color-ink-soft)] mt-1.5 italic line-clamp-2 leading-snug">
                            {h.note}
                          </p>
                        )}
                      </div>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm("删除这条标注？")) {
                          ipc
                            .deleteHighlight(h.id)
                            .then(() => onDelete(h.id))
                            .catch(() => {});
                        }
                      }}
                      className="absolute top-2 right-3 w-6 h-6 flex items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper-edge)]/60 hover:text-red-600 opacity-0 group-hover:opacity-100 transition"
                      aria-label="删除这条标注"
                      title="删除这条标注"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
