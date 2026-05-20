import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ipc, type ChatDelta, type Highlight } from "@/lib/ipc";

type Props = {
  selectedText: string;
  rect: DOMRect;
  bookId: number;
  spineIndex: number;
  prefix: string;
  suffix: string;
  aiConfigured: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onHighlightCreated?: (hl: Highlight) => void;
};

const BUBBLE_WIDTH = 340;
const BUBBLE_EST_HEIGHT = 180;

/**
 * Small one-shot AI bubble for "what does this word/phrase mean?" lookups.
 * Pops near the selection, fetches a 30-50 word explanation, then waits
 * for the user to either save it as a highlight, dismiss it with ESC,
 * or close it manually.
 *
 * Outside-click close was removed (per Bug 5 follow-up): users were
 * losing the AI reply by reflex-clicking back into the reader. ESC and
 * the × button are the only dismissal paths now.
 */
export function LookupBubble({
  selectedText,
  rect,
  bookId,
  spineIndex,
  prefix,
  suffix,
  aiConfigured,
  onClose,
  onOpenSettings,
  onHighlightCreated,
}: Props) {
  const [reply, setReply] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [saved, setSaved] = useState<boolean>(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // Wall-clock seconds since the AI request started (for the loading
  // indicator). Lets the user see whether something is happening at all.
  const [elapsedS, setElapsedS] = useState<number>(0);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // Tick a 1-second counter while a request is in flight, so the loading
  // label can show real elapsed time. Auto-surface a meaningful error if
  // we cross 30 s with zero data — that almost always means base_url is
  // wrong, the API key is invalid, or the network can't reach the
  // upstream service. Without this the bubble would silently stick on
  // "AI 思考中…" for the full 180 s reqwest timeout.
  useEffect(() => {
    if (!loading) {
      setElapsedS(0);
      return;
    }
    const start = Date.now();
    const t = window.setInterval(() => {
      const s = Math.floor((Date.now() - start) / 1000);
      setElapsedS(s);
      if (s >= 30 && reply === "") {
        setError(
          "30 秒未收到 AI 响应。最常见原因：\n" +
          "• base_url 末尾别带 /v1/chat/completions（我们会自动拼）\n" +
          "• api_key 失效或额度耗尽\n" +
          "• 网络到 base_url 主机不通 / 被代理拦截\n\n" +
          "可在 PowerShell 里直接测：\n" +
          "Invoke-RestMethod -Uri \"<base_url>/v1/models\" " +
          "-Headers @{ \"Authorization\" = \"Bearer <api_key>\" } -TimeoutSec 10"
        );
        setLoading(false);
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [loading, reply]);

  // Position: prefer below selection, flip above if it would overflow
  const goAbove = rect.bottom + BUBBLE_EST_HEIGHT + 16 > window.innerHeight;
  const top = goAbove
    ? Math.max(8, rect.top - BUBBLE_EST_HEIGHT - 8)
    : rect.bottom + 8;
  const rawLeft = rect.left + rect.width / 2 - BUBBLE_WIDTH / 2;
  const left = Math.max(
    8,
    Math.min(rawLeft, window.innerWidth - BUBBLE_WIDTH - 8),
  );

  // Kick off the AI lookup as soon as the bubble mounts. Uses the
  // streaming endpoint so the user sees text appear immediately instead
  // of staring at "AI 思考中…" for several seconds while the full reply
  // is composed server-side. The visual feedback alone makes the
  // perceived latency feel ~3x faster.
  useEffect(() => {
    if (!aiConfigured) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    setLoading(true);
    setError(null);
    setReply("");

    const trimmed = selectedText.trim().slice(0, 600);
    const sessionId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    (async () => {
      try {
        unlisten = await listen<ChatDelta>("chat-delta", (event) => {
          const p = event.payload;
          if (p.session_id !== sessionId) return;
          if (cancelled) return;
          if (p.error) {
            setError(p.error);
            setLoading(false);
            return;
          }
          if (p.delta) {
            setReply((prev) => prev + p.delta);
            // First token arrived — clear loading state.
            setLoading(false);
          }
          if (p.done) {
            setLoading(false);
          }
        });
        await ipc.aiChatStream(
          [
            {
              role: "system",
              content:
                "你是一个简洁的阅读助手。请用 30-60 字解释、翻译或提供文化背景。中文回答。不要客套话。",
            },
            { role: "user", content: trimmed },
          ],
          sessionId,
        );
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [selectedText, aiConfigured]);

  // ESC to close. Outside-click no longer dismisses (user kept losing
  // their AI reply by reflex-clicking back into the reader).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function saveAsHighlight() {
    if (saving || saved) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const hl = await ipc.createHighlight({
        bookId,
        spineIndex,
        selectedText: selectedText.trim(),
        prefix,
        suffix,
        color: "yellow",
        note: reply.trim(),
      });
      onHighlightCreated?.(hl);
      setSaved(true);
    } catch (e) {
      setSaveErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={bubbleRef}
      style={{
        position: "fixed",
        top,
        left,
        width: BUBBLE_WIDTH,
        zIndex: 55,
      }}
      className="bg-[var(--color-paper-soft)] border border-[var(--color-paper-edge)] rounded-lg shadow-xl overflow-hidden"
    >
      <div className="px-4 py-2 border-b border-[var(--color-paper-edge)] bg-[var(--color-paper)]/60 flex items-center justify-between">
        <span className="text-[10px] text-[var(--color-muted)] tracking-[0.3em] uppercase">
          AI 释义
        </span>
        <button
          onClick={onClose}
          className="w-5 h-5 flex items-center justify-center rounded text-[var(--color-muted)] hover:bg-[var(--color-paper-edge)]/40 transition text-xs"
          aria-label="Close"
          title="关闭 (ESC)"
        >
          ×
        </button>
      </div>
      <div className="px-4 py-3">
        <p className="font-serif text-[13px] text-[var(--color-ink-soft)] mb-2 line-clamp-2 italic">
          「{selectedText.length > 60 ? selectedText.slice(0, 60) + "…" : selectedText}」
        </p>
        {!aiConfigured ? (
          <div className="text-sm text-[var(--color-ink)] leading-relaxed">
            <p className="mb-2">还没配置 AI 接口。</p>
            <button
              onClick={onOpenSettings}
              className="text-xs text-[var(--color-accent)] underline underline-offset-4 hover:opacity-80"
            >
              去配置
            </button>
          </div>
        ) : loading ? (
          <p className="text-sm text-[var(--color-muted)] italic">
            AI 思考中…{elapsedS > 0 ? ` ${elapsedS}s` : ""}
          </p>
        ) : error ? (
          <p className="text-xs text-red-600 leading-relaxed whitespace-pre-wrap">
            {error}
          </p>
        ) : (
          <>
            <p className="text-sm text-[var(--color-ink)] leading-relaxed whitespace-pre-wrap">
              {reply}
            </p>
            {reply.trim() !== "" && (
              <div className="mt-3 pt-2 border-t border-[var(--color-paper-edge)] flex items-center justify-between gap-2">
                <button
                  onClick={saveAsHighlight}
                  disabled={saving || saved}
                  className={`text-xs px-2 py-1 rounded transition ${
                    saved
                      ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)] cursor-default"
                      : "bg-[var(--color-paper)] text-[var(--color-ink-soft)] border border-[var(--color-paper-edge)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)]"
                  } ${saving ? "opacity-50" : ""}`}
                  title={
                    saved
                      ? "已存到本书的批注里"
                      : "高亮选中文字 + AI 回答作为笔记保存"
                  }
                >
                  {saved ? "✓ 已存为批注" : saving ? "保存中…" : "✦ 存为批注"}
                </button>
                {saveErr && (
                  <span
                    className="text-[10px] text-red-600 truncate max-w-[60%]"
                    title={saveErr}
                  >
                    保存失败
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
