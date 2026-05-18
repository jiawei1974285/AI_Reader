import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_READER_SETTINGS,
  ipc,
  loadAiSettings,
  loadReaderSettings,
  saveAiSettings,
  saveReaderSettings,
  type AiSettings,
  type EpubPreview,
  type Highlight,
  type ReaderSettings,
  type TocEntry,
} from "@/lib/ipc";
import { ReaderSettingsPanel } from "./ReaderSettings";
import { TocPanel } from "./TocPanel";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { HighlightPopover } from "./HighlightPopover";
import { ChatPanel } from "./ChatPanel";
import { LookupBubble } from "./LookupBubble";
import { MusicSuggestPanel } from "./MusicSuggestPanel";
import { useReadTimeHeartbeat } from "./useReadTimeHeartbeat";
import { applyHighlights, captureSelection } from "./highlight";
import { BookSearch } from "./BookSearch";

type Props = {
  path: string;
  bookId: number;
  onBack: () => void;
  backLabel?: string;
  initialSpine?: number;
  initialHighlightId?: number;
};

type HighlightColor = "yellow" | "green" | "blue" | "red";
const COLOR_SWATCHES: Record<HighlightColor, string> = {
  yellow: "#facc15",
  green: "#84cc5a",
  blue: "#60a5fa",
  red: "#fc645a",
};

type PendingSelection = {
  rect: DOMRect;
  spineIdx: number;
  selectedText: string;
  prefix: string;
  suffix: string;
};

type ActiveHighlight = {
  hl: Highlight;
  rect: DOMRect;
};

