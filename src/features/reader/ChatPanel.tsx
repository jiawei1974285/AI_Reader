import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ipc,
  isTauriRuntime,
  type BookIndexStatus,
  type ChatContext,
  type ChatDelta,
  type ChatHit,
  type ChatMessage,
} from "@/lib/ipc";

type Props = {
  bookId: number;
  bookPath: string;
  bookTitle: string;
  chapterLabel: string;
  chapterText: string;
  chapterSpineIndex: number;
  onClose: () => void;
  onOpenSettings: () => void;
  onJumpToChapter?: (spineIndex: number) => void;
  aiConfigured: boolean;
};

type Mode = "chapter" | "book" | "library";

// UI-only extension of ChatMessage with the retrieved RAG hits attached.
// Hits live in-memory for the active session; DB persistence stores only
// (role, content) so reloaded history loses the click-to-jump affordance,
// which is the intended trade-off (transient retrieval state shouldn't
// pin chunk references that may have shifted after re-indexing).
type UiMessage = ChatMessage & { hits?: ChatHit[] };

const MAX_CHAPTER_CONTEXT_CHARS = 6000;

type IndexProgressEvent = {
  book_id: number;
  current: number;
  total: number;
};

export function ChatPanel({
  bookId,
  bookPath,
  bookTitle,
  chapterLabel,
  chapterText,
  chapterSpineIndex,
  onClose,
  onOpenSettings,
  onJumpToChapter,
  aiConfigured,
}: Props) {
  const [mode, setMode] = useState<Mode>("chapter");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexStatus, setIndexStatus] = useState<BookIndexStatus | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // The DB key under which to load + save messages.
  // chapter mode: scoped to (book, spine_index)
  // book / library mode: scoped to (book, mode), spine_index = -1
  const sessionSpine = mode === "chapter" ? chapterSpineIndex : -1;

  // Load saved history whenever the session key changes
  useEffect(() => {
    let cancelled = false;
    setError(null);
    ipc
      .chatHistoryLoad(bookId, mode, sessionSpine)
      .then((rows) => {
        if (cancelled) return;
        setMessages(
          rows.map((r) => ({
            role: r.role as ChatMessage["role"],
            content: r.content,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, mode, sessionSpine]);

  async function clearHistory() {
    try {
      await ipc.chatHistoryClear(bookId, mode, sessionSpine);
      setMessages([]);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // ESC to close (since we removed click-outside in Bug 5 fix).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Fetch index status for this book on mount + when book changes
  useEffect(() => {
    let cancelled = false;
    ipc
      .aiGetIndexStatus(bookId)
      .then((s) => {
        if (!cancelled) setIndexStatus(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  // Listen for index progress events
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: UnlistenFn | null = null;
    listen<IndexProgressEvent>("index-progress", (event) => {
      const p = event.payload;
      if (p.book_id !== bookId) return;
      setIndexProgress({ current: p.current, total: p.total });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [bookId]);

  const chapterSystemPrompt = useMemo(() => {
    const ctx = truncate(chapterText, MAX_CHAPTER_CONTEXT_CHARS);
    return `你是帮助用户理解书籍内容的阅读助手。
当前书：《${bookTitle}》
当前章节：${chapterLabel}

【当前章节内容】
${ctx}

请基于上述章节内容回答用户的问题。回答时请引用具体段落或观点。如果问题超出本章信息范围，请诚实说明。回答用中文。`;
  }, [bookTitle, chapterLabel, chapterText]);

  async function startIndex() {
    setIndexing(true);
    setError(null);
    setIndexProgress(null);
    try {
      const count = await ipc.aiIndexBook({ bookId, bookPath });
      const status = await ipc.aiGetIndexStatus(bookId);
      setIndexStatus(status);
      setError(null);
      // Brief success indicator
      console.log(`Indexed ${count} chunks`);
    } catch (e) {
      setError(String(e));
      const status = await ipc.aiGetIndexStatus(bookId).catch(() => null);
      setIndexStatus(status);
    } finally {
      setIndexing(false);
      setIndexProgress(null);
    }
  }

  async function ask(userText: string, resetThread: boolean) {
    if (!aiConfigured) {
      setError("请先在「设置」中配置 AI 接口（base_url / api_key / 模型）");
      return;
    }
    setInput("");
    setError(null);
    if (resetThread) {
      // resetThread means quick-action buttons like "总结本章" — wipe
      // prior history so the new thread starts clean (both UI + DB).
      await ipc
        .chatHistoryClear(bookId, mode, sessionSpine)
        .catch(() => {});
    }
    const userMsg: ChatMessage = { role: "user", content: userText };
    const next = resetThread ? [userMsg] : [...messages, userMsg];
    // Insert an empty assistant message that we'll append chunks into
    setMessages([...next, { role: "assistant", content: "" }]);
    setLoading(true);
    // Persist user turn immediately
    ipc
      .chatHistoryAppend({
        bookId,
        mode,
        spineIndex: sessionSpine,
        role: "user",
        content: userText,
      })
      .catch(() => {});

    const sessionId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Listen for chat-delta + chat-context events tagged with this session_id
    let unlisten: UnlistenFn | null = null;
    let unlistenCtx: UnlistenFn | null = null;
    let finished = false;
    let accumulated = "";
    const cleanup = () => {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      if (unlistenCtx) {
        unlistenCtx();
        unlistenCtx = null;
      }
    };
    const finish = (errMsg: string | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      setLoading(false);
      if (errMsg) {
        setError(errMsg);
        // Roll back: remove the empty/partial assistant message + user msg
        setMessages((prev) => {
          const arr = prev.slice();
          if (
            arr.length &&
            arr[arr.length - 1].role === "assistant" &&
            arr[arr.length - 1].content.trim() === ""
          ) {
            arr.pop();
          }
          return arr;
        });
        return;
      }
      // Persist the final assistant message to DB
      if (accumulated.trim()) {
        ipc
          .chatHistoryAppend({
            bookId,
            mode,
            spineIndex: sessionSpine,
            role: "assistant",
            content: accumulated,
          })
          .catch(() => {});
      }
    };

    try {
      if (!isTauriRuntime()) {
        accumulated =
          "这是浏览器预览模式下的 AI 示例回答。真实流式回答会在 Tauri 应用中显示。";
        setMessages((prev) => {
          const arr = prev.slice();
          const last = arr[arr.length - 1];
          if (last && last.role === "assistant") {
            arr[arr.length - 1] = { ...last, content: accumulated };
          }
          return arr;
        });
        finish(null);
        return;
      }

      unlistenCtx = await listen<ChatContext>("chat-context", (event) => {
        const p = event.payload;
        if (p.session_id !== sessionId) return;
        // Attach the retrieved hits to the pending assistant message so
        //「片段 N」 in its body can be rendered as clickable jump-to-chapter.
        setMessages((prev) => {
          const arr = prev.slice();
          const last = arr[arr.length - 1];
          if (last && last.role === "assistant") {
            arr[arr.length - 1] = { ...last, hits: p.hits };
          }
          return arr;
        });
      });

      unlisten = await listen<ChatDelta>("chat-delta", (event) => {
        const p = event.payload;
        if (p.session_id !== sessionId) return;
        if (p.error) {
          finish(p.error);
          return;
        }
        if (p.delta) {
          accumulated += p.delta;
          setMessages((prev) => {
            const arr = prev.slice();
            const last = arr[arr.length - 1];
            if (last && last.role === "assistant") {
              arr[arr.length - 1] = {
                ...last,
                content: last.content + p.delta,
              };
            }
            return arr;
          });
        }
        if (p.done) {
          finish(null);
        }
      });

      if (mode === "chapter") {
        const payload: ChatMessage[] = [
          { role: "system", content: chapterSystemPrompt },
          ...next,
        ];
        await ipc.aiChatStream(payload, sessionId);
      } else {
        // book / library: RAG streaming
        const history = next.slice(0, -1);
        await ipc.aiChatRagStream({
          question: userText,
          bookId: mode === "book" ? bookId : null,
          history,
          sessionId,
        });
      }
      // The command resolves when the stream completes server-side.
      // The `done` event will already have fired, but as a safety net:
      if (!finished) finish(null);
    } catch (e) {
      finish(String(e));
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const t = input.trim();
    if (!t || loading) return;
    ask(t, false);
  }

  const ready = indexStatus?.status === "ready";
  const needsIndex = (mode === "book" || mode === "library") && !ready;
  const isLibraryMode = mode === "library";

  return (
    // Outer overlay no longer closes on click (Bug 5). Only the × button
    // and the ESC key dismiss the panel — this prevents accidental loss
    // of an in-progress AI conversation when the user clicks back into
    // the reader by reflex. The backdrop still absorbs clicks to prevent
    // accidental text selection on the reader underneath.
    <div className="absolute inset-0 z-30 flex justify-end">
      <div className="absolute inset-0 bg-[var(--color-ink)]/10 backdrop-blur-[2px]" />
      <aside
        className="studio-drawer relative h-full w-96 lg:w-[420px] flex flex-col"
      >
        <div className="px-6 py-4 border-b border-[var(--color-paper-edge)] flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="studio-title text-lg">
              AI 问答
            </h3>
            <p className="text-xs studio-subtle mt-0.5 truncate">
              {mode === "chapter"
                ? chapterLabel
                : mode === "book"
                  ? `本书 · ${indexStatus?.chunks_count ?? 0} 片段`
                  : "全书库"}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {messages.length > 0 && (
              <button
                onClick={clearHistory}
                className="studio-ghost"
                title="清除本会话的所有消息（按当前模式/章节计）"
              >
                清空
              </button>
            )}
            <button
              onClick={onClose}
              className="studio-icon-button"
              aria-label="Close"
            >
              x
            </button>
          </div>
        </div>

        {/* Mode picker */}
        <div className="px-4 py-3 border-b border-[var(--color-paper-edge)] flex-shrink-0">
          <div className="studio-segmented grid-cols-3">
            {(
              [
                { v: "chapter", label: "当前章节" },
                { v: "book", label: "整本书" },
                { v: "library", label: "全书库" },
              ] as { v: Mode; label: string }[]
            ).map((opt) => (
              <button
                key={opt.v}
                onClick={() => setMode(opt.v)}
                className={`studio-segment ${
                  mode === opt.v
                    ? "studio-segment-active"
                    : ""
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div
          ref={scrollRef}
          className="flex-1 overflow-auto px-6 py-4 space-y-3"
        >
          {!aiConfigured && (
            <div className="text-center py-8">
              <p className="text-sm text-[var(--color-muted)] mb-3">
                还没配置 AI 接口
              </p>
              <button
                onClick={onOpenSettings}
                className="studio-button studio-button-primary"
              >
                去配置
              </button>
            </div>
          )}

          {aiConfigured && needsIndex && !indexing && !isLibraryMode && (
            <div className="studio-panel p-4 text-sm leading-relaxed">
              <p className="text-[var(--color-ink)] mb-3">
                整本书问答需要先把全书切片做向量索引。
              </p>
              <p className="text-xs text-[var(--color-muted)] mb-3">
                首次索引会下载嵌入模型（约 120 MB，仅一次）。然后扫描全书内容，按章节切片并生成向量。中等小说约几十秒到几分钟。
              </p>
              <button
                onClick={startIndex}
                className="studio-button studio-button-primary"
              >
                索引本书
              </button>
              {indexStatus?.error && (
                <p className="text-xs text-red-600 mt-3">
                  上次索引失败：{indexStatus.error}
                </p>
              )}
            </div>
          )}

          {aiConfigured && needsIndex && !indexing && isLibraryMode && (
            <div className="studio-panel p-4 text-sm leading-relaxed">
              <p className="text-[var(--color-ink)] mb-2">
                全书库问答需要先索引你想检索的每本书。
              </p>
              <p className="text-xs text-[var(--color-muted)] mb-3">
                打开任一本书，切到「整本书」模式点「索引本书」即可。索引完的书会自动加入全书库搜索范围。
              </p>
              <button
                onClick={startIndex}
                className="studio-button studio-button-primary"
              >
                先索引本书
              </button>
            </div>
          )}

          {indexing && (
            <div className="studio-panel p-4">
              <p className="text-sm text-[var(--color-ink)] mb-2">索引中…</p>
              {indexProgress && indexProgress.total > 0 ? (
                <>
                  <div className="w-full h-1.5 bg-[var(--color-paper-edge)]/40 rounded overflow-hidden">
                    <div
                      className="h-full bg-[var(--color-ink)] transition-all"
                      style={{
                        width: `${Math.min(100, (indexProgress.current / indexProgress.total) * 100)}%`,
                      }}
                    />
                  </div>
                  <p className="text-xs text-[var(--color-muted)] mt-2 tabular-nums">
                    {indexProgress.current} / {indexProgress.total} 章
                  </p>
                </>
              ) : (
                <p className="text-xs text-[var(--color-muted)]">
                  正在加载嵌入模型（首次约 120 MB）…
                </p>
              )}
            </div>
          )}

          {aiConfigured && !needsIndex && messages.length === 0 && !loading && (
            <div className="flex flex-col gap-2 py-4">
              {mode === "chapter" && (
                <>
                  <button
                    onClick={() =>
                      ask("请用 200 字以内总结这一章的核心内容、关键人物和情节发展。", true)
                    }
                    className="studio-card text-left px-4 py-3 transition text-sm"
                  >
                    <span className="text-[var(--color-ink)] font-medium">
                      总结本章
                    </span>
                  </button>
                  <button
                    onClick={() =>
                      ask("这一章引出了哪些值得思考的问题或观点？请列 3-5 个。", true)
                    }
                    className="studio-card text-left px-4 py-3 transition text-sm"
                  >
                    <span className="text-[var(--color-ink)] font-medium">
                      提出问题
                    </span>
                  </button>
                </>
              )}
              {mode === "book" && (
                <>
                  <button
                    onClick={() =>
                      ask("用 5 个要点总结这本书的核心论点或主线。", true)
                    }
                    className="studio-card text-left px-4 py-3 transition text-sm"
                  >
                    <span className="text-[var(--color-ink)] font-medium">
                      总览全书
                    </span>
                  </button>
                  <button
                    onClick={() => ask("本书最具争议或最反直觉的观点是什么？", true)}
                    className="studio-card text-left px-4 py-3 transition text-sm"
                  >
                    <span className="text-[var(--color-ink)] font-medium">
                      最反直觉的观点
                    </span>
                  </button>
                </>
              )}
              <p className="text-xs text-[var(--color-muted)] text-center mt-3">
                或在下方输入框直接提问
              </p>
            </div>
          )}

          {messages.map((m, i) => {
            // C7: 保存 AI 回答为笔记时，需要带上"问"——就是最近的一条 user 消息
            const precedingQuestion =
              m.role === "assistant"
                ? (() => {
                    for (let k = i - 1; k >= 0; k--) {
                      if (messages[k].role === "user") return messages[k].content;
                    }
                    return "";
                  })()
                : "";
            return (
              <MessageBubble
                key={i}
                role={m.role}
                content={m.content}
                hits={m.hits}
                bookId={bookId}
                onJumpToChapter={onJumpToChapter}
                onClose={onClose}
                noteContext={{
                  mode,
                  spineIndex: sessionSpine,
                  question: precedingQuestion,
                }}
              />
            );
          })}
          {loading &&
            (messages.length === 0 ||
              (messages[messages.length - 1].role === "assistant" &&
                messages[messages.length - 1].content === "")) && (
              <div className="text-xs text-[var(--color-muted)] italic px-2 py-1">
                AI 思考中…
              </div>
            )}
          {error && (
            <div className="text-xs text-red-600 px-3 py-2 bg-red-50/50 rounded">
              {error}
            </div>
          )}
        </div>

        <form
          onSubmit={onSubmit}
          className="border-t border-[var(--color-paper-edge)] p-3 flex gap-2 flex-shrink-0"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit(e);
              }
            }}
            placeholder={
              !aiConfigured
                ? "请先配置 AI 接口"
                : needsIndex
                  ? "需要先索引本书"
                  : "问点什么…（Enter 发送，Shift+Enter 换行）"
            }
            disabled={!aiConfigured || loading || needsIndex}
            rows={2}
            className="studio-textarea flex-1 text-sm resize-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!aiConfigured || loading || !input.trim() || needsIndex}
            className="studio-button studio-button-primary disabled:opacity-30 disabled:cursor-not-allowed"
          >
            发送
          </button>
        </form>
      </aside>
    </div>
  );
}

function MessageBubble({
  role,
  content,
  hits,
  bookId,
  onJumpToChapter,
  onClose,
  noteContext,
}: {
  role: ChatMessage["role"];
  content: string;
  hits?: ChatHit[];
  bookId: number;
  onJumpToChapter?: (spineIndex: number) => void;
  onClose?: () => void;
  /** C7: 把这条 assistant 回答存为笔记需要的上下文。 */
  noteContext?: { mode: string; spineIndex: number; question: string };
}) {
  if (role === "system") return null;
  // Skip empty assistant bubble during initial stream wait — parent
  // shows "AI 思考中…" placeholder instead.
  if (role === "assistant" && content === "") return null;
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] px-4 py-2.5 rounded-lg text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "bg-[var(--color-accent)] text-[var(--color-paper-soft)]"
            : "bg-[var(--color-paper-edge)]/45 text-[var(--color-ink)]"
        }`}
      >
        {role === "assistant" && hits && hits.length > 0 && onJumpToChapter
          ? renderCitations(content, hits, (spine) => {
              onJumpToChapter(spine);
              onClose?.();
            })
          : content}
        {role === "assistant" && hits && hits.length > 0 && content.trim() !== "" && (
          <CitationSaveRow hits={hits} bookId={bookId} aiReply={content} />
        )}
        {role === "assistant" && content.trim() !== "" && noteContext && (
          <SaveAsNoteButton
            bookId={bookId}
            spineIndex={noteContext.spineIndex}
            mode={noteContext.mode}
            question={noteContext.question}
            answer={content}
            hits={hits}
          />
        )}
      </div>
    </div>
  );
}

/**
 * C7: "💾 存为笔记" — 把当前这条 AI 回答（+ 问题 + 引用片段）整体落到
 * ai_notes 表。NotesView 里会显示。
 */
function SaveAsNoteButton({
  bookId,
  spineIndex,
  mode,
  question,
  answer,
  hits,
}: {
  bookId: number;
  spineIndex: number;
  mode: string;
  question: string;
  answer: string;
  hits?: ChatHit[];
}) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  async function save() {
    if (saving || saved) return;
    setSaving(true);
    try {
      await ipc.saveAiNote({
        bookId,
        spineIndex,
        mode,
        question,
        answer,
        hitsJson: hits && hits.length > 0 ? JSON.stringify(hits) : null,
      });
      setSaved(true);
    } catch {
      // 留按钮可重试
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="mt-2 pt-2 border-t border-[var(--color-paper-edge)]/40 flex items-center justify-end">
      <button
        onClick={save}
        disabled={saving || saved}
        className="text-[11px] px-2 py-0.5 rounded studio-button disabled:opacity-50"
        title="把这条 AI 回答存到笔记，可在「笔记」视图里看到"
      >
        {saved ? "✓ 已存为笔记" : saving ? "保存中…" : "💾 存为笔记"}
      </button>
    </div>
  );
}

/**
 * Footer row under an AI assistant message: one button per retrieved hit.
 * Clicking saves a highlight on the corresponding chapter where:
 *   - selected_text = first ~60 chars of the chunk (a stable anchor)
 *   - note = the full AI reply
 *
 * The highlight then appears in the book's NotesView and, when the user
 * navigates into that chapter, the matching text gets the yellow
 * marker overlay (via highlight.ts's indexOf fallback when prefix/suffix
 * are empty).
 */
function CitationSaveRow({
  hits,
  bookId,
  aiReply,
}: {
  hits: ChatHit[];
  bookId: number;
  aiReply: string;
}) {
  const [savedIdx, setSavedIdx] = useState<Set<number>>(new Set());
  const [savingIdx, setSavingIdx] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save(i: number) {
    const hit = hits[i];
    if (!hit) return;
    setSavingIdx(i);
    setErr(null);
    try {
      const anchor = hit.text.trim().slice(0, 60);
      await ipc.createHighlight({
        bookId,
        spineIndex: hit.spine_index,
        selectedText: anchor,
        prefix: "",
        suffix: "",
        color: "yellow",
        note: aiReply.trim(),
      });
      setSavedIdx((prev) => {
        const next = new Set(prev);
        next.add(i);
        return next;
      });
    } catch (e) {
      setErr(String(e));
    } finally {
      setSavingIdx(null);
    }
  }

  return (
    <div className="mt-2 pt-2 border-t border-[var(--color-ink)]/10 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] text-[var(--color-muted)] mr-0.5 tracking-[0.05em]">
        ✦ 存为批注
      </span>
      {hits.map((h, i) => {
        const saved = savedIdx.has(i);
        const saving = savingIdx === i;
        return (
          <button
            key={i}
            type="button"
            disabled={saved || saving}
            onClick={(e) => {
              e.stopPropagation();
              save(i);
            }}
            title={
              saved
                ? "已存到这本书的批注里"
                : `保存到「第 ${h.spine_index + 1} 章」的批注（AI 回答会作为笔记）`
            }
            className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded transition ${
              saved
                ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)] cursor-default"
                : "bg-[var(--color-paper)] text-[var(--color-ink-soft)] border border-[var(--color-paper-edge)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)]"
            } ${saving ? "opacity-50" : ""}`}
          >
            {saved ? `✓ 片段 ${i + 1}` : `片段 ${i + 1}`}
          </button>
        );
      })}
      {err && (
        <span className="text-[10px] text-red-600 ml-1" title={err}>
          保存失败
        </span>
      )}
    </div>
  );
}

/**
 * Walk the assistant text and replace 「片段 N」 / 「片段N」 (with or
 * without space) with clickable spans that jump to the corresponding
 * chapter. N is 1-based as it appears in the prompt; we map it into the
 * `hits` array (also 1-based -> index N-1) to get the spine_index.
 *
 * Unknown indices (LLM hallucinated a片段 number beyond what we sent)
 * are rendered as plain text so the user isn't misled by an unjumpable
 * link.
 */
function renderCitations(
  content: string,
  hits: ChatHit[],
  jump: (spineIndex: number) => void,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /片段\s*(\d+)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(content)) !== null) {
    if (match.index > lastIdx) {
      out.push(content.slice(lastIdx, match.index));
    }
    const n = parseInt(match[1], 10);
    const hit = Number.isFinite(n) && n >= 1 ? hits[n - 1] : undefined;
    if (hit) {
      const spine = hit.spine_index;
      out.push(
        <button
          key={`cite-${key++}`}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            jump(spine);
          }}
          title={`跳到第 ${spine + 1} 章 · ${hit.text.slice(0, 60)}${hit.text.length > 60 ? "…" : ""}`}
          className="inline-flex items-center px-1.5 py-0.5 mx-0.5 text-xs rounded bg-[var(--color-paper)] text-[var(--color-accent)] border border-[var(--color-accent)]/40 hover:bg-[var(--color-accent)]/10 transition cursor-pointer align-baseline"
        >
          {match[0]}
        </button>,
      );
    } else {
      out.push(match[0]);
    }
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < content.length) {
    out.push(content.slice(lastIdx));
  }
  return out;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n…（后续内容已省略）";
}
