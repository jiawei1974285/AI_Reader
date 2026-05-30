import { useEffect, useState } from "react";
import { LibraryView } from "@/features/library/LibraryView";
import { EpubView } from "@/features/reader/EpubView";
import { PdfView } from "@/features/reader/PdfView";
import { NotesView } from "@/features/notes/NotesView";
import { MusicView } from "@/features/music/MusicView";
import { MusicMiniPlayer } from "@/features/music/MusicMiniPlayer";
import { MusicPlayerProvider } from "@/features/music/MusicPlayerContext";
import { StatsView } from "@/features/stats/StatsView";
import {
  DEFAULT_AI_SETTINGS,
  ipc,
  loadAiSettings,
  saveAiSettings,
} from "@/lib/ipc";
import { GlobalAiSettingsPanel } from "@/features/settings/GlobalAiSettingsPanel";
import { CommandPalette } from "@/features/command-palette/CommandPalette";
import { useCommandPalette } from "@/features/command-palette/useCommandPalette";
import { FullTextSearch } from "@/features/search/FullTextSearch";
import { HelpPanel } from "@/features/help/HelpPanel";
import { AppSidebar } from "@/components/shell/AppSidebar";
import { GlobalBookmarksPanel } from "@/features/bookmarks/GlobalBookmarksPanel";
import { RecommendPanel } from "@/features/library/RecommendPanel";
import type { AiSettings, Book } from "@/lib/ipc";

type View =
  | { kind: "library" }
  | { kind: "notes" }
  | { kind: "music" }
  | { kind: "stats" }
  | {
      kind: "reader";
      book: Book;
      initialSpine?: number;
      initialScrollY?: number;
      initialHighlight?: number;
      returnTo: "library" | "notes" | "stats";
    };

type AppSection = "library" | "notes" | "music" | "stats";

function App() {
  return (
    <MusicPlayerProvider>
      <AppShell />
      <MusicMiniPlayer />
    </MusicPlayerProvider>
  );
}

