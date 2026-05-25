import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ipc,
  type AiSettings,
  type Bookmark,
  type EpubPreview,
  type Highlight,
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
import { applyHighlights } from "./highlight";
import { findViewportTopAnchor, scrollToAnchor } from "./progressAnchor";
import { useReadingProgress } from "./useReadingProgress";
// B2 阶段 1+2: 抽出独立 hook
import { useFullscreen } from "./useFullscreen";
import { useReaderSettings } from "./useReaderSettings";
import { useBookmarksPanel } from "./useBookmarksPanel";
import { useReaderKeybindings } from "./useReaderKeybindings";
import { useSelectionPopover } from "./useSelectionPopover";
import { useChapterEntities } from "./useChapterEntities";
import { BookSearch } from "./BookSearch";
import { BookmarksPanel } from "./BookmarksPanel";
import { ChapterEntitiesPanel } from "./ChapterEntitiesPanel";
import {
  applyEntityUnderlines,
  type EntityWithKey,
} from "./entityUnderlines";

type Props = {
  path: string;
  bookId: number;
  aiSettings: AiSettings;
  onOpenAiSettings: () => void;
  onBack: () => void;
  backLabel?: string;
  initialSpine?: number;
  initialScrollY?: number;
  initialHighlightId?: number;
};

type HighlightColor = "yellow" | "green" | "blue" | "red";
const COLOR_SWATCHES: Record<HighlightColor, string> = {
  yellow: "#facc15",
  green: "#84cc5a",
  blue: "#60a5fa",
  red: "#fc645a",
};

// B2: PendingSelection / ActiveHighlight 类型已搬到 useSelectionPopover.ts

