import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Document, Page, pdfjs } from "react-pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  DEFAULT_READER_SETTINGS,
  ipc,
  loadReaderSettings,
  saveReaderSettings,
  type Bookmark,
  type Highlight,
  type AiSettings,
  type ReaderSettings,
  type TocEntry,
} from "@/lib/ipc";
import { TocPanel } from "./TocPanel";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { HighlightPopover } from "./HighlightPopover";
import { LookupBubble } from "./LookupBubble";
import { MusicSuggestPanel } from "./MusicSuggestPanel";
import { useReadTimeHeartbeat } from "./useReadTimeHeartbeat";
import { ReaderSettingsPanel } from "./ReaderSettings";
import { ChatPanel } from "./ChatPanel";
import { captureSelection } from "./highlight";
import { BookSearch } from "./BookSearch";
import { BookmarksPanel } from "./BookmarksPanel";
import { BookRating } from "@/features/library/BookRating";

// Bundle the pdf.js worker via Vite's URL resolution so it ships with the app
// in both dev and production builds.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

type Props = {
  path: string;
  bookId: number;
  aiSettings: AiSettings;
  onOpenAiSettings: () => void;
  onOpenHelp: () => void;
  bookRating?: number | null;
  onRateBook: (rating: number | null) => void;
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

type PendingSelection = {
  rect: DOMRect;
  selectedText: string;
  prefix: string;
  suffix: string;
};

type ActiveHighlight = { hl: Highlight; rect: DOMRect };

type HighlightRect = {
  hlId: number;
  color: string;
  top: number;
  left: number;
  width: number;
  height: number;
};

export function PdfView({
  path,
  bookId,
  aiSettings,
  onOpenAiSettings,
  onOpenHelp,
  bookRating,
  onRateBook,
  onBack,
  backLabel = "返回书架",
  initialSpine,
  initialScrollY,
  initialHighlightId,
}: Props) {
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNum, setPageNum] = useState<number>(1);
  const [pageInput, setPageInput] = useState<string>("1");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [containerSize, setContainerSize] = useState({ w: 800, h: 600 });
  const [pageDims, setPageDims] = useState<{ w: number; h: number } | null>(
    null,
  );
  const [displayMode, setDisplayMode] = useState<
    "fit-width" | "fit-page" | "custom"
  >("fit-width");
  const [textMode, setTextMode] = useState(false);
  const [pageText, setPageText] = useState("");
  const [pageTextLoading, setPageTextLoading] = useState(false);
  const [customScale, setCustomScale] = useState(1.0);
  const [fullscreen, setFullscreen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [bookmarksLoading, setBookmarksLoading] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [companionOpen, setCompanionOpen] = useState(false);
  const [bookmarkStatus, setBookmarkStatus] = useState<string | null>(null);

  // Ctrl/Cmd+F opens the in-book search bar (current page only; pdf.js
  // doesn't expose a way to text-search across un-rendered pages without
  // a heavier integration). Capture phase so WebView2's native find
  // toolbar doesn't get the event first.
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
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocLoading, setTocLoading] = useState(true);
  const [settings, setSettings] = useState<ReaderSettings>(
    DEFAULT_READER_SETTINGS,
  );

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [musicSuggestOpen, setMusicSuggestOpen] = useState(false);
  const [musicChapterText, setMusicChapterText] = useState("");
  const [lookupSel, setLookupSel] = useState<{
    text: string;
    rect: DOMRect;
    spineIdx: number;
    prefix: string;
    suffix: string;
  } | null>(null);

  // Annotation state paralleling EpubView
  const [allHighlights, setAllHighlights] = useState<Highlight[]>([]);
  const [pendingSel, setPendingSel] = useState<PendingSelection | null>(null);
  const [activeHl, setActiveHl] = useState<ActiveHighlight | null>(null);
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const [highlightRects, setHighlightRects] = useState<HighlightRect[]>([]);
  const [pendingFlashId, setPendingFlashId] = useState<number | null>(
    initialHighlightId ?? null,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const pageWrapRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const initialApplied = useRef(false);
  const pendingInitialScroll = useRef<number | null>(initialScrollY ?? null);

  // Bank reading time while this view is open
  useReadTimeHeartbeat(bookId);

  // Theme + persistence (shared with EpubView via reader_settings)
  useEffect(() => {
    document.body.setAttribute("data-theme", settings.theme);
    return () => {
      document.body.removeAttribute("data-theme");
    };
  }, [settings.theme]);

  useEffect(() => {
    loadReaderSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      saveReaderSettings(settings).catch(() => {});
    }, 200);
    return () => window.clearTimeout(t);
  }, [settings]);

  async function refreshBookmarks() {
    setBookmarksLoading(true);
    try {
      setBookmarks(await ipc.listBookmarksByBook(bookId));
    } catch {
      setBookmarks([]);
    } finally {
      setBookmarksLoading(false);
    }
  }

  useEffect(() => {
    if (bookmarksOpen) {
      refreshBookmarks();
    }
  }, [bookmarksOpen, bookId]);

  // Load all highlights for this book
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

  const fileSrc = useMemo(() => {
    try {
      return convertFileSrc(path);
    } catch {
      return path;
    }
  }, [path]);
  const fileName = useMemo(() => path.split(/[\\/]/).pop() ?? path, [path]);

  // pdf.js needs CMap tables for CJK PDFs that don't embed fonts, and
  // standard_fonts as a fallback. We copy these from pdfjs-dist into the
  // copy with scripts/copy-pdfjs-assets.mjs and reference them here. Must be
  // memoized; react-pdf reloads the document if `options` identity
  // changes.
  const pdfOptions = useMemo(
    () => ({
      cMapUrl: "/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/standard_fonts/",
      // Let pdf.js use Windows system CJK fonts (SimSun / Microsoft YaHei) as
      // fallback when a PDF references non-embedded CJK fonts.
      useSystemFonts: true,
      // Some Chinese PDFs use very old encoding tricks; eval-based font
      // rasterization helps pdf.js handle Type3 / synthesized fonts.
      isEvalSupported: true,
    }),
    [],
  );

  // Restore progress (or use caller-supplied initial page)
  useEffect(() => {
    if (initialApplied.current) return;
    if (initialSpine !== undefined) {
      const p = initialSpine + 1;
      setPageNum(p);
      setPageInput(String(p));
      pendingInitialScroll.current = initialScrollY ?? 0;
      initialApplied.current = true;
      return;
    }
    ipc
      .getProgress(bookId)
      .then((p) => {
        if (p) {
          const n = p.spine_index + 1;
          setPageNum(n);
          setPageInput(String(n));
        }
      })
      .catch(() => {})
      .finally(() => {
        initialApplied.current = true;
      });
  }, [bookId, initialSpine, initialScrollY]);

  useEffect(() => {
    const y = pendingInitialScroll.current;
    if (y == null || numPages === 0) return;
    pendingInitialScroll.current = null;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        containerRef.current?.scrollTo({ top: Math.max(0, y) });
      });
    });
  }, [numPages, pageNum]);

  // Save progress on page change
  useEffect(() => {
    if (numPages === 0) return;
    ipc.saveProgress(bookId, pageNum - 1, 0).catch(() => {});
  }, [bookId, pageNum, numPages]);

  // Track container size (driving fit-mode calculations)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setContainerSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Derive the actual <Page width=...> from mode + container size + page
  // natural dimensions.
  const width = useMemo(() => {
    const cw = Math.max(320, containerSize.w - 64);
    const ch = Math.max(400, containerSize.h - 16);
    switch (displayMode) {
      case "fit-page":
        if (!pageDims) return Math.min(900, cw);
        return Math.min(cw, (pageDims.w * ch) / pageDims.h);
      case "custom":
        return Math.min(cw * 2, Math.max(200, cw * customScale));
      case "fit-width":
      default:
        return Math.min(1200, cw);
    }
  }, [containerSize, displayMode, customScale, pageDims]);

  const actualScalePct = useMemo(() => {
    if (!pageDims) return null;
    return Math.round((width / pageDims.w) * 100);
  }, [width, pageDims]);

  const readingStyle = useMemo<CSSProperties>(
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

  useEffect(() => {
    if (!textMode || numPages === 0) return;
    let cancelled = false;
    setPageTextLoading(true);
    ipc
      .readPdfPageText(path, pageNum - 1)
      .then((text) => {
        if (!cancelled) setPageText(text);
      })
      .catch((e) => {
        if (!cancelled) setPageText(`PDF 文本解析失败：${String(e)}`);
      })
      .finally(() => {
        if (!cancelled) setPageTextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [textMode, path, pageNum, numPages]);

  function zoomIn() {
    if (displayMode !== "custom") {
      // Lock the current effective scale as the starting customScale
      const cw = Math.max(320, containerSize.w - 64);
      const baseW = Math.min(1200, cw);
      setCustomScale(Math.min(3, (width / baseW) * 1.1));
    } else {
      setCustomScale((s) => Math.min(3, s * 1.1));
    }
    setDisplayMode("custom");
  }

  function zoomOut() {
    if (displayMode !== "custom") {
      const cw = Math.max(320, containerSize.w - 64);
      const baseW = Math.min(1200, cw);
      setCustomScale(Math.max(0.3, width / baseW / 1.1));
    } else {
      setCustomScale((s) => Math.max(0.3, s / 1.1));
    }
    setDisplayMode("custom");
  }

  async function toggleFullscreen() {
    try {
      const win = getCurrentWindow();
      const isFs = await win.isFullscreen();
      await win.setFullscreen(!isFs);
      setFullscreen(!isFs);
    } catch (e) {
      setError(String(e));
    }
  }

  // Keep fullscreen state in sync if user presses F11 etc.
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

  async function onLoadSuccess(pdf: PDFDocumentProxy) {
    setNumPages(pdf.numPages);
    setLoading(false);
    setError(null);
    setPageNum((p) => {
      const clamped = Math.min(Math.max(1, p), pdf.numPages);
      setPageInput(String(clamped));
      return clamped;
    });

    try {
      const outline = await pdf.getOutline();
      if (outline && outline.length > 0) {
        const entries: TocEntry[] = [];
        await walkOutline(pdf, outline, 0, entries);
        setToc(entries);
      } else {
        setToc([]);
      }
    } catch {
      setToc([]);
    } finally {
      setTocLoading(false);
    }
  }

  function onLoadError(err: Error) {
    setError(err.message || "Failed to load PDF");
    setLoading(false);
  }

  function goTo(n: number) {
    if (!Number.isInteger(n)) return;
    const clamped = Math.max(1, Math.min(numPages || 1, n));
    setPageNum(clamped);
    setPageInput(String(clamped));
    containerRef.current?.scrollTo({ top: 0 });
  }

  function commitPageInput() {
    const n = parseInt(pageInput, 10);
    if (Number.isInteger(n)) goTo(n);
    else setPageInput(String(pageNum));
  }

  async function addBookmark() {
    const textLayerText =
      pageWrapRef.current?.querySelector(".react-pdf__Page__textContent")
        ?.textContent ?? "";
    const label =
      toc.find((t) => t.spine_index === pageNum - 1)?.label ??
      `第 ${pageNum} 页`;
    const excerpt = (textMode ? pageText : textLayerText).trim().slice(0, 120);
    setBookmarkStatus("保存中...");
    try {
      await ipc.createBookmark({
        bookId,
        spineIndex: pageNum - 1,
        scrollY: containerRef.current?.scrollTop ?? 0,
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

  function jumpToBookmark(bookmark: Bookmark) {
    setBookmarksOpen(false);
    goTo(bookmark.spine_index + 1);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        containerRef.current?.scrollTo({
          top: Math.max(0, bookmark.scroll_y),
          behavior: "smooth",
        });
      });
    });
  }

  async function deleteBookmark(bookmark: Bookmark) {
    if (!window.confirm("删除这条书签？")) return;
    try {
      await ipc.deleteBookmark(bookmark.id);
      setBookmarks((prev) => prev.filter((item) => item.id !== bookmark.id));
    } catch (e) {
      setBookmarkStatus(`书签删除失败：${String(e)}`);
      window.setTimeout(() => setBookmarkStatus(null), 1800);
    }
  }

  // Keyboard nav
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === "ArrowLeft") goTo(pageNum - 1);
      else if (e.key === "ArrowRight") goTo(pageNum + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum, numPages]);

  // Mouse-wheel pagination. When the user is at the page's scroll
  // boundary (top or bottom) and continues to wheel in the same
  // direction, flip to the prev/next page. While scrolling within a
  // long page, wheel behaves normally.
  //
  // Throttled to one flip per 350ms; without this, a long trackpad
  // gesture would jump 5+ pages at once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let lastFlip = 0;
    const COOLDOWN_MS = 350;
    const EDGE_SLOP = 4; // px tolerance when comparing scrollTop to bounds

    function onWheel(e: WheelEvent) {
      if (!el) return;
      // Ignore zoom (ctrl+wheel); that's a future feature, don't hijack
      if (e.ctrlKey) return;
      const dy = e.deltaY;
      if (Math.abs(dy) < 1) return;

      const atTop = el.scrollTop <= EDGE_SLOP;
      const atBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - EDGE_SLOP;

      const now = Date.now();
      if (now - lastFlip < COOLDOWN_MS) {
        // During cooldown still consume the event when at edge so the
        // page doesn't bounce / scroll past the boundary.
        if ((dy > 0 && atBottom) || (dy < 0 && atTop)) {
          e.preventDefault();
        }
        return;
      }

      if (dy > 0 && atBottom && pageNum < (numPages || 1)) {
        e.preventDefault();
        lastFlip = now;
        goTo(pageNum + 1);
      } else if (dy < 0 && atTop && pageNum > 1) {
        e.preventDefault();
        lastFlip = now;
        goTo(pageNum - 1);
        // After going back, jump to the bottom of the new page so the
        // reading rhythm is "page-by-page" not "page+ghost-top".
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    }

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum, numPages]);

  // Compute highlight rects for the current page after each render and
  // whenever the highlights list changes.
  function recomputeRects() {
    const wrap = pageWrapRef.current;
    if (!wrap) {
      setHighlightRects([]);
      return;
    }
    const textLayer = wrap.querySelector(
      ".react-pdf__Page__textContent",
    ) as HTMLElement | null;
    if (!textLayer || textLayer.children.length === 0) {
      setHighlightRects([]);
      return;
    }
    const fullText = textLayer.textContent ?? "";
    const wrapRect = wrap.getBoundingClientRect();
    const rects: HighlightRect[] = [];
    const hlsForPage = allHighlights.filter(
      (h) => h.spine_index === pageNum - 1,
    );

    for (const hl of hlsForPage) {
      const located = locateHighlight(fullText, hl);
      if (!located) continue;
      const range = rangeFromOffsets(textLayer, located.start, located.end);
      if (!range) continue;
      const clientRects = range.getClientRects();
      for (let i = 0; i < clientRects.length; i++) {
        const r = clientRects[i];
        if (r.width === 0 && r.height === 0) continue;
        rects.push({
          hlId: hl.id,
          color: hl.color,
          top: r.top - wrapRect.top,
          left: r.left - wrapRect.left,
          width: r.width,
          height: r.height,
        });
      }
    }
    setHighlightRects(rects);
  }

  // Trigger recomputation when page renders or highlights change. Poll
  // briefly because text layer renders async after canvas.
  // Wait for the text layer to settle (children stable for ~80ms) then
  // run a final compute. pdf.js streams spans in over multiple frames so
  // a one-shot compute can miss late arrivals.
  function waitForTextLayerAndApply() {
    let attempts = 0;
    let lastChildCount = -1;
    let stableFrames = 0;
    const tryApply = () => {
      const tl = pageWrapRef.current?.querySelector(
        ".react-pdf__Page__textContent",
      );
      if (!tl || tl.children.length === 0) {
        if (++attempts < 240) requestAnimationFrame(tryApply);
        return;
      }
      if (tl.children.length === lastChildCount) {
        if (++stableFrames >= 5) {
          recomputeRects();
          // Schedule one more pass shortly after to catch any final
          // characterData mutations inside existing spans
          window.setTimeout(() => recomputeRects(), 300);
          return;
        }
      } else {
        lastChildCount = tl.children.length;
        stableFrames = 0;
      }
      if (++attempts < 240) requestAnimationFrame(tryApply);
    };
    requestAnimationFrame(tryApply);
  }

  // Clear stale rects immediately on page change so they don't briefly
  // appear at wrong positions over the new page while the text layer
  // re-renders.
  useEffect(() => {
    setHighlightRects([]);
  }, [pageNum, width]);

  // Recompute when content or layout changes (polls for text layer ready).
  useEffect(() => {
    waitForTextLayerAndApply();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allHighlights, pageNum, width]);

  // Selection on PDF text layer
  useEffect(() => {
    function onMouseUp() {
      window.setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
          setPendingSel(null);
          return;
        }
        const range = sel.getRangeAt(0);
        // Selection must live inside the text layer
        let node: Node | null = range.commonAncestorContainer;
        let textLayer: HTMLElement | null = null;
        while (node) {
          if (
            node instanceof HTMLElement &&
            node.classList.contains("react-pdf__Page__textContent")
          ) {
            textLayer = node;
            break;
          }
          node = node.parentNode;
        }
        if (!textLayer) {
          setPendingSel(null);
          return;
        }
        const cap = captureSelection(textLayer);
        if (!cap) {
          setPendingSel(null);
          return;
        }
        setPendingSel({
          rect: cap.rect,
          selectedText: cap.selectedText,
          prefix: cap.prefix,
          suffix: cap.suffix,
        });
      }, 10);
    }
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, []);

  // Dismiss floating toolbar on outside mousedown
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (toolbarRef.current && toolbarRef.current.contains(target)) return;
      setPendingSel(null);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  // Click on a highlight rect to open popover. We detect clicks via
  // hit-testing rather than putting pointer-events on the rects, so text
  // selection can still happen on top of marked passages.
  useEffect(() => {
    const wrap = pageWrapRef.current;
    if (!wrap) return;
    function onClick(e: MouseEvent) {
      if (highlightRects.length === 0) return;
      const wrap = pageWrapRef.current!;
      const wr = wrap.getBoundingClientRect();
      const x = e.clientX - wr.left;
      const y = e.clientY - wr.top;
      const hit = highlightRects.find(
        (r) =>
          x >= r.left &&
          x <= r.left + r.width &&
          y >= r.top &&
          y <= r.top + r.height,
      );
      if (!hit) return;
      const hl = allHighlights.find((h) => h.id === hit.hlId);
      if (!hl) return;
      // Convert rect to viewport coords for the popover
      const rect = new DOMRect(
        wr.left + hit.left,
        wr.top + hit.top,
        hit.width,
        hit.height,
      );
      setActiveHl({ hl, rect });
      e.preventDefault();
      e.stopPropagation();
    }
    wrap.addEventListener("click", onClick);
    return () => wrap.removeEventListener("click", onClick);
  }, [highlightRects, allHighlights]);

  async function commitHighlight(color: HighlightColor) {
    if (!pendingSel) return;
    try {
      const hl = await ipc.createHighlight({
        bookId,
        spineIndex: pageNum - 1,
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

  // Flash a queued highlight (from notes view or AnnotationsPanel jump)
  // once its rect is rendered on the current page. One-shot: clears the
  // pending id after firing so navigating pages later won't re-flash.
  useEffect(() => {
    if (pendingFlashId === null) return;
    if (highlightRects.length === 0) return;
    const target = highlightRects.find((r) => r.hlId === pendingFlashId);
    if (!target) return;
    const wrap = pageWrapRef.current;
    const container = containerRef.current;
    if (!wrap || !container) return;
    const wr = wrap.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    const targetTopInContainer =
      wr.top - cr.top + target.top - 80 + container.scrollTop;
    container.scrollTo({ top: targetTopInContainer, behavior: "smooth" });
    const flashTarget = pendingFlashId;
    setPendingFlashId(null);
    window.setTimeout(() => {
      const el = wrap.querySelector(
        `[data-hl-id="${flashTarget}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.classList.add("ai-hl-flash");
        window.setTimeout(() => el.classList.remove("ai-hl-flash"), 1500);
      }
    }, 200);
  }, [highlightRects, pendingFlashId]);

  return (
    <div className="app-frame relative flex flex-col">
      <header className="studio-header reader-header reader-header-quiet flex items-center justify-between">
        <div className="reader-header-title min-w-0">
          <h2 className="studio-title text-lg leading-tight truncate">
            {fileName}
          </h2>
          <p className="text-xs studio-subtle mt-0.5 tracking-[0.2em] uppercase">
            PDF
          </p>
        </div>
        <div className="reader-toolbar text-xs">
          <div className="reader-toolbar-group">
            <button onClick={onBack} className="studio-ghost">
              {backLabel}
            </button>
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
              onClick={() => setSearchOpen(true)}
              className="studio-ghost"
              title="本页内查找 (Ctrl+F)"
            >
              查找
            </button>
            <button
              onClick={() => setBookmarksOpen(true)}
              className={`studio-ghost ${
                bookmarksOpen ? "studio-ghost-active" : ""
              }`}
              title="书签列表"
            >
              书签{bookmarks.length > 0 ? ` ${bookmarks.length}` : ""}
            </button>
            <button onClick={() => setChatOpen(true)} className="studio-ghost">
              问 AI
            </button>
            <button
              onClick={() => setCompanionOpen((v) => !v)}
              className={`studio-button ${
                companionOpen ? "studio-button-primary" : ""
              }`}
            >
              AI 伴读
            </button>
          </div>
          <div className="reader-toolbar-group">
            <BookRating
              value={bookRating}
              onChange={onRateBook}
              size="sm"
              label="给当前书评分"
            />
            <span className="studio-chip reader-page-control tabular-nums">
              页
              <input
                type="text"
                inputMode="numeric"
                value={pageInput}
                onChange={(e) =>
                  setPageInput(e.target.value.replace(/[^\d]/g, ""))
                }
                onBlur={commitPageInput}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitPageInput();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                className="reader-page-input mx-1 tabular-nums"
              />
              / {numPages || "-"}
            </span>
            <button
              onClick={() => setTextMode((v) => !v)}
              className={`studio-ghost ${textMode ? "studio-ghost-active" : ""}`}
              title="切换 PDF 文本模式"
            >
              文本
            </button>
            <button
              onClick={zoomOut}
              className="studio-icon-button"
              aria-label="缩小"
              title="缩小"
            >
              −
            </button>
            <span className="tabular-nums text-[10px] min-w-[3em] text-center">
              {actualScalePct != null ? `${actualScalePct}%` : "-"}
            </span>
            <button
              onClick={zoomIn}
              className="studio-icon-button"
              aria-label="放大"
              title="放大"
            >
              +
            </button>
            <button
              onClick={() => {
                setDisplayMode("fit-width");
                setCustomScale(1.0);
              }}
              className={`studio-ghost ${
                displayMode === "fit-width" ? "studio-ghost-active" : ""
              }`}
              title="按宽度适应"
            >
              整宽
            </button>
            <button
              onClick={() => {
                setDisplayMode("fit-page");
                setCustomScale(1.0);
              }}
              className={`studio-ghost ${
                displayMode === "fit-page" ? "studio-ghost-active" : ""
              }`}
              title="整页适应"
            >
              整页
            </button>
            <button
              onClick={toggleFullscreen}
              className={`studio-ghost ${fullscreen ? "studio-ghost-active" : ""}`}
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
            activeSpineIndex={pageNum - 1}
            loading={tocLoading}
            onJump={(idx) => goTo(idx + 1)}
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
          ref={containerRef}
          className="reader-page flex-1 overflow-auto flex flex-col items-center py-8 px-4"
        >
          {loading && (
            <div className="text-sm text-[var(--color-muted)] mt-12 tracking-widest">
              加载 PDF...
            </div>
          )}
          {error && (
            <div className="text-sm text-red-600 max-w-xl text-center mt-12">
              {error}
            </div>
          )}
          <Document
            file={fileSrc}
            options={pdfOptions}
            onLoadSuccess={onLoadSuccess}
            onLoadError={onLoadError}
            loading=""
            error=""
          >
            {numPages > 0 && textMode && (
              <article
                className={`reading mx-auto px-10 md:px-16 py-14 studio-panel whitespace-pre-wrap ${
                  settings.paragraph_indent ? "" : "indent-none"
                }`}
                style={readingStyle}
              >
                {pageTextLoading
                  ? "正在解析本页文本..."
                  : pageText || "这一页没有可提取的文本。"}
              </article>
            )}
            {numPages > 0 && !textMode && (
              <div
                ref={pageWrapRef}
                className="relative shadow-lg rounded-sm overflow-hidden bg-white"
              >
                <Page
                  pageNumber={pageNum}
                  width={width}
                  renderAnnotationLayer={false}
                  renderTextLayer={true}
                  onLoadSuccess={(page) => {
                    try {
                      const vp = page.getViewport({ scale: 1 });
                      setPageDims({ w: vp.width, h: vp.height });
                    } catch {
                      // ignore
                    }
                  }}
                  onRenderSuccess={() => waitForTextLayerAndApply()}
                />
                {/* Highlight overlays: pointer-events none so text selection
                    works through them. Clicks are handled via hit-testing
                    on the wrapping div (see useEffect). */}
                {highlightRects.map((r, i) => (
                  <div
                    key={`${r.hlId}-${i}`}
                    data-hl-id={r.hlId}
                    className={`ai-hl-rect ai-hl-rect-${r.color}`}
                    style={{
                      position: "absolute",
                      top: r.top,
                      left: r.left,
                      width: r.width,
                      height: r.height,
                    }}
                  />
                ))}
              </div>
            )}
          </Document>
        </div>
        {companionOpen && (
          <aside className="companion-panel">
            <div className="companion-panel-head">
              <div>
                <h3 className="studio-title text-lg">AI 伴读</h3>
                <p className="text-xs studio-subtle mt-1">
                  第 {pageNum} 页 / 共 {numPages || "-"} 页
                </p>
              </div>
              <button
                onClick={() => setCompanionOpen(false)}
                className="studio-icon-button"
                aria-label="关闭 AI 伴读"
              >
                x
              </button>
            </div>
            <div className="studio-segmented grid-cols-3 mb-4">
              <button className="studio-segment studio-segment-active">
                当前页
              </button>
              <button onClick={() => setChatOpen(true)} className="studio-segment">
                整本书
              </button>
              <button onClick={() => setChatOpen(true)} className="studio-segment">
                全书库
              </button>
            </div>
            <div className="companion-section">
              <div className="companion-section-title">快速操作</div>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setChatOpen(true)} className="studio-button">
                  问 AI
                </button>
                <button onClick={addBookmark} className="studio-button">
                  保存书签
                </button>
                <button
                  onClick={() => setAnnotationsOpen(true)}
                  className="studio-button"
                >
                  标注 {allHighlights.length}
                </button>
                <button
                  onClick={() => setBookmarksOpen(true)}
                  className="studio-button"
                >
                  书签 {bookmarks.length}
                </button>
                <button
                  onClick={() => {
                    const tl = pageWrapRef.current?.querySelector(
                      ".react-pdf__Page__textContent",
                    );
                    setMusicChapterText(
                      textMode ? pageText : (tl?.textContent ?? ""),
                    );
                    setMusicSuggestOpen(true);
                  }}
                  className="studio-button"
                >
                  AI 配乐
                </button>
                <button onClick={onOpenHelp} className="studio-button">
                  使用帮助
                </button>
              </div>
            </div>
            <div className="companion-section">
              <div className="companion-section-title">页面工具</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => goTo(pageNum - 1)}
                  disabled={pageNum <= 1}
                  className="studio-button disabled:opacity-30"
                >
                  上一页
                </button>
                <button
                  onClick={() => goTo(pageNum + 1)}
                  disabled={pageNum >= numPages}
                  className="studio-button disabled:opacity-30"
                >
                  下一页
                </button>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* Page progress strip matching EpubView's chapter strip. */}
      {numPages > 0 && (
        <div className="flex-shrink-0 px-6 py-1.5 border-t border-[var(--color-paper-edge)] bg-[var(--color-paper-soft)]/60 flex items-center gap-3">
          <span className="text-[10px] studio-subtle tracking-[0.1em] tabular-nums">
            第 {pageNum} 页 / 共 {numPages} 页
          </span>
          <div className="flex-1 h-1 bg-[var(--color-paper-edge)]/40 rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--color-accent)] transition-all"
              style={{
                width: `${Math.max(2, Math.min(100, (pageNum / numPages) * 100))}%`,
              }}
            />
          </div>
          <span className="text-[10px] studio-subtle tabular-nums w-10 text-right">
            {Math.round((pageNum / numPages) * 100)}%
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
                spineIdx: pageNum - 1,
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
          rootEl={containerRef.current}
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
          aiConfigured={true}
          onOpenSettings={() => setLookupSel(null)}
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

      {annotationsOpen && (
        <AnnotationsPanel
          bookId={bookId}
          bookTitle={fileName}
          bookAuthor=""
          highlights={allHighlights}
          toc={toc}
          onJump={(spineIdx, hlId) => {
            setAnnotationsOpen(false);
            setPendingFlashId(hlId);
            goTo(spineIdx + 1);
          }}
          onDelete={(hlId) => onHighlightDeleted(hlId)}
          onClose={() => setAnnotationsOpen(false)}
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
          bookTitle={fileName}
          chapterSpineIndex={pageNum - 1}
          chapterLabel={`第 ${pageNum} 页`}
          chapterText={
            textMode
              ? pageText
              : (pageWrapRef.current?.querySelector(
                  ".react-pdf__Page__textContent",
                )?.textContent ?? "")
          }
          aiConfigured={
            aiSettings.base_url.trim() !== "" &&
            aiSettings.api_key.trim() !== "" &&
            aiSettings.chat_model.trim() !== ""
          }
          onOpenSettings={onOpenAiSettings}
          onJumpToChapter={(spineIdx) => goTo(spineIdx + 1)}
          onClose={() => setChatOpen(false)}
        />
      )}

      {musicSuggestOpen && (
        <MusicSuggestPanel
          chapterLabel={
            toc.find((t) => t.spine_index === pageNum - 1)?.label ??
            `第 ${pageNum} 页`
          }
          chapterText={musicChapterText}
          onClose={() => setMusicSuggestOpen(false)}
        />
      )}
    </div>
  );
}

/** Walk a PDF outline tree (bookmarks), resolving each entry's destination
 * to a page index and flattening into a depth-tagged list for our TocPanel. */
async function walkOutline(
  pdf: PDFDocumentProxy,
  nodes: unknown[],
  depth: number,
  out: TocEntry[],
): Promise<void> {
  for (const raw of nodes) {
    const n = raw as {
      title?: string;
      dest?: unknown;
      items?: unknown[];
    };
    const title = (n.title ?? "").trim();
    let dest = n.dest;
    if (typeof dest === "string") {
      try {
        dest = await pdf.getDestination(dest);
      } catch {
        dest = null;
      }
    }
    let pageIndex = -1;
    if (Array.isArray(dest) && dest[0]) {
      try {
        pageIndex = await pdf.getPageIndex(dest[0]);
      } catch {
        pageIndex = -1;
      }
    }
    if (pageIndex >= 0 && title) {
      out.push({ spine_index: pageIndex, label: title, depth });
    }
    if (Array.isArray(n.items) && n.items.length > 0) {
      await walkOutline(pdf, n.items, depth + 1, out);
    }
  }
}

/**
 * Try to locate a highlight's text in `fullText` with progressive
 * fallbacks, returning character offsets [start, end) in the original
 * string. Handles cases where pdf.js text layer has subtly different
 * whitespace from the original capture.
 */
function locateHighlight(
  fullText: string,
  hl: { prefix: string; selected_text: string; suffix: string },
): { start: number; end: number } | null {
  // 1. Exact match of prefix + text + suffix (strongest, disambiguates
  //    when the same text appears multiple times).
  const target = hl.prefix + hl.selected_text + hl.suffix;
  let idx = fullText.indexOf(target);
  if (idx >= 0) {
    const start = idx + hl.prefix.length;
    return { start, end: start + hl.selected_text.length };
  }

  // 2. Bare selected_text exact match.
  idx = fullText.indexOf(hl.selected_text);
  if (idx >= 0) {
    return { start: idx, end: idx + hl.selected_text.length };
  }

  // 3. Whitespace-normalised match. pdf.js text layers sometimes insert
  //    extra spaces between spans or collapse whitespace differently from
  //    when the highlight was first captured.
  const haystackNorm = normalizeWs(fullText);
  const needleNorm = normalizeWs(hl.selected_text);
  if (needleNorm.length === 0) return null;
  const normIdx = haystackNorm.indexOf(needleNorm);
  if (normIdx < 0) return null;
  // Map normalised offset back to original-string offset by walking
  // chars and skipping collapsed whitespace.
  const start = mapNormToOriginal(fullText, normIdx);
  const end = mapNormToOriginal(fullText, normIdx + needleNorm.length);
  if (start < 0 || end < 0 || end <= start) return null;
  return { start, end };
}

/** Collapse runs of whitespace to a single space and trim. */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ");
}

/** Given a normalised-string offset, find the corresponding offset in
 * the original string by walking and skipping collapsed runs. */
function mapNormToOriginal(orig: string, normOffset: number): number {
  let seen = 0;
  let i = 0;
  while (i < orig.length) {
    if (seen === normOffset) return i;
    if (/\s/.test(orig[i])) {
      // Skip the whole run, counts as one normalized space
      while (i < orig.length && /\s/.test(orig[i])) i++;
      seen++;
    } else {
      i++;
      seen++;
    }
  }
  return seen >= normOffset ? orig.length : -1;
}

/** Walk text nodes inside `root` and build a Range covering the global
 * character offsets [start, end). Returns null if either offset is out of
 * range. */
function rangeFromOffsets(
  root: Node,
  start: number,
  end: number,
): Range | null {
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let startSet = false;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const len = n.textContent?.length ?? 0;
    if (!startSet && seen + len >= start) {
      range.setStart(n, start - seen);
      startSet = true;
    }
    if (startSet && seen + len >= end) {
      range.setEnd(n, end - seen);
      return range;
    }
    seen += len;
  }
  return null;
}
