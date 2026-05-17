# 架构

> 本文档面向想读源码 / 加新功能的人。读完应该能回答：「我要加一个新命令 X，碰哪几个文件？」

---

## 总览

AIreader 是个典型的 Tauri 2 应用：**前端是浏览器进程（WebView2），后端是 Rust 主进程**，两边走 IPC。

```
┌─────────────────────────────────────────────────────────────────┐
│   WebView2 (Chromium-based)                                      │
│   ┌─ React 19 + Vite + Tailwind v4 ─────────────────────────┐   │
│   │  App.tsx (router-ish: library / reader / notes / music) │   │
│   │      ↓                                                  │   │
│   │  features/* (UI 组件，按业务切)                          │   │
│   │      ↓                                                  │   │
│   │  lib/ipc.ts  (thin wrappers over Tauri invoke + types)  │   │
│   └─────────────────────────────────────────────────────────┘   │
└──────────────────────────────────┬──────────────────────────────┘
                                   │  invoke("cmd_name", args)
                                   │  listen<T>("event-name", cb)
┌──────────────────────────────────▼──────────────────────────────┐
│   Tauri 2 Main Process (Rust)                                    │
│   ┌─ lib.rs ────────────────────────────────────────────────┐   │
│   │  generate_handler![…] 把所有 #[tauri::command] 挂出去   │   │
│   │      ↓                                                  │   │
│   │  commands.rs (薄包装：抓 AppState/AppHandle → 调业务)   │   │
│   │      ↓                                                  │   │
│   │  db / readers / library / ai / music (业务模块)         │   │
│   └─────────────────────────────────────────────────────────┘   │
└──────────────────────────────────┬──────────────────────────────┘
                                   │
                ┌──────────────────┼──────────────────────┐
                │                  │                      │
            SQLite (WAL)     文件系统               外部 LLM API
        aireader.db          covers/, embed_cache/   (OpenAI 兼容)
                             music_cache/, …
```

---

## 后端分层（`src-tauri/src/`）

```
src-tauri/src/
├── main.rs                  # 入口，调 lib::run()
├── lib.rs                   # Tauri builder + invoke_handler 注册
├── state.rs                 # AppState { db: Mutex<Connection> }
├── commands.rs              # #[tauri::command] 薄包装层
├── db.rs                    # rusqlite schema + 所有 SQL
│
├── readers/                 # 把书变成 (HTML, 文本, TOC)
│   ├── epub.rs              # epub crate + 抽 <body> 内容 + 提取封面
│   ├── txt.rs               # encoding_rs + chardetng 自动判码 + 章节正则切
│   └── docx.rs              # docx-rs 解析 paragraph styles 生成伪 TOC
│
├── library/
│   └── scanner.rs           # walkdir 扫描 + 启发式过滤"非书文件"
│                            #  + 元数据写库 + EPUB 封面缓存 + 孤儿清理
│
├── ai/
│   ├── chat.rs              # OpenAI 兼容 ChatCompletions
│                            #  ai_chat (非流式, 内部 JSON 用)
│                            #  ai_chat_stream / ai_chat_rag_stream (流式)
│                            #  ai_index_book / ai_summarize_highlights
│                            #  ai_classify_books / ai_recommend_books
│                            #  ai_tag_music_tracks / ai_recommend_music
│   ├── chunker.rs           # 段落级切片 (TARGET_CHARS = 500)
│   ├── embed.rs             # fastembed-rs 懒加载 (BGE-Small-ZH-V1.5)
│   ├── index.rs             # 切片 + 嵌入 + 写 book_chunks + 余弦检索
│   └── recommend.rs         # 阅读历史 + 标签向量 → 推荐 + 章节情绪
│
└── music/
    ├── scanner.rs           # 扫描音乐根目录，返回 Track[]
    ├── ncm.rs               # ncmdump 解密 NCM → 缓存到 music_cache/
    └── tagger.rs            # AI 给曲目打 mood tags + 描述 + embedding
```

### 设计原则

