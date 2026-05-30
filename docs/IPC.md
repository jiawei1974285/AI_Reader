# IPC 参考

> 完整的 Tauri command 清单 + Tauri event 清单。所有命令在 `src-tauri/src/lib.rs::invoke_handler` 注册，所有前端调用统一走 `src/lib/ipc.ts`。

约定：
- Rust 端 `book_id`（snake_case）；前端调用时传 `bookId`（camelCase），Tauri 框架自动转换。
- 所有命令返回 `Result<T, String>`；失败时前端 `await` 抛 Promise reject，`String` 即错误信息。

---

## 命令清单

### 书库

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `get_library_root` | — | `Option<String>` | 取已设置的书库根目录 |
| `set_library_root` | `path: String` | `()` | 设置 / 切换书库根 |
| `scan_library` | — | `ScanReport` | 全量扫描，返回 `{ scanned, added_or_updated, removed }` |
| `import_dropped_books` | `paths: Vec<String>` | `ImportDroppedBooksReport` | 拖入书籍后复制到当前书库并扫描 |
| `start_library_watcher` | — | `bool` | 启动/重启文件监听；`true` 表示已激活，`false` 表示没有 library_root |
| `list_books` | — | `Vec<Book>` | 列出书库所有书（含 `last_read_at` LEFT JOIN 和 `user_rating`） |
| `set_book_rating` | `bookId, rating: i64/null` | `()` | 设置 1–5 星个人评分；`null` 清空评分 |
| `get_book_by_path` | `path: String` | `Option<Book>` | 按绝对路径查 |

### 阅读 / 进度

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `get_progress` | `book_id: i64` | `Option<ReadingProgress>` | 取上次进度 |
| `save_progress` | `book_id, spine_index, scroll_y` | `()` | 保存进度（throttle 调用） |
| `create_bookmark` | `bookId, spineIndex, scrollY, label, excerpt` | `Bookmark` | 保存当前阅读位置为书签 |
| `list_recent_bookmarks` | `limit?: i64` | `Vec<BookmarkWithBook>` | 首页读取最近书签入口 |
| `add_read_time` | `book_id, delta_ms: i64` | `()` | 累计阅读时长（心跳调） |

### Reader 设置

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `get_reader_settings` | — | `Option<String>` | 返回 JSON 字符串，前端 parse |
| `set_reader_settings` | `value: String` | `()` | 整体覆盖 |

### 内容读取（按格式分支）

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `read_epub_preview` | `path: String` | `EpubPreview` | 第一章 |
| `read_epub_chapter` | `path, spine_index` | `EpubPreview` | 指定章 |
| `get_book_toc` | `path: String` | `Vec<TocEntry>` | EPUB TOC |
| `read_txt_initial` | `path: String` | `EpubPreview` | TXT 第一章 |
| `read_txt_chapter` | `path, spine_index` | `EpubPreview` | TXT 指定章 |
| `get_txt_toc` | `path: String` | `Vec<TocEntry>` | TXT 自动切的章节 |
| `read_docx_initial` | `path: String` | `EpubPreview` | DOCX 第一章 |
| `read_docx_chapter` | `path, spine_index` | `EpubPreview` | DOCX 指定章 |
| `get_docx_toc` | `path: String` | `Vec<TocEntry>` | DOCX 按 Heading 抽 |
| `read_mobi_initial` | `path: String` | `EpubPreview` | MOBI / AZW / AZW3 第一章；加密或不可可靠解析时返回错误 |
| `read_mobi_chapter` | `path, spine_index` | `EpubPreview` | MOBI / AZW / AZW3 指定章 |
| `get_mobi_toc` | `path: String` | `Vec<TocEntry>` | MOBI / AZW / AZW3 按 pagebreak、标题或长度 fallback 切章节 |

> PDF 不走 Tauri，直接 `convertFileSrc(path)` 喂给 react-pdf。

### 标注

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `create_highlight` | `bookId, spineIndex, selectedText, prefix, suffix, color, note` | `Highlight` | 创建一条 |
| `list_highlights_by_chapter` | `bookId, spineIndex` | `Vec<Highlight>` | 当前章高亮 |
| `list_highlights_by_book` | `bookId` | `Vec<Highlight>` | 当前书所有 |
| `list_all_highlights` | `query: String\|null` | `Vec<HighlightWithBook>` | 全库搜（NotesView） |
| `update_highlight` | `id, color, note` | `()` | 改颜色 / 注释 |
| `delete_highlight` | `id` | `()` | 删 |

### AI — 设置

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `get_ai_settings` | — | `Option<String>` | JSON 字符串 |
| `set_ai_settings` | `value: String` | `()` | 整体覆盖 |
| `test_ai_model` | `baseUrl, apiKey, chatModel, temperature?, fastMode?` | `String` | 用非流式 ChatCompletions 链路测试模型是否可用 |

