import logoUrl from "@/assets/aireader-logo-256.png";

type AppSection = "library" | "notes" | "music" | "stats";
type SidebarIcon =
  | "library"
  | "recommend"
  | "bookmark"
  | "notes"
  | "music"
  | "stats"
  | "ai"
  | "help"
  | "settings";

type Props = {
  active: AppSection;
  onNavigate: (section: AppSection) => void;
  onOpenRecommend: () => void;
  onOpenBookmarks: () => void;
  onOpenAiSettings: () => void;
  onOpenHelp: () => void;
};

const NAV_ITEMS: { id: AppSection; icon: SidebarIcon; label: string }[] = [
  { id: "library", icon: "library", label: "书架" },
  { id: "notes", icon: "notes", label: "笔记" },
  { id: "music", icon: "music", label: "音乐" },
  { id: "stats", icon: "stats", label: "统计" },
];

export function AppSidebar({
  active,
  onNavigate,
  onOpenRecommend,
  onOpenBookmarks,
  onOpenAiSettings,
  onOpenHelp,
}: Props) {
  return (
    <aside className="app-sidebar">
      <div className="app-sidebar-brand">
        <div className="app-sidebar-mark">
          <img src={logoUrl} alt="AIreader" />
        </div>
        <div>
          <div className="app-sidebar-title">AIreader</div>
          <div className="app-sidebar-badge">本地优先</div>
        </div>
      </div>

      <nav className="app-sidebar-nav" aria-label="主导航">
        <button
          type="button"
          onClick={() => onNavigate("library")}
          className={`app-sidebar-item ${
            active === "library" ? "app-sidebar-item-active" : ""
          }`}
        >
          <SidebarGlyph id="library" />
          <span>书架</span>
        </button>
        <button
          type="button"
          onClick={onOpenRecommend}
          className="app-sidebar-item"
        >
          <SidebarGlyph id="recommend" />
          <span>推荐</span>
        </button>
        <button
          type="button"
          onClick={onOpenBookmarks}
          className="app-sidebar-item"
        >
          <SidebarGlyph id="bookmark" />
          <span>书签</span>
        </button>
        {NAV_ITEMS.filter((item) => item.id !== "library").map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            className={`app-sidebar-item ${
              active === item.id ? "app-sidebar-item-active" : ""
            }`}
          >
            <SidebarGlyph id={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={onOpenAiSettings}
          className="app-sidebar-item"
        >
          <SidebarGlyph id="ai" />
          <span>AI</span>
        </button>
      </nav>

      <div className="app-sidebar-footer">
        <button
          type="button"
          onClick={onOpenHelp}
          className="app-sidebar-item"
        >
          <SidebarGlyph id="help" />
          <span>帮助</span>
        </button>
        <button
          type="button"
          onClick={onOpenAiSettings}
          className="app-sidebar-item"
        >
          <SidebarGlyph id="settings" />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}

function SidebarGlyph({ id }: { id: SidebarIcon }) {
  return (
    <span className="app-sidebar-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img">
        {id === "library" && (
          <>
            <path d="M5 5.5h4.7c1.3 0 2.3.5 2.3 1.8v11.2c0-1.1-1-1.8-2.3-1.8H5z" />
            <path d="M19 5.5h-4.7c-1.3 0-2.3.5-2.3 1.8v11.2c0-1.1 1-1.8 2.3-1.8H19z" />
          </>
        )}
        {id === "recommend" && (
          <>
            <path d="M12 5.2l1.4 3.5 3.7.3-2.8 2.4.9 3.6-3.2-1.9-3.2 1.9.9-3.6L6.9 9l3.7-.3z" />
            <path d="M18.2 15.3v2.4" />
            <path d="M19.4 16.5H17" />
          </>
        )}
        {id === "bookmark" && <path d="M7 4.5h10v15l-5-3-5 3z" />}
        {id === "notes" && (
          <>
            <path d="M7 4.5h8l2 2v13H7z" />
            <path d="M10 10h4" />
            <path d="M10 14h5" />
          </>
        )}
        {id === "music" && (
          <>
            <path d="M9 17.5V6.5l8-1.5v10.8" />
            <circle cx="7" cy="17.5" r="2" />
            <circle cx="15" cy="15.8" r="2" />
          </>
        )}
        {id === "stats" && (
          <>
            <path d="M5 19h14" />
            <path d="M7.5 16v-5" />
            <path d="M12 16V7" />
            <path d="M16.5 16v-8" />
          </>
        )}
        {id === "ai" && (
          <>
            <path d="M12 4.5l2.1 5.4 5.4 2.1-5.4 2.1-2.1 5.4-2.1-5.4-5.4-2.1 5.4-2.1z" />
            <path d="M18 4.5v3" />
            <path d="M19.5 6h-3" />
          </>
        )}
        {id === "help" && (
          <>
            <path d="M9.5 9a2.6 2.6 0 1 1 4.4 1.9c-.9.8-1.9 1.4-1.9 3" />
            <path d="M12 18.5h.01" />
          </>
        )}
        {id === "settings" && (
          <>
            <circle cx="12" cy="12" r="2.6" />
            <path d="M12 4.5v2" />
            <path d="M12 17.5v2" />
            <path d="M4.5 12h2" />
            <path d="M17.5 12h2" />
            <path d="M6.7 6.7l1.4 1.4" />
            <path d="M15.9 15.9l1.4 1.4" />
            <path d="M17.3 6.7l-1.4 1.4" />
            <path d="M8.1 15.9l-1.4 1.4" />
          </>
        )}
      </svg>
    </span>
  );
}
