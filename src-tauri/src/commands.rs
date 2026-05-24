use crate::db;
use crate::library::douban;
use crate::library::scanner::{self, ScanReport};
use crate::library::watcher;
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[tauri::command]
pub fn get_library_root(state: State<AppState>) -> Result<Option<String>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::config_get(&conn, "library_root").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_library_root(path: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::config_set(&conn, "library_root", &path).map_err(|e| e.to_string())
}

/// Start (or restart) the file watcher on the configured library root.
/// Called by the frontend once on app startup and again after the user
/// changes the library root. Idempotent — dropping the old debouncer
/// releases its OS handles automatically.
///
/// Returns `true` if a watcher is now active, `false` if there's no
/// library root configured yet (no error — user just hasn't set one).
#[tauri::command]
pub fn start_library_watcher(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let root_opt = {
        let conn = state.db.get().map_err(|e| e.to_string())?;
        db::config_get(&conn, "library_root").map_err(|e| e.to_string())?
    };
    let Some(root) = root_opt else {
        // Clear any existing watcher — root may have been unset
        let mut w = state.watcher.lock().map_err(|e| e.to_string())?;
        *w = None;
        return Ok(false);
    };

    let path = Path::new(&root);
    if !path.exists() {
        return Err(format!("library_root 不存在: {root}"));
    }

    let new_debouncer = watcher::start(app, path)?;
    let mut w = state.watcher.lock().map_err(|e| e.to_string())?;
    // Replacing drops the old one, which stops its watch.
    *w = Some(new_debouncer);
    Ok(true)
}

#[tauri::command]
#[tracing::instrument(skip_all)]
pub fn scan_library(state: State<AppState>, app: tauri::AppHandle) -> Result<ScanReport, String> {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let covers_dir = app_data.join("covers");
    let conn = state.db.get().map_err(|e| e.to_string())?;
    let root = db::config_get(&conn, "library_root")
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Library root not configured".to_string())?;
    let started = std::time::Instant::now();
    let result = scanner::scan(&conn, &PathBuf::from(root), Some(&covers_dir));
    match &result {
        Ok(report) => tracing::info!(
            scanned = report.scanned,
            added_or_updated = report.added_or_updated,
            removed = report.removed,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "scan_library complete"
        ),
        Err(e) => tracing::warn!(error = %e, "scan_library failed"),
    }
    result
}

