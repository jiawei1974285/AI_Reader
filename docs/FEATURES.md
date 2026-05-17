# 功能详解

> 本文按功能模块逐一解释 **能做什么 / 不能做什么 / 怎么实现的 / 触发哪条命令**。

---

## 1. 多格式阅读

### 支持格式

| 格式 | 渲染路径 | TOC 来源 | 限制 |
|---|---|---|---|
| EPUB | epub crate → `<body>` 抽取 → HTML 直接渲染 | epub `nav.xhtml` / spine 顺序 fallback | 加密 EPUB 不支持 |
| TXT | encoding_rs 自动判码 → 段落切分 | 章节正则（"第 N 章" 等）/ 按段数兜底 | 全文一次性读入内存 |
| DOCX | docx-rs 解析 paragraph styles | 按 Heading 样式生成 | 表格 / 图片仅做基础呈现 |
| PDF | pdf.js (`react-pdf`) | PDF outline | 无 ToUnicode CMap 的 PDF 会乱码（PDF 本身缺陷） |
| MOBI | mobi crate → `content_as_string_lossy()` → 按 `<mbp:pagebreak/>` 切伪章节 | `<h1>/<h2>/<h3>` 标签作 label，否则「第 N 章」 | DRM / KF8-only 不支持；不抽封面（用 placeholder） |

### 章节切换
- 滚动到下一章末尾 → 自动按 spine_index + 1 加载下一章拼接在尾部（无限滚）。
- 左侧目录点击 → `jumpToChapter(spineIdx)`：已加载就 scrollIntoView，未加载则 fetch + 跳。

### 续读
`reading_progress` 表存 `(book_id, spine_index, scroll_y)`，每次滚动 throttle 后写库。打开同一本书自动恢复。

### 阅读时长
`useReadTimeHeartbeat(bookId)`：

- TICK_MS = 30s
- 监听 `visibilitychange / focus / blur`：窗口被隐藏 / 失焦时暂停累加。
- 单 tick clip 到 `TICK_MS * 1.5`，防系统休眠后一觉醒来灌好几小时。
- 卸载时把残余时间一并 bank。
- 写入 `books.read_time_ms`。书架卡片 `> 60s` 才显示 `1h25m` 格式。

### Reader 设置
持久化 `app_config[reader_settings]`：

```json
{
  "font_family": "serif" | "sans",
  "font_size": 14..24,
  "line_height": 1.6..2.4,
  "column_width": 36..56,       // ch unit
  "theme": "cream" | "white" | "dark",
  "paragraph_indent": boolean,
  "toc_sidebar_open": boolean
}
```

主题通过 CSS 变量切：`--color-paper / --color-ink / --color-accent / …`。

---

## 2. 书架（LibraryView）

### 扫描 + 自动同步
1. 设置「书库根目录」（持久化 `app_config[library_root]`）。
2. 进入书架时自动启动**文件监听**（`notify-debouncer-full`，2s 聚合窗口）：用户往书库扔新书 / 删书 / 改名时，后台自动 rescan + `library-changed` 事件刷新书架，不用手点。
3. 「扫描书库」按钮 → `ipc.scanLibrary()` 仍保留，用于强制全量扫描：
   - walkdir 递归
   - `looks_like_a_book()` 启发式过滤：
     - 大小 < 5 KB 跳过
     - 文件名匹配黑名单（README / changelog / license / sample / demo / test 等）跳过
     - 落在系统目录（node_modules / .git / __MACOSX 等）跳过
   - 元数据 (`title` / `author`) 抽取，新书 INSERT / 已存在 UPDATE
   - EPUB 顺手抽封面缓存
   - 「磁盘上消失但库里还在」的孤儿删掉

返回 `ScanReport { scanned, added_or_updated, removed }`。

### 搜索 / 排序 / 筛选
全前端实现（`useMemo` 链）：

```
allBooks
  → filter by category (顶部 chip)
  → filter by search query (顶部 input, debounce 200ms, 匹配 title/author)
  → sort by (added_desc | read_desc | title_asc | author_asc)
```

搜索词 + 排序选择持久化到 `localStorage[library_search / library_sort]`。

### 封面
- **EPUB**：扫描时 `doc.get_cover() -> (Vec<u8>, String)`，按 mime 决定 jpg/png，hash(file_path) 作文件名写到 `{appData}/covers/`，路径回填到 `books.cover_path`。
- **非 EPUB / 没封面**：`BookCard` 用 `hash(title) % 7` 选一组渐变色，加上 `title.charAt(0)` 作大字 placeholder。

### AI 分类
`ai_classify_books(force?)`：
- 把没分类的书每 20 本一批发给 LLM，要求只回 JSON 数组（11 个固定类别选一）。
- `normalize_category()` 把"近似"答案 snap 回标准列表，未匹配落 "其他"。
- 进度通过 `classify-progress` 事件推送。
- `force=true` 时连已有分类的书也重跑。

### AI 推荐
`ai_recommend_books({ anchorBookId, topK, withReasons })`：
- 基于阅读历史（read_time_ms）+ 分类相似度 + 封面/标题 embedding 做协同。
- `withReasons=true` 时多走一步 LLM，给每个推荐写一句「为什么推荐」。

