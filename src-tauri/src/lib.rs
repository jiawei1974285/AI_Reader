mod ai;
mod commands;
mod db;
mod library;
mod music;
mod readers;
mod secrets;
mod state;

use state::AppState;
use std::sync::Mutex;
use tauri::Manager;
use tracing::info;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// A5 (CLAUDE.md 原则 8 能观测性): 把日志写到 app_data/logs/aireader.log，
/// 按天滚动。同时 stderr 也输出，方便 `npm run tauri dev` 时直接看。
///
/// 日志等级默认 `info`，可以通过 `AIREADER_LOG=debug` / `=warn` 环境变量调整。
/// 不设置时 noisy 第三方 crate (hyper/tracing 自身/h2) 被 EnvFilter 默认压到 warn。
fn init_tracing(log_dir: &std::path::Path) {
    let _ = std::fs::create_dir_all(log_dir);
    let file_appender = tracing_appender::rolling::daily(log_dir, "aireader.log");
    // 注意：file_appender 是 non-blocking guard，正常应该 leak 一份保活——
    // 因为 run() 永不返回，简单 Box::leak 即可；如果之后改成可以 graceful
    // exit 再换成显式 _guard 形式。
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    Box::leak(Box::new(guard));

    let filter = EnvFilter::try_from_env("AIREADER_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,hyper=warn,h2=warn,reqwest=warn,tracing=warn"));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(std::io::stderr).with_target(true))
        .with(
            fmt::layer()
                .with_writer(non_blocking)
                .with_ansi(false)
                .with_target(true)
                .json(),
        )
        .init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;

            // A5: 先把日志拉起来再 open DB，DB 启动报错也能进日志
            init_tracing(&app_data.join("logs"));
            info!(app_data = %app_data.display(), "aireader starting");

            let db_path = app_data.join("aireader.db");
            // B3: 启动 r2d2 连接池替代单 Mutex<Connection>
            let pool = db::init_pool(&db_path)
                .map_err(|e| format!("Failed to init DB pool: {e}"))?;

            // A3: 一次性迁移旧版 SQLite 里的明文 api_key 到 OS keystore
            if let Ok(conn) = pool.get() {
                if let Err(e) = ai::chat::migrate_api_key_to_keystore(&conn) {
                    tracing::warn!(error = %e, "api_key 迁移到 keystore 失败（可在设置面板重新输入）");
                }
            }

            app.manage(AppState {
                db: pool,
                watcher: Mutex::new(None),
            });
            info!("aireader ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            readers::epub::read_epub_preview,
            readers::epub::read_epub_chapter,
            readers::epub::get_book_toc,
            readers::txt::read_txt_initial,
            readers::txt::read_txt_chapter,
            readers::txt::get_txt_toc,
            readers::docx::read_docx_initial,
            readers::docx::read_docx_chapter,
            readers::docx::get_docx_toc,
            readers::mobi::read_mobi_initial,
            readers::mobi::read_mobi_chapter,
            readers::mobi::get_mobi_toc,
            readers::pdf::read_pdf_page_text,
            commands::get_library_root,
            commands::set_library_root,
            commands::scan_library,
            commands::start_library_watcher,
            commands::list_books,
            commands::get_douban_metadata,
            commands::refresh_douban_metadata,
            commands::remove_book,
            commands::get_book_by_path,
            commands::get_progress,
            commands::save_progress,
            commands::create_bookmark,
            commands::list_recent_bookmarks,
            commands::list_bookmarks_by_book,
            commands::delete_bookmark,
            commands::get_reader_settings,
            commands::set_reader_settings,
            commands::create_highlight,
            commands::list_highlights_by_chapter,
            commands::list_highlights_by_book,
            commands::list_all_highlights,
            commands::update_highlight,
            commands::delete_highlight,
            ai::chat::ai_chat,
            ai::chat::test_ai_model,
            ai::chat::ai_extract_entities,
            ai::chat::ai_chat_stream,
            ai::chat::ai_chat_rag_stream,
            ai::chat::get_ai_settings,
            ai::chat::set_ai_settings,
            ai::chat::ai_index_book,
            ai::chat::ai_get_index_status,
            ai::chat::ai_summarize_highlights,
            ai::chat::ai_chat_rag,
            ai::chat::ai_recommend_books,
            ai::chat::ai_tag_music_tracks,
            ai::chat::ai_recommend_music,
            ai::chat::ai_classify_books,
            commands::get_music_root,
            commands::set_music_root,
            commands::scan_music,
            commands::decrypt_ncm,
            commands::read_lrc,
            commands::list_track_tags,
            commands::chat_history_load,
            commands::chat_history_append,
            commands::chat_history_clear,
            commands::add_read_time,
            commands::list_calendar_days,
            commands::get_day_reading,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
