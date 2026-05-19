import { useEffect, useState } from "react";
import { LibraryView } from "@/features/library/LibraryView";
import { EpubView } from "@/features/reader/EpubView";
import { PdfView } from "@/features/reader/PdfView";
import { NotesView } from "@/features/notes/NotesView";
import { MusicView } from "@/features/music/MusicView";
import { MusicMiniPlayer } from "@/features/music/MusicMiniPlayer";
import { MusicPlayerProvider } from "@/features/music/MusicPlayerContext";
import { StatsView } from "@/features/stats/StatsView";
import { DEFAULT_AI_SETTINGS, loadAiSettings, saveAiSettings } from "@/lib/ipc";
import { GlobalAiSettingsPanel } from "@/features/settings/GlobalAiSettingsPanel";
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
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);

  useEffect(() => {
    loadAiSettings().then(setAiSettings).catch(() => {});
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      saveAiSettings(aiSettings).catch(() => {});
    }, 300);
    return () => window.clearTimeout(t);
  }, [aiSettings]);

  const globalSettingsPanel = aiSettingsOpen ? (
    <GlobalAiSettingsPanel
      settings={aiSettings}
      onChange={setAiSettings}
      onClose={() => setAiSettingsOpen(false)}
    />
  ) : null;

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
            initialHighlightId={view.initialHighlight}
            backLabel={backLabel}
            onBack={onBack}
          />
          {globalSettingsPanel}
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
    );
  }

  if (view.kind === "music") {
    return <MusicView onBack={() => setView({ kind: "library" })} />;
  }

  if (view.kind === "stats") {
    return (
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
    );
  }

  return (
    <>
      <LibraryView
        onOpenBook={(book) =>
          setView({ kind: "reader", book, returnTo: "library" })
        }
        onOpenNotes={() => setView({ kind: "notes" })}
        onOpenMusic={() => setView({ kind: "music" })}
        onOpenStats={() => setView({ kind: "stats" })}
        onOpenAiSettings={() => setAiSettingsOpen(true)}
      />
      {globalSettingsPanel}
    </>
  );
}

export default App;