---

## 3. 标注 / 注释

### 涂色 + 写注释
- 选中正文文字 → `HighlightPopover` 浮在选区上方/下方。
- 5 色按钮 → 立即 `ipc.createHighlight(...)`。
- 同一高亮再点 → 弹注释编辑框 + 删除按钮。

### 锚定方式
| 格式 | 锚定 |
|---|---|
| EPUB / TXT / DOCX | 文本指纹 `prefix(40) + selected_text + suffix(40)` |
| PDF | pdf 页号 + 矩形坐标（react-pdf 提供） |

文本指纹的好处：章节内容做小修改不会让所有标注全失效，搜索 prefix+text+suffix 仍能精准定位。
缺点：跨章节移动 / 重排时仍会失锚（rare，未做迁移）。

### 注入高亮
`highlight.ts::applyHighlights(root, hls)`：

1. 在 DOM 里 walk text nodes。
2. 对每条 highlight 找出 `text + prefix + suffix` 拼接后的连续匹配。
3. 用 `<mark>` 包裹匹配的子串，注入颜色 CSS 类。
4. 落不到的（章节变了 / 内容更新了）记录到一个 fallback bag，下一次再试（保险）。

### 全局笔记视图（`NotesView`）
- 查所有书的所有 highlight：`ipc.listAllHighlights(query)`。
- 顶部搜索框模糊匹配 selected_text + note + book_title + book_author。
- 点单条 → 跳到对应书的对应章节并 flash 该 highlight。
- 「导出 Markdown」：见 `notes/markdown.ts`，按书分组，输出 H1 书名 + 每条 highlight 的引用块 + 注释。

### AI 章节汇总
`AnnotationsPanel` → 「✦ AI 汇总」按钮：
- 把当前书的所有 highlight + note 喂给 LLM。
- system: "你是一个善于提炼读书笔记的助手。"
- user: 列出所有 clipping 要求 5-7 条要点 + 1-2 条主线。
- 走 `ai_summarize_highlights(bookId)`（非流式，因为短）。

---

## 4. AI 问答

### 三种模式

| 模式 | 数据源 | 命令 | 是否需要索引 |
|---|---|---|---|
| 当前章节 | 当前章节正文 (truncate 到 6000 字) 直接做 system prompt | `ai_chat_stream` | 否 |
| 整本书 | 嵌入检索 top-K 片段 | `ai_chat_rag_stream` (book_id 限定) | 是，必须先索引 |
| 全书库 | 嵌入检索 top-K 片段 (跨所有书) | `ai_chat_rag_stream` (book_id=null) | 是，每本都要先索引 |

### 索引一本书 (`ai_index_book`)
1. 抽全书每章正文（调对应 reader 的 `read_*_chapter`）。
2. `chunker::chunk_text` 按段落聚合，TARGET_CHARS = 500，MIN_CHARS 保底。
3. `embed::ensure_loaded` 第一次会下载 BGE-Small-ZH-V1.5 ONNX 模型到 `{appData}/embed_cache/`，~120 MB。
4. `TextEmbedding::embed(chunks)` 拿到 f32 向量。
5. 写 `book_chunks (book_id, spine_index, chunk_index, text, embedding BLOB, created_at)`。
6. 更新 `book_index_status { status: "ready", chunks_count, indexed_at }`。
7. 每章发一个 `index-progress { book_id, current, total }` 事件。

### RAG 检索 (`index::search_chunks`)
- 嵌入问题为单个向量。
- 全量读 `book_chunks`（按 book_id 过滤或不过滤），算余弦相似度。
- 取 top K=8 → 拼成「片段 1..N」上下文喂给 LLM。

### 流式回答
`stream_chat_to_events`：

- 设 `body.stream = true`。
- `resp.bytes_stream()` 拿到字节流。
- 累积到 line buffer，按 `\n\n` 切 SSE 消息。
- 每行去 `data: ` 前缀：
  - `data: [DONE]` → `emit("chat-delta", { done: true })`，return。
  - JSON → 取 `choices[0].delta.content` → `emit("chat-delta", { delta, done: false })`。
- 整个流程不阻塞 IPC return —— `ai_chat_stream` 立刻返回 `()`，结果通过事件推送。

### 引用跳转
RAG 模式独有：
1. 后端 RAG 检索完成后，**先**发一个 `chat-context { session_id, hits: ChatHit[] }`。
2. 前端 `ChatPanel` 把 hits 挂到 pending assistant msg。
3. 流式 delta 累加到 content。
4. `renderCitations()` 在渲染 assistant msg 时用 `/片段\s*(\d+)/g` 切分，命中 hits 数组下标的「片段 N」渲染成可点的小药丸。
5. 点击 → 关闭 ChatPanel → `EpubView.jumpToChapter(hits[n-1].spine_index)`。
6. 未命中（LLM 编了一个不存在的编号）→ 渲染为纯文本，不假装能跳。

### 历史持久化
- DB 表 `chat_messages (book_id, mode, spine_index, role, content, created_at)`。
- 会话 key = `(book_id, mode, spine_index)`：
  - chapter 模式：spine_index = 当前章节
  - book / library 模式：spine_index = -1