1. **commands.rs 永远薄**：只做 unwrap State → 调业务模块。不在 command 里写业务逻辑，便于单测。
2. **db.rs 集中所有 SQL**：schema、ALTER、CRUD 全在一个文件，方便对照 schema 改字段时一次性看到所有调用点。
3. **readers 统一返回 `EpubPreview`**：哪怕是 TXT / DOCX，也包装成同一个结构（`title / author / html / spine_index / spine_total`），让前端 `EpubView` 一套渲染器吃所有格式。PDF 是例外（pdf.js 自己渲染）。
4. **AI 模块分两层**：
   - 「想要 JSON 结果」的内部调用（分类、推荐理由、心情标签）走 `ai_chat()` 非流式。
   - 「给用户看字」的对话走 `ai_chat_stream` / `ai_chat_rag_stream` 流式。
   - 两套共用 `load_config()` 读 AI 设置，但 HTTP 调用路径完全分开（一个 `resp.json()`，一个 `resp.bytes_stream()`）。
5. **嵌入模型懒加载**：`embed::ensure_loaded()` 第一次调用才下载/初始化，避免冷启动卡顿。

---

## 前端分层（`src/`）

```
src/
├── App.tsx                  # 极简 router：library / reader / notes / music
├── main.tsx                 # ReactDOM.createRoot
├── index.css                # Tailwind + 字体 + CSS 变量定义主题
│
├── lib/
│   └── ipc.ts               # 所有 IPC 调用 + TypeScript 类型，单一源
│
└── features/                # 按业务切，不按"组件类型"切
    ├── library/
    │   ├── LibraryView.tsx        # 书架：搜索 / 排序 / 分类 / 推荐
    │   ├── BookCard.tsx           # 单本书卡片（封面+元数据）
    │   └── RecommendPanel.tsx     # AI 推荐展示
    │
    ├── reader/
    │   ├── EpubView.tsx           # EPUB / TXT / DOCX 共用渲染器
    │   ├── PdfView.tsx            # react-pdf 独立分支
    │   ├── TocPanel.tsx           # 左侧目录边栏
    │   ├── ReaderSettings.tsx     # 字号/字体/主题面板
    │   ├── HighlightPopover.tsx   # 选区浮动工具栏 (涂色 / 注释 / 删除)
    │   ├── LookupBubble.tsx       # ✦ 问 AI 速答气泡
    │   ├── AnnotationsPanel.tsx   # 当前书的标注列表 + AI 汇总
    │   ├── ChatPanel.tsx          # 右侧抽屉 — 三模 AI 问答 + 流式 + 引用跳转
    │   ├── MusicSuggestPanel.tsx  # 章节配乐推荐
    │   ├── highlight.ts           # 文本指纹定位 + DOM 高亮注入
    │   └── useReadTimeHeartbeat.ts# 阅读时长心跳 hook
    │
    ├── notes/
    │   ├── NotesView.tsx          # 跨书全局标注检索 + 导出
    │   └── markdown.ts            # 导出 markdown 序列化
    │
    └── music/
        ├── MusicView.tsx          # 音乐库视图
        ├── MusicMiniPlayer.tsx    # 右下角常驻 mini player
        └── MusicPlayerContext.tsx # 全局 <audio> Provider，跨视图不断流
```

### 设计原则

1. **`lib/ipc.ts` 是唯一 IPC 出口**：所有 `invoke()` 都包成 `ipc.xxx()`，组件不直接调 `invoke`。改后端 command 时只需要改这一个文件。
2. **`features/` 按业务而非组件类型切**：`reader/` 下既有页面级组件（`EpubView`）也有原子级（`LookupBubble`），但它们都属于"读书"这件事。
3. **没有全局状态库（Redux/Zustand）**：状态要么 hoist 到 `App.tsx`（view kind），要么收在 feature 内（`useState`），要么走 Context（仅 `MusicPlayerContext`）。这是有意的——业务还没大到需要状态机的程度。
4. **MusicPlayerProvider 必须在 App 根**：`<audio>` 一旦 unmount 播放就停。把它和 mini player 都挂在 `App` 根，view 切换只换 AppShell 内部内容。
5. **CSS 变量做主题**：`--color-paper / --color-ink / --color-accent / …` 在 `index.css` 按三套主题定义，组件统一用变量不写硬色。