#[tauri::command]
pub fn list_books(state: State<AppState>) -> Result<Vec<db::Book>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::list_books(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_douban_metadata(
    book_id: i64,
    state: State<AppState>,
) -> Result<Option<db::DoubanMetadata>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::get_douban_metadata(&conn, book_id).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DoubanRefreshReport {
    pub scheduled: usize,
}

#[tauri::command]
pub fn refresh_douban_metadata(
    force: Option<bool>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<DoubanRefreshReport, String> {
    use tauri::Manager;
    let force = force.unwrap_or(false);
    let books = {
        let conn = state.db.get().map_err(|e| e.to_string())?;
        db::list_books_for_douban_refresh(&conn, force).map_err(|e| e.to_string())?
    };
    let scheduled = books.len();
    if scheduled == 0 {
        return Ok(DoubanRefreshReport { scheduled });
    }

    let db_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("aireader.db");
    tauri::async_runtime::spawn(async move {
        for book in books {
            let metadata = douban::fetch_book_metadata(&book).await;
            if let Ok(conn) = db::open(&db_path) {
                let _ = db::upsert_douban_metadata(&conn, &metadata);
            }
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        }
    });

    Ok(DoubanRefreshReport { scheduled })
}

/// Remove a book from the library WITHOUT deleting the underlying file.
/// CASCADE drops dependent rows: reading_progress, highlights, book_chunks,
/// book_index_status, chat_messages. The on-disk file at `books.file_path`
/// is left alone — users can re-add it by scanning, or the file watcher
/// will pick it back up on its own.
///
/// Note: a re-scan WILL re-add this book unless the user moves it out of
/// the library root first. There's no "ignore list" yet; we may add one
/// if this becomes a frequent gripe.
#[tauri::command]
pub fn remove_book(book_id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM books WHERE id = ?1",
        rusqlite::params![book_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_book_by_path(path: String, state: State<AppState>) -> Result<Option<db::Book>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::get_book_by_path(&conn, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_progress(
    book_id: i64,
    state: State<AppState>,
) -> Result<Option<db::ReadingProgress>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::get_progress(&conn, book_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[tracing::instrument(
    skip(state),
    fields(book_id = book_id, spine = spine_index, para = paragraph_index)
)]
pub fn save_progress(
    book_id: i64,
    spine_index: i64,
    scroll_y: f64,
    paragraph_index: Option<i64>,
    char_offset: Option<i64>,
    state: State<AppState>,
) -> Result<(), String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    let started = std::time::Instant::now();
    let conn = state.db.get().map_err(|e| e.to_string())?;
    let lock_ms = started.elapsed().as_millis() as u64;
    if lock_ms > 50 {
        // 高频调用，正常应 < 5ms。> 50 表示 RAG 检索或扫描占着 DB 锁
        // (CLAUDE.md 原则 11 反馈环过长的早期信号)
        tracing::warn!(lock_ms, "save_progress 拿到锁等待过长");
    }
    db::save_progress(
        &conn,
        book_id,
        spine_index,
        scroll_y,
        paragraph_index,
        char_offset,
        now_ms,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_bookmark(
    book_id: i64,
    spine_index: i64,
    scroll_y: f64,
    label: String,
    excerpt: String,
    state: State<AppState>,
) -> Result<db::Bookmark, String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    let conn = state.db.get().map_err(|e| e.to_string())?;
    let id = db::create_bookmark(
        &conn,
        book_id,
        spine_index,
        scroll_y,
        &label,
        &excerpt,
        now_ms,
    )
    .map_err(|e| e.to_string())?;
    Ok(db::Bookmark {
        id,
        book_id,
        spine_index,
        scroll_y,
        label,
        excerpt,
        created_at: now_ms,
    })
}

#[tauri::command]
pub fn list_recent_bookmarks(
    limit: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<db::BookmarkWithBook>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(100).clamp(1, 500);
    db::list_recent_bookmarks(&conn, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_bookmarks_by_book(
    book_id: i64,
    state: State<AppState>,
) -> Result<Vec<db::Bookmark>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::list_bookmarks_by_book(&conn, book_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_bookmark(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::delete_bookmark(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_reader_settings(state: State<AppState>) -> Result<Option<String>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::config_get(&conn, "reader_settings").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_reader_settings(value: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::config_set(&conn, "reader_settings", &value).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_highlight(
    book_id: i64,
    spine_index: i64,
    selected_text: String,
    prefix: String,
    suffix: String,
    color: String,
    note: String,
    state: State<AppState>,
) -> Result<db::Highlight, String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    let conn = state.db.get().map_err(|e| e.to_string())?;
    let id = db::create_highlight(
        &conn,
        book_id,
        spine_index,
        &selected_text,
        &prefix,
        &suffix,
        &color,
        &note,
        now_ms,
    )
    .map_err(|e| e.to_string())?;
    Ok(db::Highlight {
        id,
        book_id,
        spine_index,
        selected_text,
        prefix,
        suffix,
        color,
        note,
        created_at: now_ms,
        updated_at: now_ms,
    })
}

#[tauri::command]
pub fn list_highlights_by_chapter(
    book_id: i64,
    spine_index: i64,
    state: State<AppState>,
) -> Result<Vec<db::Highlight>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::list_highlights_by_chapter(&conn, book_id, spine_index).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_highlights_by_book(
    book_id: i64,
    state: State<AppState>,
) -> Result<Vec<db::Highlight>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::list_highlights_by_book(&conn, book_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_all_highlights(
    query: Option<String>,
    state: State<AppState>,
) -> Result<Vec<db::HighlightWithBook>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::list_all_highlights_with_book(&conn, query.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_highlight(
    id: i64,
    color: String,
    note: String,
    state: State<AppState>,
) -> Result<(), String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::update_highlight(&conn, id, &color, &note, now_ms).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_highlight(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::delete_highlight(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_music_root(state: State<AppState>) -> Result<Option<String>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::config_get(&conn, "music_root").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_music_root(path: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::config_set(&conn, "music_root", &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn scan_music(state: State<AppState>) -> Result<Vec<crate::music::scanner::Track>, String> {
    let root = {
        let conn = state.db.get().map_err(|e| e.to_string())?;
        db::config_get(&conn, "music_root")
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "音乐目录未配置".to_string())?
    };
    Ok(crate::music::scanner::scan(std::path::Path::new(&root)))
}

#[tauri::command]
pub fn list_track_tags(state: State<AppState>) -> Result<Vec<db::TrackTag>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::list_track_tag_meta(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_history_load(
    book_id: i64,
    mode: String,
    spine_index: i64,
    state: State<AppState>,
) -> Result<Vec<db::ChatHistoryMsg>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::list_chat_messages(&conn, book_id, &mode, spine_index).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_history_append(
    book_id: i64,
    mode: String,
    spine_index: i64,
    role: String,
    content: String,
    state: State<AppState>,
) -> Result<(), String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::append_chat_message(&conn, book_id, &mode, spine_index, &role, &content, now_ms)
        .map_err(|e| e.to_string())
}

/// Add `delta_ms` to the book's cumulative read time. Called by the
/// reader UI on a heartbeat (e.g. every 30 seconds while the page is
/// visible). Frontend caps the delta to a sensible max so a stalled
/// session can't bank false hours.
///
/// 读书日历: 当 `day_key` 不为 None 时同时往 `reading_sessions` 累加一条。
/// `day_key` 由前端按用户本地时区算（YYYYMMDD 整数）—— 服务端不知道时区。
#[tauri::command]
pub fn add_read_time(
    book_id: i64,
    delta_ms: i64,
    day_key: Option<i64>,
    state: State<AppState>,
) -> Result<(), String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::add_read_time(&conn, book_id, delta_ms).map_err(|e| e.to_string())?;
    if let Some(day) = day_key {
        // 日历写入失败不让总累计也失败（双表是冗余兜底，原则 14）
        if let Err(e) = db::add_reading_session(&conn, book_id, day, delta_ms, now_ms) {
            tracing::warn!(error = %e, book_id, day, "reading_sessions 写入失败");
        }
    }
    Ok(())
}

/// 读书日历月视图。前端传 [from_day, to_day]（YYYYMMDD），返回区间内
/// 所有有阅读活动的天 + 当天总时长 + 涉及书数。
#[tauri::command]
pub fn list_calendar_days(
    from_day: i64,
    to_day: i64,
    state: State<AppState>,
) -> Result<Vec<db::CalendarDay>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::list_calendar_days(&conn, from_day, to_day).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DayReading {
    pub day_key: i64,
    pub sessions: Vec<db::DaySessionEntry>,
    pub highlights: Vec<db::HighlightWithBook>,
    pub bookmarks: Vec<db::BookmarkWithBook>,
}

/// 当日阅读详情：阅读时长（按书）+ 创建的高亮 + 创建的书签。
/// `start_ms` / `end_ms` 是当天本地时区的 [00:00, 次日00:00) epoch ms，
/// 用于框定 highlights/bookmarks 的 created_at（按时间戳过滤更可靠）。
#[tauri::command]
pub fn get_day_reading(
    day_key: i64,
    start_ms: i64,
    end_ms: i64,
    state: State<AppState>,
) -> Result<DayReading, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    let sessions = db::list_day_sessions(&conn, day_key).map_err(|e| e.to_string())?;
    let highlights = db::list_day_highlights(&conn, start_ms, end_ms).map_err(|e| e.to_string())?;
    let bookmarks = db::list_day_bookmarks(&conn, start_ms, end_ms).map_err(|e| e.to_string())?;
    Ok(DayReading {
        day_key,
        sessions,
        highlights,
        bookmarks,
    })
}

#[tauri::command]
pub fn chat_history_clear(
    book_id: i64,
    mode: String,
    spine_index: i64,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::clear_chat_messages(&conn, book_id, &mode, spine_index).map_err(|e| e.to_string())
}

// ---------- B4: per-book tags ----------

#[tauri::command]
pub fn list_book_tags(book_id: i64, state: State<AppState>) -> Result<Vec<String>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::list_book_tags(&conn, book_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_book_tags(
    book_id: i64,
    tags: Vec<String>,
    source: String,
    state: State<AppState>,
) -> Result<Vec<String>, String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    let normalized = db::normalize_tags(&tags);
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    db::set_book_tags(&mut conn, book_id, &normalized, &source, now_ms)
        .map_err(|e| e.to_string())?;
    // 同步主标签 (books.category) — 第一个标签作为兼容性主类目。
    let primary = normalized.first().cloned().unwrap_or_default();
    db::set_book_category(&conn, book_id, &primary).map_err(|e| e.to_string())?;
    Ok(normalized)
}

#[tauri::command]
pub fn add_book_tag(
    book_id: i64,
    tag: String,
    source: String,
    state: State<AppState>,
) -> Result<Vec<String>, String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    // Snap a single tag through the same whitelist normalizer.
    let snapped = db::normalize_tags(&[tag]);
    let conn = state.db.get().map_err(|e| e.to_string())?;
    if let Some(t) = snapped.first() {
        db::add_book_tag(&conn, book_id, t, &source, now_ms).map_err(|e| e.to_string())?;
        // Keep `books.category` as the first tag if it was empty —
        // otherwise the chip filter on the old UI would silently lose
        // newly added books from the user's view.
        let existing = db::list_book_tags(&conn, book_id).map_err(|e| e.to_string())?;
        if let Some(first) = existing.first() {
            db::set_book_category(&conn, book_id, first).map_err(|e| e.to_string())?;
        }
    }
    db::list_book_tags(&conn, book_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_book_tag(
    book_id: i64,
    tag: String,
    state: State<AppState>,
) -> Result<Vec<String>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::remove_book_tag(&conn, book_id, &tag).map_err(|e| e.to_string())?;
    let remaining = db::list_book_tags(&conn, book_id).map_err(|e| e.to_string())?;
    // Rewrite the primary `books.category` to the new first tag (or "")
    // so the legacy filter stays consistent.
    let primary = remaining.first().cloned().unwrap_or_default();
    db::set_book_category(&conn, book_id, &primary).map_err(|e| e.to_string())?;
    Ok(remaining)
}

#[tauri::command]
pub fn list_all_book_tags(state: State<AppState>) -> Result<Vec<db::BookTagRow>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::list_all_book_tags(&conn).map_err(|e| e.to_string())
}

/// Decrypt a NetEase `.ncm` audio file into our music cache and return
/// the absolute path of the decrypted (mp3/flac) file. Subsequent calls
/// for the same source hit the cache instantly.
#[tauri::command]
pub async fn decrypt_ncm(path: String, app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let cache_dir = app_data.join("music_cache");
    let src = std::path::PathBuf::from(path);
    tokio::task::spawn_blocking(move || crate::music::ncm::decrypt_to_cache(&src, &cache_dir))
        .await
        .map_err(|e| e.to_string())?
}

/// Read the LRC lyric file that sits next to an audio file (same stem,
/// `.lrc` extension). Returns the decoded text content, or `None` if no
/// .lrc file exists.
///
/// LRC files in the wild are commonly UTF-8 (with or without BOM), UTF-16
/// LE/BE, or GBK (older Chinese tools). We detect encoding the same way
/// the TXT reader does.
#[tauri::command]
pub fn read_lrc(audio_path: String) -> Result<Option<String>, String> {
    let audio = Path::new(&audio_path);
    let lrc = audio.with_extension("lrc");
    if !lrc.exists() {
        // Also try the .LRC uppercase variant — Windows file systems are
        // case-insensitive but the metadata can preserve case.
        let alt = audio.with_extension("LRC");
        if !alt.exists() {
            return Ok(None);
        }
        return Ok(Some(crate::readers::txt::read_and_decode(&alt)?));
    }
    Ok(Some(crate::readers::txt::read_and_decode(&lrc)?))
}
