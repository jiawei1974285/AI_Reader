import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useMusicPlayer } from "./MusicPlayerContext";

type Line = { time: number; text: string };

/**
 * Parses LRC. Supports:
 *   [mm:ss]
 *   [mm:ss.xx]
 *   [mm:ss.xxx]
 *   multi-stamp lines like [00:01.23][00:05.67]同一段歌词
 *   metadata tags like [ti:title] [ar:artist] — skipped
 * Returns lines sorted by timestamp ascending.
 */
function parseLrc(raw: string): Line[] {
  const stampRe = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  const out: Line[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip metadata tags (no digit-colon-digit format)
    const stamps: number[] = [];
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    stampRe.lastIndex = 0;
    while ((m = stampRe.exec(line)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseFloat(m[2]);
      if (Number.isFinite(min) && Number.isFinite(sec)) {
        stamps.push(min * 60 + sec);
      }
      lastEnd = stampRe.lastIndex;
    }
    if (stamps.length === 0) continue;
    const text = line.slice(lastEnd).trim();
    if (text === "") continue; // pure-stamp line, ignore
    for (const t of stamps) {
      out.push({ time: t, text });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Floating lyrics panel anchored above the mini player. Reads
 * `<audio>.lrc` for the currently-playing track and auto-scrolls the
 * active line into view as playback progresses.
 *
 * If there's no .lrc next to the audio file, shows a "无歌词" hint
 * instead of failing silently.
 */
export function LyricsPanel({ onClose }: { onClose: () => void }) {
  const player = useMusicPlayer();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const audioPath = player.currentTrack?.path ?? "";

  // (Re)load lyrics whenever the current track changes.
  useEffect(() => {
    if (!audioPath) {
      setLines(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLines(null);
    ipc
      .readLrc(audioPath)
      .then((raw) => {
        if (cancelled) return;
        if (!raw) {
          setLines([]);
          return;
        }
        setLines(parseLrc(raw));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLines([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [audioPath]);

  // Find the line index whose timestamp is the greatest ≤ current
  // playback position. Recomputed every position tick (~4 Hz from the
  // audio element's timeupdate); the linear scan is cheap for lyrics
  // (typically < 100 lines).
  const activeIdx = useMemo(() => {
    if (!lines || lines.length === 0) return -1;
    const pos = player.position;
    let lo = 0;
    let hi = lines.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= pos) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }, [lines, player.position]);

  // Smoothly scroll the active line to the visual center of the panel.
  useEffect(() => {
    if (activeIdx < 0) return;
    const list = listRef.current;
    if (!list) return;
    const node = list.children[activeIdx] as HTMLElement | undefined;
    if (!node) return;
    const listRect = list.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const offset =
      nodeRect.top - listRect.top - listRect.height / 2 + nodeRect.height / 2;
    list.scrollBy({ top: offset, behavior: "smooth" });
  }, [activeIdx]);

  const hasLyrics = lines && lines.length > 0;

  return (
    <div
      className="fixed bottom-20 right-4 z-40 w-80 max-h-[60vh] rounded-xl bg-[var(--color-ink)]/95 text-[var(--color-paper)] shadow-2xl backdrop-blur-sm flex flex-col overflow-hidden"
      style={{ fontFamily: "var(--font-sans)" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 flex items-center justify-between border-b border-[var(--color-paper)]/15 flex-shrink-0">
        <div className="text-xs font-medium truncate">
          {player.currentTrack?.filename ?? "歌词"}
        </div>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded-full text-[var(--color-paper)]/60 hover:text-[var(--color-paper)] hover:bg-[var(--color-paper)]/10 transition text-sm"
          aria-label="关闭歌词"
        >
          ×
        </button>
      </div>

      {loading && (
        <div className="px-4 py-6 text-center text-xs text-[var(--color-paper)]/60">
          加载中…
        </div>
      )}

      {!loading && error && (
        <div className="px-4 py-6 text-center text-xs text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && !hasLyrics && (
        <div className="px-4 py-6 text-center text-xs text-[var(--color-paper)]/60 leading-relaxed">
          没找到歌词。
          <br />
          在音频文件同目录放一个同名 .lrc 文件即可自动加载。
        </div>
      )}

      {!loading && hasLyrics && (
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto px-3 py-4 space-y-2 scroll-smooth"
        >
          {lines!.map((ln, i) => (
            <div
              key={i}
              onClick={() => player.seek(ln.time)}
              className={`text-center text-sm leading-relaxed transition cursor-pointer ${
                i === activeIdx
                  ? "text-[var(--color-paper)] font-medium scale-105"
                  : "text-[var(--color-paper)]/45 hover:text-[var(--color-paper)]/80"
              }`}
              title={fmtStamp(ln.time)}
            >
              {ln.text}
            </div>
          ))}
          {/* Bottom padding so the last line can scroll to the center */}
          <div className="h-32" aria-hidden />
        </div>
      )}
    </div>
  );
}

function fmtStamp(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