### AI — 聊天

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `ai_chat` | `messages: Vec<ChatMessage>` | `String` | 非流式，给内部 JSON 返回类调用用（分类、推荐、标签） |
| `ai_chat_stream` | `messages, session_id` | `()` | 流式，结果通过 `chat-delta` 事件推送 |
| `ai_chat_rag` | `question, bookId?, history` | `String` | 非流式 RAG（已废弃，保留兼容） |
| `ai_chat_rag_stream` | `question, bookId?, history, session_id` | `()` | 流式 RAG，先发 `chat-context` 后流 `chat-delta` |
| `ai_extract_entities` | `chapterLabel, chapterText` | `Vec<ChapterEntity>` | 提取当前章节人名 / 地名和简介 |
| `ai_summarize_highlights` | `bookId` | `String` | 把当前书所有 highlight 喂 LLM 输出要点 + 主线 |

### AI — 索引 / 推荐 / 分类

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `ai_index_book` | `bookId, bookPath` | `usize` | 切片 + 嵌入 + 写库，返回 chunks 数量；进度通过 `index-progress` |
| `ai_get_index_status` | `bookId` | `Option<BookIndexStatus>` | `{ status, chunks_count, indexed_at, error }` |
| `ai_recommend_books` | `anchorBookId?, topK, withReasons?` | `Vec<Recommendation>` | top-K 推荐 + 可选 LLM 写理由 |
| `ai_classify_books` | `force?` | `ClassifyReport` | 批量分类；进度 `classify-progress` |

### AI — 音乐

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `ai_tag_music_tracks` | — | `TagReport` | 批量打标；进度 `tag-progress` |
| `ai_recommend_music` | `chapterText, topK` | `ChapterMoodWithRecs` | 章节情绪 + 推荐 |

### 历史持久化

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `chat_history_load` | `bookId, mode, spineIndex` | `Vec<ChatHistoryMsg>` | 加载会话历史 |
| `chat_history_append` | `bookId, mode, spineIndex, role, content` | `()` | 追加一条 |
| `chat_history_clear` | `bookId, mode, spineIndex` | `()` | 清空当前会话 |

### 音乐

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `get_music_root` | — | `Option<String>` | |
| `set_music_root` | `path` | `()` | |
| `scan_music` | — | `Vec<Track>` | 不入库，直接返回扫描结果 |
| `decrypt_ncm` | `path` | `String` | 返回解密后的缓存路径 |
| `read_lrc` | `audio_path: String` | `Option<String>` | 读取同目录同名 .lrc 文件文本（自动判码），无文件返回 None |
| `list_track_tags` | — | `Vec<TrackTagMeta>` | 已打标的曲目元数据（mood_tags 是 JSON 字符串） |

---

## Tauri events（后端 → 前端推送）

所有 event 通过 `app.emit(name, payload)` 发，前端 `listen<PayloadType>(name, cb)` 收。

| 事件名 | Payload | 何时发 |
|---|---|---|
| `index-progress` | `{ book_id, current, total }` | 每索引完一章发一次 |
| `classify-progress` | `{ current, total }` | 每批分类完发一次 |
| `tag-progress` | `{ current, total }` | 每打标一首发一次 |
| `chat-delta` | `{ session_id, delta, done, error? }` | 流式 chat 每 token / 流结束 / 错误时 |
| `chat-context` | `{ session_id, hits: ChatHit[] }` | RAG 流式开始前发**一次**，把检索到的片段交给 UI |
| `library-changed` | `ScanReport` | 文件 watcher 检测到书库变化、自动 rescan 完成后发 |

### 过滤约定

`chat-delta` 和 `chat-context` 都带 `session_id`，前端必须用自己请求时的 ID 过滤，否则并发会话会串台：

```ts
const sessionId = crypto.randomUUID();
const unlisten = await listen<ChatDelta>("chat-delta", (e) => {
  if (e.payload.session_id !== sessionId) return;  // ← 必须
  // …
});
await ipc.aiChatStream(messages, sessionId);
```

---

## 类型定义

### Book
```ts
type Book = {
  id: number;
  file_path: string;
  format: "epub" | "txt" | "pdf" | "docx" | "mobi" | "azw" | "azw3";
  title: string;
  author: string;
  added_at: number;       // unix ms
  file_size: number;      // bytes
  file_modified: number;  // unix ms
  category: string;       // 11 个固定类别之一，或 ""
  last_read_at: number | null;
  cover_path: string | null;
  read_time_ms: number;
  user_rating: number | null;
};
```

