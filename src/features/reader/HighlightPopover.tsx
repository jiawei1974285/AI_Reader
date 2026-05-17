import { useEffect, useRef, useState } from "react";
import { ipc, type Highlight } from "@/lib/ipc";

const COLORS = ["yellow", "green", "blue", "red"] as const;
const COLOR_HEX: Record<(typeof COLORS)[number], string> = {
  yellow: "#facc15",
  green: "#84cc5a",
  blue: "#60a5fa",
  red: "#fc645a",
};

type Props = {
  hl: Highlight;
  rect: DOMRect;
  onChange: (hl: Highlight) => void;
  onDelete: () => void;
  onClose: () => void;
};

export function HighlightPopover({
  hl,
  rect,
  onChange,
  onDelete,
  onClose,
}: Props) {
  const [note, setNote] = useState(hl.note);
  const [color, setColor] = useState(hl.color);
  const popRef = useRef<HTMLDivElement>(null);

  // Try to position below the mark; flip above if it would go off-screen
  const popHeight = 200; // approx
  const popWidth = 320;
  const goAbove = rect.bottom + popHeight + 16 > window.innerHeight;
  const top = goAbove
    ? Math.max(8, rect.top - popHeight - 8)
    : rect.bottom + 8;
  const rawLeft = rect.left + rect.width / 2 - popWidth / 2;
  const left = Math.max(8, Math.min(rawLeft, window.innerWidth - popWidth - 8));

  // Commit changes when closing (outside click / ESC / explicit close)
  async function commitIfDirty() {
    if (note === hl.note && color === hl.color) return;
    try {
      await ipc.updateHighlight({ id: hl.id, color, note });
      onChange({ ...hl, color, note });
    } catch {}
  }

  // Outside click closes (after commit)
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        commitIfDirty().then(onClose);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        commitIfDirty().then(onClose);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note, color]);

  async function changeColor(c: string) {
    setColor(c);
    try {
      await ipc.updateHighlight({ id: hl.id, color: c, note });
      onChange({ ...hl, color: c, note });
    } catch {}
  }

  async function handleDelete() {
    if (!window.confirm("删除这条高亮？")) return;
    try {
      await ipc.deleteHighlight(hl.id);
      onDelete();
    } catch {}
  }

  return (
    <div
      ref={popRef}
      style={{
        position: "fixed",
        top,
        left,
        width: popWidth,
        zIndex: 60,
      }}
      className="bg-[var(--color-paper-soft)] border border-[var(--color-paper-edge)] rounded-lg shadow-xl overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-[var(--color-paper-edge)] bg-[var(--color-paper)]/60">
        <p className="font-serif text-sm text-[var(--color-ink)] line-clamp-3 leading-snug">
          「{hl.selected_text}」
        </p>
      </div>

      <div className="px-4 py-3 space-y-3">
        <div className="flex items-center gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => changeColor(c)}
              className={`w-6 h-6 rounded-full border transition ${
                color === c
                  ? "ring-2 ring-offset-1 ring-[var(--color-ink)]/40 ring-offset-[var(--color-paper-soft)]"
                  : "border-[var(--color-paper-edge)] hover:scale-110"
              }`}
              style={{ background: COLOR_HEX[c] }}
              aria-label={c}
            />
          ))}
          <div className="flex-1" />
          <button
            onClick={handleDelete}
            className="text-xs text-[var(--color-muted)] hover:text-red-600 transition"
          >
            删除
          </button>
        </div>

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => commitIfDirty()}
          placeholder="写下你的笔记…"
          rows={3}
          className="w-full px-3 py-2 text-sm rounded border border-[var(--color-paper-edge)] bg-[var(--color-paper)] text-[var(--color-ink)] placeholder:text-[var(--color-muted)] focus:outline-none focus:border-[var(--color-ink)]/40 resize-none"
        />
      </div>
    </div>
  );
}