---

## 关键数据流

### A. 打开一本 EPUB

```
LibraryView.onClick(book)
  ↓ setState
App.tsx → renders <EpubView path bookId />
  ↓ on mount
EpubView fetches:
  ├─ ipc.readBookInitial(path)        → EpubPreview (第一章 HTML + spine 总数)
  ├─ ipc.getBookToc(path)             → TocEntry[]
  ├─ ipc.getProgress(bookId)          → 上次的 spine_index / scroll_y
  ├─ ipc.listHighlightsByBook(bookId) → Highlight[]
  └─ loadReaderSettings()             → 字号/主题
  ↓
渲染 ←── chapters[spine_index].html → dangerouslySetInnerHTML
  ↓
applyHighlights(root, hls) → 走指纹定位把 <mark> 注入对应文本节点
  ↓
useReadTimeHeartbeat(bookId) 启动 30s tick
```

### B. AI 流式问答（RAG 模式）

```
ChatPanel.ask(userText)
  ↓ 立即插入 user msg + 空 assistant msg
  ↓ 生成 sessionId = crypto.randomUUID()
  ↓ listen<ChatContext>("chat-context") → 把 hits 挂到 assistant msg
  ↓ listen<ChatDelta>("chat-delta")     → 累加 delta 到 assistant.content
  ↓ ipc.aiChatRagStream({ question, bookId, history, sessionId })
       │
       ▼ (Rust)
ai_chat_rag_stream:
  ├─ embed::ensure_loaded() → embed 问题
  ├─ index::search_chunks(conn, q_emb, book_id, K=8)  → Vec<Hit>
  ├─ app.emit("chat-context", { session_id, hits })    ← (1) 先发 hits
  ├─ 拼 system prompt (含「片段 1..N」上下文)
  └─ stream_chat_to_events:
        for chunk in resp.bytes_stream():
          解析 SSE "data: {…}\n\n"
          → app.emit("chat-delta", { session_id, delta, done })  ← (2)
  ↓ frontend done=true → finish(null)
  ↓ ipc.chatHistoryAppend(role=assistant, content=accumulated)  持久化
  ↓ 用户点「片段 3」 → onJumpToChapter(hits[2].spine_index)
  ↓ EpubView.jumpToChapter(spineIdx)
```

`sessionId` 用于过滤——多个并发流不会串台。

### C. 扫描书库 + 缓存封面

```
LibraryView 「扫描书库」按钮
  ↓ ipc.scanLibrary()
  ↓ (Rust) commands::scan_library
       ├─ app.path().app_data_dir() / "covers"
       └─ scanner::scan(&conn, root, Some(covers_dir))
             ├─ walkdir 递归
             ├─ looks_like_a_book() 过滤 (size / 黑名单 / 系统目录)
             ├─ 对每个文件:
             │    ├─ extract_metadata(path)
             │    ├─ upsert_book(conn, …)
             │    └─ 若是 EPUB: maybe_cache_epub_cover() → 写 covers/{hash}.{jpg|png}
             │                  → db::set_book_cover_by_path(conn, path, cover_path)
             └─ prune_missing_books(conn, scanned_paths)  孤儿清理
  ↓ 返回 ScanReport { scanned, added_or_updated, removed }
```

---

## 状态持久化策略

