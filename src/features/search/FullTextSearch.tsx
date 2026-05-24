import { useEffect, useRef, useState } from "react";
import { ipc, type Book, type FtsHit } from "@/lib/ipc";

type Props = {
  open: boolean;
  onClose: () => void;
  /** 限定在某本书内搜（reader 内调用时传），null = 全库 */
  scope: { kind: "library" } | { kind: "book"; bookId: number; title: string };
  /** 命中后跳进对应书的对应章节 */
  onOpenHit: (book: Book, spineIndex: number) => void;
};

/**
 * C1 — 全文 FTS5 检索面板。
 *
 * 触发：library 顶部「全文搜」按钮 → 全库；reader 内可后续加同款按钮限制在
 * 当前书。前提：目标书已经做过 ai_index_book（chunks 落盘 + FTS 触发器同步）。
 *
 * UI 模仿 Linear/Raycast: 顶部 input + 下方结果列表，命中片段把 «...»
 * 包裹的部分高亮。
 */
export function FullTextSearch({ open, onClose, scope, onOpenHit }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FtsHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allBooksById, setAllBooksById] = useState<Map<number, Book>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);

  // 拉一次书目，用于点命中后跳书
  useEffect(() => {
    if (!open) return;
    ipc
      .listBooks()
      .then((bs) => {
        const m = new Map<number, Book>();
        for (const b of bs) m.set(b.id, b);
        setAllBooksById(m);
      })
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits([]);
    setError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // 输入防抖搜
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setHits([]);
      setError(null);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      const bookId = scope.kind === "book" ? scope.bookId : null;
      ipc
        .ftsSearch(query, bookId, 80)
        .then((rs) => setHits(rs))
        .catch((e) => {
          setHits([]);
          setError(String(e));
        })
        .finally(() => setLoading(false));
    }, 220);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, open, scope]);

  if (!open) return null;

  const scopeLabel =
    scope.kind === "book" ? `《${scope.title}》` : "全部已索引的书";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" />
      <div
        className="relative w-[min(720px,94vw)] max-h-[78vh] studio-panel shadow-2xl flex flex-col overflow-hidden"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="px-5 pt-4 pb-2">
          <div className="text-[10px] studio-subtle tracking-wider uppercase mb-1">
            全文检索 · {scopeLabel}
          </div>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜书里的句子... (至少 2 字)"
            className="w-full bg-transparent text-base text-[var(--color-ink)] outline-none border-b border-[var(--color-paper-edge)] py-2"
          />
        </div>

        <div
          className="flex-1 overflow-y-auto"
          style={{ scrollbarWidth: "thin" }}
        >
          {error ? (
            <div className="px-5 py-6 text-xs text-red-600">{error}</div>
          ) : loading ? (
            <div className="px-5 py-6 text-xs studio-subtle">搜索中…</div>
          ) : query.trim().length < 2 ? (
            <div className="px-5 py-6 text-xs studio-subtle leading-relaxed">
              输入 2 个或更多字符开始搜索。<br />
              <span className="opacity-70">
                提示：FTS 只覆盖已经做过 AI 索引的书 (RAG 面板里点过「索引本书」)。
              </span>
            </div>
          ) : hits.length === 0 ? (
            <div className="px-5 py-6 text-xs studio-subtle">
              没有匹配。换个词试试，或确认书已索引。
            </div>
          ) : (
            <ul>
              {hits.map((hit, idx) => (
                <li
                  key={`${hit.book_id}-${hit.spine_index}-${idx}`}
                  className="px-5 py-3 border-b border-[var(--color-paper-edge)]/40 hover:bg-[var(--color-paper-edge)]/30 cursor-pointer"
                  onClick={() => {
                    const book = allBooksById.get(hit.book_id);
                    if (book) {
                      onOpenHit(book, hit.spine_index);
                      onClose();
                    }
                  }}
                >
                  <div className="text-xs studio-subtle mb-1 truncate">
                    《{hit.book_title}》
                    <span className="opacity-60"> · {hit.book_author}</span>
                    <span className="opacity-60"> · 第 {hit.spine_index + 1} 章</span>
                  </div>
                  <div className="text-sm text-[var(--color-ink)] leading-relaxed">
                    {renderSnippet(hit.snippet)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-4 py-2 border-t border-[var(--color-paper-edge)] flex items-center justify-between text-[10px] studio-subtle">
          <span>Esc 关闭 · 点结果跳到对应章节</span>
          <span className="tabular-nums">{hits.length} 条</span>
        </div>
      </div>
    </div>
  );
}

/**
 * 后端用 « ... » 标记命中片段；前端把这部分包成 <mark> 高亮。
 * snippet 像: "…前文 «人间词话» 后文…"
 */
function renderSnippet(snippet: string) {
  const parts: Array<{ text: string; highlight: boolean }> = [];
  let i = 0;
  while (i < snippet.length) {
    const open = snippet.indexOf("«", i);
    if (open < 0) {
      parts.push({ text: snippet.slice(i), highlight: false });
      break;
    }
    if (open > i) parts.push({ text: snippet.slice(i, open), highlight: false });
    const close = snippet.indexOf("»", open + 1);
    if (close < 0) {
      // 配不上 — 把剩下全当原文
      parts.push({ text: snippet.slice(open), highlight: false });
      break;
    }
    parts.push({ text: snippet.slice(open + 1, close), highlight: true });
    i = close + 1;
  }
  return parts.map((p, idx) =>
    p.highlight ? (
      <mark
        key={idx}
        className="bg-[var(--color-accent)]/30 text-[var(--color-ink)] rounded-sm px-0.5"
      >
        {p.text}
      </mark>
    ) : (
      <span key={idx}>{p.text}</span>
    ),
  );
}
