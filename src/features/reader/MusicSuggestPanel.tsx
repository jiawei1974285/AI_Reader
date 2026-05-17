import { useEffect, useState } from "react";
import { ipc, type ChapterMoodWithRecs } from "@/lib/ipc";
import { useMusicPlayer } from "@/features/music/MusicPlayerContext";

type Props = {
  chapterText: string;
  chapterLabel: string;
  onClose: () => void;
};

export function MusicSuggestPanel({
  chapterText,
  chapterLabel,
  onClose,
}: Props) {
  const player = useMusicPlayer();
  const [result, setResult] = useState<ChapterMoodWithRecs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    if (!chapterText.trim()) {
      setError("当前章节没有可分析的文字内容");
      setLoading(false);
      return;
    }
    ipc
      .aiRecommendMusic(chapterText, 5)
      .then((r) => {
        if (!cancelled) setResult(r);
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
  }, [chapterText]);

  function playRec(trackPath: string) {
    const idx = player.tracks.findIndex((t) => t.path === trackPath);
    if (idx < 0) {
      setError(
        "这首歌不在当前音乐库里，可能是音乐目录变化了。请回音乐页面重新扫描。",
      );
      return;
    }
    player.play(idx);
  }

  return (
    <div className="absolute inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/10" />
      <aside
        onClick={(e) => e.stopPropagation()}
        className="relative h-full w-96 lg:w-[420px] bg-[var(--color-paper-soft)] border-l border-[var(--color-paper-edge)] shadow-xl flex flex-col"
      >
        <div className="px-6 py-5 border-b border-[var(--color-paper-edge)] flex items-center justify-between flex-shrink-0">
          <div className="min-w-0">
            <h3 className="font-serif text-lg text-[var(--color-ink)]">
              AI 配乐
            </h3>
            <p className="text-xs text-[var(--color-muted)] mt-0.5 truncate">
              {chapterLabel}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper-edge)]/40 transition"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4">
          {loading && (
            <p className="text-sm text-[var(--color-muted)]">分析章节情绪…</p>
          )}
          {error && (
            <div className="rounded-md border border-[var(--color-paper-edge)] p-4 text-sm">
              <p className="text-[var(--color-ink)] mb-2">没法给出配乐</p>
              <p className="text-xs text-[var(--color-muted)] leading-relaxed">
                {error}
              </p>
              <p className="text-xs text-[var(--color-muted)] leading-relaxed mt-3">
                提示：需要先在音乐页面点「AI 标记情绪」给本地音乐打标签，配乐推荐才能工作。
              </p>
            </div>
          )}
          {!loading && !error && result && (
            <>
              <div className="mb-4 pb-3 border-b border-[var(--color-paper-edge)]/60">
                <p className="text-xs text-[var(--color-muted)] mb-2 tracking-widest">
                  本章氛围
                </p>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {result.mood_tags.map((tag, i) => (
                    <span
                      key={i}
                      className="px-2 py-0.5 text-xs rounded bg-[var(--color-paper-edge)]/60 text-[var(--color-ink)]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <p className="text-sm text-[var(--color-ink-soft)] italic leading-relaxed">
                  {result.description}
                </p>
              </div>

              {result.recommendations.length === 0 ? (
                <p className="text-sm text-[var(--color-muted)] text-center py-8">
                  匹配到 0 首。先去音乐页面给音乐打标签吧。
                </p>
              ) : (
                <ul className="space-y-3">
                  {result.recommendations.map((rec) => (
                    <li key={rec.track_path}>
                      <button
                        onClick={() => playRec(rec.track_path)}
                        className="w-full text-left p-3 rounded-md border border-[var(--color-paper-edge)] hover:border-[var(--color-ink)]/20 hover:bg-[var(--color-paper-edge)]/20 transition"
                      >
                        <p className="font-serif text-sm text-[var(--color-ink)] truncate leading-snug">
                          {rec.filename}
                        </p>
                        {rec.mood_tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {rec.mood_tags.map((tag, i) => (
                              <span
                                key={i}
                                className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-paper-edge)]/50 text-[var(--color-ink-soft)]"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                        <p className="text-xs text-[var(--color-muted)] mt-1.5 italic leading-snug line-clamp-2">
                          {rec.description}
                        </p>
                        <p className="text-[10px] text-[var(--color-muted)] mt-1.5 tabular-nums tracking-wider">
                          匹配度 {(rec.score * 100).toFixed(0)}%
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
