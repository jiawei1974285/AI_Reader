import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime()) return tauriInvoke<T>(cmd, args);
  return mockInvoke<T>(cmd, args);
}

function isTxt(path: string): boolean {
  return path.toLowerCase().endsWith(".txt");
}

function isDocx(path: string): boolean {
  return path.toLowerCase().endsWith(".docx");
}

function isMobi(path: string): boolean {
  return path.toLowerCase().endsWith(".mobi");
}

const now = Date.now();

const mockBooks: Book[] = [
  {
    id: 1,
    file_path: "preview://three-body.epub",
    format: "epub",
    title: "三体",
    author: "刘慈欣",
    added_at: now - 5 * 86_400_000,
    file_size: 1_240_000,
    file_modified: now - 5 * 86_400_000,
    category: "文学小说",
    last_read_at: now - 32_000_000,
    cover_path: null,
    read_time_ms: 4_320_000,
  },
  {
    id: 2,
    file_path: "preview://principles.pdf",
    format: "pdf",
    title: "原则",
    author: "Ray Dalio",
    added_at: now - 8 * 86_400_000,
    file_size: 4_120_000,
    file_modified: now - 8 * 86_400_000,
    category: "经管",
    last_read_at: now - 2 * 86_400_000,
    cover_path: null,
    read_time_ms: 5_040_000,
  },
  {
    id: 3,
    file_path: "preview://thinking.txt",
    format: "txt",
    title: "人类群星闪耀时",
    author: "斯蒂芬·茨威格",
    added_at: now - 2 * 86_400_000,
    file_size: 820_000,
    file_modified: now - 2 * 86_400_000,
    category: "历史",
    last_read_at: null,
    cover_path: null,
    read_time_ms: 0,
  },
  {
    id: 4,
    file_path: "preview://design.docx",
    format: "docx",
    title: "设计中的设计",
    author: "原研哉",
    added_at: now - 1 * 86_400_000,
    file_size: 640_000,
    file_modified: now - 1 * 86_400_000,
    category: "艺术",
    last_read_at: now - 800_000,
    cover_path: null,
    read_time_ms: 1_920_000,
  },
  {
    id: 5,
    file_path: "preview://philosophy.mobi",
    format: "mobi",
    title: "存在与时间",
    author: "海德格尔",
    added_at: now - 12 * 86_400_000,
    file_size: 2_300_000,
    file_modified: now - 12 * 86_400_000,
    category: "哲学",
    last_read_at: null,
    cover_path: null,
    read_time_ms: 0,
  },
];

const mockHighlights: HighlightWithBook[] = [
  {
    id: 1,
    book_id: 1,
    spine_index: 0,
    selected_text: "这是默认的高亮颜色示例文本。",
    prefix: "",
    suffix: "",
    color: "yellow",
    note: "这里是一条读书札记。",
    created_at: now - 1_000_000,
    updated_at: now - 1_000_000,
    book_title: "三体",
    book_author: "刘慈欣",
    book_format: "epub",
  },
  {
    id: 2,
    book_id: 2,
    spine_index: 2,
    selected_text: "好的原则不是束缚行动，而是让决策更稳定。",
    prefix: "",
    suffix: "",
    color: "blue",
    note: "",
    created_at: now - 2_000_000,
    updated_at: now - 2_000_000,
    book_title: "原则",
    book_author: "Ray Dalio",
    book_format: "pdf",
  },
];

const mockTracks: Track[] = [
  {
    path: "preview://river.mp3",
    filename: "River Flows in You.mp3",
    format: "mp3",
    size_bytes: 3_400_000,
    modified_at: now,
  },
  {
    path: "preview://quiet.flac",
    filename: "Quiet Reading Room.flac",
    format: "flac",
    size_bytes: 12_400_000,
    modified_at: now,
  },
];

export type Book = {
  id: number;
  file_path: string;
  format: "epub" | "txt" | "pdf" | "docx" | "mobi";
  title: string;
  author: string;
  added_at: number;
  file_size: number;
  file_modified: number;
  category: string;
  last_read_at: number | null;
  cover_path: string | null;
  read_time_ms: number;
};

export type ReadingProgress = {
  book_id: number;
  spine_index: number;
  scroll_y: number;
  updated_at: number;
};