| 状态 | 存哪里 | 何时写 |
|---|---|---|
| 阅读进度 (spine_index, scroll_y) | `reading_progress` 表 | 滚动事件 throttle / chapter 切换 |
| 标注 | `highlights` 表 | 涂色 / 编辑注释 / 删除立即写 |
| 阅读时长 | `books.read_time_ms` | 30s 心跳，clip ≤ 1.5× tick |
| AI 设置 | `app_config[ai_settings]` (JSON) | 设置面板保存按钮 |
| Reader 设置 | `app_config[reader_settings]` (JSON) | 字号/主题切换立即写 |
| 书库根 / 音乐根 | `app_config[library_root / music_root]` | 选目录立即写 |
| 聊天历史 | `chat_messages` 表 | user 立即写，assistant 流式完成后整段写 |
| 嵌入向量 | `book_chunks.embedding` (f32 LE blob) | 索引时一次写完 |
| 音乐标签 | `track_tags.embedding` | 批量打标时一次写完 |
| EPUB 封面 | `{appData}/covers/{hash}.{ext}` + `books.cover_path` | 扫描时写 |
| NCM 解密缓存 | `{appData}/music_cache/{hash}.{ext}` | 首次播放时写 |
| 嵌入模型 | `{appData}/embed_cache/` (fastembed 内部) | 首次 `embed::ensure_loaded()` 时下载 |

详见 [`DATA_MODEL.md`](./DATA_MODEL.md)。

---

## 错误处理 / 边界

- **rusqlite 操作全 `Result`**：在 `commands.rs` 转 `String` 透传给前端。
- **AI 请求超时**：非流式 90s，流式 180s（fastembed + LLM 链路较长）。
- **流式中断**：emit `chat-delta { done: true, error: Some(...) }`，前端回滚 pending assistant msg。
- **PDF mojibake**：pdf.js 撑住 CMap 后仍可能存在「PDF 自身字典损坏」情况（金庸老 PDF 常见），文档级限制，不抛错只显示乱码。
- **EPUB 没封面 / 没 TOC**：fallback 到 placeholder / spine 顺序伪 TOC，不阻塞打开。
- **嵌入模型下载失败**：抛 fastembed 错误给前端 UI，用户可重试。

---

## 扩展指南

加一个新的 Tauri command：

1. 在合适的 `src-tauri/src/*` 模块写业务函数。
2. 在 `commands.rs` 加 `#[tauri::command] pub fn xxx(...)` 薄包装（或者直接在业务模块加，看分层）。
3. 在 `lib.rs` 的 `generate_handler![...]` 数组里加上完整路径。
4. 在 `src/lib/ipc.ts` 加 wrapper + TypeScript 类型。
5. UI 调 `ipc.xxx(...)`。

加一个新的 Tauri event（异步推送）：

1. Rust 端：`app.emit("event-name", payload)` (payload 必须 `Serialize + Clone`)。
2. 前端：`listen<PayloadType>("event-name", cb)`，记得 cleanup 时 `unlisten()`。
3. 现有 pattern：`index-progress` / `classify-progress` / `tag-progress` / `chat-delta` / `chat-context`。

加一个新的格式 reader：

1. `src-tauri/src/readers/{format}.rs`：实现 `read_xxx_initial` / `read_xxx_chapter` / `get_xxx_toc`，返回 `EpubPreview` / `TocEntry[]`。
2. `lib.rs` 注册。
3. `src/lib/ipc.ts` 的 `readBookInitial / readBookChapter / getBookToc` switch 加分支。
4. `src-tauri/src/library/scanner.rs::SUPPORTED_EXTS` 加扩展名 + `extract_metadata` 加分支。

---

## 已知的「为什么这么写」

- **不用 sqlx**：rusqlite + bundled SQLite 是单文件 zero-dep 部署，sqlx 的 compile-time check + async 在桌面单连接场景无收益。
- **不用全文搜索 (FTS5)**：当前规模（个人书库）下 `LIKE '%q%'` 完全够用，FTS5 的额外索引 + 中文分词成本大于收益。
- **不用 vector DB**：所有片段都在 SQLite blob 里，检索时全量加载到内存做余弦。普通书库（< 1000 本，< 100 万片段）下完全够；超过这个量再考虑 sqlite-vss 或外部 store。
- **PDF 走 react-pdf 而非自己包 pdfium**：rust 生态没有真正稳定的 pdfium 绑定；pdf.js 虽慢但能跑。
- **嵌入用 BGE-Small-ZH 而非 multilingual**：库以中文为主，small 版本 120 MB 比 multilingual base 节省 4-5 倍体积和推理时间。
