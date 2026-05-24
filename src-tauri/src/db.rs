use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    format TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    file_modified INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_books_added_at ON books(added_at DESC);

CREATE TABLE IF NOT EXISTS reading_progress (
    book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    spine_index INTEGER NOT NULL DEFAULT 0,
    scroll_y REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    spine_index INTEGER NOT NULL DEFAULT 0,
    scroll_y REAL NOT NULL DEFAULT 0,
    label TEXT NOT NULL,
    excerpt TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON bookmarks(book_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_created ON bookmarks(created_at DESC);

CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS highlights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    spine_index INTEGER NOT NULL,
    selected_text TEXT NOT NULL,
    prefix TEXT NOT NULL,
    suffix TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'yellow',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id);
CREATE INDEX IF NOT EXISTS idx_highlights_chapter ON highlights(book_id, spine_index);

CREATE TABLE IF NOT EXISTS book_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    spine_index INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(book_id, spine_index, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_book_chunks_book ON book_chunks(book_id);

CREATE TABLE IF NOT EXISTS book_index_status (
    book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    chunks_count INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER,
    error TEXT
);

CREATE TABLE IF NOT EXISTS douban_book_metadata (
    book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    rating TEXT,
    rating_count INTEGER,
    summary TEXT,
    douban_url TEXT,
    fetched_at INTEGER NOT NULL,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_douban_book_metadata_status
  ON douban_book_metadata(status, fetched_at);

CREATE TABLE IF NOT EXISTS track_tags (
    track_path TEXT PRIMARY KEY,
    file_mtime INTEGER NOT NULL,
    mood_tags TEXT NOT NULL,
    description TEXT NOT NULL,
    embedding BLOB NOT NULL,
    tagged_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_track_tags_path ON track_tags(track_path);

-- AI chat history per book / mode / chapter. `mode` is 'chapter' /
-- 'book' / 'library'. spine_index is -1 for non-chapter scoped modes.
CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    mode TEXT NOT NULL,
    spine_index INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session
  ON chat_messages(book_id, mode, spine_index, created_at);

-- C7: AI 对话沉淀。把 ChatPanel 里有价值的 AI 回答（连带它引用的片段）
-- 落到表里，作为 "可重读的读书笔记"。比 chat_messages 高一级：chat_messages
-- 是流水会话，可清；ai_notes 是用户显式标记 "这条值得留下" 的子集。
-- spine_index = -1 表示 book/library 模式下的笔记 (不绑定具体章)。
CREATE TABLE IF NOT EXISTS ai_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    spine_index INTEGER NOT NULL,
    mode TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    hits_json TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_notes_book ON ai_notes(book_id, spine_index, created_at);

-- C1: 全文检索 (FTS5 + trigram 分词) 覆盖 book_chunks.text。
-- 用 trigram 是因为 SQLite 默认 unicode61 分词对 CJK 无效；trigram 把
-- 任意 3 字滑窗作 token，中文短查询（>=3 字符）召回稳定，不需要 jieba 等
-- 外部依赖。代价: 索引体积约 2x text 大小，单机阅读场景接受。
-- 不用 external content，让 FTS5 自己拷一份文本，省一次 join — text 已经
-- 是 book_chunks 里相对小头（大头是 embedding blob）。
CREATE VIRTUAL TABLE IF NOT EXISTS book_chunks_fts USING fts5(
    text,
    book_id UNINDEXED,
    spine_index UNINDEXED,
    chunk_id UNINDEXED,
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS book_chunks_fts_insert AFTER INSERT ON book_chunks BEGIN
    INSERT INTO book_chunks_fts(rowid, text, book_id, spine_index, chunk_id)
    VALUES (new.id, new.text, new.book_id, new.spine_index, new.chunk_index);
END;

CREATE TRIGGER IF NOT EXISTS book_chunks_fts_delete AFTER DELETE ON book_chunks BEGIN
    DELETE FROM book_chunks_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS book_chunks_fts_update AFTER UPDATE ON book_chunks BEGIN
    DELETE FROM book_chunks_fts WHERE rowid = old.id;
    INSERT INTO book_chunks_fts(rowid, text, book_id, spine_index, chunk_id)
    VALUES (new.id, new.text, new.book_id, new.spine_index, new.chunk_index);
END;

-- 读书日历：按 (book, 本地日期) 聚合阅读时长。day_key = YYYYMMDD（本地时区）。
-- 由前端在调 add_read_time 时算好 day_key 传过来——服务端不知道用户时区，
-- 由前端单一来源决定（CLAUDE.md 原则 17 协调信号集中）。
CREATE TABLE IF NOT EXISTS reading_sessions (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    day_key INTEGER NOT NULL,
    read_time_ms INTEGER NOT NULL DEFAULT 0,
    last_updated_at INTEGER NOT NULL,
    PRIMARY KEY (book_id, day_key)
);

CREATE INDEX IF NOT EXISTS idx_reading_sessions_day
  ON reading_sessions(day_key);

-- B4: multi-tag per book. `source` ∈ {'ai','user'}. `books.category`
-- 字段保留作为「主标签」(向后兼容老 UI)，但真值落在这里。
CREATE TABLE IF NOT EXISTS book_tags (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL,
    PRIMARY KEY(book_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_book_tags_tag ON book_tags(tag);
CREATE INDEX IF NOT EXISTS idx_book_tags_book ON book_tags(book_id);
"#;

/// B3: 在一条 `Connection` 上跑 schema + 增量 ALTER。被 `open()`（独立调用，
/// 比如 index_book 的早期路径）和 `init_pool()`（池启动）共用。
pub fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA_SQL)?;
    // Lightweight column-add migrations. SQLite doesn't support
    // "ADD COLUMN IF NOT EXISTS", so we run them blind and swallow the
    // "duplicate column name" error.
    let _ = conn.execute(
        "ALTER TABLE books ADD COLUMN category TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute("ALTER TABLE books ADD COLUMN cover_path TEXT", []);
    // Phase F: cumulative read time per book
    let _ = conn.execute(
        "ALTER TABLE books ADD COLUMN read_time_ms INTEGER NOT NULL DEFAULT 0",
        [],
    );
    // A4 (CLAUDE.md 原则 8 + 13): 进度锚定从「绝对像素」升级为「段索引 +
    // 段内字符偏移」。字号/字体/主题切换时不会再丢位置。`scroll_y` 保留作
    // fallback（老数据 + 新锚定失败时仍可用）。
    let _ = conn.execute(
        "ALTER TABLE reading_progress ADD COLUMN paragraph_index INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE reading_progress ADD COLUMN char_offset INTEGER",
        [],
    );
    // B1 (CLAUDE.md 原则 16 自适应): 嵌入维度 + 模型 ID 跟着每条 chunk 落库。
    // 将来换模型时按 (model, dim) 过滤检索，老 chunks 不会被错算成 cosine=0。
    // 对老数据做一次回填：假设老 chunks 都是 A 阶段及之前的 BGESmallZHV15 / 512。
    let _ = conn.execute(
        "ALTER TABLE book_chunks ADD COLUMN embedding_dim INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE book_chunks ADD COLUMN embedding_model TEXT",
        [],
    );
    // 回填老数据。新插入的 chunk 由 insert_chunk 写正确值，老的（NULL）按
    // 当前唯一用过的模型 BGESmallZHV15/512 兜底。如果用户后来换了模型再读到
    // 老 chunk，会按 (model, dim) 过滤掉，不至于产生错的 cosine 分数。
    let _ = conn.execute(
        "UPDATE book_chunks SET embedding_dim = 512 WHERE embedding_dim IS NULL",
        [],
    );
    let _ = conn.execute(
        "UPDATE book_chunks
         SET embedding_model = 'BAAI/bge-small-zh-v1.5'
         WHERE embedding_model IS NULL",
        [],
    );
    // C1: FTS5 回填——把已存在但 FTS 表里没有的 chunks 灌进去。幂等：
    // 触发器同步新增/删除/更新，回填只补历史。
    let _ = conn.execute(
        "INSERT INTO book_chunks_fts(rowid, text, book_id, spine_index, chunk_id)
         SELECT id, text, book_id, spine_index, chunk_index
         FROM book_chunks
         WHERE id NOT IN (SELECT rowid FROM book_chunks_fts)",
        [],
    );
    Ok(())
}

/// 老版"打开一条独立 Connection + 跑迁移"的入口。仍然保留给：
/// - watcher 后台任务在 spawn_blocking 里复用
/// - index_book 失败分支独立 open（不依赖 pool）
/// 但日常 IPC 应该走 `init_pool()` 创建的池。
pub fn open(db_path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    run_migrations(&conn)?;
    Ok(conn)
}

/// B3: 启动 r2d2 连接池。每个池里的 connection 出池前都跑 WAL +
/// foreign_keys 初始化。在 main 线程上先用一条 connection 跑一次迁移。
///
/// 池大小：max_size = 8（最多 8 个并发 SQL 操作）。WAL 下读不阻塞，
/// 写串行化。AIreader 是单用户单窗口，8 足够，不会引发 SQLite "database
/// is locked" 风暴。
pub fn init_pool(db_path: &Path) -> Result<crate::state::DbPool, String> {
    use r2d2_sqlite::SqliteConnectionManager;

    let manager = SqliteConnectionManager::file(db_path).with_init(|c| {
        // 注意：journal_mode 是 db-wide 设置，多次设是 no-op；foreign_keys
        // 是 per-connection，必须每条连接都设。
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        Ok(())
    });

    let pool = r2d2::Pool::builder()
        .max_size(8)
        .build(manager)
        .map_err(|e| format!("DB 连接池初始化失败: {e}"))?;

    // 先用一条连接跑一次迁移，确保 schema / ALTER / 回填都做完
    let conn = pool
        .get()
        .map_err(|e| format!("DB 连接池启动后取连接失败: {e}"))?;
    run_migrations(&conn).map_err(|e| format!("DB 迁移失败: {e}"))?;
    Ok(pool)
}

#[derive(Debug, Clone, Serialize)]
pub struct Book {
    pub id: i64,
    pub file_path: String,
    pub format: String,
    pub title: String,
    pub author: String,
    pub added_at: i64,
    pub file_size: i64,
    pub file_modified: i64,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub last_read_at: Option<i64>,
    #[serde(default)]
    pub cover_path: Option<String>,
    #[serde(default)]
    pub read_time_ms: i64,
}

pub fn config_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM app_config WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
}

pub fn config_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO app_config (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn upsert_book(conn: &Connection, b: &Book) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO books (file_path, format, title, author, added_at, file_size, file_modified)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(file_path) DO UPDATE SET
            format = excluded.format,
            title = excluded.title,
            author = excluded.author,
            file_size = excluded.file_size,
            file_modified = excluded.file_modified",
        params![
            b.file_path,
            b.format,
            b.title,
            b.author,
            b.added_at,
            b.file_size,
            b.file_modified
        ],
    )?;
    Ok(())
}

pub fn list_books(conn: &Connection) -> rusqlite::Result<Vec<Book>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.file_path, b.format, b.title, b.author, b.added_at,
                b.file_size, b.file_modified, b.category, p.updated_at,
                b.cover_path, b.read_time_ms
         FROM books b
         LEFT JOIN reading_progress p ON p.book_id = b.id
         ORDER BY b.added_at DESC, b.title ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Book {
            id: row.get(0)?,
            file_path: row.get(1)?,
            format: row.get(2)?,
            title: row.get(3)?,
            author: row.get(4)?,
            added_at: row.get(5)?,
            file_size: row.get(6)?,
            file_modified: row.get(7)?,
            category: row.get(8)?,
            last_read_at: row.get(9)?,
            cover_path: row.get(10)?,
            read_time_ms: row.get(11)?,
        })
    })?;
    rows.collect()
}