function AppShell() {
  const [view, setView] = useState<View>({ kind: "library" });
  const [aiSettings, setAiSettings] = useState<AiSettings>(DEFAULT_AI_SETTINGS);
  const [aiSettingsLoaded, setAiSettingsLoaded] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [recommendOpen, setRecommendOpen] = useState(false);
  const [doubanRefreshText, setDoubanRefreshText] = useState<string | null>(null);
  // C6: 全局命令面板 (Ctrl/Cmd+K)
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();
  // C1: 全文 FTS 检索面板（命令面板 / library 按钮 都能触发）
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    loadAiSettings()
      .then(setAiSettings)
      .catch(() => {})
      .finally(() => setAiSettingsLoaded(true));
  }, []);

  useEffect(() => {
    ipc
      .refreshDoubanMetadata(false)
      .then((report) => {
        if (report.scheduled > 0) {
          setDoubanRefreshText(`正在增量获取豆瓣信息：${report.scheduled} 本`);
          window.setTimeout(() => setDoubanRefreshText(null), 8000);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!aiSettingsLoaded) return;
    const t = window.setTimeout(() => {
      saveAiSettings(aiSettings).catch(() => {});
    }, 300);
    return () => window.clearTimeout(t);
  }, [aiSettings, aiSettingsLoaded]);

  const globalSettingsPanel = aiSettingsOpen ? (
    <GlobalAiSettingsPanel
      settings={aiSettings}
      onChange={setAiSettings}
      onClose={() => setAiSettingsOpen(false)}
    />
  ) : null;

  const globalHelpPanel = helpOpen ? (
    <HelpPanel onClose={() => setHelpOpen(false)} />
  ) : null;

  const globalBookmarksPanel = (
    <GlobalBookmarksPanel
      open={bookmarksOpen}
      onClose={() => setBookmarksOpen(false)}
      onOpenBook={(book, initialSpine, initialScrollY) =>
        setView({
          kind: "reader",
          book,
          initialSpine,
          initialScrollY,
          returnTo: "library",
        })
      }
    />
  );

  const globalRecommendPanel = recommendOpen ? (
    <RecommendPanel
      onOpenBook={(book) => {
        setRecommendOpen(false);
        setView({
          kind: "reader",
          book,
          returnTo: "library",
        });
      }}
      onClose={() => setRecommendOpen(false)}
    />
  ) : null;

  async function setCurrentBookRating(rating: number | null) {
    if (view.kind !== "reader") return;
    const bookId = view.book.id;
    setView({ ...view, book: { ...view.book, user_rating: rating } });
    try {
      await ipc.setBookRating(bookId, rating);
    } catch {
      setView({ ...view });
    }
  }

  const navigateSection = (section: AppSection) => {
    setView({ kind: section });
  };

  const activeSection: AppSection =
    view.kind === "reader" ? view.returnTo : view.kind;

  function renderWorkspace(children: React.ReactNode) {
    return (
      <div className="app-frame app-workspace">
        <AppSidebar
          active={activeSection}
          onNavigate={navigateSection}
          onOpenRecommend={() => setRecommendOpen(true)}
          onOpenBookmarks={() => setBookmarksOpen(true)}
          onOpenAiSettings={() => setAiSettingsOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
        />
        <div className="app-workspace-main">{children}</div>
      </div>
    );
  }

  // C6: 命令面板可达的导航 + 打开书 — 由 App 注入，CommandPalette 不直接 setView
  const globalCommandPalette = (
    <CommandPalette
      open={paletteOpen}
      onClose={() => setPaletteOpen(false)}
      extraActions={[
        {
          id: "global-fts-search",
          label: "全文搜索本库",
          hint: "C1 · 在已索引的书里全文搜",
          group: "其他",
          run: () => {
            setSearchOpen(true);
          },
        },
      ]}
      navigate={{
        library: () => setView({ kind: "library" }),
        notes: () => setView({ kind: "notes" }),
        music: () => setView({ kind: "music" }),
        stats: () => setView({ kind: "stats" }),
        openAiSettings: () => setAiSettingsOpen(true),
      }}
      openBook={(book, spineIndex, scrollY) =>
        setView({
          kind: "reader",
          book,
          initialSpine: spineIndex,
          initialScrollY: scrollY,
          returnTo: "library",
        })
      }
    />
  );

  const globalFullTextSearch = (
    <FullTextSearch
      open={searchOpen}
      onClose={() => setSearchOpen(false)}
      scope={{ kind: "library" }}
      onOpenHit={(book, spineIndex) =>
        setView({
          kind: "reader",
          book,
          initialSpine: spineIndex,
          returnTo: "library",
        })
      }
    />
  );

  if (view.kind === "reader") {
    const backLabel =
      view.returnTo === "notes"
        ? "返回笔记"
        : view.returnTo === "stats"
          ? "返回统计"
          : "返回书架";
    const onBack = () => setView({ kind: view.returnTo });

    if (view.book.format === "pdf") {
      return (
        <>
          <PdfView
            path={view.book.file_path}
            bookId={view.book.id}
            aiSettings={aiSettings}
            onOpenAiSettings={() => setAiSettingsOpen(true)}
            onOpenHelp={() => setHelpOpen(true)}
            bookRating={view.book.user_rating}
            onRateBook={setCurrentBookRating}
            initialSpine={view.initialSpine}
            initialScrollY={view.initialScrollY}
            initialHighlightId={view.initialHighlight}
            backLabel={backLabel}
            onBack={onBack}
          />
          {globalSettingsPanel}
          {globalHelpPanel}
          {globalBookmarksPanel}
          {globalRecommendPanel}
          {globalCommandPalette}
          {globalFullTextSearch}
        </>
      );
    }

    return (
      <>
        <EpubView
          path={view.book.file_path}
          bookId={view.book.id}
          aiSettings={aiSettings}
          onOpenAiSettings={() => setAiSettingsOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
          bookRating={view.book.user_rating}
          onRateBook={setCurrentBookRating}
          initialSpine={view.initialSpine}
          initialScrollY={view.initialScrollY}
          initialHighlightId={view.initialHighlight}
          backLabel={backLabel}
          onBack={onBack}
        />
        {globalSettingsPanel}
        {globalHelpPanel}
        {globalBookmarksPanel}
        {globalRecommendPanel}
      </>
    );
  }

  if (view.kind === "notes") {
    return (
      <>
        {renderWorkspace(
          <NotesView
            onBack={() => setView({ kind: "library" })}
            onOpenBookAtHighlight={(book, spineIdx, hlId) =>
              setView({
                kind: "reader",
                book,
                initialSpine: spineIdx,
                initialHighlight: hlId,
                returnTo: "notes",
              })
            }
          />,
        )}
        {globalCommandPalette}
        {globalFullTextSearch}
        {globalSettingsPanel}
        {globalHelpPanel}
        {globalBookmarksPanel}
        {globalRecommendPanel}
      </>
    );
  }

  if (view.kind === "music") {
    return (
      <>
        {renderWorkspace(<MusicView onBack={() => setView({ kind: "library" })} />)}
        {globalCommandPalette}
        {globalFullTextSearch}
        {globalSettingsPanel}
        {globalHelpPanel}
        {globalBookmarksPanel}
        {globalRecommendPanel}
      </>
    );
  }

  if (view.kind === "stats") {
    return (
      <>
        {renderWorkspace(
          <StatsView
            onBack={() => setView({ kind: "library" })}
            onOpenBook={(book) =>
              setView({
                kind: "reader",
                book,
                returnTo: "stats",
              })
            }
          />,
        )}
        {globalCommandPalette}
        {globalFullTextSearch}
        {globalSettingsPanel}
        {globalHelpPanel}
        {globalBookmarksPanel}
        {globalRecommendPanel}
      </>
    );
  }

  return (
    <>
      {renderWorkspace(
        <LibraryView
          onOpenBook={(book, initialSpine, initialScrollY) =>
            setView({
              kind: "reader",
              book,
              initialSpine,
              initialScrollY,
              returnTo: "library",
            })
          }
          onOpenNotes={() => setView({ kind: "notes" })}
          onOpenMusic={() => setView({ kind: "music" })}
          onOpenStats={() => setView({ kind: "stats" })}
          onOpenRecommend={() => setRecommendOpen(true)}
          onOpenAiSettings={() => setAiSettingsOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
        />,
      )}
      {globalSettingsPanel}
      {globalHelpPanel}
      {globalBookmarksPanel}
      {globalRecommendPanel}
      {globalCommandPalette}
      {globalFullTextSearch}
      {doubanRefreshText && (
        <div className="fixed bottom-4 right-4 z-50 rounded-md border border-[var(--color-paper-edge)] bg-[var(--color-paper)]/95 px-3 py-2 text-xs text-[var(--color-ink)] shadow-xl backdrop-blur">
          {doubanRefreshText}
        </div>
      )}
    </>
  );
}

export default App;