### ChapterEntity
```ts
type ChapterEntity = {
  name: string;
  kind: "person" | "place" | string;
  summary: string;
};
```

### ReadingProgress
```ts
type ReadingProgress = {
  book_id: number;
  spine_index: number;
  scroll_y: number;
  updated_at: number;
};
```

### EpubPreview
```ts
type EpubPreview = {
  title: string;
  author: string;
  html: string;            // <body> 内的 HTML 片段，直接 dangerouslySetInnerHTML
  raw_length: number;
  extracted_length: number;
  spine_index: number;     // 当前章
  spine_total: number;     // 全书章节数
};
```

### TocEntry
```ts
type TocEntry = {
  spine_index: number;
  label: string;
  depth: number;           // 缩进层级，0 = 顶级
};
```

### Highlight
```ts
type Highlight = {
  id: number;
  book_id: number;
  spine_index: number;
  selected_text: string;
  prefix: string;          // 选区前 ~40 字
  suffix: string;          // 选区后 ~40 字
  color: string;           // "yellow" / "pink" / "green" / "blue" / "purple"
  note: string;
  created_at: number;
  updated_at: number;
};

type HighlightWithBook = Highlight & {
  book_title: string;
  book_author: string;
  book_format: string;
};
```

### Bookmark / BookmarkWithBook
```ts
type Bookmark = {
  id: number;
  book_id: number;
  spine_index: number;
  scroll_y: number;
  label: string;
  excerpt: string;
  created_at: number;
};

type BookmarkWithBook = Bookmark & {
  book_title: string;
  book_author: string;
  book_format: string;
  book_path: string;
};
```

### ChatMessage / ChatDelta / ChatHit / ChatContext
```ts
type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatDelta = {
  session_id: string;
  delta: string;
  done: boolean;
  error: string | null;
};

type ChatHit = {
  spine_index: number;
  text: string;
};

type ChatContext = {
  session_id: string;
  hits: ChatHit[];
};

type ChatHistoryMsg = {
  role: string;
  content: string;
  created_at: number;
};
```

### BookIndexStatus
```ts
type BookIndexStatus = {
  book_id: number;
  status: "pending" | "indexing" | "ready" | "error" | string;
  chunks_count: number;
  indexed_at: number | null;
  error: string | null;
};
```

### Recommendation / ClassifyReport
```ts
type Recommendation = {
  book: Book;
  score: number;
  reason: string;       // LLM 写的理由（withReasons=false 时为空）
};

type ClassifyReport = {
  total: number;
  classified: number;
  skipped: number;
  failed: number;
};
```

### Music
```ts
type Track = {
  path: string;
  filename: string;
  format: "mp3" | "flac" | "wav" | "m4a" | "ogg" | "aac" | "ncm" | string;
  size_bytes: number;
  modified_at: number;
};

type TrackTagMeta = {
  track_path: string;
  file_mtime: number;
  mood_tags: string;          // JSON string, parse to string[]
  description: string;
  tagged_at: number;
};

type TagReport = {
  total: number;
  tagged: number;
  skipped: number;
  failed: number;
};

type MusicRecommendation = {
  track_path: string;
  filename: string;
  mood_tags: string[];
  description: string;
  score: number;
};

type ChapterMoodWithRecs = {
  mood_tags: string[];
  description: string;
  recommendations: MusicRecommendation[];
};
```

### AiSettings / ReaderSettings
```ts
type AiSettings = {
  base_url: string;       // 不带 /v1 后缀
  api_key: string;
  chat_model: string;
  temperature?: number | null;
};

type ReaderSettings = {
  font_family: "serif" | "sans";
  font_size: number;       // 14..24
  line_height: number;     // 1.6..2.4
  column_width: number;    // 36..56 (ch unit)
  theme: "cream" | "white" | "dark";
  paragraph_indent: boolean;
  toc_sidebar_open: boolean;
};
```

---

## 错误信息约定

后端命令返回 `Result<T, String>`，所有错误是中文 / 英文混杂的人类可读字符串，前端直接拿去显示。规范：

| 类别 | 前缀 | 示例 |
|---|---|---|
| 配置缺失 | （直接描述） | `"AI 设置未配置：请在设置中填入 base_url / api_key / chat_model"` |
| 上游 API 错误 | `"API 错误 {status}: …"` | `"API 错误 401: invalid api key"` |
| 网络 | `"请求失败: …"` | `"请求失败: timed out"` |
| 解析 | `"…解析失败: …"` | `"响应解析失败: missing field 'choices'"` |
| 资源未找到 | （直接描述） | `"找不到这本书"` / `"未找到相关内容"` |

前端约定：捕获到 error 后塞到 `setError(String(e))` 显示在 UI，**不要**重写或翻译错误文案。