export function EpubView({
  path,
  bookId,
  aiSettings,
  onOpenAiSettings,
  onBack,
  backLabel = "返回书架",
  initialSpine,
  initialScrollY,
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

  // B2: 抽到 useReaderSettings — load / debounced save / theme apply 三个 effect 一并搬走
  const { settings, setSettings, settingsReady } = useReaderSettings();
  const [pagedWidth, setPagedWidth] = useState(720);
  const [pageOffset, setPageOffset] = useState(0);
  const [pageMaxOffset, setPageMaxOffset] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [musicSuggestOpen, setMusicSuggestOpen] = useState(false);
  const [lookupSel, setLookupSel] = useState<{
    text: string;
    rect: DOMRect;
    spineIdx: number;
    prefix: string;
    suffix: string;
  } | null>(null);
  // B2: 抽到 useFullscreen — 既同步 OS 状态又提供 toggle
  const { fullscreen, toggleFullscreen } = useFullscreen();
  const [searchOpen, setSearchOpen] = useState(false);
  // B2: 抽到 useBookmarksPanel — 抽屉开关 + 列表 + auto-refresh
  const {
    bookmarks,
    bookmarksOpen,
    setBookmarksOpen,
    bookmarksLoading,
    refresh: refreshBookmarks,
  } = useBookmarksPanel(bookId);
  // B2: entities 5 个 state + click effect + fetch fn 都搬到 useChapterEntities，
  //     但 hook 需要 currentChapter/currentChapterLabel/aiConfigured，这些在下方
  //     才计算——所以 hook 的实例化移到 line ~165 处（chapter 解出来之后）。
  const [bookmarkStatus, setBookmarkStatus] = useState<string | null>(null);

  // B2: 进度（初始 load / 恢复 / 滚动 throttle 保存）三件事抽到一个 hook。
  // A4 引入的 paragraph_index/char_offset 在 hook 内部统一管。
  const readingProgress = useReadingProgress();

  // B2: Ctrl+F 抽到 useReaderKeybindings；fullscreen 抽到 useFullscreen（见上）
  useReaderKeybindings({ onOpenSearch: () => setSearchOpen(true) });

  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocLoading, setTocLoading] = useState(true);

  // Single flat source of truth for highlights
  const [allHighlights, setAllHighlights] = useState<Highlight[]>([]);
  const [annotationsOpen, setAnnotationsOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const chapterEls = useRef<Map<number, HTMLElement>>(new Map());
  const toolbarRef = useRef<HTMLDivElement>(null);

  // B2: 选区浮动工具栏 + 点击高亮 popover — 三个 effect 都搬到 hook
  const { pendingSel, setPendingSel, activeHl, setActiveHl } =
    useSelectionPopover({
      scrollRef,
      toolbarRef,
      allHighlights,
    });

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

  const currentChapter = chapters.find((c) => c.spine_index === activeIdx);
  const total = chapters[0]?.spine_total ?? 0;
  const currentChapterLabel =
    toc.find((t) => t.spine_index === activeIdx)?.label ??
    `第 ${activeIdx + 1} 章`;
  const aiConfigured =
    aiSettings.base_url.trim() !== "" &&
    aiSettings.api_key.trim() !== "" &&
    aiSettings.chat_model.trim() !== "";
  const isPagedMode = (settings.reading_mode ?? "scroll") === "paged";

  // B2: entities 抽到 useChapterEntities（在 currentChapter 解出后）
  const {
    entitiesBySpine,
    currentEntities,
    entitiesOpen,
    setEntitiesOpen,
    entitiesLoading,
    entitiesError,
    activeEntityKey,
    setActiveEntityKey,
    fetchEntitiesForCurrentChapter,
  } = useChapterEntities({
    scrollRef,
    aiConfigured,
    currentChapter,
    currentChapterLabel,
    htmlToText,
  });

  // B2: theme apply / settings load+save 都已抽到 useReaderSettings；
  //      refreshBookmarks + auto-refresh 都已抽到 useBookmarksPanel

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
        const initial = await readingProgress.loadInitialChapter({
          path,
          bookId,
          initialSpine,
          initialScrollY,
        });
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
  }, [path, bookId, initialSpine, initialScrollY]);

  useEffect(() => {
    const { anchor, scrollY: y } = readingProgress.restoreTarget;
    if (!settingsReady || chapters.length === 0) return;
    if (anchor == null && y === 0) return; // 没有需要恢复的目标
    // 消费：一次性，避免后续 chapters 变更被重复触发
    readingProgress.consumeRestoreTarget();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const root = scrollRef.current;
        if (!root) return;
        // A4: 优先按段落锚恢复；段落不存在 / 章节 DOM 没准备好时退回 scroll_y
        if (anchor) {
          const ch = chapters.find((c) => c.spine_index === activeIdx);
          const chapterEl = ch
            ? (chapterEls.current.get(ch.spine_index) ?? null)
            : null;
          if (
            chapterEl &&
            scrollToAnchor(
              chapterEl,
              root,
              anchor.paragraphIndex,
              anchor.charOffset,
              isPagedMode,
            )
          ) {
            return; // 成功，不再用 scroll_y
          }
        }
        if (isPagedMode) {
          root.scrollTo({ left: Math.max(0, y), top: 0 });
        } else {
          root.scrollTo({ top: Math.max(0, y), left: 0 });
        }
      });
    });
  }, [chapters, isPagedMode, settingsReady, activeIdx, readingProgress]);

  useEffect(() => {
    if (!isPagedMode || chapters.length <= 1) return;
    const current =
      chapters.find((chapter) => chapter.spine_index === activeIdx) ??
      chapters[0];
    setChapters([current]);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ left: 0, top: 0 });
      // A4: 章首 = paragraph 0
      readingProgress.recordScrollPosition({
        bookId,
        spineIndex: current.spine_index,
        scrollPixel: 0,
        paragraphIndex: 0,
        charOffset: 0,
      });
    });
  }, [activeIdx, bookId, chapters, isPagedMode, readingProgress]);

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
        if (isPagedMode) {
          const offset = mr.left - cr.left + scrollRef.current.scrollLeft - 40;
          scrollRef.current.scrollTo({
            left: offset,
            top: 0,
            behavior: "smooth",
          });
        } else {
          const offset = mr.top - cr.top + scrollRef.current.scrollTop - 120;
          scrollRef.current.scrollTo({ top: offset, behavior: "smooth" });
        }
        mark.classList.add("ai-hl-flash");
        window.setTimeout(() => mark.classList.remove("ai-hl-flash"), 1500);
        flashedInitial.current = true;
      });
    });
  }, [chapters, allHighlights, initialHighlightId, isPagedMode]);

  // Auto-load next chapter
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (isPagedMode) return;
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
  }, [chapters, loading, loadingMore, path, isPagedMode]);

  // Save progress on scroll
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || chapters.length === 0) return;
    let timer: number | null = null;

    const onScroll = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (isPagedMode) {
          setPageOffset(root.scrollLeft);
          setPageMaxOffset(Math.max(0, root.scrollWidth - root.clientWidth));
          // A4: 分页模式也找段落锚
          const pagedEl = chapterEls.current.get(activeIdx);
          const pagedAnchor = pagedEl
            ? findViewportTopAnchor(pagedEl, root, true)
            : null;
          readingProgress.recordScrollPosition({
            bookId,
            spineIndex: activeIdx,
            scrollPixel: root.scrollLeft,
            paragraphIndex: pagedAnchor?.paragraphIndex ?? null,
            charOffset: pagedAnchor?.charOffset ?? null,
          });
          return;
        }
        const probe = root.scrollTop + 80;
        let current = chapters[0].spine_index;
        for (const ch of chapters) {
          const el = chapterEls.current.get(ch.spine_index);
          if (!el) continue;
          if (el.offsetTop <= probe) current = ch.spine_index;
        }
        if (current !== activeIdx) setActiveIdx(current);
        // A4: 在当前 active chapter 里找视口顶部段落
        const activeEl = chapterEls.current.get(current);
        const anchor = activeEl
          ? findViewportTopAnchor(activeEl, root, false)
          : null;
        readingProgress.recordScrollPosition({
          bookId,
          spineIndex: current,
          scrollPixel: root.scrollTop,
          paragraphIndex: anchor?.paragraphIndex ?? null,
          charOffset: anchor?.charOffset ?? null,
        });
      }, 400);
    };

    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (timer) window.clearTimeout(timer);
    };
  }, [chapters, bookId, activeIdx, isPagedMode]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const syncPagedSize = () => {
      setPagedWidth(Math.max(320, root.clientWidth));
      setPageOffset(root.scrollLeft);
      setPageMaxOffset(Math.max(0, root.scrollWidth - root.clientWidth));
    };
    syncPagedSize();
    const ro = new ResizeObserver(syncPagedSize);
    ro.observe(root);
    return () => ro.disconnect();
  }, [chapters, isPagedMode, settings.toc_sidebar_open, entitiesOpen]);

  useEffect(() => {
    if (!isPagedMode) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const root = scrollRef.current;
        if (!root) return;
        setPageOffset(root.scrollLeft);
        setPageMaxOffset(Math.max(0, root.scrollWidth - root.clientWidth));
      });
    });
  }, [chapters, isPagedMode, pagedWidth, settings.font_size, settings.line_height]);

  // B2: 选区/popover 三个 effect 都搬到 useSelectionPopover

  // B2: ai-entity click → 打开面板 effect 搬到 useChapterEntities

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

  const goToPrevPage = useCallback(async () => {
    const root = scrollRef.current;
    if (!root || loadingPrev) return;
    const pageStep = getPagedStep(root);
    if (root.scrollLeft > 8) {
      const left = Math.max(0, root.scrollLeft - pageStep);
      root.scrollTo({ left, top: 0, behavior: "smooth" });
      setPageOffset(left);
      ipc.saveProgress(bookId, activeIdx, left).catch(() => {});
      return;
    }
    if (activeIdx <= 0) return;

    setLoadingPrev(true);
    try {
      const prev = await ipc.readBookChapter(path, activeIdx - 1);
      setChapters([prev]);
      chapterEls.current.clear();
      setActiveIdx(prev.spine_index);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const nextRoot = scrollRef.current;
          if (!nextRoot) return;
          const left = Math.max(0, nextRoot.scrollWidth - nextRoot.clientWidth);
          nextRoot.scrollTo({ left, top: 0 });
          setPageOffset(left);
          setPageMaxOffset(left);
          ipc.saveProgress(bookId, prev.spine_index, left).catch(() => {});
        });
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingPrev(false);
    }
  }, [activeIdx, bookId, loadingPrev, path]);

  const goToNextPage = useCallback(async () => {
    const root = scrollRef.current;
    if (!root || loadingMore) return;
    const maxLeft = Math.max(0, root.scrollWidth - root.clientWidth);
    const pageStep = getPagedStep(root);
    if (root.scrollLeft < maxLeft - 8) {
      const left = Math.min(maxLeft, root.scrollLeft + pageStep);
      root.scrollTo({ left, top: 0, behavior: "smooth" });
      setPageOffset(left);
      setPageMaxOffset(maxLeft);
      ipc.saveProgress(bookId, activeIdx, left).catch(() => {});
      return;
    }
    if (activeIdx >= total - 1) return;

    setLoadingMore(true);
    try {
      const next = await ipc.readBookChapter(path, activeIdx + 1);
      setChapters([next]);
      chapterEls.current.clear();
      setActiveIdx(next.spine_index);
      setPageOffset(0);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ left: 0, top: 0 });
        setPageMaxOffset(
          Math.max(
            0,
            (scrollRef.current?.scrollWidth ?? 0) -
              (scrollRef.current?.clientWidth ?? 0),
          ),
        );
      });
      ipc.saveProgress(bookId, next.spine_index, 0).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [activeIdx, bookId, loadingMore, path, total]);

  useEffect(() => {
    if (!isPagedMode) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest?.("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goToPrevPage();
      } else if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        goToNextPage();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goToNextPage, goToPrevPage, isPagedMode]);

  // Jump to a specific chapter; optionally then scroll to a specific highlight
  const jumpToChapter = useCallback(
    async (spineIdx: number, hlIdToFlash?: number) => {
      const existing = chapterEls.current.get(spineIdx);
      const scrollToMark = (mark: HTMLElement) => {
        const containerRect = scrollRef.current!.getBoundingClientRect();
        const markRect = mark.getBoundingClientRect();
        if (isPagedMode) {
          const offset =
            markRect.left - containerRect.left + scrollRef.current!.scrollLeft - 40;
          scrollRef.current!.scrollTo({
            left: offset,
            top: 0,
            behavior: "smooth",
          });
        } else {
          const offset =
            markRect.top - containerRect.top + scrollRef.current!.scrollTop - 120;
          scrollRef.current!.scrollTo({ top: offset, behavior: "smooth" });
        }
        mark.classList.add("ai-hl-flash");
        window.setTimeout(() => mark.classList.remove("ai-hl-flash"), 1500);
      };

      if (!isPagedMode && existing && scrollRef.current) {
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
            scrollRef.current?.scrollTo({ top: 0, left: 0 });
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
    [bookId, isPagedMode, path],
  );

  const jumpToBookmark = useCallback(
    async (bookmark: Bookmark) => {
      setBookmarksOpen(false);
      const existing = chapterEls.current.get(bookmark.spine_index);
      if (existing && scrollRef.current) {
        if (isPagedMode) {
          scrollRef.current.scrollTo({
            left: Math.max(0, bookmark.scroll_y),
            top: 0,
            behavior: "smooth",
          });
        } else {
          scrollRef.current.scrollTo({
            top: Math.max(0, bookmark.scroll_y),
            left: 0,
            behavior: "smooth",
          });
        }
        setActiveIdx(bookmark.spine_index);
        ipc
          .saveProgress(bookId, bookmark.spine_index, bookmark.scroll_y)
          .catch(() => {});
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const ch = await ipc.readBookChapter(path, bookmark.spine_index);
        setChapters([ch]);
        chapterEls.current.clear();
        setActiveIdx(bookmark.spine_index);
        ipc
          .saveProgress(bookId, bookmark.spine_index, bookmark.scroll_y)
          .catch(() => {});
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (isPagedMode) {
              scrollRef.current?.scrollTo({
                left: Math.max(0, bookmark.scroll_y),
                top: 0,
                behavior: "smooth",
              });
            } else {
              scrollRef.current?.scrollTo({
                top: Math.max(0, bookmark.scroll_y),
                left: 0,
                behavior: "smooth",
              });
            }
          });
        });
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [bookId, isPagedMode, path],
  );

  async function deleteBookmark(bookmark: Bookmark) {
    if (!window.confirm("删除这条书签？")) return;
    try {
      await ipc.deleteBookmark(bookmark.id);
      // B2: hook 内部不暴露 setBookmarks——删完直接 refresh（本地 DB，微秒级）
      await refreshBookmarks();
    } catch (e) {
      setBookmarkStatus(`书签删除失败：${String(e)}`);
      window.setTimeout(() => setBookmarkStatus(null), 1800);
    }
  }

  const registerChapterEl = useCallback(
    (idx: number, el: HTMLElement | null) => {
      if (el) chapterEls.current.set(idx, el);
      else chapterEls.current.delete(idx);
    },
    [],
  );

  // B2: extractCurrentEntities 抽到 useChapterEntities.fetchEntitiesForCurrentChapter

  // 改进 1: 把整本书已抽取的实体按章组装成 MD 下载. 每章一个 ##, 人物/地点分组.
  // 只导出已经在 entitiesBySpine 里有的章节 (用户主动跑过"提取本章"的那些).
  function exportEntitiesMarkdown() {
    const spineKeys = Object.keys(entitiesBySpine)
      .map((k) => Number(k))
      .filter((k) => Number.isFinite(k) && (entitiesBySpine[k]?.length ?? 0) > 0)
      .sort((a, b) => a - b);
    if (spineKeys.length === 0) return;
    const bookTitle =
      chapters[0]?.title ?? toc.find((t) => t.spine_index === 0)?.label ?? "未知书";
    const bookAuthor = chapters[0]?.author ?? "";
    const lines: string[] = [];
    lines.push(`# 《${bookTitle}》全书实体`);
    if (bookAuthor && bookAuthor !== "Unknown") {
      lines.push(`> ${bookAuthor}`);
    }
    lines.push(
      `> 共 ${spineKeys.length} 个章节, ${spineKeys.reduce(
        (acc, k) => acc + (entitiesBySpine[k]?.length ?? 0),
        0,
      )} 个实体 · 导出于 ${new Date().toLocaleString("zh-CN")}`,
    );
    lines.push("");
    for (const spine of spineKeys) {
      const list = entitiesBySpine[spine] ?? [];
      if (list.length === 0) continue;
      const label =
        toc.find((t) => t.spine_index === spine)?.label ?? `第 ${spine + 1} 章`;
      lines.push(`## ${label}`);
      lines.push("");
      const people = list.filter((e) => e.kind === "person");
      const places = list.filter((e) => e.kind !== "person");
      if (people.length > 0) {
        lines.push(`### 人物 · ${people.length}`);
        lines.push("");
        for (const e of people) {
          lines.push(`- **${e.name}** — ${e.summary}`);
        }
        lines.push("");
      }
      if (places.length > 0) {
        lines.push(`### 地点 · ${places.length}`);
        lines.push("");
        for (const e of places) {
          lines.push(`- **${e.name}** — ${e.summary}`);
        }
        lines.push("");
      }
    }
    const safeTitle = bookTitle.replace(/[<>:"/\\|?*]/g, "_");
    const blob = new Blob([lines.join("\n")], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeTitle}-实体.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function addBookmark() {
    if (!currentChapter) return;
    const scrollY = isPagedMode
      ? (scrollRef.current?.scrollLeft ?? 0)
      : (scrollRef.current?.scrollTop ?? 0);
    const label = currentChapterLabel;
    const excerpt = htmlToText(currentChapter.html).slice(0, 120);
    setBookmarkStatus("保存中...");
    try {
      await ipc.createBookmark({
        bookId,
        spineIndex: activeIdx,
        scrollY,
        label,
        excerpt,
      });
      if (bookmarksOpen) refreshBookmarks();
      setBookmarkStatus("已加入书签");
      window.setTimeout(() => setBookmarkStatus(null), 1600);
    } catch (e) {
      setBookmarkStatus(`书签保存失败：${String(e)}`);
    }
  }

  function selectEntity(entity: EntityWithKey) {
    setActiveEntityKey(entity.key);
    const chapterEl = chapterEls.current.get(activeIdx);
    const first = chapterEl?.querySelector(
      `.ai-entity[data-entity-key="${cssEscape(entity.key)}"]`,
    ) as HTMLElement | null;
    if (first && scrollRef.current) {
      const cr = scrollRef.current.getBoundingClientRect();
      const er = first.getBoundingClientRect();
      if (isPagedMode) {
        const offset = er.left - cr.left + scrollRef.current.scrollLeft - 40;
        scrollRef.current.scrollTo({ left: offset, top: 0, behavior: "smooth" });
      } else {
        const offset = er.top - cr.top + scrollRef.current.scrollTop - 120;
        scrollRef.current.scrollTo({ top: offset, behavior: "smooth" });
      }
    }
  }

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
      ...(isPagedMode
        ? {
            columnWidth: `${pagedWidth}px`,
            maxWidth: "none",
          }
        : {
            maxWidth: `${settings.column_width}em`,
          }),
    }),
    [isPagedMode, pagedWidth, settings],
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
        <button onClick={onBack} className="studio-button">
          返回书架
        </button>
      </div>
    );
  }

  const head = chapters[0];

  return (
    <div className="app-frame relative flex flex-col">
      <header className="studio-header reader-header flex items-center justify-between">
        <div className="reader-header-title min-w-0">
          <h2 className="studio-title text-lg leading-tight truncate">
            {head?.title}
          </h2>
          <p className="text-xs studio-subtle truncate mt-0.5 tracking-wide">
            {head?.author || "未知作者"}
          </p>
        </div>
        <div className="reader-toolbar text-xs">
          <div className="reader-toolbar-group">
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
              onClick={addBookmark}
              className="studio-ghost"
              title="保存当前阅读位置"
            >
              书签
            </button>
            <button
              onClick={() => setBookmarksOpen(true)}
              className={`studio-ghost ${
                bookmarksOpen ? "studio-ghost-active" : ""
              }`}
              title="查看当前书的书签"
            >
              书签列表{bookmarks.length > 0 ? ` · ${bookmarks.length}` : ""}
            </button>
            <button
              onClick={() => setSearchOpen(true)}
              className="studio-ghost"
              title="本书内查找 (Ctrl+F)"
            >
              查找
            </button>
            <button onClick={() => setChatOpen(true)} className="studio-ghost">
              问 AI
            </button>
            <button
              onClick={() => setMusicSuggestOpen(true)}
              className="studio-ghost"
            >
              AI 配乐
            </button>
            <button
              onClick={() => setEntitiesOpen((v) => !v)}
              className={`studio-ghost ${
                entitiesOpen ? "studio-ghost-active" : ""
              }`}
            >
              实体
              {currentEntities.length > 0 ? ` · ${currentEntities.length}` : ""}
            </button>
          </div>
          <div className="reader-toolbar-group">
            <span className="studio-chip reader-page-control tabular-nums">
              第 {activeIdx + 1} / {total} 章
            </span>
            <button
              onClick={isPagedMode ? goToPrevPage : loadPrev}
              disabled={
                loadingPrev ||
                (isPagedMode
                  ? activeIdx <= 0 && pageOffset <= 8
                  : (chapters[0]?.spine_index ?? 0) <= 0)
              }
              className="studio-button disabled:opacity-30 disabled:cursor-not-allowed"
              title={isPagedMode ? "上一页" : "加载上一章"}
            >
              {loadingPrev ? "..." : isPagedMode ? "← 上一页" : "↑ 上一章"}
            </button>
            {isPagedMode && (
              <button
                onClick={goToNextPage}
                disabled={
                  loadingMore ||
                  (activeIdx >= total - 1 && pageOffset >= pageMaxOffset - 8)
                }
                className="studio-button disabled:opacity-30 disabled:cursor-not-allowed"
                title="下一页"
              >
                {loadingMore ? "..." : "下一页 →"}
              </button>
            )}
          </div>
          <div className="reader-toolbar-group">
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
            <button onClick={onBack} className="studio-button">
              {backLabel}
            </button>
          </div>
        </div>
      </header>

      {bookmarkStatus && (
        <div className="absolute right-6 top-20 z-40 rounded border border-[var(--color-paper-edge)] bg-[var(--color-paper)] px-3 py-2 text-xs text-[var(--color-accent)] shadow-sm">
          {bookmarkStatus}
        </div>
      )}

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
        {bookmarksOpen && (
          <BookmarksPanel
            bookmarks={bookmarks}
            toc={toc}
            loading={bookmarksLoading}
            onJump={jumpToBookmark}
            onDelete={deleteBookmark}
            onClose={() => setBookmarksOpen(false)}
          />
        )}
        <div
          ref={scrollRef}
          className={`reader-page flex-1 ${
            isPagedMode ? "reader-page-paged" : "overflow-auto"
          }`}
        >
          <article
            className={`reading mx-auto px-10 md:px-16 py-16 ${
              settings.paragraph_indent ? "" : "indent-none"
            } ${isPagedMode ? "reading-paged" : ""}`}
            style={readingStyle}
          >
            {chapters.map((ch, i) => (
              <ChapterBlock
                key={ch.spine_index}
                chapter={ch}
                showDivider={i > 0}
                highlights={highlightsForChapter.get(ch.spine_index) ?? []}
                entities={entitiesBySpine[ch.spine_index] ?? []}
                activeEntityKey={activeEntityKey}
                registerRef={registerChapterEl}
              />
            ))}
            {!isPagedMode && <div ref={sentinelRef} className="h-2" />}
            {!isPagedMode && loadingMore && (
              <div className="text-center py-8 text-sm text-[var(--color-muted)] tracking-wider">
                加载下一章...
              </div>
            )}
            {!isPagedMode && atLast && !loadingMore && (
              <div className="text-center py-16 text-xs text-[var(--color-muted)] tracking-[0.5em]">
                完
              </div>
            )}
          </article>
        </div>
        {entitiesOpen && (
          <ChapterEntitiesPanel
            chapterLabel={currentChapterLabel}
            aiConfigured={aiConfigured}
            entities={currentEntities}
            loading={entitiesLoading}
            error={entitiesError}
            activeKey={activeEntityKey}
            onExtract={fetchEntitiesForCurrentChapter}
            onSelect={selectEntity}
            onOpenSettings={onOpenAiSettings}
            onClose={() => setEntitiesOpen(false)}
            onExportAll={exportEntitiesMarkdown}
            totalExtractedChapters={
              Object.values(entitiesBySpine).filter((arr) => arr && arr.length > 0).length
            }
          />
        )}
      </div>

      {/* Chapter progress strip + 翻页按钮 (分页模式) — 改进 3 把翻页放到正文下方,
          手指/鼠标不用跨屏到 header */}
      {total > 0 && (
        <div className="flex-shrink-0 px-6 py-1.5 border-t border-[var(--color-paper-edge)] bg-[var(--color-paper-soft)]/60 flex items-center gap-3">
          {isPagedMode && (
            <button
              onClick={goToPrevPage}
              disabled={
                loadingPrev ||
                (activeIdx <= 0 && pageOffset <= 8)
              }
              className="studio-button px-3 py-0.5 text-xs disabled:opacity-30 disabled:cursor-not-allowed"
              title="上一页"
            >
              ← 上一页
            </button>
          )}
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
          {isPagedMode && (
            <button
              onClick={goToNextPage}
              disabled={
                loadingMore ||
                (activeIdx >= total - 1 && pageOffset >= pageMaxOffset - 8)
              }
              className="studio-button px-3 py-0.5 text-xs disabled:opacity-30 disabled:cursor-not-allowed"
              title="下一页"
            >
              下一页 →
            </button>
          )}
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
            问 AI
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
          onHighlightCreated={(hl) => setAllHighlights((prev) => [...prev, hl])}
          aiConfigured={
            aiSettings.base_url.trim() !== "" &&
            aiSettings.api_key.trim() !== "" &&
            aiSettings.chat_model.trim() !== ""
          }
          onOpenSettings={() => {
            setLookupSel(null);
            onOpenAiSettings();
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
            onOpenAiSettings();
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
  entities: EntityWithKey[];
  activeEntityKey: string | null;
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

// B2: normalizeEntities 已移到 entityUnderlines.ts，被 useChapterEntities 复用

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function getPagedStep(root: HTMLElement): number {
  const article = root.querySelector(".reading-paged");
  const gap = article ? Number.parseFloat(getComputedStyle(article).columnGap) : 0;
  return Math.max(320, root.clientWidth + (Number.isFinite(gap) ? gap : 0));
}

const ChapterBlock = memo(function ChapterBlock({
  chapter,
  showDivider,
  highlights,
  entities,
  activeEntityKey,
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
    if (!ref.current) return;
    applyHighlights(ref.current, highlights);
    applyEntityUnderlines(ref.current, entities, activeEntityKey);
  }, [chapter.html, highlights, entities, activeEntityKey]);

  return (
    <section ref={onRef} data-spine={chapter.spine_index}>
      {showDivider && (
        <div className="text-center my-12 text-[var(--color-muted)] tracking-[0.5em]">
          ...
        </div>
      )}
      <div dangerouslySetInnerHTML={{ __html: chapter.html }} />
    </section>
  );
});