pub fn get_book_by_path(conn: &Connection, path: &str) -> rusqlite::Result<Option<Book>> {
    conn.query_row(
        "SELECT b.id, b.file_path, b.format, b.title, b.author, b.added_at,
                b.file_size, b.file_modified, b.category, p.updated_at,
                b.cover_path, b.read_time_ms
         FROM books b
         LEFT JOIN reading_progress p ON p.book_id = b.id
         WHERE b.file_path = ?1",
        params![path],
        |row| {
            Ok(Book {
                id: row.get(0)?,
                file_path: row.get(1)?,
                format: row.get(2)?,
                title: row.get(3)?,
                author: row.get(4)?,
                added_at: row.get(5)?,
                file_size: row.get(6)?,
                file_modified: row.get(7)?,
                category: row.get(8)?,
                last_read_at: row.get(9)?,
                cover_path: row.get(10)?,
                read_time_ms: row.get(11)?,
            })
        },
    )
    .optional()
}

pub fn add_read_time(conn: &Connection, book_id: i64, delta_ms: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE books SET read_time_ms = read_time_ms + ?1 WHERE id = ?2",
        params![delta_ms, book_id],
    )?;
    Ok(())
}

/// 读书日历：往 reading_sessions 累加一次心跳。day_key 由前端按用户本地时区
/// 算好（YYYYMMDD 整数，如 20240115）。`books.read_time_ms` 仍由
/// `add_read_time` 单独维护——双表是有意冗余，避免日级数据丢失影响累计总数
/// （CLAUDE.md 原则 14 冗余兜底）。
pub fn add_reading_session(
    conn: &Connection,
    book_id: i64,
    day_key: i64,
    delta_ms: i64,
    now_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO reading_sessions (book_id, day_key, read_time_ms, last_updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(book_id, day_key) DO UPDATE SET
            read_time_ms = read_time_ms + excluded.read_time_ms,
            last_updated_at = excluded.last_updated_at",
        params![book_id, day_key, delta_ms, now_ms],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct CalendarDay {
    pub day_key: i64,
    pub total_ms: i64,
    pub book_count: i64,
}

/// 月历视图：返回 [from_day, to_day] 区间里所有有阅读活动的天，按 day_key 升序。
/// 用于日历单元格高亮 + 显示当日总时长。
pub fn list_calendar_days(
    conn: &Connection,
    from_day: i64,
    to_day: i64,
) -> rusqlite::Result<Vec<CalendarDay>> {
    let mut stmt = conn.prepare(
        "SELECT day_key, SUM(read_time_ms) as total_ms, COUNT(DISTINCT book_id) as book_count
         FROM reading_sessions
         WHERE day_key >= ?1 AND day_key <= ?2
         GROUP BY day_key
         ORDER BY day_key ASC",
    )?;
    let rows = stmt.query_map(params![from_day, to_day], |row| {
        Ok(CalendarDay {
            day_key: row.get(0)?,
            total_ms: row.get(1)?,
            book_count: row.get(2)?,
        })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct DaySessionEntry {
    pub book_id: i64,
    pub book_title: String,
    pub book_author: String,
    pub book_format: String,
    pub book_path: String,
    pub read_time_ms: i64,
}

/// 当日详情：每本书的阅读时长。
pub fn list_day_sessions(
    conn: &Connection,
    day_key: i64,
) -> rusqlite::Result<Vec<DaySessionEntry>> {
    let mut stmt = conn.prepare(
        "SELECT s.book_id, b.title, b.author, b.format, b.file_path, s.read_time_ms
         FROM reading_sessions s
         JOIN books b ON b.id = s.book_id
         WHERE s.day_key = ?1
         ORDER BY s.read_time_ms DESC",
    )?;
    let rows = stmt.query_map(params![day_key], |row| {
        Ok(DaySessionEntry {
            book_id: row.get(0)?,
            book_title: row.get(1)?,
            book_author: row.get(2)?,
            book_format: row.get(3)?,
            book_path: row.get(4)?,
            read_time_ms: row.get(5)?,
        })
    })?;
    rows.collect()
}

/// 当日的高亮 / 书签：按 created_at 的本地时区范围圈定 [start_ms, end_ms)。
/// 前端传 [当天00:00, 次日00:00) 的 epoch ms 比让 SQLite 算 strftime/localtime
/// 更稳——跨设备一致、不依赖 DB 时区设置。
pub fn list_day_highlights(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
) -> rusqlite::Result<Vec<HighlightWithBook>> {
    let mut stmt = conn.prepare(
        "SELECT h.id, h.book_id, h.spine_index, h.selected_text, h.prefix, h.suffix,
                h.color, h.note, h.created_at, h.updated_at,
                b.title, b.author, b.format
         FROM highlights h JOIN books b ON b.id = h.book_id
         WHERE h.created_at >= ?1 AND h.created_at < ?2
         ORDER BY h.created_at ASC",
    )?;
    let rows = stmt.query_map(params![start_ms, end_ms], |row| {
        Ok(HighlightWithBook {
            id: row.get(0)?,
            book_id: row.get(1)?,
            spine_index: row.get(2)?,
            selected_text: row.get(3)?,
            prefix: row.get(4)?,
            suffix: row.get(5)?,
            color: row.get(6)?,
            note: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            book_title: row.get(10)?,
            book_author: row.get(11)?,
            book_format: row.get(12)?,
        })
    })?;
    rows.collect()
}

pub fn list_day_bookmarks(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
) -> rusqlite::Result<Vec<BookmarkWithBook>> {
    let mut stmt = conn.prepare(
        "SELECT bm.id, bm.book_id, bm.spine_index, bm.scroll_y, bm.label,
                bm.excerpt, bm.created_at, b.title, b.author, b.format, b.file_path
         FROM bookmarks bm
         JOIN books b ON b.id = bm.book_id
         WHERE bm.created_at >= ?1 AND bm.created_at < ?2
         ORDER BY bm.created_at ASC",
    )?;
    let rows = stmt.query_map(params![start_ms, end_ms], |row| {
        Ok(BookmarkWithBook {
            id: row.get(0)?,
            book_id: row.get(1)?,
            spine_index: row.get(2)?,
            scroll_y: row.get(3)?,
            label: row.get(4)?,
            excerpt: row.get(5)?,
            created_at: row.get(6)?,
            book_title: row.get(7)?,
            book_author: row.get(8)?,
            book_format: row.get(9)?,
            book_path: row.get(10)?,
        })
    })?;
    rows.collect()
}

pub fn set_book_category(conn: &Connection, book_id: i64, category: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE books SET category = ?1 WHERE id = ?2",
        params![category, book_id],
    )?;
    Ok(())
}

pub fn set_book_cover_by_path(
    conn: &Connection,
    file_path: &str,
    cover_path: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE books SET cover_path = ?1 WHERE file_path = ?2",
        params![cover_path, file_path],
    )?;
    Ok(())
}

pub fn get_book_cover_path(conn: &Connection, file_path: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT cover_path FROM books WHERE file_path = ?1",
        params![file_path],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|opt| opt.flatten())
}

#[derive(Debug, Clone, Serialize)]
pub struct DoubanMetadata {
    pub book_id: i64,
    pub status: String,
    pub rating: Option<String>,
    pub rating_count: Option<i64>,
    pub summary: Option<String>,
    pub douban_url: Option<String>,
    pub fetched_at: i64,
    pub error: Option<String>,
}

pub fn get_douban_metadata(
    conn: &Connection,
    book_id: i64,
) -> rusqlite::Result<Option<DoubanMetadata>> {
    conn.query_row(
        "SELECT book_id, status, rating, rating_count, summary, douban_url, fetched_at, error
         FROM douban_book_metadata
         WHERE book_id = ?1",
        params![book_id],
        |row| {
            Ok(DoubanMetadata {
                book_id: row.get(0)?,
                status: row.get(1)?,
                rating: row.get(2)?,
                rating_count: row.get(3)?,
                summary: row.get(4)?,
                douban_url: row.get(5)?,
                fetched_at: row.get(6)?,
                error: row.get(7)?,
            })
        },
    )
    .optional()
}

pub fn upsert_douban_metadata(
    conn: &Connection,
    metadata: &DoubanMetadata,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO douban_book_metadata
            (book_id, status, rating, rating_count, summary, douban_url, fetched_at, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(book_id) DO UPDATE SET
            status = excluded.status,
            rating = excluded.rating,
            rating_count = excluded.rating_count,
            summary = excluded.summary,
            douban_url = excluded.douban_url,
            fetched_at = excluded.fetched_at,
            error = excluded.error",
        params![
            metadata.book_id,
            metadata.status,
            metadata.rating,
            metadata.rating_count,
            metadata.summary,
            metadata.douban_url,
            metadata.fetched_at,
            metadata.error
        ],
    )?;
    Ok(())
}

pub fn list_books_for_douban_refresh(
    conn: &Connection,
    force: bool,
) -> rusqlite::Result<Vec<Book>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.file_path, b.format, b.title, b.author, b.added_at,
                b.file_size, b.file_modified, b.category, p.updated_at,
                b.cover_path, b.read_time_ms
         FROM books b
         LEFT JOIN reading_progress p ON p.book_id = b.id
         LEFT JOIN douban_book_metadata dm ON dm.book_id = b.id
         WHERE ?1 OR dm.book_id IS NULL
         ORDER BY b.added_at DESC, b.title ASC",
    )?;
    let rows = stmt.query_map(params![force], |row| {
        Ok(Book {
            id: row.get(0)?,
            file_path: row.get(1)?,
            format: row.get(2)?,
            title: row.get(3)?,
            author: row.get(4)?,
            added_at: row.get(5)?,
            file_size: row.get(6)?,
            file_modified: row.get(7)?,
            category: row.get(8)?,
            last_read_at: row.get(9)?,
            cover_path: row.get(10)?,
            read_time_ms: row.get(11)?,
        })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadingProgress {
    pub book_id: i64,
    pub spine_index: i64,
    pub scroll_y: f64,
    pub updated_at: i64,
    /// A4: 段落索引（chapter 内第几段），优先用它恢复进度。`None` 表示
    /// 旧数据 / 前端没传，恢复时退回 scroll_y。
    #[serde(default)]
    pub paragraph_index: Option<i64>,
    /// A4: 段内字符偏移（视口顶部段落的可见首字符），与 paragraph_index 配合。
    #[serde(default)]
    pub char_offset: Option<i64>,
}

pub fn get_progress(conn: &Connection, book_id: i64) -> rusqlite::Result<Option<ReadingProgress>> {
    conn.query_row(
        "SELECT book_id, spine_index, scroll_y, updated_at, paragraph_index, char_offset
         FROM reading_progress WHERE book_id = ?1",
        params![book_id],
        |row| {
            Ok(ReadingProgress {
                book_id: row.get(0)?,
                spine_index: row.get(1)?,
                scroll_y: row.get(2)?,
                updated_at: row.get(3)?,
                paragraph_index: row.get(4)?,
                char_offset: row.get(5)?,
            })
        },
    )
    .optional()
}

pub fn save_progress(
    conn: &Connection,
    book_id: i64,
    spine_index: i64,
    scroll_y: f64,
    paragraph_index: Option<i64>,
    char_offset: Option<i64>,
    updated_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO reading_progress
            (book_id, spine_index, scroll_y, updated_at, paragraph_index, char_offset)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(book_id) DO UPDATE SET
            spine_index = excluded.spine_index,
            scroll_y = excluded.scroll_y,
            updated_at = excluded.updated_at,
            paragraph_index = excluded.paragraph_index,
            char_offset = excluded.char_offset",
        params![
            book_id,
            spine_index,
            scroll_y,
            updated_at,
            paragraph_index,
            char_offset
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct Bookmark {
    pub id: i64,
    pub book_id: i64,
    pub spine_index: i64,
    pub scroll_y: f64,
    pub label: String,
    pub excerpt: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BookmarkWithBook {
    pub id: i64,
    pub book_id: i64,
    pub spine_index: i64,
    pub scroll_y: f64,
    pub label: String,
    pub excerpt: String,
    pub created_at: i64,
    pub book_title: String,
    pub book_author: String,
    pub book_format: String,
    pub book_path: String,
}

pub fn create_bookmark(
    conn: &Connection,
    book_id: i64,
    spine_index: i64,
    scroll_y: f64,
    label: &str,
    excerpt: &str,
    now_ms: i64,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO bookmarks (book_id, spine_index, scroll_y, label, excerpt, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![book_id, spine_index, scroll_y, label, excerpt, now_ms],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_recent_bookmarks(
    conn: &Connection,
    limit: i64,
) -> rusqlite::Result<Vec<BookmarkWithBook>> {
    let mut stmt = conn.prepare(
        "SELECT bm.id, bm.book_id, bm.spine_index, bm.scroll_y, bm.label,
                bm.excerpt, bm.created_at, b.title, b.author, b.format, b.file_path
         FROM bookmarks bm
         JOIN books b ON b.id = bm.book_id
         ORDER BY bm.created_at DESC, bm.id DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |row| {
        Ok(BookmarkWithBook {
            id: row.get(0)?,
            book_id: row.get(1)?,
            spine_index: row.get(2)?,
            scroll_y: row.get(3)?,
            label: row.get(4)?,
            excerpt: row.get(5)?,
            created_at: row.get(6)?,
            book_title: row.get(7)?,
            book_author: row.get(8)?,
            book_format: row.get(9)?,
            book_path: row.get(10)?,
        })
    })?;
    rows.collect()
}

pub fn list_bookmarks_by_book(conn: &Connection, book_id: i64) -> rusqlite::Result<Vec<Bookmark>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, spine_index, scroll_y, label, excerpt, created_at
         FROM bookmarks
         WHERE book_id = ?1
         ORDER BY spine_index ASC, scroll_y ASC, created_at DESC, id DESC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(Bookmark {
            id: row.get(0)?,
            book_id: row.get(1)?,
            spine_index: row.get(2)?,
            scroll_y: row.get(3)?,
            label: row.get(4)?,
            excerpt: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn delete_bookmark(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct Highlight {
    pub id: i64,
    pub book_id: i64,
    pub spine_index: i64,
    pub selected_text: String,
    pub prefix: String,
    pub suffix: String,
    pub color: String,
    pub note: String,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn create_highlight(
    conn: &Connection,
    book_id: i64,
    spine_index: i64,
    selected_text: &str,
    prefix: &str,
    suffix: &str,
    color: &str,
    note: &str,
    now_ms: i64,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO highlights (book_id, spine_index, selected_text, prefix, suffix, color, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![book_id, spine_index, selected_text, prefix, suffix, color, note, now_ms],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_highlights_by_chapter(
    conn: &Connection,
    book_id: i64,
    spine_index: i64,
) -> rusqlite::Result<Vec<Highlight>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, spine_index, selected_text, prefix, suffix, color, note, created_at, updated_at
         FROM highlights WHERE book_id = ?1 AND spine_index = ?2
         ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![book_id, spine_index], |row| {
        Ok(Highlight {
            id: row.get(0)?,
            book_id: row.get(1)?,
            spine_index: row.get(2)?,
            selected_text: row.get(3)?,
            prefix: row.get(4)?,
            suffix: row.get(5)?,
            color: row.get(6)?,
            note: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn list_highlights_by_book(
    conn: &Connection,
    book_id: i64,
) -> rusqlite::Result<Vec<Highlight>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, spine_index, selected_text, prefix, suffix, color, note, created_at, updated_at
         FROM highlights WHERE book_id = ?1
         ORDER BY spine_index ASC, created_at ASC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(Highlight {
            id: row.get(0)?,
            book_id: row.get(1)?,
            spine_index: row.get(2)?,
            selected_text: row.get(3)?,
            prefix: row.get(4)?,
            suffix: row.get(5)?,
            color: row.get(6)?,
            note: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct HighlightWithBook {
    pub id: i64,
    pub book_id: i64,
    pub spine_index: i64,
    pub selected_text: String,
    pub prefix: String,
    pub suffix: String,
    pub color: String,
    pub note: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub book_title: String,
    pub book_author: String,
    pub book_format: String,
}

pub fn list_all_highlights_with_book(
    conn: &Connection,
    query: Option<&str>,
) -> rusqlite::Result<Vec<HighlightWithBook>> {
    let base = "SELECT h.id, h.book_id, h.spine_index, h.selected_text, h.prefix, h.suffix,
                       h.color, h.note, h.created_at, h.updated_at,
                       b.title, b.author, b.format
                FROM highlights h JOIN books b ON b.id = h.book_id";
    let map_row = |row: &rusqlite::Row| {
        Ok(HighlightWithBook {
            id: row.get(0)?,
            book_id: row.get(1)?,
            spine_index: row.get(2)?,
            selected_text: row.get(3)?,
            prefix: row.get(4)?,
            suffix: row.get(5)?,
            color: row.get(6)?,
            note: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            book_title: row.get(10)?,
            book_author: row.get(11)?,
            book_format: row.get(12)?,
        })
    };

    if let Some(q) = query.filter(|q| !q.trim().is_empty()) {
        let pattern = format!("%{}%", q.trim());
        let sql = format!(
            "{base} WHERE h.selected_text LIKE ?1 OR h.note LIKE ?1
             ORDER BY h.updated_at DESC LIMIT 500"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![pattern], map_row)?;
        rows.collect()
    } else {
        let sql = format!("{base} ORDER BY h.updated_at DESC LIMIT 500");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], map_row)?;
        rows.collect()
    }
}

pub fn update_highlight(
    conn: &Connection,
    id: i64,
    color: &str,
    note: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE highlights SET color = ?1, note = ?2, updated_at = ?3 WHERE id = ?4",
        params![color, note, now_ms, id],
    )?;
    Ok(())
}

pub fn delete_highlight(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM highlights WHERE id = ?1", params![id])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct BookIndexStatus {
    pub book_id: i64,
    pub status: String,
    pub chunks_count: i64,
    pub indexed_at: Option<i64>,
    pub error: Option<String>,
}

pub fn get_index_status(
    conn: &Connection,
    book_id: i64,
) -> rusqlite::Result<Option<BookIndexStatus>> {
    conn.query_row(
        "SELECT book_id, status, chunks_count, indexed_at, error
         FROM book_index_status WHERE book_id = ?1",
        params![book_id],
        |row| {
            Ok(BookIndexStatus {
                book_id: row.get(0)?,
                status: row.get(1)?,
                chunks_count: row.get(2)?,
                indexed_at: row.get(3)?,
                error: row.get(4)?,
            })
        },
    )
    .optional()
}

pub fn set_index_status(
    conn: &Connection,
    book_id: i64,
    status: &str,
    chunks_count: i64,
    indexed_at: Option<i64>,
    error: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO book_index_status (book_id, status, chunks_count, indexed_at, error)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(book_id) DO UPDATE SET
            status = excluded.status,
            chunks_count = excluded.chunks_count,
            indexed_at = excluded.indexed_at,
            error = excluded.error",
        params![book_id, status, chunks_count, indexed_at, error],
    )?;
    Ok(())
}

pub fn clear_book_chunks(conn: &Connection, book_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM book_chunks WHERE book_id = ?1",
        params![book_id],
    )?;
    Ok(())
}

pub fn insert_chunk(
    conn: &Connection,
    book_id: i64,
    spine_index: i64,
    chunk_index: i64,
    text: &str,
    embedding: &[u8],
    embedding_dim: i64,
    embedding_model: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO book_chunks
            (book_id, spine_index, chunk_index, text, embedding, created_at,
             embedding_dim, embedding_model)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(book_id, spine_index, chunk_index) DO UPDATE SET
            text = excluded.text,
            embedding = excluded.embedding,
            embedding_dim = excluded.embedding_dim,
            embedding_model = excluded.embedding_model",
        params![
            book_id,
            spine_index,
            chunk_index,
            text,
            embedding,
            now_ms,
            embedding_dim,
            embedding_model
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct ChunkRow {
    pub id: i64,
    pub book_id: i64,
    pub spine_index: i64,
    pub text: String,
    pub embedding: Vec<u8>,
    /// B1: 这条 chunk 用的嵌入维度。`None` 仅出现在老数据回填失败的极端
    /// 情况——`list_chunks_for_model` 会把它当成不匹配跳过。
    pub embedding_dim: Option<i64>,
    /// B1: 这条 chunk 用的嵌入模型 ID（如 "BAAI/bge-small-zh-v1.5"）。
    pub embedding_model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrackTag {
    pub track_path: String,
    pub file_mtime: i64,
    pub mood_tags: String, // JSON array of strings
    pub description: String,
    pub tagged_at: i64,
}

#[derive(Debug, Clone)]
pub struct TrackTagWithEmbedding {
    pub track_path: String,
    pub file_mtime: i64,
    pub mood_tags: String,
    pub description: String,
    pub embedding: Vec<u8>,
}

pub fn get_track_tag(conn: &Connection, track_path: &str) -> rusqlite::Result<Option<TrackTag>> {
    conn.query_row(
        "SELECT track_path, file_mtime, mood_tags, description, tagged_at
         FROM track_tags WHERE track_path = ?1",
        params![track_path],
        |row| {
            Ok(TrackTag {
                track_path: row.get(0)?,
                file_mtime: row.get(1)?,
                mood_tags: row.get(2)?,
                description: row.get(3)?,
                tagged_at: row.get(4)?,
            })
        },
    )
    .optional()
}

pub fn upsert_track_tag(
    conn: &Connection,
    track_path: &str,
    file_mtime: i64,
    mood_tags: &str,
    description: &str,
    embedding: &[u8],
    tagged_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO track_tags
            (track_path, file_mtime, mood_tags, description, embedding, tagged_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(track_path) DO UPDATE SET
            file_mtime = excluded.file_mtime,
            mood_tags = excluded.mood_tags,
            description = excluded.description,
            embedding = excluded.embedding,
            tagged_at = excluded.tagged_at",
        params![
            track_path,
            file_mtime,
            mood_tags,
            description,
            embedding,
            tagged_at
        ],
    )?;
    Ok(())
}

pub fn list_all_track_tags(conn: &Connection) -> rusqlite::Result<Vec<TrackTagWithEmbedding>> {
    let mut rows = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT track_path, file_mtime, mood_tags, description, embedding FROM track_tags",
    )?;
    let iter = stmt.query_map([], |r| {
        Ok(TrackTagWithEmbedding {
            track_path: r.get(0)?,
            file_mtime: r.get(1)?,
            mood_tags: r.get(2)?,
            description: r.get(3)?,
            embedding: r.get(4)?,
        })
    })?;
    for r in iter {
        rows.push(r?);
    }
    Ok(rows)
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatHistoryMsg {
    pub role: String,
    pub content: String,
    pub created_at: i64,
}

pub fn list_chat_messages(
    conn: &Connection,
    book_id: i64,
    mode: &str,
    spine_index: i64,
) -> rusqlite::Result<Vec<ChatHistoryMsg>> {
    let mut stmt = conn.prepare(
        "SELECT role, content, created_at
         FROM chat_messages
         WHERE book_id = ?1 AND mode = ?2 AND spine_index = ?3
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![book_id, mode, spine_index], |row| {
        Ok(ChatHistoryMsg {
            role: row.get(0)?,
            content: row.get(1)?,
            created_at: row.get(2)?,
        })
    })?;
    rows.collect()
}

pub fn append_chat_message(
    conn: &Connection,
    book_id: i64,
    mode: &str,
    spine_index: i64,
    role: &str,
    content: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO chat_messages
            (book_id, mode, spine_index, role, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![book_id, mode, spine_index, role, content, now_ms],
    )?;
    Ok(())
}

pub fn clear_chat_messages(
    conn: &Connection,
    book_id: i64,
    mode: &str,
    spine_index: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM chat_messages
         WHERE book_id = ?1 AND mode = ?2 AND spine_index = ?3",
        params![book_id, mode, spine_index],
    )?;
    Ok(())
}

pub fn list_track_tag_meta(conn: &Connection) -> rusqlite::Result<Vec<TrackTag>> {
    let mut rows = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT track_path, file_mtime, mood_tags, description, tagged_at FROM track_tags",
    )?;
    let iter = stmt.query_map([], |r| {
        Ok(TrackTag {
            track_path: r.get(0)?,
            file_mtime: r.get(1)?,
            mood_tags: r.get(2)?,
            description: r.get(3)?,
            tagged_at: r.get(4)?,
        })
    })?;
    for r in iter {
        rows.push(r?);
    }
    Ok(rows)
}

// ---------- B4: per-book tags ----------

/// Allowed tag whitelist. Anything outside this list gets dropped during
/// `normalize_tags`. Mirrors the frontend `BOOK_CATEGORIES` constant —
/// keep in sync.
pub const ALLOWED_BOOK_TAGS: &[&str] = &[
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
];

/// Normalize a raw tag list from the LLM (or a user paste): trim, drop
/// empty / non-whitelisted entries, dedup while preserving first-seen
/// order. Returns at most 3 tags (我们只允许多打 3 个标签，太多失去
/// "信号 vs 数据堆" 的意义 —— 原则 19).
pub fn normalize_tags(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in raw {
        let t = r.trim();
        if t.is_empty() {
            continue;
        }
        // Snap to whitelist: exact match wins; otherwise substring match
        // against any allowed tag (covers cases like "历史 / 文化" or
        // "科技与未来").
        let snapped: Option<&str> = ALLOWED_BOOK_TAGS
            .iter()
            .copied()
            .find(|c| *c == t)
            .or_else(|| ALLOWED_BOOK_TAGS.iter().copied().find(|c| t.contains(c)));
        if let Some(s) = snapped {
            if !out.iter().any(|x| x == s) {
                out.push(s.to_string());
            }
        }
    }
    if out.len() > 3 {
        out.truncate(3);
    }
    out
}

pub fn list_book_tags(conn: &Connection, book_id: i64) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT tag FROM book_tags WHERE book_id = ?1 ORDER BY created_at ASC, tag ASC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| row.get::<_, String>(0))?;
    rows.collect()
}

pub fn set_book_tags(
    conn: &mut Connection,
    book_id: i64,
    tags: &[String],
    source: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM book_tags WHERE book_id = ?1", params![book_id])?;
    for tag in tags {
        tx.execute(
            "INSERT OR IGNORE INTO book_tags (book_id, tag, source, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![book_id, tag, source, now_ms],
        )?;
    }
    tx.commit()
}

pub fn add_book_tag(
    conn: &Connection,
    book_id: i64,
    tag: &str,
    source: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO book_tags (book_id, tag, source, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![book_id, tag, source, now_ms],
    )?;
    Ok(())
}

pub fn remove_book_tag(conn: &Connection, book_id: i64, tag: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM book_tags WHERE book_id = ?1 AND tag = ?2",
        params![book_id, tag],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct BookTagRow {
    pub book_id: i64,
    pub tag: String,
}

/// Bulk-load tags for many books in one query — used by `list_books`
/// shaped views that want to attach tags without N+1.
pub fn list_all_book_tags(conn: &Connection) -> rusqlite::Result<Vec<BookTagRow>> {
    let mut stmt = conn.prepare(
        "SELECT book_id, tag FROM book_tags ORDER BY book_id, created_at ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(BookTagRow {
            book_id: row.get(0)?,
            tag: row.get(1)?,
        })
    })?;
    rows.collect()
}

/// Load chunks for one or all indexed books. If `book_id` is Some, scopes
/// to that book; if None, returns chunks from every book in the library.
///
/// B1: 这个函数仍然返回**全部** chunks（包括不同模型 / 维度的）。模型过滤
/// 在 `ai::index::score_chunks_for_model` 里做，把 IO 和过滤策略解耦——
/// 将来想做"老模型按 BM25 兜底"也只改 score 层。
pub fn list_chunks(conn: &Connection, book_id: Option<i64>) -> rusqlite::Result<Vec<ChunkRow>> {
    let mut rows = Vec::new();
    let row_mapper = |r: &rusqlite::Row| {
        Ok(ChunkRow {
            id: r.get(0)?,
            book_id: r.get(1)?,
            spine_index: r.get(2)?,
            text: r.get(3)?,
            embedding: r.get(4)?,
            embedding_dim: r.get(5)?,
            embedding_model: r.get(6)?,
        })
    };
    if let Some(bid) = book_id {
        let mut stmt = conn.prepare(
            "SELECT id, book_id, spine_index, text, embedding, embedding_dim, embedding_model
             FROM book_chunks WHERE book_id = ?1",
        )?;
        let iter = stmt.query_map(params![bid], row_mapper)?;
        for c in iter {
            rows.push(c?);
        }
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, book_id, spine_index, text, embedding, embedding_dim, embedding_model
             FROM book_chunks",
        )?;
        let iter = stmt.query_map([], row_mapper)?;
        for c in iter {
            rows.push(c?);
        }
    }
    Ok(rows)
}

// ---------- C7: AI 对话沉淀为笔记 ----------

#[derive(Debug, Clone, Serialize)]
pub struct AiNote {
    pub id: i64,
    pub book_id: i64,
    pub spine_index: i64,
    pub mode: String,
    pub question: String,
    pub answer: String,
    pub hits_json: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiNoteWithBook {
    pub id: i64,
    pub book_id: i64,
    pub spine_index: i64,
    pub mode: String,
    pub question: String,
    pub answer: String,
    pub hits_json: Option<String>,
    pub created_at: i64,
    pub book_title: String,
    pub book_author: String,
    pub book_format: String,
}

pub fn create_ai_note(
    conn: &Connection,
    book_id: i64,
    spine_index: i64,
    mode: &str,
    question: &str,
    answer: &str,
    hits_json: Option<&str>,
    now_ms: i64,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO ai_notes (book_id, spine_index, mode, question, answer, hits_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![book_id, spine_index, mode, question, answer, hits_json, now_ms],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_ai_notes_by_book(conn: &Connection, book_id: i64) -> rusqlite::Result<Vec<AiNote>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, spine_index, mode, question, answer, hits_json, created_at
         FROM ai_notes WHERE book_id = ?1
         ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(AiNote {
            id: row.get(0)?,
            book_id: row.get(1)?,
            spine_index: row.get(2)?,
            mode: row.get(3)?,
            question: row.get(4)?,
            answer: row.get(5)?,
            hits_json: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?;
    rows.collect()
}

pub fn list_all_ai_notes(conn: &Connection) -> rusqlite::Result<Vec<AiNoteWithBook>> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.book_id, n.spine_index, n.mode, n.question, n.answer,
                n.hits_json, n.created_at, b.title, b.author, b.format
         FROM ai_notes n JOIN books b ON b.id = n.book_id
         ORDER BY n.created_at DESC LIMIT 500",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(AiNoteWithBook {
            id: row.get(0)?,
            book_id: row.get(1)?,
            spine_index: row.get(2)?,
            mode: row.get(3)?,
            question: row.get(4)?,
            answer: row.get(5)?,
            hits_json: row.get(6)?,
            created_at: row.get(7)?,
            book_title: row.get(8)?,
            book_author: row.get(9)?,
            book_format: row.get(10)?,
        })
    })?;
    rows.collect()
}

pub fn delete_ai_note(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM ai_notes WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------- C1: 全文检索 (FTS5 trigram) ----------

#[derive(Debug, Clone, Serialize)]
pub struct FtsHit {
    /// C3: book_chunks.id（= FTS rowid），用于和 vector 召回去重做 RRF 融合
    pub chunk_id: i64,
    pub book_id: i64,
    pub spine_index: i64,
    pub snippet: String,
    pub book_title: String,
    pub book_author: String,
    pub book_format: String,
    pub book_path: String,
}

/// 把用户输入的自由文本转成 FTS5 MATCH 能吃的 query string。
///
/// - 双引号包起来 → 当短语查（避免被 FTS5 当成多 token AND）
/// - 引号本身转义成两个双引号（FTS5 字符串字面量规则）
/// - 控制字符 / 反斜杠剥掉，避免引爆 parser
pub fn build_fts_match(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control() && *c != '\\')
        .collect();
    let escaped = cleaned.replace('"', "\"\"");
    format!("\"{}\"", escaped.trim())
}

/// 全库 / 单本全文检索。`book_id=Some(_)` 只搜该书；None 搜全库。
/// 返回 top-`limit` 命中，按 FTS5 内置 bm25() 排序（rank 越小越靠前）。
/// snippet 是 FTS5 highlight 函数包了 «...» 的命中上下文。
pub fn search_fts(
    conn: &Connection,
    raw_query: &str,
    book_id: Option<i64>,
    limit: i64,
) -> rusqlite::Result<Vec<FtsHit>> {
    let match_expr = build_fts_match(raw_query);
    if match_expr.trim_matches('"').is_empty() {
        return Ok(Vec::new());
    }
    let sql = if book_id.is_some() {
        "SELECT f.rowid, f.book_id, f.spine_index,
                snippet(book_chunks_fts, 0, '«', '»', '…', 24) AS snip,
                b.title, b.author, b.format, b.file_path
         FROM book_chunks_fts f
         JOIN books b ON b.id = f.book_id
         WHERE f.text MATCH ?1 AND f.book_id = ?2
         ORDER BY bm25(book_chunks_fts)
         LIMIT ?3"
    } else {
        "SELECT f.rowid, f.book_id, f.spine_index,
                snippet(book_chunks_fts, 0, '«', '»', '…', 24) AS snip,
                b.title, b.author, b.format, b.file_path
         FROM book_chunks_fts f
         JOIN books b ON b.id = f.book_id
         WHERE f.text MATCH ?1
         ORDER BY bm25(book_chunks_fts)
         LIMIT ?2"
    };

    let mapper = |row: &rusqlite::Row| {
        Ok(FtsHit {
            chunk_id: row.get(0)?,
            book_id: row.get(1)?,
            spine_index: row.get(2)?,
            snippet: row.get(3)?,
            book_title: row.get(4)?,
            book_author: row.get(5)?,
            book_format: row.get(6)?,
            book_path: row.get(7)?,
        })
    };

    let mut stmt = conn.prepare(sql)?;
    let rows = if let Some(bid) = book_id {
        stmt.query_map(params![match_expr, bid, limit], mapper)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map(params![match_expr, limit], mapper)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- C1: FTS5 ----------

    #[test]
    fn build_fts_match_escapes_quotes_and_wraps() {
        assert_eq!(build_fts_match("人间词话"), r#""人间词话""#);
        // 用户输入双引号 → 转成两个引号 (FTS5 字符串字面量规则)
        assert_eq!(build_fts_match(r#"a"b"#), r#""a""b""#);
        // 控制字符被剥掉
        assert_eq!(build_fts_match("a\tb\nc"), r#""abc""#);
        // 反斜杠剥掉
        assert_eq!(build_fts_match(r"\path\\"), r#""path""#);
    }

    /// 端到端冒烟：建表→插数据→查→确认 trigram 中文检索能跑通。
    /// 这个测试同时验证 SQLite bundled 版本支持 FTS5 trigram 分词器。
    #[test]
    fn fts5_trigram_matches_chinese() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE books (id INTEGER PRIMARY KEY, file_path TEXT NOT NULL,
                                  format TEXT NOT NULL DEFAULT '',
                                  title TEXT NOT NULL DEFAULT '',
                                  author TEXT NOT NULL DEFAULT '');
             CREATE TABLE book_chunks (id INTEGER PRIMARY KEY,
                                        book_id INTEGER NOT NULL,
                                        spine_index INTEGER NOT NULL,
                                        chunk_index INTEGER NOT NULL,
                                        text TEXT NOT NULL);
             CREATE VIRTUAL TABLE book_chunks_fts USING fts5(
                 text, book_id UNINDEXED, spine_index UNINDEXED, chunk_id UNINDEXED,
                 tokenize='trigram'
             );
             INSERT INTO books(id, file_path, title, author) VALUES (1, 'p', '词话', '王国维');
             INSERT INTO book_chunks(id, book_id, spine_index, chunk_index, text)
                VALUES (1, 1, 0, 0, '人间词话讲究境界');
             INSERT INTO book_chunks_fts(rowid, text, book_id, spine_index, chunk_id)
                VALUES (1, '人间词话讲究境界', 1, 0, 0);",
        )
        .unwrap();

        let hits = search_fts(&conn, "人间词话", None, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].book_id, 1);
        // snippet 应该包含我们的命中标记
        assert!(hits[0].snippet.contains('«') || hits[0].snippet.contains('»'));

        // 无关查询应返空
        let none = search_fts(&conn, "外星人", None, 10).unwrap();
        assert!(none.is_empty());

        // 空查询应返空（防 FTS5 parse error）
        let empty = search_fts(&conn, "   ", None, 10).unwrap();
        assert!(empty.is_empty());
    }

    #[test]
    fn normalize_tags_dedup_and_whitelist() {
        let raw: Vec<String> = vec![
            "历史".into(),
            "历史".into(), // dup
            "科技".into(),
            "外星玄学".into(), // not in whitelist → dropped
            "".into(),         // empty → dropped
        ];
        let out = normalize_tags(&raw);
        assert_eq!(out, vec!["历史".to_string(), "科技".to_string()]);
    }

    #[test]
    fn normalize_tags_snaps_substring_to_whitelist() {
        let raw: Vec<String> = vec![
            "历史 / 文化".into(), // contains "历史" → snap
            "科技与未来".into(),  // contains "科技" → snap
        ];
        let out = normalize_tags(&raw);
        assert_eq!(out, vec!["历史".to_string(), "科技".to_string()]);
    }

    #[test]
    fn normalize_tags_caps_at_three() {
        let raw: Vec<String> = vec![
            "历史".into(),
            "科技".into(),
            "哲学".into(),
            "心理".into(),
        ];
        let out = normalize_tags(&raw);
        assert_eq!(out.len(), 3);
        assert_eq!(
            out,
            vec!["历史".to_string(), "科技".to_string(), "哲学".to_string()]
        );
    }

    #[test]
    fn normalize_tags_empty_input_yields_empty() {
        let out = normalize_tags(&[]);
        assert!(out.is_empty());
    }
}
