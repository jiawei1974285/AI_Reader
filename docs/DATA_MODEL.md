# 数据模型

> SQLite 表结构 + 磁盘文件布局 + 数据生命周期。

---

## 磁盘布局

所有持久化数据放在 Tauri 的 `app_data_dir`：

```
%APPDATA%\com.aireader.app\         (Windows)
~/Library/Application Support/com.aireader.app/  (macOS, 未官方支持)
~/.local/share/com.aireader.app/    (Linux, 未官方支持)
│
├── aireader.db                  # SQLite，所有结构化数据
├── aireader.db-wal              # WAL 日志（rusqlite 自动管理）
├── aireader.db-shm              # 共享内存
│
├── covers/                      # EPUB 封面缓存
│   ├── a3f8b21e.jpg             # 文件名 = hash(file_path)
│   ├── 7c2d4f55.png
│   └── …
│
├── embed_cache/                 # fastembed-rs 模型缓存（首次自动下载）
│   └── models--Xenova--bge-small-zh-v1.5/
│       ├── tokenizer.json
│       ├── model.onnx           # ~120 MB
│       └── …
│
└── music_cache/                 # NCM 解密缓存
    ├── 1a2b3c4d.mp3
    └── …
```

**完全删 app 痕迹**：删 `%APPDATA%\com.aireader.app\` 整个目录即可，等于全新安装。

---

## 数据库 schema

完整 schema 见 `src-tauri/src/db.rs::SCHEMA_SQL`。下面按表分组说明。

### `books` — 书目

```sql
CREATE TABLE books (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path       TEXT NOT NULL UNIQUE,        -- 绝对路径
    format          TEXT NOT NULL,               -- "epub" / "pdf" / "txt" / "docx"
    title           TEXT NOT NULL,
    author          TEXT NOT NULL,
    added_at        INTEGER NOT NULL,            -- unix ms
    file_size       INTEGER NOT NULL,            -- bytes
    file_modified   INTEGER NOT NULL,            -- unix ms
    -- 后续 ALTER 加的列：
    category        TEXT NOT NULL DEFAULT '',    -- 11 个分类之一，'' = 未分类
    cover_path      TEXT,                        -- {appData}/covers/{hash}.{ext}，NULL = 用 placeholder
    read_time_ms    INTEGER NOT NULL DEFAULT 0   -- 累计阅读时长
);
CREATE INDEX idx_books_added_at ON books(added_at DESC);
```

> `list_books` 查询时 `LEFT JOIN reading_progress` 取 `MAX(updated_at)` 拼成 `last_read_at`（不入此表）。

### `reading_progress` — 续读位置

```sql
CREATE TABLE reading_progress (
    book_id      INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    spine_index  INTEGER NOT NULL DEFAULT 0,    -- 当前章
    scroll_y     REAL    NOT NULL DEFAULT 0,    -- 当前章内的 scrollTop
    updated_at   INTEGER NOT NULL
);
```

一个 book 一条记录。书删除时级联清。

### `app_config` — 杂项 KV

```sql
CREATE TABLE app_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL                          -- 任意字符串，多为 JSON
);
```

常驻 key：

| key | value 形式 | 说明 |
|---|---|---|
| `library_root` | 路径字符串 | 书库根 |
| `music_root` | 路径字符串 | 音乐根 |
| `ai_settings` | JSON | `{ base_url, api_key, chat_model, temperature? }` |
| `reader_settings` | JSON | `ReaderSettings` 类型 |

### `highlights` — 标注

```sql
CREATE TABLE highlights (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id        INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    spine_index    INTEGER NOT NULL,
    selected_text  TEXT NOT NULL,
    prefix         TEXT NOT NULL,                -- 选区前 ~40 字
    suffix         TEXT NOT NULL,                -- 选区后 ~40 字
    color          TEXT NOT NULL DEFAULT 'yellow',
    note           TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_highlights_book    ON highlights(book_id);
CREATE INDEX idx_highlights_chapter ON highlights(book_id, spine_index);
```

> **锚定策略**：用 `prefix + selected_text + suffix` 做文本指纹定位，对小幅度内容变化鲁棒（详见 ARCHITECTURE.md 4.B）。PDF 例外，用 `page + rect` 存在 `prefix/suffix` 里（约定俗成的小 hack，未来可能加专用列）。

### `book_chunks` — RAG 片段 + 向量

```sql
CREATE TABLE book_chunks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id      INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    spine_index  INTEGER NOT NULL,             -- 来自哪一章
    chunk_index  INTEGER NOT NULL,             -- 章内第几片
    text         TEXT NOT NULL,                -- 片段原文
    embedding    BLOB NOT NULL,                -- f32 LE 字节流，dim = 512 (BGE-Small-ZH)
    created_at   INTEGER NOT NULL,
    UNIQUE(book_id, spine_index, chunk_index)
);
CREATE INDEX idx_book_chunks_book ON book_chunks(book_id);
```

> **embedding 格式**：直接 `as_bytes()` 写 f32 vector。读时按 4 字节切分还原。
> 不用专门的向量库 — 检索时全量加载到内存做余弦，对个人书库够用（详见 ARCHITECTURE.md「已知的为什么这么写」）。

### `book_index_status` — 索引状态

```sql
CREATE TABLE book_index_status (
    book_id        INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    status         TEXT NOT NULL DEFAULT 'pending',   -- pending / indexing / ready / error
    chunks_count   INTEGER NOT NULL DEFAULT 0,
    indexed_at     INTEGER,                            -- 完成时间，NULL 表示未成功过
    error          TEXT
);
```

ChatPanel 进入 "整本书 / 全书库" 模式时检查 `status == 'ready'`，否则提示先索引。

### `track_tags` — 音乐 AI 标签

```sql
CREATE TABLE track_tags (
    track_path   TEXT PRIMARY KEY,
    file_mtime   INTEGER NOT NULL,             -- 用于检测文件变化重标
    mood_tags    TEXT NOT NULL,                -- JSON 数组字符串
    description  TEXT NOT NULL,
    embedding    BLOB NOT NULL,                -- f32 LE，对 description 做嵌入
    tagged_at    INTEGER NOT NULL
);
CREATE INDEX idx_track_tags_path ON track_tags(track_path);
```

> 音乐文件本身不入 books 表 — 它们是「需要时扫，不持久化」。只有打过 AI 标签的曲目才入 `track_tags`，目的是给「章节配乐推荐」提供检索源。

### `chat_messages` — AI 对话历史

```sql
CREATE TABLE chat_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id      INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    mode         TEXT NOT NULL,                -- 'chapter' / 'book' / 'library'
    spine_index  INTEGER NOT NULL,             -- chapter 模式 = 章号；其他模式 = -1 哨兵
    role         TEXT NOT NULL,                -- 'user' / 'assistant' / 'system'
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL
);
CREATE INDEX idx_chat_messages_session
    ON chat_messages(book_id, mode, spine_index, created_at);