- user 消息：发送时立即写。
- assistant 消息：流式完成后整段写（中途中断 / 错误不持久化部分）。
- 「清空」按钮：删当前会话 key 下所有消息。

### 划词速问（`LookupBubble`）
- 选区工具栏「✦ 问 AI」按钮。
- 弹小气泡（HighlightPopover 同款定位逻辑）。
- system: "你是一个简洁的阅读助手。请用 30-60 字解释、翻译或提供文化背景。"
- user: 选中的文字。
- 走 `ipc.aiChat()`（非流式，30-60 字延迟可接受 + 不需要历史）。
- ESC / 外点关闭。

---

## 5. 背景音乐

### 播放
- 「音乐」视图列出 `music_root` 下所有支持格式。
- 点击播放 / 暂停。
- 右下角 `MusicMiniPlayer` 常驻：换书、跳章不打断（`<audio>` 挂在 `App` 根的 `MusicPlayerProvider`）。

### NCM 解密
NCM = 网易云加密格式。HTML5 audio 不认。

流程：
1. 用户点击播放 NCM。
2. `MusicPlayerContext` 查 `ncmSrcCache: Map<path, string>`。
3. 没缓存 → `ipc.decryptNcm(path)`：
   - Rust 用 ncmdump 解密。
   - 写到 `{appData}/music_cache/{hash}.{ext}`（mp3 / flac 视原始格式）。
   - 返回缓存路径。
4. `convertFileSrc(cached_path)` 喂给 `<audio>`。
5. 缓存路径塞回 map，下次直接用。

### 歌词显示（LRC 同步）
- 同目录下放一个同名 `.lrc` 文件（例：`song.mp3` 配 `song.lrc`） → mini player 的「词」按钮一键打开歌词面板。
- 解析 `[mm:ss.xx]` 时间戳（含多戳行 `[00:01][00:05]` 共用文本）。
- 当前行高亮 + 居中自动滚动；点任意行可跳转到该时间。
- 编码自动判断（UTF-8 / UTF-16 / GBK 都行，走 chardetng）。
- 无 .lrc 时显示「没找到歌词」提示，不报错。
- 切歌自动重载。

### 章节配乐推荐（`MusicSuggestPanel`）
1. 「为本章推荐」按钮 → `ai_recommend_music(chapterText, topK)`。
2. Rust 端：
   - LLM 给章节打 mood_tags + description（限制 3000 字 snippet）。
   - 嵌入 description → 余弦检索 `track_tags.embedding`。
   - 返回 top-K + 各自的 score。
3. 前端展示，点哪首播哪首。

### 批量打标（`ai_tag_music_tracks`）
1. 扫描 `music_root` → 没标过的曲目。
2. 每首调 LLM：根据文件名（含曲名 / 演奏者 / 专辑常见词）猜 mood + 写一句描述。
3. 嵌入描述 → 写 `track_tags` 表。
4. 进度通过 `tag-progress` 事件推送。
5. 已标过 + 文件 mtime 没变 → 跳过；mtime 变了 → 重标。

---

## 6. 阅读统计

目前仅累计阅读时长（`books.read_time_ms`），书架卡片右下显示。

未实现（roadmap）：
- 日 / 周 / 月阅读时长图表
- 阅读速度（字/分钟）
- 完读率
- 阅读热力图

---

## 7. 隐私 / 离线

| 数据 | 出网吗 |
|---|---|
| 书内容、笔记、聊天历史、音乐索引 | 不出 |
| 嵌入计算 | 不出（fastembed-rs 本地 ONNX runtime） |
| 封面图、NCM 解密缓存 | 不出 |
| AI 对话（chat / chat_rag / 分类 / 推荐 / 心情标签） | 出 — 你**自己配置的** LLM 网关 |
| Reader / AI 设置 | 不出（本地 SQLite） |

唯一出网点：你主动触发 AI 功能时，prompt（含检索到的片段 / 当前章节 / 标注内容）→ 你的 LLM 网关。

---

## 8. 已知限制

- **PDF mojibake**：缺 ToUnicode CMap 的老 PDF（部分老金庸 / 老古龙扫描转的）字体字典损坏，pdf.js 无法解 unicode，正文显示乱码。这是 PDF 本身的问题，AIreader 已经做了 CMaps + standard_fonts + useSystemFonts 三重保险，但本质无解。建议这类书转 EPUB 后再读。
- **EPUB 加密**：不支持 Adobe DRM / Apple DRM。
- **TXT 全量读入**：超过 50 MB 的纯文本会卡。可以先 split 再读。
- **DOCX 复杂排版**：表格、嵌套列表、艺术字、SmartArt 仅做基础呈现，不保证视觉一致。
- **嵌入模型仅中文优化**：BGE-Small-ZH-V1.5 在英文上效果一般。如果你的库以英文为主，可以改 `embed.rs` 换 `BGESmallEN` / `BGEBaseEN`。
- **跨设备同步**：当前完全本地。需要同步可以把 `%APPDATA%/com.aireader.app/` 整个塞进网盘 / Git LFS。
