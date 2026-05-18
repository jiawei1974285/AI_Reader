import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ipc, isTauriRuntime, type TagProgress } from "@/lib/ipc";
import { MUSIC_PLAYABLE, useMusicPlayer } from "./MusicPlayerContext";

type Props = {
  onBack: () => void;
};

export function MusicView({ onBack }: Props) {
  const player = useMusicPlayer();
  const [root, setRoot] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagging, setTagging] = useState(false);
  const [tagProgress, setTagProgress] = useState<TagProgress | null>(null);
  const [tagReport, setTagReport] = useState<string | null>(null);
  const [trackTags, setTrackTags] = useState<Map<string, string[]>>(new Map());

  // Initial: read root config + existing track tags
  useEffect(() => {
    (async () => {
      try {
        const r = await ipc.getMusicRoot();
        setRoot(r);
        try {
          const tags = await ipc.listTrackTags();
          const m = new Map<string, string[]>();
          for (const t of tags) {
            try {
              m.set(t.track_path, JSON.parse(t.mood_tags));
            } catch {
              // ignore malformed
            }
          }
          setTrackTags(m);
        } catch {
          // No tags yet — fine
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Listen for tag-progress events while tagging is in flight
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: UnlistenFn | null = null;
    listen<TagProgress>("tag-progress", (event) => {
      setTagProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  async function runTagging() {
    setTagging(true);
    setTagProgress(null);
    setTagReport(null);
    setError(null);
    try {
      const report = await ipc.aiTagMusicTracks();
      setTagReport(
        `共 ${report.total} 首 · 新标 ${report.tagged} · 跳过 ${report.skipped}${
          report.failed > 0 ? ` · 失败 ${report.failed}` : ""
        }`,
      );
      // Reload tag map
      const tags = await ipc.listTrackTags();
      const m = new Map<string, string[]>();
      for (const t of tags) {
        try {
          m.set(t.track_path, JSON.parse(t.mood_tags));
        } catch {
          // ignore
        }
      }
      setTrackTags(m);
    } catch (e) {
      setError(String(e));
    } finally {
      setTagging(false);
    }
  }

  async function pickRoot() {
    let selected = "浏览器预览音乐库";
    if (isTauriRuntime()) {
      const picked = await openDialog({ directory: true, multiple: false });
      if (!picked || typeof picked !== "string") return;
      selected = picked;
    }
    await ipc.setMusicRoot(selected);
    setRoot(selected);
    await rescan();
  }

  async function rescan() {
    setScanning(true);
    setError(null);
    try {
      const list = await ipc.scanMusic();
      player.setTracks(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  const displayed = useMemo(() => {
    if (!filter.trim()) return player.tracks.map((t, i) => ({ t, idx: i }));
    const q = filter.trim().toLowerCase();
    return player.tracks
      .map((t, i) => ({ t, idx: i }))
      .filter(({ t }) => t.filename.toLowerCase().includes(q));
  }, [player.tracks, filter]);

  if (loading) {
    return (
      <div className="app-frame flex items-center justify-center text-sm studio-subtle">
        Loading…
      </div>
    );
  }

  if (!root) {
    return (
      <div className="app-frame flex flex-col items-center justify-center gap-8 px-6">
        <div className="text-center">
          <h1 className="studio-title text-4xl mb-3">
            音乐
          </h1>
          <p className="text-sm studio-subtle tracking-widest">
            选一个文件夹作为音乐库
          </p>
        </div>
        <button
          onClick={pickRoot}
          className="studio-button studio-button-primary"
        >
          选择音乐目录
        </button>
        <button
          onClick={onBack}
          className="studio-button"
        >
          返回书架
        </button>
        {error && (
          <p className="text-sm text-red-600 max-w-md text-center">{error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="app-frame flex flex-col">
      <header className="studio-header px-6 py-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="studio-title text-2xl leading-tight">
            音乐
          </h2>
          <p
            className="text-xs studio-subtle truncate max-w-xl mt-0.5"
            title={root}
          >
            {root} · {player.tracks.length} 首
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs flex-shrink-0">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索…"
            className="studio-input text-sm w-48"
          />
          <button
            onClick={runTagging}
            disabled={tagging || player.tracks.length === 0}
            className="studio-button disabled:opacity-50"
            title="批量给所有音乐打情绪标签（一次性 LLM 调用）"
          >
            {tagging
              ? tagProgress
                ? `AI 标记中… ${tagProgress.current}/${tagProgress.total}`
                : "AI 标记中…"
              : "AI 标记情绪"}
          </button>
          <button
            onClick={rescan}
            disabled={scanning}
            className="studio-button disabled:opacity-50"
          >
            {scanning ? "扫描中…" : "重新扫描"}
          </button>
          <button
            onClick={pickRoot}
            className="studio-button"
          >
            更换目录
          </button>
          <button
            onClick={onBack}
            className="studio-button"
          >
            返回书架
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-8 py-4">
        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}
        {tagReport && (
          <p className="text-xs text-[var(--color-muted)] mb-4 text-center">
            {tagReport}
          </p>
        )}
        {player.tracks.length === 0 && !scanning && (
          <div className="text-center py-16 text-sm text-[var(--color-muted)]">
            这个目录里还没有音频文件。
            <br />
            支持 MP3 / FLAC / WAV / M4A / OGG / AAC（NCM 暂未支持播放）。
          </div>
        )}
        <ul className="max-w-3xl mx-auto divide-y divide-[var(--color-paper-edge)]/60">
          {displayed.map(({ t, idx }) => {
            const isCurrent = idx === player.currentIndex;
            const isPlayable = MUSIC_PLAYABLE.has(t.format);
            const isDecrypting = isCurrent && player.decrypting;
            const tags = trackTags.get(t.path);
            return (
              <li key={t.path}>
                <button
                  onClick={() => isPlayable && player.play(idx)}
                  disabled={!isPlayable}
                  className={`w-full text-left px-4 py-3 flex items-center gap-3 transition group ${
                    isCurrent
                      ? "bg-[var(--color-paper-edge)]/40"
                      : "hover:bg-[var(--color-paper-edge)]/20"
                  } ${!isPlayable ? "opacity-40 cursor-not-allowed" : ""}`}
                >
                  <span
                    className={`w-5 h-5 flex items-center justify-center flex-shrink-0 ${
                      isCurrent && player.playing
                        ? "text-[var(--color-accent)]"
                        : "text-[var(--color-muted)]"
                    }`}
                  >
                    {isCurrent && player.playing ? "▶" : "♪"}
                  </span>
                  <span className="flex-1 min-w-0 flex flex-col gap-1">
                    <span
                      className={`block truncate font-serif text-[15px] ${
                        isCurrent
                          ? "text-[var(--color-ink)] font-medium"
                          : "text-[var(--color-ink-soft)]"
                      }`}
                    >
                      {t.filename}
                      {isDecrypting && (
                        <span className="ml-2 text-[10px] text-[var(--color-accent)]">
                          解密中…
                        </span>
                      )}
                    </span>
                    {tags && tags.length > 0 && (
                      <span className="flex flex-wrap gap-1">
                        {tags.map((tag, i) => (
                          <span
                            key={i}
                            className="inline-block px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-paper-edge)]/50 text-[var(--color-ink-soft)] tracking-wide"
                          >
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-[var(--color-muted)] uppercase tracking-[0.2em] flex-shrink-0">
                    {t.format}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