export type ScanReport = {
  scanned: number;
  added_or_updated: number;
  removed: number;
};

export type EpubPreview = {
  title: string;
  author: string;
  html: string;
  raw_length: number;
  extracted_length: number;
  spine_index: number;
  spine_total: number;
};

export type TocEntry = {
  spine_index: number;
  label: string;
  depth: number;
};

export type Highlight = {
  id: number;
  book_id: number;
  spine_index: number;
  selected_text: string;
  prefix: string;
  suffix: string;
  color: string;
  note: string;
  created_at: number;
  updated_at: number;
};

export type HighlightWithBook = Highlight & {
  book_title: string;
  book_author: string;
  book_format: string;
};

async function mockInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const storage = typeof localStorage === "undefined" ? null : localStorage;
  switch (cmd) {
    case "get_library_root":
      return (storage?.getItem("preview_library_root") ?? null) as T;
    case "set_library_root":
      storage?.setItem("preview_library_root", String(args?.path ?? ""));
      return undefined as T;
    case "scan_library":
      storage?.setItem("preview_library_root", "浏览器预览书库");
      return {
        scanned: mockBooks.length,
        added_or_updated: mockBooks.length,
        removed: 0,
      } as T;
    case "start_library_watcher":
      return false as T;
    case "list_books":
      return mockBooks as T;
    case "get_book_by_path":
      return (
        mockBooks.find((book) => book.file_path === args?.path) ?? null
      ) as T;
    case "get_progress":
      return null as T;
    case "save_progress":
    case "set_reader_settings":
    case "set_ai_settings":
    case "update_highlight":
    case "delete_highlight":
    case "chat_history_append":
    case "chat_history_clear":
    case "add_read_time":
      return undefined as T;
    case "read_epub_preview":
    case "read_txt_initial":
    case "read_docx_initial":
    case "read_mobi_initial":
    case "read_epub_chapter":
    case "read_txt_chapter":
    case "read_docx_chapter":
    case "read_mobi_chapter": {
      const spine = Number(args?.spineIndex ?? 0);
      return {
        title: spine === 0 ? "第一章 平静的日子" : `第 ${spine + 1} 章`,
        author: "预览作者",
        html: `<h1>第一章 平静的日子</h1><p>一九七五年三月间，一个平静的日子，细雨绵绵地笼罩着这座城市。这里展示的是浏览器预览模式下的阅读正文，用来检查排版、目录、标注和 AI 侧栏的视觉效果。</p><p>他走在田埂上，冷风吹得人打哆嗦，心里却明亮安定。新的界面应该像纸页一样安静，也像工具一样可靠。</p>`,
        raw_length: 240,
        extracted_length: 200,
        spine_index: spine,
        spine_total: 12,
      } as T;
    }
    case "get_book_toc":
    case "get_txt_toc":
    case "get_docx_toc":
    case "get_mobi_toc":
      return [
        { spine_index: 0, label: "第一章 平静的日子", depth: 0 },
        { spine_index: 1, label: "第二章 动荡的开端", depth: 0 },
        { spine_index: 2, label: "第三章 黑暗森林", depth: 0 },
      ] as T;
    case "get_reader_settings":
      return (storage?.getItem("preview_reader_settings") ?? null) as T;
    case "create_highlight":
      return {
        id: Math.floor(Math.random() * 100_000),
        book_id: Number(args?.bookId ?? 1),
        spine_index: Number(args?.spineIndex ?? 0),
        selected_text: String(args?.selectedText ?? ""),
        prefix: String(args?.prefix ?? ""),
        suffix: String(args?.suffix ?? ""),
        color: String(args?.color ?? "yellow"),
        note: "",
        created_at: Date.now(),
        updated_at: Date.now(),
      } as T;
    case "list_highlights_by_chapter":
    case "list_highlights_by_book":
      return mockHighlights
        .filter((h) => h.book_id === Number(args?.bookId ?? 1))
        .map(({ book_title: _title, book_author: _author, book_format: _format, ...h }) => h) as T;
    case "list_all_highlights":
      return mockHighlights as T;
    case "ai_chat":
    case "ai_chat_rag":
    case "ai_summarize_highlights":
      return "这是浏览器预览模式下的 AI 示例回答。真实 AI 调用会在 Tauri 应用中使用你配置的接口。" as T;
    case "read_pdf_page_text":
      return `这是浏览器预览模式下第 ${Number(args?.pageIndex ?? 0) + 1} 页的 PDF 文本。切到文本模式后，阅读器字体、字号和行距设置会作用在这里。` as T;
    case "ai_chat_stream":
    case "ai_chat_rag_stream":
      return undefined as T;
    case "ai_index_book":
      return 36 as T;
    case "ai_get_index_status":
      return {
        book_id: Number(args?.bookId ?? 1),
        status: "ready",
        chunks_count: 36,
        indexed_at: Date.now(),
        error: null,
      } as T;
    case "get_ai_settings":
      return (storage?.getItem("preview_ai_settings") ?? null) as T;
    case "get_music_root":
      return (storage?.getItem("preview_music_root") ?? null) as T;
    case "set_music_root":
      storage?.setItem("preview_music_root", String(args?.path ?? ""));
      return undefined as T;
    case "scan_music":
      storage?.setItem("preview_music_root", "浏览器预览音乐库");
      return mockTracks as T;
    case "decrypt_ncm":
      return String(args?.path ?? "") as T;
    case "read_lrc":
      return null as T;
    case "ai_recommend_books":
      return mockBooks.slice(1, 4).map((book, index) => ({
        book,
        score: 0.96 - index * 0.04,
        reason: "与最近阅读主题相近，适合作为下一本书。",
      })) as T;
    case "ai_tag_music_tracks":
      return {
        total: mockTracks.length,
        tagged: mockTracks.length,
        skipped: 0,
        failed: 0,
      } as T;
    case "ai_recommend_music":
      return {
        mood_tags: ["安静", "专注"],
        description: "适合长时间阅读的低干扰背景音乐。",
        recommendations: mockTracks.map((track, index) => ({
          track_path: track.path,
          filename: track.filename,
          mood_tags: ["安静", "专注"],
          description: "浏览器预览曲目",
          score: 0.92 - index * 0.06,
        })),
      } as T;
    case "list_track_tags":
      return mockTracks.map((track) => ({
        track_path: track.path,
        file_mtime: track.modified_at,
        mood_tags: JSON.stringify(["安静", "专注"]),
        description: "浏览器预览曲目",
        tagged_at: now,
      })) as T;
    case "ai_classify_books":
      return {
        total: mockBooks.length,
        classified: mockBooks.length,
        skipped: 0,
        failed: 0,
      } as T;
    case "chat_history_load":
      return [] as T;
    default:
      throw new Error(`浏览器预览模式暂不支持命令：${cmd}`);
  }
}

