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
  const p = path.toLowerCase();
  return p.endsWith(".mobi") || p.endsWith(".azw") || p.endsWith(".azw3");
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
  format: "epub" | "txt" | "pdf" | "docx" | "mobi" | "azw" | "azw3";
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

export type DoubanMetadata = {
  book_id: number;
  status: "ok" | "not_found" | "failed" | string;
  rating: string | null;
  rating_count: number | null;
  summary: string | null;
  douban_url: string | null;
  fetched_at: number;
  error: string | null;
};

export type DoubanRefreshReport = {
  scheduled: number;
};

export type ReadingProgress = {
  book_id: number;
  spine_index: number;
  scroll_y: number;
  updated_at: number;
  /** A4: 段落索引（章内第几段，0-based）。优先用它恢复进度。 */
  paragraph_index?: number | null;
  /** A4: 段内字符偏移。配合 paragraph_index 精确定位视口顶部。 */
  char_offset?: number | null;
};

export type Bookmark = {
  id: number;
  book_id: number;
  spine_index: number;
  scroll_y: number;
  label: string;
  excerpt: string;
  created_at: number;
};

export type BookmarkWithBook = Bookmark & {
  book_title: string;
  book_author: string;
  book_format: Book["format"] | string;
  book_path: string;
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
    case "get_douban_metadata":
      return {
        book_id: Number(args?.bookId ?? 1),
        status: "ok",
        rating: "8.7",
        rating_count: 12345,
        summary: "Preview Douban summary loaded from the local metadata cache.",
        /*
          "娴忚鍣ㄩ瑙堢殑璞嗙摚绠€浠嬶紝鐪熷疄搴旂敤涓皢浠庢湰鍦扮紦瀛樿鍙栥€?,
        */
        douban_url: "https://book.douban.com/",
        fetched_at: Date.now(),
        error: null,
      } as T;
    case "refresh_douban_metadata":
      return { scheduled: mockBooks.length } as T;
    case "get_book_by_path":
      return (mockBooks.find((book) => book.file_path === args?.path) ??
        null) as T;
    case "get_progress":
      return null as T;
    case "create_bookmark": {
      const bookmark: Bookmark = {
        id: Date.now(),
        book_id: Number(args?.bookId ?? 1),
        spine_index: Number(args?.spineIndex ?? 0),
        scroll_y: Number(args?.scrollY ?? 0),
        label: String(args?.label ?? ""),
        excerpt: String(args?.excerpt ?? ""),
        created_at: Date.now(),
      };
      const raw = storage?.getItem("preview_bookmarks");
      const existing = raw ? (JSON.parse(raw) as BookmarkWithBook[]) : [];
      const book =
        mockBooks.find((b) => b.id === bookmark.book_id) ?? mockBooks[0];
      const withBook: BookmarkWithBook = {
        ...bookmark,
        book_title: book.title,
        book_author: book.author,
        book_format: book.format,
        book_path: book.file_path,
      };
      storage?.setItem(
        "preview_bookmarks",
        JSON.stringify([withBook, ...existing].slice(0, 24)),
      );
      return bookmark as T;
    }
    case "list_recent_bookmarks": {
      const raw = storage?.getItem("preview_bookmarks");
      return (raw ? JSON.parse(raw) : []) as T;
    }
    case "list_bookmarks_by_book": {
      const raw = storage?.getItem("preview_bookmarks");
      const existing = raw ? (JSON.parse(raw) as BookmarkWithBook[]) : [];
      const bookId = Number(args?.bookId ?? 0);
      return existing
        .filter((bookmark) => bookmark.book_id === bookId)
        .map((bookmark) => ({
          id: bookmark.id,
          book_id: bookmark.book_id,
          spine_index: bookmark.spine_index,
          scroll_y: bookmark.scroll_y,
          label: bookmark.label,
          excerpt: bookmark.excerpt,
          created_at: bookmark.created_at,
        })) as T;
    }
    case "delete_bookmark": {
      const raw = storage?.getItem("preview_bookmarks");
      const existing = raw ? (JSON.parse(raw) as BookmarkWithBook[]) : [];
      const id = Number(args?.id ?? 0);
      storage?.setItem(
        "preview_bookmarks",
        JSON.stringify(existing.filter((bookmark) => bookmark.id !== id)),
      );
      return undefined as T;
    }
    case "save_progress":
    case "set_reader_settings":
    case "set_ai_settings":
    case "update_highlight":
    case "delete_highlight":
    case "chat_history_append":
    case "chat_history_clear":
    case "add_read_time":
      return undefined as T;
    case "list_calendar_days":
      return [] as T;
    case "get_day_reading":
      return {
        day_key: Number(args?.dayKey ?? 0),
        sessions: [],
        highlights: [],
        bookmarks: [],
      } as T;
    case "detect_calibre_library":
      return null as T;
    case "import_calibre_library":
      return {
        scanned: 0,
        imported: 0,
        skipped_no_format: 0,
        skipped_missing_file: 0,
      } as T;
    case "export_highlights_epub":
    case "export_highlights_csv":
      return 0 as T;
    case "fts_search":
      return [] as T;
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
        .map(
          ({
            book_title: _title,
            book_author: _author,
            book_format: _format,
            ...h
          }) => h,
        ) as T;
    case "list_all_highlights":
      return mockHighlights as T;
    case "ai_chat":
    case "ai_chat_rag":
    case "ai_summarize_highlights":
      return "这是浏览器预览模式下的 AI 示例回答。真实 AI 调用会在 Tauri 应用中使用你配置的接口。" as T;
    case "ai_extract_entities":
      return [
        {
          name: "叶文洁",
          kind: "person",
          summary: "本章中被重点提到的人物，与故事的核心经历和选择有关。",
        },
        {
          name: "红岸基地",
          kind: "place",
          summary: "本章中的关键地点，承载秘密工程和人物命运的转折。",
        },
      ] as T;
    case "test_ai_model":
      return "连接成功：预览模型已响应" as T;
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
    case "list_book_tags": {
      const bookId = Number(args?.bookId ?? 0);
      const raw = storage?.getItem(`preview_book_tags_${bookId}`);
      if (raw) return JSON.parse(raw) as T;
      const book = mockBooks.find((b) => b.id === bookId);
      return (book?.category ? [book.category] : []) as T;
    }
    case "set_book_tags": {
      const bookId = Number(args?.bookId ?? 0);
      const tags = (args?.tags as string[] | undefined) ?? [];
      storage?.setItem(`preview_book_tags_${bookId}`, JSON.stringify(tags));
      return tags as T;
    }
    case "add_book_tag": {
      const bookId = Number(args?.bookId ?? 0);
      const tag = String(args?.tag ?? "");
      const raw = storage?.getItem(`preview_book_tags_${bookId}`);
      const existing = raw ? (JSON.parse(raw) as string[]) : [];
      if (tag && !existing.includes(tag)) existing.push(tag);
      storage?.setItem(`preview_book_tags_${bookId}`, JSON.stringify(existing));
      return existing as T;
    }
    case "remove_book_tag": {
      const bookId = Number(args?.bookId ?? 0);
      const tag = String(args?.tag ?? "");
      const raw = storage?.getItem(`preview_book_tags_${bookId}`);
      const existing = raw ? (JSON.parse(raw) as string[]) : [];
      const next = existing.filter((t) => t !== tag);
      storage?.setItem(`preview_book_tags_${bookId}`, JSON.stringify(next));
      return next as T;
    }
    case "list_all_book_tags": {
      const out: { book_id: number; tag: string }[] = [];
      for (const b of mockBooks) {
        if (b.category) out.push({ book_id: b.id, tag: b.category });
      }
      return out as T;
    }
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
  getDoubanMetadata: (bookId: number) =>
    invoke<DoubanMetadata | null>("get_douban_metadata", { bookId }),
  refreshDoubanMetadata: (force = false) =>
    invoke<DoubanRefreshReport>("refresh_douban_metadata", { force }),
  removeBook: (bookId: number) => invoke<void>("remove_book", { bookId }),
  getBookByPath: (path: string) =>
    invoke<Book | null>("get_book_by_path", { path }),
  getProgress: (bookId: number) =>
    invoke<ReadingProgress | null>("get_progress", { bookId }),
  saveProgress: (
    bookId: number,
    spineIndex: number,
    scrollY: number,
    paragraphIndex?: number | null,
    charOffset?: number | null,
  ) =>
    invoke<void>("save_progress", {
      bookId,
      spineIndex,
      scrollY,
      paragraphIndex: paragraphIndex ?? null,
      charOffset: charOffset ?? null,
    }),
  createBookmark: (args: {
    bookId: number;
    spineIndex: number;
    scrollY: number;
    label: string;
    excerpt: string;
  }) => invoke<Bookmark>("create_bookmark", args),
  listRecentBookmarks: (limit = 12) =>
    invoke<BookmarkWithBook[]>("list_recent_bookmarks", { limit }),
  listBookmarksByBook: (bookId: number) =>
    invoke<Bookmark[]>("list_bookmarks_by_book", { bookId }),
  deleteBookmark: (id: number) => invoke<void>("delete_bookmark", { id }),
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
  deleteHighlight: (id: number) => invoke<void>("delete_highlight", { id }),
  aiChat: (messages: ChatMessage[]) => invoke<string>("ai_chat", { messages }),
  aiExtractEntities: (args: { chapterLabel: string; chapterText: string }) =>
    invoke<ChapterEntity[]>("ai_extract_entities", args),
  testAiModel: (settings: AiSettings) =>
    invoke<string>("test_ai_model", {
      baseUrl: settings.base_url,
      apiKey: settings.api_key,
      chatModel: settings.chat_model,
      temperature: settings.temperature ?? null,
      fastMode: settings.fast_mode ?? true,
    }),
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
  setAiSettings: (value: string) => invoke<void>("set_ai_settings", { value }),
  getMusicRoot: () => invoke<string | null>("get_music_root"),
  setMusicRoot: (path: string) => invoke<void>("set_music_root", { path }),
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
  addReadTime: (bookId: number, deltaMs: number, dayKey?: number | null) =>
    invoke<void>("add_read_time", {
      bookId,
      deltaMs,
      dayKey: dayKey ?? null,
    }),
  listCalendarDays: (fromDay: number, toDay: number) =>
    invoke<CalendarDay[]>("list_calendar_days", { fromDay, toDay }),
  getDayReading: (dayKey: number, startMs: number, endMs: number) =>
    invoke<DayReading>("get_day_reading", { dayKey, startMs, endMs }),
  // B4: per-book tags
  listBookTags: (bookId: number) =>
    invoke<string[]>("list_book_tags", { bookId }),
  setBookTags: (bookId: number, tags: string[], source: "ai" | "user" = "user") =>
    invoke<string[]>("set_book_tags", { bookId, tags, source }),
  addBookTag: (bookId: number, tag: string, source: "ai" | "user" = "user") =>
    invoke<string[]>("add_book_tag", { bookId, tag, source }),
  removeBookTag: (bookId: number, tag: string) =>
    invoke<string[]>("remove_book_tag", { bookId, tag }),
  listAllBookTags: () =>
    invoke<BookTagRow[]>("list_all_book_tags"),
  // C8: Calibre 库直连
  detectCalibreLibrary: (path: string) =>
    invoke<CalibreLibraryInfo | null>("detect_calibre_library", { path }),
  importCalibreLibrary: (path: string) =>
    invoke<CalibreImportReport>("import_calibre_library", { path }),
  // C10: 导出高亮
  exportHighlightsEpub: (bookId: number, outputPath: string) =>
    invoke<number>("export_highlights_epub", { bookId, outputPath }),
  exportHighlightsCsv: (bookId: number | null, outputPath: string) =>
    invoke<number>("export_highlights_csv", { bookId, outputPath }),
  // C1: 全文 FTS5 检索（要求该书已 index）
  ftsSearch: (query: string, bookId: number | null = null, limit = 50) =>
    invoke<FtsHit[]>("fts_search", { query, bookId, limit }),
};

