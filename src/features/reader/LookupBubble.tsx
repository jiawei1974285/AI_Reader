import { useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";

type Props = {
  selectedText: string;
  rect: DOMRect;
  aiConfigured: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
};

const BUBBLE_WIDTH = 340;
const BUBBLE_EST_HEIGHT = 140;

/**
 * Small one-shot AI bubble for "what does this word/phrase mean?" lookups.
 * Pops near the selection, fetches a 30-50 word explanation, then idles
 * until the user dismisses it (outside click / ESC). For full back-and-
 * forth chat the user can open the dedicated AI panel.
 */
export function LookupBubble({
  selectedText,
  rect,
  aiConfigured,
  onClose,
  onOpenSettings,
}: Props) {
  const [reply, setReply] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

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

  // Kick off the AI lookup as soon as the bubble mounts
  useEffect(() => {
    if (!aiConfigured) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const trimmed = selectedText.trim().slice(0, 600);
    ipc
      .aiChat([
        {
          role: "system",
          content:
            "你是一个简洁的阅读助手。请用 30-60 字解释、翻译或提供文化背景。中文回答。不要客套话。",
        },
        { role: "user", content: trimmed },
      ])
      .then((r) => {
        if (!cancelled) setReply(r);
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
  }, [selectedText, aiConfigured]);

  // Outside click + ESC to close
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (bubbleRef.current && !bubbleRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

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
          <p className="text-sm text-[var(--color-muted)] italic">AI 思考中…</p>
        ) : error ? (
          <p className="text-xs text-red-600 leading-relaxed">{error}</p>
        ) : (
          <p className="text-sm text-[var(--color-ink)] leading-relaxed whitespace-pre-wrap">
            {reply}
          </p>
        )}
      </div>
    </div>
  );
}