export const ipc = {
  getLibraryRoot: () => invoke<string | null>("get_library_root"),
  setLibraryRoot: (path: string) => invoke<void>("set_library_root", { path }),
  scanLibrary: () => invoke<ScanReport>("scan_library"),
  startLibraryWatcher: () => invoke<boolean>("start_library_watcher"),
  listBooks: () => invoke<Book[]>("list_books"),
  removeBook: (bookId: number) => invoke<void>("remove_book", { bookId }),
  getBookByPath: (path: string) =>
    invoke<Book | null>("get_book_by_path", { path }),
  getProgress: (bookId: number) =>
    invoke<ReadingProgress | null>("get_progress", { bookId }),
  saveProgress: (bookId: number, spineIndex: number, scrollY: number) =>
    invoke<void>("save_progress", {
      bookId,
      spineIndex,
      scrollY,
    }),
  readBookInitial: (path: string) => {
    if (isTxt(path)) return invoke<EpubPreview>("read_txt_initial", { path });
    if (isDocx(path)) return invoke<EpubPreview>("read_docx_initial", { path });
    if (isMobi(path)) return invoke<EpubPreview>("read_mobi_initial", { path });
    return invoke<EpubPreview>("read_epub_preview", { path });
  },
  readBookChapter: (path: string, spineIndex: number) => {
    if (isTxt(path))
      return invoke<EpubPreview>("read_txt_chapter", { path, spineIndex });
    if (isDocx(path))
      return invoke<EpubPreview>("read_docx_chapter", { path, spineIndex });
    if (isMobi(path))
      return invoke<EpubPreview>("read_mobi_chapter", { path, spineIndex });
    return invoke<EpubPreview>("read_epub_chapter", { path, spineIndex });
  },
  getBookToc: (path: string) => {
    if (isTxt(path)) return invoke<TocEntry[]>("get_txt_toc", { path });
    if (isDocx(path)) return invoke<TocEntry[]>("get_docx_toc", { path });
    if (isMobi(path)) return invoke<TocEntry[]>("get_mobi_toc", { path });
    return invoke<TocEntry[]>("get_book_toc", { path });
  },
  getReaderSettings: () => invoke<string | null>("get_reader_settings"),
  setReaderSettings: (value: string) =>
    invoke<void>("set_reader_settings", { value }),
  createHighlight: (args: {
    bookId: number;
    spineIndex: number;
    selectedText: string;
    prefix: string;
    suffix: string;
    color: string;
    note: string;
  }) => invoke<Highlight>("create_highlight", args),
  listHighlightsByChapter: (bookId: number, spineIndex: number) =>
    invoke<Highlight[]>("list_highlights_by_chapter", { bookId, spineIndex }),
  listHighlightsByBook: (bookId: number) =>
    invoke<Highlight[]>("list_highlights_by_book", { bookId }),
  listAllHighlights: (query: string | null) =>
    invoke<HighlightWithBook[]>("list_all_highlights", { query }),
  updateHighlight: (args: { id: number; color: string; note: string }) =>
    invoke<void>("update_highlight", args),
  deleteHighlight: (id: number) =>
    invoke<void>("delete_highlight", { id }),
  aiChat: (messages: ChatMessage[]) =>
    invoke<string>("ai_chat", { messages }),
  aiChatStream: (messages: ChatMessage[], sessionId: string) =>
    invoke<void>("ai_chat_stream", { messages, sessionId }),
  aiChatRag: (args: {
    question: string;
    bookId: number | null;
    history: ChatMessage[];
  }) => invoke<string>("ai_chat_rag", args),
  aiChatRagStream: (args: {
    question: string;
    bookId: number | null;
    history: ChatMessage[];
    sessionId: string;
  }) => invoke<void>("ai_chat_rag_stream", args),
  aiIndexBook: (args: { bookId: number; bookPath: string }) =>
    invoke<number>("ai_index_book", args),
  aiGetIndexStatus: (bookId: number) =>
    invoke<BookIndexStatus | null>("ai_get_index_status", { bookId }),
  getAiSettings: () => invoke<string | null>("get_ai_settings"),
  setAiSettings: (value: string) =>
    invoke<void>("set_ai_settings", { value }),
  getMusicRoot: () => invoke<string | null>("get_music_root"),
  setMusicRoot: (path: string) =>
    invoke<void>("set_music_root", { path }),
  scanMusic: () => invoke<Track[]>("scan_music"),
  decryptNcm: (path: string) => invoke<string>("decrypt_ncm", { path }),
  readLrc: (audioPath: string) =>
    invoke<string | null>("read_lrc", { audioPath }),
  aiRecommendBooks: (args: {
    anchorBookId: number | null;
    topK: number;
    withReasons?: boolean;
  }) => invoke<Recommendation[]>("ai_recommend_books", args),
  aiTagMusicTracks: () => invoke<TagReport>("ai_tag_music_tracks"),
  aiRecommendMusic: (chapterText: string, topK: number) =>
    invoke<ChapterMoodWithRecs>("ai_recommend_music", {
      chapterText,
      topK,
    }),
  listTrackTags: () => invoke<TrackTagMeta[]>("list_track_tags"),
  aiClassifyBooks: (force?: boolean) =>
    invoke<ClassifyReport>("ai_classify_books", { force: force ?? false }),
  aiSummarizeHighlights: (bookId: number) =>
    invoke<string>("ai_summarize_highlights", { bookId }),
  readPdfPageText: (path: string, pageIndex: number) =>
    invoke<string>("read_pdf_page_text", { path, pageIndex }),
  chatHistoryLoad: (bookId: number, mode: string, spineIndex: number) =>
    invoke<ChatHistoryMsg[]>("chat_history_load", { bookId, mode, spineIndex }),
  chatHistoryAppend: (args: {
    bookId: number;
    mode: string;
    spineIndex: number;
    role: string;
    content: string;
  }) => invoke<void>("chat_history_append", args),
  chatHistoryClear: (bookId: number, mode: string, spineIndex: number) =>
    invoke<void>("chat_history_clear", { bookId, mode, spineIndex }),
  addReadTime: (bookId: number, deltaMs: number) =>
    invoke<void>("add_read_time", { bookId, deltaMs }),
};

