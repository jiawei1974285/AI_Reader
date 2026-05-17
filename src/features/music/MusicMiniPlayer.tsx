import { useState } from "react";
import { useMusicPlayer } from "./MusicPlayerContext";
import { LyricsPanel } from "./LyricsPanel";

/**
 * Floating mini-player that sits in the bottom-right corner of the
 * window. Visible whenever there is a currently-loaded track, in any
 * view. Two display modes:
 *
 *   - Collapsed (default): a slim pill showing ⏯ + truncated title +
 *     ⏭. Click anywhere on the title area to expand.
 *   - Expanded: adds scrub bar, prev button, volume slider, and a ×
 *     button to hide the player without stopping playback.
 */
export function MusicMiniPlayer() {
  const player = useMusicPlayer();
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);

  if (!player.currentTrack) return null;
  if (hidden) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-40 select-none"
      style={{ fontFamily: "var(--font-sans)" }}
    >
      <div
        className={`flex items-center gap-2 px-3 py-2 rounded-full bg-[var(--color-ink)]/95 text-[var(--color-paper)] shadow-xl backdrop-blur-sm transition-all ${
          expanded ? "w-[26rem]" : "w-72"
        }`}
      >
        <button
          onClick={player.togglePlay}
          className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full bg-[var(--color-paper)]/15 hover:bg-[var(--color-paper)]/25 transition text-sm"
          aria-label={player.playing ? "暂停" : "播放"}
        >
          {player.playing ? "⏸" : "▶"}
        </button>

        {expanded && (
          <button
            onClick={player.prev}
            className="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-[var(--color-paper)]/15 transition text-xs"
            aria-label="上一首"
          >
            ⏮
          </button>
        )}

        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 min-w-0 text-left px-1 py-0.5 hover:opacity-80 transition"
          title={player.currentTrack.filename}
        >
          <div className="text-xs leading-tight truncate font-medium">
            {player.currentTrack.filename}
          </div>
          {expanded && player.duration > 0 && (
            <div className="text-[10px] text-[var(--color-paper)]/60 tabular-nums mt-0.5">
              {fmtTime(player.position)} / {fmtTime(player.duration)}
            </div>
          )}
        </button>

        <button
          onClick={player.next}
          className="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-[var(--color-paper)]/15 transition text-xs"
          aria-label="下一首"
        >
          ⏭
        </button>

        <button
          onClick={() => setShowLyrics((v) => !v)}
          className={`w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-full transition text-[10px] font-medium ${
            showLyrics
              ? "bg-[var(--color-paper)]/30 text-[var(--color-paper)]"
              : "hover:bg-[var(--color-paper)]/15 text-[var(--color-paper)]/80"
          }`}
          aria-label={showLyrics ? "关闭歌词" : "打开歌词"}
          title={showLyrics ? "关闭歌词" : "歌词"}
        >
          词
        </button>

        {expanded && (
          <div className="flex items-center gap-1.5 flex-shrink-0 ml-1">
            <span className="text-[10px] text-[var(--color-paper)]/60">
              🔊
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={player.volume}
              onChange={(e) => player.setVolume(Number(e.target.value))}
              className="w-16 accent-[var(--color-paper)]"
              aria-label="音量"
            />
          </div>
        )}

        {expanded && (
          <button
            onClick={() => setHidden(true)}
            className="w-6 h-6 flex-shrink-0 flex items-center justify-center rounded-full text-[var(--color-paper)]/60 hover:text-[var(--color-paper)] hover:bg-[var(--color-paper)]/10 transition text-xs"
            title="隐藏（不停止播放）"
            aria-label="隐藏"
          >
            ×
          </button>
        )}
      </div>

      {expanded && player.duration > 0 && (
        <div className="mt-2 px-3">
          <input
            type="range"
            min={0}
            max={player.duration}
            step={0.5}
            value={player.position}
            onChange={(e) => player.seek(Number(e.target.value))}
            className="w-full accent-[var(--color-ink)]"
            aria-label="进度"
          />
        </div>
      )}

      {showLyrics && <LyricsPanel onClose={() => setShowLyrics(false)} />}
    </div>
  );
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