export type FtsHit = {
  book_id: number;
  spine_index: number;
  snippet: string;
  book_title: string;
  book_author: string;
  book_format: string;
  book_path: string;
};

export type BookTagRow = { book_id: number; tag: string };

export type CalibreLibraryInfo = {
  root: string;
  book_count: number;
};

export type CalibreImportReport = {
  scanned: number;
  imported: number;
  skipped_no_format: number;
  skipped_missing_file: number;
};

/** 读书日历: YYYYMMDD 数字（如 20240115）= 本地时区当天。 */
export type CalendarDay = {
  day_key: number;
  total_ms: number;
  book_count: number;
};

export type DaySessionEntry = {
  book_id: number;
  book_title: string;
  book_author: string;
  book_format: string;
  book_path: string;
  read_time_ms: number;
};

export type DayReading = {
  day_key: number;
  sessions: DaySessionEntry[];
  highlights: HighlightWithBook[];
  bookmarks: BookmarkWithBook[];
};

/** 把 Date 转成 YYYYMMDD 整数（本地时区）。所有 day_key 都从这里来。 */
export function dayKeyOf(d: Date): number {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return y * 10000 + m * 100 + day;
}

/** 把 YYYYMMDD 数字还原成 Date（本地 00:00）。 */
export function dateOfDayKey(dayKey: number): Date {
  const y = Math.floor(dayKey / 10000);
  const m = Math.floor((dayKey % 10000) / 100);
  const d = dayKey % 100;
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

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

export type ChapterEntity = {
  name: string;
  kind: "person" | "place" | string;
  summary: string;
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
export type ReaderMode = "scroll" | "paged";

export type ReaderSettings = {
  font_family: ReaderFontFamily;
  font_size: number;
  line_height: number;
  column_width: number;
  theme: ReaderTheme;
  reading_mode?: ReaderMode;
  paragraph_indent: boolean;
  toc_sidebar_open: boolean;
};

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  font_family: "serif",
  font_size: 18,
  line_height: 2.0,
  column_width: 44,
  theme: "cream",
  reading_mode: "scroll",
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
