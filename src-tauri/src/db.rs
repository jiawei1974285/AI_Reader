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
"#;

pub fn open(db_path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
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
    Ok(conn)
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

pub fn add_read_time(
    conn: &Connection,
    book_id: i64,
    delta_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE books SET read_time_ms = read_time_ms + ?1 WHERE id = ?2",
        params![delta_ms, book_id],
    )?;
    Ok(())
}

pub fn set_book_category(
    conn: &Connection,
    book_id: i64,
    category: &str,
) -> rusqlite::Result<()> {
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

pub fn get_book_cover_path(
    conn: &Connection,
    file_path: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT cover_path FROM books WHERE file_path = ?1",
        params![file_path],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|opt| opt.flatten())
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadingProgress {
    pub book_id: i64,
    pub spine_index: i64,
    pub scroll_y: f64,
    pub updated_at: i64,
}

pub fn get_progress(conn: &Connection, book_id: i64) -> rusqlite::Result<Option<ReadingProgress>> {
    conn.query_row(
        "SELECT book_id, spine_index, scroll_y, updated_at
         FROM reading_progress WHERE book_id = ?1",
        params![book_id],
        |row| {
            Ok(ReadingProgress {
                book_id: row.get(0)?,
                spine_index: row.get(1)?,
                scroll_y: row.get(2)?,
                updated_at: row.get(3)?,
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
    updated_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO reading_progress (book_id, spine_index, scroll_y, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(book_id) DO UPDATE SET
            spine_index = excluded.spine_index,
            scroll_y = excluded.scroll_y,
            updated_at = excluded.updated_at",
        params![book_id, spine_index, scroll_y, updated_at],
    )?;
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
    now_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO book_chunks (book_id, spine_index, chunk_index, text, embedding, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(book_id, spine_index, chunk_index) DO UPDATE SET
            text = excluded.text,
            embedding = excluded.embedding",
        params![book_id, spine_index, chunk_index, text, embedding, now_ms],
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

pub fn get_track_tag(
    conn: &Connection,
    track_path: &str,
) -> rusqlite::Result<Option<TrackTag>> {
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

pub fn list_all_track_tags(
    conn: &Connection,
) -> rusqlite::Result<Vec<TrackTagWithEmbedding>> {
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

/// Load chunks for one or all indexed books. If `book_id` is Some, scopes
/// to that book; if None, returns chunks from every book in the library.
pub fn list_chunks(
    conn: &Connection,
    book_id: Option<i64>,
) -> rusqlite::Result<Vec<ChunkRow>> {
    let mut rows = Vec::new();
    if let Some(bid) = book_id {
        let mut stmt = conn.prepare(
            "SELECT id, book_id, spine_index, text, embedding
             FROM book_chunks WHERE book_id = ?1",
        )?;
        let iter = stmt.query_map(params![bid], |r| {
            Ok(ChunkRow {
                id: r.get(0)?,
                book_id: r.get(1)?,
                spine_index: r.get(2)?,
                text: r.get(3)?,
                embedding: r.get(4)?,
            })
        })?;
        for c in iter {
            rows.push(c?);
        }
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, book_id, spine_index, text, embedding FROM book_chunks",
        )?;
        let iter = stmt.query_map([], |r| {
            Ok(ChunkRow {
                id: r.get(0)?,
                book_id: r.get(1)?,
                spine_index: r.get(2)?,
                text: r.get(3)?,
                embedding: r.get(4)?,
            })
        })?;
        for c in iter {
            rows.push(c?);
        }
    }
    Ok(rows)
}
