import { invoke } from "@tauri-apps/api/core";

function isTxt(path: string): boolean {
  return path.toLowerCase().endsWith(".txt");
}

function isDocx(path: string): boolean {
  return path.toLowerCase().endsWith(".docx");
}

function isMobi(path: string): boolean {
  return path.toLowerCase().endsWith(".mobi");
}

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

export const ipc = {
  getLibraryRoot: () => invoke<string | null>("get_library_root"),
  setLibraryRoot: (path: string) => invoke<void>("set_library_root", { path }),
  scanLibrary: () => invoke<ScanReport>("scan_library"),
  startLibraryWatcher: () => invoke<boolean>("start_library_watcher"),
  listBooks: () => invoke<Book[]>("list_books"),
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
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  base_url: "",
  api_key: "",
  chat_model: "",
  temperature: null,
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
