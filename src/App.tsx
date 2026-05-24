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
    ipc.refreshDoubanMetadata(false).catch(() => {});
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
            initialSpine={view.initialSpine}
            initialScrollY={view.initialScrollY}
            initialHighlightId={view.initialHighlight}
            backLabel={backLabel}
            onBack={onBack}
          />
          {globalSettingsPanel}
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
          initialSpine={view.initialSpine}
          initialScrollY={view.initialScrollY}
          initialHighlightId={view.initialHighlight}
          backLabel={backLabel}
          onBack={onBack}
        />
        {globalSettingsPanel}
      </>
    );
  }

  if (view.kind === "notes") {
    return (
      <>
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
        />
        {globalCommandPalette}
        {globalFullTextSearch}
      </>
    );
  }

  if (view.kind === "music") {
    return (
      <>
        <MusicView onBack={() => setView({ kind: "library" })} />
        {globalCommandPalette}
        {globalFullTextSearch}
      </>
    );
  }

  if (view.kind === "stats") {
    return (
      <>
        <StatsView
          onBack={() => setView({ kind: "library" })}
          onOpenBook={(book) =>
            setView({
              kind: "reader",
              book,
              returnTo: "stats",
            })
          }
        />
        {globalCommandPalette}
        {globalFullTextSearch}
      </>
    );
  }

  return (
    <>
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
        onOpenAiSettings={() => setAiSettingsOpen(true)}
      />
      {globalSettingsPanel}
      {globalCommandPalette}
      {globalFullTextSearch}
    </>
  );
}

export default App;