export function EpubView({
  path,
  bookId,
  onBack,
  backLabel = "返回书架",
  initialSpine,
  initialHighlightId,
}: Props) {
  // Track whether we've already flashed the initial highlight (one-shot)
  const flashedInitial = useRef(false);

  // Bank reading time while this view is open
  useReadTimeHeartbeat(bookId);
  const [chapters, setChapters] = useState<EpubPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingPrev, setLoadingPrev] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState<number>(0);

  const [settings, setSettings] = useState<ReaderSettings>(
    DEFAULT_READER_SETTINGS,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiSettings, setAiSettings] = useState<AiSettings>(DEFAULT_AI_SETTINGS);
  const [chatOpen, setChatOpen] = useState(false);
  const [musicSuggestOpen, setMusicSuggestOpen] = useState(false);
  const [lookupSel, setLookupSel] = useState<{
    text: string;
    rect: DOMRect;
    spineIdx: number;
    prefix: string;
    suffix: string;
  } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Ctrl/Cmd+F opens the in-book search bar.
  // Listen in CAPTURE phase + on window so WebView2's native find toolbar
  // doesn't intercept the event before we can preventDefault it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "f" || e.key === "F")
      ) {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Sync fullscreen state on mount
  useEffect(() => {
    let mounted = true;
    getCurrentWindow()
      .isFullscreen()
      .then((v) => {
        if (mounted) setFullscreen(v);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  async function toggleFullscreen() {
    try {
      const win = getCurrentWindow();
      const isFs = await win.isFullscreen();
      await win.setFullscreen(!isFs);
      setFullscreen(!isFs);
    } catch {
      // ignore
    }
  }

  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocLoading, setTocLoading] = useState(true);

  // Single flat source of truth for highlights
  const [allHighlights, setAllHighlights] = useState<Highlight[]>([]);
  const [pendingSel, setPendingSel] = useState<PendingSelection | null>(null);
  const [activeHl, setActiveHl] = useState<ActiveHighlight | null>(null);
  const [annotationsOpen, setAnnotationsOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const chapterEls = useRef<Map<number, HTMLElement>>(new Map());
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Derived: highlights grouped by chapter for fast lookup per ChapterBlock
  const highlightsForChapter = useMemo(() => {
    const map = new Map<number, Highlight[]>();
    for (const h of allHighlights) {
      const list = map.get(h.spine_index) ?? [];
      list.push(h);
      map.set(h.spine_index, list);
    }
    return map;
  }, [allHighlights]);

  // Apply theme to <body>
  useEffect(() => {
    document.body.setAttribute("data-theme", settings.theme);
    return () => {
      document.body.removeAttribute("data-theme");
    };
  }, [settings.theme]);

  useEffect(() => {
    loadReaderSettings().then(setSettings).catch(() => {});
    loadAiSettings().then(setAiSettings).catch(() => {});
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      saveReaderSettings(settings).catch(() => {});
    }, 200);
    return () => window.clearTimeout(t);
  }, [settings]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      saveAiSettings(aiSettings).catch(() => {});
    }, 300);
    return () => window.clearTimeout(t);
  }, [aiSettings]);

  useEffect(() => {
    let cancelled = false;
    setTocLoading(true);
    setToc([]);
    ipc
      .getBookToc(path)
      .then((entries) => {
        if (!cancelled) setToc(entries);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTocLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Load all highlights for this book once
  useEffect(() => {
    let cancelled = false;
    ipc
      .listHighlightsByBook(bookId)
      .then((hs) => {
        if (!cancelled) setAllHighlights(hs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  // Initial chapter load
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setChapters([]);
    chapterEls.current.clear();

    (async () => {
      try {
        let initial: EpubPreview;
        if (initialSpine !== undefined) {
          // Caller specified a starting chapter (e.g. jump from notes view)
          initial = await ipc.readBookChapter(path, initialSpine);
        } else {
          const progress = await ipc.getProgress(bookId);
          initial = progress
            ? await ipc.readBookChapter(path, progress.spine_index)
            : await ipc.readBookInitial(path);
          if (!progress) {
            ipc.saveProgress(bookId, initial.spine_index, 0).catch(() => {});
          }
        }
        if (cancelled) return;
        setChapters([initial]);
        setActiveIdx(initial.spine_index);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, bookId]);

  // When opened with an initial highlight (jump from notes view), once both
  // the chapter and the highlight metadata are loaded, scroll to and flash
  // the target mark exactly once.
  useEffect(() => {
    if (!initialHighlightId || flashedInitial.current) return;
    if (chapters.length === 0) return;
    if (!allHighlights.some((h) => h.id === initialHighlightId)) return;
    // Wait two frames so ChapterBlock's applyHighlights effect runs first.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const mark = document.querySelector(
          `mark.ai-hl[data-hl-id="${initialHighlightId}"]`,
        ) as HTMLElement | null;
        if (!mark || !scrollRef.current) return;
        const cr = scrollRef.current.getBoundingClientRect();
        const mr = mark.getBoundingClientRect();
        const offset = mr.top - cr.top + scrollRef.current.scrollTop - 120;
        scrollRef.current.scrollTo({ top: offset, behavior: "smooth" });
        mark.classList.add("ai-hl-flash");
        window.setTimeout(() => mark.classList.remove("ai-hl-flash"), 1500);
        flashedInitial.current = true;
      });
    });
  }, [chapters, allHighlights, initialHighlightId]);

  // Auto-load next chapter
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || loading) return;
    const last = chapters[chapters.length - 1];
    if (!last) return;
    if (last.spine_index >= last.spine_total - 1) return;

    const obs = new IntersectionObserver(
      async (entries) => {
        if (!entries[0].isIntersecting) return;
        if (loadingMore) return;
        setLoadingMore(true);
        try {
          const next = await ipc.readBookChapter(path, last.spine_index + 1);
          setChapters((prev) => [...prev, next]);
        } catch (e) {
          setError(String(e));
        } finally {
          setLoadingMore(false);
        }
      },
      { root, rootMargin: "400px 0px" },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [chapters, loading, loadingMore, path]);

  // Save progress on scroll
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || chapters.length === 0) return;
    let timer: number | null = null;

    const onScroll = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const probe = root.scrollTop + 80;
        let current = chapters[0].spine_index;
        for (const ch of chapters) {
          const el = chapterEls.current.get(ch.spine_index);
          if (!el) continue;
          if (el.offsetTop <= probe) current = ch.spine_index;
        }
        if (current !== activeIdx) setActiveIdx(current);
        ipc.saveProgress(bookId, current, root.scrollTop).catch(() => {});
      }, 400);
    };

    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (timer) window.clearTimeout(timer);
    };
  }, [chapters, bookId, activeIdx]);

  // Selection → floating toolbar
  useEffect(() => {
    function onMouseUp() {
      window.setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
          setPendingSel(null);
          return;
        }
        const range = sel.getRangeAt(0);
        let node: Node | null = range.commonAncestorContainer;
        let section: HTMLElement | null = null;
        while (node) {
          if (node instanceof HTMLElement && node.dataset.spine != null) {
            section = node;
            break;
          }
          node = node.parentNode;
        }
        if (!section) {
          setPendingSel(null);
          return;
        }
        const cap = captureSelection(section);
        if (!cap) {
          setPendingSel(null);
          return;
        }
        setPendingSel({
          rect: cap.rect,
          spineIdx: Number(section.dataset.spine),
          selectedText: cap.selectedText,
          prefix: cap.prefix,
          suffix: cap.suffix,
        });
      }, 10);
    }
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, []);

  // Click outside selection toolbar dismisses it
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (toolbarRef.current && toolbarRef.current.contains(target)) return;
      if (target.closest && target.closest("mark.ai-hl")) return;
      setPendingSel(null);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  // Click on existing highlight → open popover
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    function onClick(e: Event) {
      const target = e.target as HTMLElement;
      const mark = target.closest("mark.ai-hl") as HTMLElement | null;
      if (!mark) return;
      e.preventDefault();
      e.stopPropagation();
      const id = Number(mark.dataset.hlId);
      const hl = allHighlights.find((h) => h.id === id);
      if (!hl) return;
      setActiveHl({ hl, rect: mark.getBoundingClientRect() });
    }
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [allHighlights]);

  async function commitHighlight(color: HighlightColor) {
    if (!pendingSel) return;
    try {
      const hl = await ipc.createHighlight({
        bookId,
        spineIndex: pendingSel.spineIdx,
        selectedText: pendingSel.selectedText,
        prefix: pendingSel.prefix,
        suffix: pendingSel.suffix,
        color,
        note: "",
      });
      setAllHighlights((prev) => [...prev, hl]);
      window.getSelection()?.removeAllRanges();
      setPendingSel(null);
    } catch (e) {
      setError(String(e));
    }
  }

  function onHighlightChanged(updated: Highlight) {
    setAllHighlights((prev) =>
      prev.map((h) => (h.id === updated.id ? updated : h)),
    );
    setActiveHl((curr) =>
      curr && curr.hl.id === updated.id ? { ...curr, hl: updated } : curr,
    );
  }

  function onHighlightDeleted(id: number) {
    setAllHighlights((prev) => prev.filter((h) => h.id !== id));
    setActiveHl((curr) => (curr && curr.hl.id === id ? null : curr));
  }

  const loadPrev = useCallback(async () => {
    if (chapters.length === 0 || loadingPrev) return;
    const first = chapters[0];
    if (first.spine_index <= 0) return;
    setLoadingPrev(true);
    const root = scrollRef.current;
    const prevHeight = root?.scrollHeight ?? 0;
    try {
      const prev = await ipc.readBookChapter(path, first.spine_index - 1);
      setChapters((cs) => [prev, ...cs]);
      requestAnimationFrame(() => {
        const newHeight = scrollRef.current?.scrollHeight ?? 0;
        if (scrollRef.current) {
          scrollRef.current.scrollTop += newHeight - prevHeight;
        }
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingPrev(false);
    }
  }, [chapters, loadingPrev, path]);

  // Jump to a specific chapter; optionally then scroll to a specific highlight
  const jumpToChapter = useCallback(
    async (spineIdx: number, hlIdToFlash?: number) => {
      const existing = chapterEls.current.get(spineIdx);
      const scrollToMark = (mark: HTMLElement) => {
        const containerRect = scrollRef.current!.getBoundingClientRect();
        const markRect = mark.getBoundingClientRect();
        const offset =
          markRect.top -
          containerRect.top +
          scrollRef.current!.scrollTop -
          120;
        scrollRef.current!.scrollTo({ top: offset, behavior: "smooth" });
        mark.classList.add("ai-hl-flash");
        window.setTimeout(() => mark.classList.remove("ai-hl-flash"), 1500);
      };

      if (existing && scrollRef.current) {
        if (hlIdToFlash) {
          const mark = existing.querySelector(
            `mark.ai-hl[data-hl-id="${hlIdToFlash}"]`,
          ) as HTMLElement | null;
          if (mark) {
            scrollToMark(mark);
            setActiveIdx(spineIdx);
            return;
          }
        }
        scrollRef.current.scrollTo({
          top: existing.offsetTop - 20,
          behavior: "smooth",
        });
        setActiveIdx(spineIdx);
        ipc.saveProgress(bookId, spineIdx, existing.offsetTop).catch(() => {});
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const ch = await ipc.readBookChapter(path, spineIdx);
        setChapters([ch]);
        chapterEls.current.clear();
        setActiveIdx(spineIdx);
        ipc.saveProgress(bookId, spineIdx, 0).catch(() => {});
        // After paint, find and flash the target mark if requested
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            scrollRef.current?.scrollTo({ top: 0 });
            if (hlIdToFlash) {
              const mark = document.querySelector(
                `mark.ai-hl[data-hl-id="${hlIdToFlash}"]`,
              ) as HTMLElement | null;
              if (mark) scrollToMark(mark);
            }
          });
        });
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [bookId, path],
  );

  const registerChapterEl = useCallback(
    (idx: number, el: HTMLElement | null) => {
      if (el) chapterEls.current.set(idx, el);
      else chapterEls.current.delete(idx);
    },
    [],
  );

  const total = chapters[0]?.spine_total ?? 0;
  const atLast =
    chapters.length > 0 &&
    chapters[chapters.length - 1].spine_index >= total - 1;

  const readingStyle = useMemo<React.CSSProperties>(
    () => ({
      fontFamily:
        settings.font_family === "serif"
          ? "var(--font-serif)"
          : "var(--font-sans)",
      fontSize: `${settings.font_size}px`,
      lineHeight: settings.line_height,
      maxWidth: `${settings.column_width}em`,
    }),
    [settings],
  );

  if (loading && chapters.length === 0) {
    return (
      <div className="app-frame flex items-center justify-center text-sm studio-subtle">
        正在打开阅读页...
      </div>
    );
  }

  if (error && chapters.length === 0) {
    return (
      <div className="app-frame flex flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-red-600 max-w-xl">{error}</p>
        <button
          onClick={onBack}
          className="studio-button"
        >
          返回书架
        </button>
      </div>
    );
  }

  const head = chapters[0];

  return (
    <div className="app-frame relative flex flex-col">
      <header className="studio-header px-6 py-3.5 flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="studio-title text-lg leading-tight truncate">
            {head?.title}
          </h2>
          <p className="text-xs studio-subtle truncate mt-0.5 tracking-wide">
            {head?.author}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs flex-shrink-0">
          <button
            onClick={() =>
              setSettings((s) => ({
                ...s,
                toc_sidebar_open: !s.toc_sidebar_open,
              }))
            }
            className={`studio-ghost ${
              settings.toc_sidebar_open ? "studio-ghost-active" : ""
            }`}
          >
            目录
          </button>
          <button
            onClick={() => setAnnotationsOpen(true)}
            className="studio-ghost"
          >
            标注{allHighlights.length > 0 ? ` · ${allHighlights.length}` : ""}
          </button>
          <button
            onClick={() => setSearchOpen(true)}
            className="studio-ghost"
            title="本书内查找 (Ctrl+F)"
          >
            查找
          </button>
          <button
            onClick={() => setChatOpen(true)}
            className="studio-ghost"
          >
            问 AI
          </button>
          <button
            onClick={() => setMusicSuggestOpen(true)}
            className="studio-ghost"
          >
            AI 配乐
          </button>
          <span className="studio-chip tabular-nums">
            第 {activeIdx + 1} / {total} 章
          </span>
          <button
            onClick={loadPrev}
            disabled={loadingPrev || (chapters[0]?.spine_index ?? 0) <= 0}
            className="studio-button disabled:opacity-30 disabled:cursor-not-allowed"
            title="加载上一章"
          >
            {loadingPrev ? "…" : "↑ 上一章"}
          </button>
          <button
            onClick={toggleFullscreen}
            className={`studio-ghost ${
              fullscreen ? "studio-ghost-active" : ""
            }`}
            title={fullscreen ? "退出全屏" : "全屏 (F11)"}
          >
            {fullscreen ? "退出全屏" : "全屏"}
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="studio-ghost"
          >
            设置
          </button>
          <button
            onClick={onBack}
            className="studio-button"
          >
            {backLabel}
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {settings.toc_sidebar_open && (
          <TocPanel
            toc={toc}
            activeSpineIndex={activeIdx}
            loading={tocLoading}
            onJump={(idx) => jumpToChapter(idx)}
            onClose={() =>
              setSettings((s) => ({ ...s, toc_sidebar_open: false }))
            }
          />
        )}
        <div ref={scrollRef} className="reader-page flex-1 overflow-auto">
        <article
          className={`reading mx-auto px-10 md:px-16 py-16 ${
            settings.paragraph_indent ? "" : "indent-none"
          }`}
          style={readingStyle}
        >
          {chapters.map((ch, i) => (
            <ChapterBlock
              key={ch.spine_index}
              chapter={ch}
              showDivider={i > 0}
              highlights={highlightsForChapter.get(ch.spine_index) ?? []}
              registerRef={registerChapterEl}
            />
          ))}
          <div ref={sentinelRef} className="h-2" />
          {loadingMore && (
            <div className="text-center py-8 text-sm text-[var(--color-muted)] tracking-wider">
              加载下一章…
            </div>
          )}
          {atLast && !loadingMore && (
            <div className="text-center py-16 text-xs text-[var(--color-muted)] tracking-[0.5em]">
              — 完 —
            </div>
          )}
        </article>
        </div>
      </div>

      {/* Chapter progress strip — pinned to the bottom of the reader so
       *  it's always visible without taking up vertical reading space.
       *  Pure information; non-interactive. */}
      {total > 0 && (
        <div className="flex-shrink-0 px-6 py-1.5 border-t border-[var(--color-paper-edge)] bg-[var(--color-paper-soft)]/60 flex items-center gap-3">
          <span className="text-[10px] studio-subtle tracking-[0.1em] tabular-nums">
            第 {activeIdx + 1} 章 / 共 {total} 章
          </span>
          <div className="flex-1 h-1 bg-[var(--color-paper-edge)]/40 rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--color-accent)] transition-all"
              style={{
                width: `${Math.max(2, Math.min(100, ((activeIdx + 1) / total) * 100))}%`,
              }}
            />
          </div>
          <span className="text-[10px] studio-subtle tabular-nums w-10 text-right">
            {Math.round(((activeIdx + 1) / total) * 100)}%
          </span>
        </div>
      )}

      {pendingSel && (
        <div
          ref={toolbarRef}
          style={{
            position: "fixed",
            left: pendingSel.rect.left + pendingSel.rect.width / 2,
            top: Math.max(8, pendingSel.rect.top - 44),
            transform: "translateX(-50%)",
            zIndex: 50,
          }}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-full bg-[var(--color-ink)] text-[var(--color-paper)] shadow-lg"
        >
          {(Object.keys(COLOR_SWATCHES) as HighlightColor[]).map((c) => (
            <button
              key={c}
              onClick={() => commitHighlight(c)}
              className="w-6 h-6 rounded-full border border-white/20 hover:scale-110 transition"
              style={{ background: COLOR_SWATCHES[c] }}
              aria-label={`高亮 ${c}`}
              title="高亮"
            />
          ))}
          <span className="w-px h-5 bg-white/20 mx-0.5" />
          <button
            onClick={() => {
              if (!pendingSel) return;
              setLookupSel({
                text: pendingSel.selectedText,
                rect: pendingSel.rect,
                spineIdx: pendingSel.spineIdx,
                prefix: pendingSel.prefix,
                suffix: pendingSel.suffix,
              });
              setPendingSel(null);
              window.getSelection()?.removeAllRanges();
            }}
            className="px-2 py-0.5 rounded-full text-xs hover:bg-white/15 transition"
            title="问 AI 这段是什么意思"
          >
            ✦ 问 AI
          </button>
        </div>
      )}

      {searchOpen && (
        <BookSearch
          rootEl={scrollRef.current}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {lookupSel && (
        <LookupBubble
          selectedText={lookupSel.text}
          rect={lookupSel.rect}
          bookId={bookId}
          spineIndex={lookupSel.spineIdx}
          prefix={lookupSel.prefix}
          suffix={lookupSel.suffix}
          onHighlightCreated={(hl) =>
            setAllHighlights((prev) => [...prev, hl])
          }
          aiConfigured={
            aiSettings.base_url.trim() !== "" &&
            aiSettings.api_key.trim() !== "" &&
            aiSettings.chat_model.trim() !== ""
          }
          onOpenSettings={() => {
            setLookupSel(null);
            setSettingsOpen(true);
          }}
          onClose={() => setLookupSel(null)}
        />
      )}

      {activeHl && (
        <HighlightPopover
          hl={activeHl.hl}
          rect={activeHl.rect}
          onChange={onHighlightChanged}
          onDelete={() => onHighlightDeleted(activeHl.hl.id)}
          onClose={() => setActiveHl(null)}
        />
      )}

      {settingsOpen && (
        <ReaderSettingsPanel
          settings={settings}
          onChange={setSettings}
          aiSettings={aiSettings}
          onAiChange={setAiSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {chatOpen && (
        <ChatPanel
          bookId={bookId}
          bookPath={path}
          bookTitle={head?.title ?? ""}
          chapterSpineIndex={activeIdx}
          chapterLabel={
            toc.find((t) => t.spine_index === activeIdx)?.label ??
            `第 ${activeIdx + 1} 章`
          }
          chapterText={
            chapters.find((c) => c.spine_index === activeIdx)
              ? htmlToText(
                  chapters.find((c) => c.spine_index === activeIdx)!.html,
                )
              : ""
          }
          aiConfigured={
            aiSettings.base_url.trim() !== "" &&
            aiSettings.api_key.trim() !== "" &&
            aiSettings.chat_model.trim() !== ""
          }
          onOpenSettings={() => {
            setChatOpen(false);
            setSettingsOpen(true);
          }}
          onJumpToChapter={(spineIdx) => jumpToChapter(spineIdx)}
          onClose={() => setChatOpen(false)}
        />
      )}

      {musicSuggestOpen && (
        <MusicSuggestPanel
          chapterLabel={
            toc.find((t) => t.spine_index === activeIdx)?.label ??
            `第 ${activeIdx + 1} 章`
          }
          chapterText={
            chapters.find((c) => c.spine_index === activeIdx)
              ? htmlToText(
                  chapters.find((c) => c.spine_index === activeIdx)!.html,
                )
              : ""
          }
          onClose={() => setMusicSuggestOpen(false)}
        />
      )}

      {annotationsOpen && (
        <AnnotationsPanel
          bookId={bookId}
          bookTitle={head?.title ?? ""}
          bookAuthor={head?.author ?? ""}
          highlights={allHighlights}
          toc={toc}
          onJump={(spineIdx, hlId) => {
            setAnnotationsOpen(false);
            jumpToChapter(spineIdx, hlId);
          }}
          onDelete={(hlId) => onHighlightDeleted(hlId)}
          onClose={() => setAnnotationsOpen(false)}
        />
      )}
    </div>
  );
}

type ChapterBlockProps = {
  chapter: EpubPreview;
  showDivider: boolean;
  highlights: Highlight[];
  registerRef: (idx: number, el: HTMLElement | null) => void;
};

/** Strip tags and collapse whitespace to feed chapter content into the AI
 * panel as plain text. */
function htmlToText(html: string): string {
  let s = html.replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ");
  s = s.replace(/&amp;/g, "&");
  s = s.replace(/&lt;/g, "<");
  s = s.replace(/&gt;/g, ">");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

const ChapterBlock = memo(function ChapterBlock({
  chapter,
  showDivider,
  highlights,
  registerRef,
}: ChapterBlockProps) {
  const ref = useRef<HTMLElement | null>(null);

  const onRef = useCallback(
    (el: HTMLElement | null) => {
      ref.current = el;
      registerRef(chapter.spine_index, el);
    },
    [chapter.spine_index, registerRef],
  );

  useEffect(() => {
    if (ref.current) applyHighlights(ref.current, highlights);
  }, [chapter.html, highlights]);

  return (
    <section ref={onRef} data-spine={chapter.spine_index}>
      {showDivider && (
        <div className="text-center my-12 text-[var(--color-muted)] tracking-[0.5em]">
          · · ·
        </div>
      )}
      <div dangerouslySetInnerHTML={{ __html: chapter.html }} />
    </section>
  );
});
