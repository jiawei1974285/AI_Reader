import { useEffect, useRef, useState } from "react";
import { ipc, type Highlight, loadAiSettings } from "@/lib/ipc";

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
const WARN_S = 15;
const GIVE_UP_S = 45;

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
  const [reply, setReply] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [elapsedS, setElapsedS] = useState(0);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!loading) {
      setElapsedS(0);
      return;
    }
    const start = Date.now();
    const timer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - start) / 1000);
      setElapsedS(seconds);
      if (seconds >= GIVE_UP_S && reply === "") {
        cancelledRef.current = true;
        loadAiSettings()
          .then((cfg) => {
            setError(
              `${GIVE_UP_S} 秒未收到 AI 响应，已取消请求。\n\n` +
                `当前端点：${cfg.base_url || "(未设置)"}\n` +
                `当前模型：${cfg.chat_model || "(未设置)"}\n\n` +
                "模型连接测试已改为同一条非流式链路；如果这里仍超时，通常是模型响应过慢、key/额度异常，或网络被代理拦截。",
            );
          })
          .catch(() => {
            setError(`${GIVE_UP_S} 秒未收到 AI 响应，已取消请求。`);
          });
        setLoading(false);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loading, reply]);

  const goAbove = rect.bottom + BUBBLE_EST_HEIGHT + 16 > window.innerHeight;
  const top = goAbove
    ? Math.max(8, rect.top - BUBBLE_EST_HEIGHT - 8)
    : rect.bottom + 8;
  const rawLeft = rect.left + rect.width / 2 - BUBBLE_WIDTH / 2;
  const left = Math.max(8, Math.min(rawLeft, window.innerWidth - BUBBLE_WIDTH - 8));

  useEffect(() => {
    if (!aiConfigured) return;
    cancelledRef.current = false;
    setLoading(true);
    setError(null);
    setReply("");

    const trimmed = selectedText.trim().slice(0, 600);
    (async () => {
      try {
        const answer = await ipc.aiChat([
          {
            role: "system",
            content:
              "你是一个简洁的阅读助手。请用 30-60 字解释、翻译或提供文化背景。中文回答。不要客套话。",
          },
          { role: "user", content: trimmed },
        ]);
        if (cancelledRef.current) return;
        setReply(answer);
        setLoading(false);
      } catch (e) {
        if (!cancelledRef.current) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [selectedText, aiConfigured]);

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

  const loadingLabel = (() => {
    if (!loading) return null;
    if (elapsedS < WARN_S) return `AI 思考中... ${elapsedS}s`;
    return `仍在等待... ${elapsedS}s`;
  })();

  return (
    <div
      ref={bubbleRef}
      style={{ position: "fixed", top, left, width: BUBBLE_WIDTH, zIndex: 55 }}
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
          x
        </button>
      </div>
      <div className="px-4 py-3">
        <p className="font-serif text-[13px] text-[var(--color-ink-soft)] mb-2 line-clamp-2 italic">
          「{selectedText.length > 60 ? `${selectedText.slice(0, 60)}...` : selectedText}」
        </p>
        {!aiConfigured ? (
          <div className="text-sm text-[var(--color-ink)] leading-relaxed">
            <p className="mb-2">还没有配置 AI 接口。</p>
            <button
              onClick={onOpenSettings}
              className="text-xs text-[var(--color-accent)] underline underline-offset-4 hover:opacity-80"
            >
              去配置
            </button>
          </div>
        ) : loading ? (
          <p className="text-sm text-[var(--color-muted)] italic">
            {loadingLabel}
            {elapsedS >= WARN_S && (
              <span className="block text-[11px] mt-1 not-italic text-[var(--color-muted)]/70">
                如超过 {GIVE_UP_S}s 将自动取消
              </span>
            )}
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
                  {saved ? "已存为批注" : saving ? "保存中..." : "存为批注"}
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