export type ChatHistoryMsg = {
  role: string;
  content: string;
  created_at: number;
};

export type ClassifyReport = {
  total: number;
  classified: number;
  skipped: number;
  failed: number;
};

export type ClassifyProgress = {
  current: number;
  total: number;
};

export const BOOK_CATEGORIES = [
  "文学小说",
  "历史",
  "哲学",
  "科技",
  "经管",
  "心理",
  "艺术",
  "诗歌散文",
  "教材工具书",
  "传记",
  "其他",
] as const;
export type BookCategory = (typeof BOOK_CATEGORIES)[number];

export type TrackTagMeta = {
  track_path: string;
  file_mtime: number;
  mood_tags: string; // JSON string, parse to string[]
  description: string;
  tagged_at: number;
};

export type TagReport = {
  total: number;
  tagged: number;
  skipped: number;
  failed: number;
};

export type TagProgress = {
  current: number;
  total: number;
};

export type MusicRecommendation = {
  track_path: string;
  filename: string;
  mood_tags: string[];
  description: string;
  score: number;
};

export type ChapterMoodWithRecs = {
  mood_tags: string[];
  description: string;
  recommendations: MusicRecommendation[];
};

export type Recommendation = {
  book: Book;
  score: number;
  reason: string;
};

export type BookIndexStatus = {
  book_id: number;
  status: "pending" | "indexing" | "ready" | "error" | string;
  chunks_count: number;
  indexed_at: number | null;
  error: string | null;
};

