import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ipc, type Track } from "@/lib/ipc";

// Formats HTML5 audio can play directly. NCM requires a decrypt step
// (see ncm-aware src resolution below).
const HTML5_PLAYABLE = new Set(["mp3", "flac", "wav", "m4a", "ogg", "aac"]);
const NCM_PLAYABLE = new Set(["mp3", "flac", "wav", "m4a", "ogg", "aac", "ncm"]);

type MusicState = {
  tracks: Track[];
  tracksLoaded: boolean;
  currentIndex: number | null;
  currentTrack: Track | null;
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  error: string | null;
  decrypting: boolean;
};

type MusicActions = {
  loadTracks: () => Promise<void>;
  setTracks: (tracks: Track[]) => void;
  play: (index: number) => void;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  setVolume: (v: number) => void;
  seek: (t: number) => void;
  stop: () => void;
};

type MusicContextValue = MusicState & MusicActions;

const MusicContext = createContext<MusicContextValue | null>(null);

export function useMusicPlayer(): MusicContextValue {
  const ctx = useContext(MusicContext);
  if (!ctx) {
    throw new Error("useMusicPlayer must be inside MusicPlayerProvider");
  }
  return ctx;
}

export function MusicPlayerProvider({ children }: { children: React.ReactNode }) {
  const [tracks, setTracksState] = useState<Track[]>([]);
  const [tracksLoaded, setTracksLoaded] = useState(false);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.7);
  const [error, setError] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  // For NCM tracks: src starts undefined, becomes the decrypted-file URL
  // after `decrypt_ncm` resolves. Keyed by source path so we don't re-
  // decrypt on every component remount.
  const [ncmSrcCache, setNcmSrcCache] = useState<Map<string, string>>(
    new Map(),
  );

  const audioRef = useRef<HTMLAudioElement>(null);
  // Track whether the user expects playback (so we don't auto-pause on
  // src changes caused by next/prev).
  const wantPlayRef = useRef(false);

  const currentTrack = currentIndex !== null ? tracks[currentIndex] ?? null : null;

  const currentSrc = useMemo(() => {
    if (!currentTrack) return undefined;
    if (currentTrack.format === "ncm") {
      // NCM tracks resolve via decrypt-to-cache. We only have a real src
      // after `ipc.decryptNcm` completes (see effect below).
      const decryptedPath = ncmSrcCache.get(currentTrack.path);
      return decryptedPath ? convertFileSrc(decryptedPath) : undefined;
    }
    if (!HTML5_PLAYABLE.has(currentTrack.format)) return undefined;
    return convertFileSrc(currentTrack.path);
  }, [currentTrack, ncmSrcCache]);

  // Kick off NCM decryption when an undecrypted NCM track becomes current
  useEffect(() => {
    if (!currentTrack || currentTrack.format !== "ncm") return;
    if (ncmSrcCache.has(currentTrack.path)) return;
    let cancelled = false;
    setDecrypting(true);
    setError(null);
    ipc
      .decryptNcm(currentTrack.path)
      .then((decryptedPath) => {
        if (cancelled) return;
        setNcmSrcCache((prev) => {
          const next = new Map(prev);
          next.set(currentTrack.path, decryptedPath);
          return next;
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setError(`解密失败：${e}`);
        setPlaying(false);
        wantPlayRef.current = false;
      })
      .finally(() => {
        if (!cancelled) setDecrypting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentTrack, ncmSrcCache]);

  // When src changes, load + play if user wants playback
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!currentSrc) return;
    el.load();
    if (wantPlayRef.current) {
      el.play().catch(() => setPlaying(false));
    }
  }, [currentSrc]);

  // Sync volume
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  const loadTracks = useCallback(async () => {
    setError(null);
    try {
      const root = await ipc.getMusicRoot();
      if (!root) {
        setTracksLoaded(true);
        return;
      }
      const list = await ipc.scanMusic();
      setTracksState(list);
      setTracksLoaded(true);
    } catch (e) {
      setError(String(e));
      setTracksLoaded(true);
    }
  }, []);

  // Lazy-load on first mount
  useEffect(() => {
    if (!tracksLoaded) {
      loadTracks();
    }
  }, [tracksLoaded, loadTracks]);

  const setTracks = useCallback((next: Track[]) => {
    setTracksState(next);
    setTracksLoaded(true);
    // If the currently-playing track is no longer in the list, stop
    if (currentTrack && !next.some((t) => t.path === currentTrack.path)) {
      setCurrentIndex(null);
      setPlaying(false);
      wantPlayRef.current = false;
    }
  }, [currentTrack]);

  const play = useCallback((idx: number) => {
    wantPlayRef.current = true;
    setCurrentIndex(idx);
    setPlaying(true);
  }, []);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el || currentIndex === null) return;
    if (el.paused) {
      wantPlayRef.current = true;
      el.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      wantPlayRef.current = false;
      el.pause();
      setPlaying(false);
    }
  }, [currentIndex]);

  const next = useCallback(() => {
    if (currentIndex === null || tracks.length === 0) return;
    wantPlayRef.current = true;
    setCurrentIndex((currentIndex + 1) % tracks.length);
    setPlaying(true);
  }, [currentIndex, tracks.length]);

  const prev = useCallback(() => {
    if (currentIndex === null || tracks.length === 0) return;
    wantPlayRef.current = true;
    setCurrentIndex((currentIndex - 1 + tracks.length) % tracks.length);
    setPlaying(true);
  }, [currentIndex, tracks.length]);

  const setVolume = useCallback((v: number) => {
    setVolumeState(Math.max(0, Math.min(1, v)));
  }, []);

  const seek = useCallback((t: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = t;
    setPosition(t);
  }, []);

  const stop = useCallback(() => {
    wantPlayRef.current = false;
    setCurrentIndex(null);
    setPlaying(false);
  }, []);

  const value: MusicContextValue = {
    tracks,
    tracksLoaded,
    currentIndex,
    currentTrack,
    playing,
    position,
    duration,
    volume,
    error,
    decrypting,
    loadTracks,
    setTracks,
    play,
    togglePlay,
    next,
    prev,
    setVolume,
    seek,
    stop,
  };

  return (
    <MusicContext.Provider value={value}>
      {children}
      {/* The audio element lives at the provider root so it never
       *  unmounts as the user navigates between views — playback is
       *  truly global. */}
      <audio
        ref={audioRef}
        src={currentSrc}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => next()}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) =>
          setDuration(e.currentTarget.duration || 0)
        }
        onError={(e) => {
          // 解析 HTMLMediaElement.error 拿具体原因——用户报"不能播放"时
          // 之前只能看到一行 "无法播放：xxx.ncm", 排查不动。
          const me = (e.currentTarget as HTMLAudioElement).error;
          const codeLabel: Record<number, string> = {
            1: "MEDIA_ERR_ABORTED 用户中止",
            2: "MEDIA_ERR_NETWORK 网络错误",
            3: "MEDIA_ERR_DECODE 解码失败 (文件损坏或格式不被支持)",
            4: "MEDIA_ERR_SRC_NOT_SUPPORTED 文件类型或路径不可加载",
          };
          const reason = me
            ? `${codeLabel[me.code] ?? `code=${me.code}`}${me.message ? ` · ${me.message}` : ""}`
            : "未知错误";
          const file = currentTrack?.filename ?? "(unknown)";
          const srcInfo = currentSrc ? ` · src=${currentSrc.slice(0, 80)}` : "";
          // 控制台打印完整 src 方便用 devtools 复制
          // eslint-disable-next-line no-console
          console.error("[music] audio error", {
            file,
            code: me?.code,
            message: me?.message,
            src: currentSrc,
            format: currentTrack?.format,
          });
          setError(`无法播放 ${file}: ${reason}${srcInfo}`);
          setPlaying(false);
        }}
      />
    </MusicContext.Provider>
  );
}

// Exported for views that need to know whether to gate a row.
// MUSIC_PLAYABLE now includes NCM, since the provider decrypts it
// transparently. HTML5_PLAYABLE is kept for components that need the
// strict native-playable set (e.g. for showing a 🔒 indicator on NCM).
export const MUSIC_PLAYABLE = NCM_PLAYABLE;
export const NATIVE_PLAYABLE = HTML5_PLAYABLE;