```

> **会话粒度**：`(book_id, mode, spine_index)` 三元组。每章节聊每章的，整书 / 全库各自一个长会话。
> **写入时机**：user 立即写；assistant 在流式完成后整段写（中断 / 错误不持久化部分内容）。
> **RAG 引用**：`hits` 是 transient retrieval state，**不持久化** — 重新加载历史后「片段 N」回退为纯文本，避免再索引后片段编号漂移导致错跳。

---

## 数据生命周期

| 事件 | 影响 |
|---|---|
| `scan_library` | books 表 upsert；磁盘消失的孤儿删；EPUB 顺手更 cover_path |
| `set_library_root` 切换 | 旧库数据保留，新扫描会形成两套并存（按 file_path 区分） |
| 删一本书（手动 SQL，UI 暂未提供） | CASCADE 触发：reading_progress / highlights / book_chunks / book_index_status / chat_messages 都被清；covers/ 文件**不自动清**（孤儿） |
| `ai_index_book` 重索引 | 先 DELETE 该 book_id 下所有 book_chunks 再写入；book_index_status upsert |
| `ai_classify_books(force=false)` | 仅未分类的书；`force=true` 全跑 |
| `ai_tag_music_tracks` | 跳过 `track_path + file_mtime` 没变的；变了重标 |
| 重新打开 app | DB 自动跑 schema CREATE IF NOT EXISTS + 盲 ALTER 兼容旧库 |

---

## 迁移策略

SQLite 不支持 `ALTER TABLE ADD COLUMN IF NOT EXISTS`，AIreader 用「盲 ALTER + 忽略 duplicate column 错误」：

```rust
// src-tauri/src/db.rs::open
let _ = conn.execute(
    "ALTER TABLE books ADD COLUMN category TEXT NOT NULL DEFAULT ''", []);
let _ = conn.execute(
    "ALTER TABLE books ADD COLUMN cover_path TEXT", []);
let _ = conn.execute(
    "ALTER TABLE books ADD COLUMN read_time_ms INTEGER NOT NULL DEFAULT 0", []);
```

- 旧库：ALTER 成功，新列就位。
- 新库：ALTER 报 "duplicate column" 被 `let _ =` 吞掉，无害。
- 加新列只需在这里追加一行。

**新建表** 写在 `SCHEMA_SQL` 常量里，`CREATE TABLE IF NOT EXISTS …` 幂等。

**改列类型 / 删列**：SQLite 限制，需要走 `CREATE new_table → INSERT … SELECT → DROP old → RENAME`。AIreader 至今没遇到。

---

## 索引 / 性能要点

| 表 | 主要查询模式 | 索引 |
|---|---|---|
| books | 按 added_at 倒序列、按 file_path 查 | `idx_books_added_at` + UNIQUE(file_path) |
| highlights | 按 book_id 列、按 (book_id, spine_index) 列、按 query LIKE 搜 | `idx_highlights_book` + `idx_highlights_chapter` |
| book_chunks | 按 book_id 列（全量）、跨 book 列（library RAG） | `idx_book_chunks_book` |
| chat_messages | 按 (book_id, mode, spine_index) + created_at 顺序列 | `idx_chat_messages_session` 复合索引 |

**没建索引的字段**：`books.category` / `highlights.color` 等过滤量低（基数低）的字段，全表 scan 反而比走索引快。

**WAL 模式**：`PRAGMA journal_mode = WAL` 让读写并发性更好（虽然桌面单进程场景收益有限）。`foreign_keys = ON` 让 CASCADE 真正生效。

---

## ER 关系图

```
                         books
                        ┌─────┐
                        │ id  │◄─────────────────────────┐
                        │ … │                            │
                        └─┬───┘                          │
              ┌───────────┼───────────┬────────────────┐ │
              │           │           │                │ │
              ▼           ▼           ▼                ▼ │
   reading_progress  highlights  book_chunks   book_index_status
   (1:1)             (1:N)       (1:N)         (1:1)
                                                          │
              ┌──────────────────────────────────────────┘
              │
              ▼
      chat_messages
      (1:N，按 mode + spine_index 切会话)


   app_config (无 FK)       track_tags (无 FK，按 path 唯一)
```

所有 FK 都带 `ON DELETE CASCADE`，删 book 干净。