export type Track = {
  path: string;
  filename: string;
  format: "mp3" | "flac" | "wav" | "m4a" | "ogg" | "aac" | "ncm" | string;
  size_bytes: number;
  modified_at: number;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatDelta = {
  session_id: string;
  delta: string;
  done: boolean;
  error: string | null;
};

export type ChatHit = {
  spine_index: number;
  text: string;
};

export type ChatContext = {
  session_id: string;
  hits: ChatHit[];
};

export type AiSettings = {
  base_url: string;
  api_key: string;
  chat_model: string;
  temperature?: number | null;
  /** 快速模式：在 API 请求体里加 `enable_thinking: false` 关闭思考链；
   *  同时过滤掉返回里 `<think>…</think>` 块。绝大多数阅读助手场景不需
   *  要 reasoning，开着默认能大幅提速。*/
  fast_mode?: boolean;
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  base_url: "",
  api_key: "",
  chat_model: "",
  temperature: null,
  fast_mode: true,
};

export async function loadAiSettings(): Promise<AiSettings> {
  const raw = await ipc.getAiSettings();
  if (!raw) return DEFAULT_AI_SETTINGS;
  try {
    return { ...DEFAULT_AI_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
}

export async function saveAiSettings(s: AiSettings): Promise<void> {
  await ipc.setAiSettings(JSON.stringify(s));
}

export type ReaderTheme = "cream" | "white" | "dark";
export type ReaderFontFamily = "serif" | "sans";

export type ReaderSettings = {
  font_family: ReaderFontFamily;
  font_size: number;
  line_height: number;
  column_width: number;
  theme: ReaderTheme;
  paragraph_indent: boolean;
  toc_sidebar_open: boolean;
};

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  font_family: "serif",
  font_size: 18,
  line_height: 2.0,
  column_width: 44,
  theme: "cream",
  paragraph_indent: true,
  toc_sidebar_open: true,
};

export async function loadReaderSettings(): Promise<ReaderSettings> {
  const raw = await ipc.getReaderSettings();
  if (!raw) return DEFAULT_READER_SETTINGS;
  try {
    return { ...DEFAULT_READER_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_READER_SETTINGS;
  }
}

export async function saveReaderSettings(s: ReaderSettings): Promise<void> {
  await ipc.setReaderSettings(JSON.stringify(s));
}
