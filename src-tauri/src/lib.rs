mod ai;
mod commands;
mod db;
mod library;
mod music;
mod readers;
mod state;

use state::AppState;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            let db_path = app_data.join("aireader.db");
            let conn = db::open(&db_path)
                .map_err(|e| format!("Failed to open database: {e}"))?;
            app.manage(AppState {
                db: Mutex::new(conn),
                watcher: Mutex::new(None),
            });
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
            commands::remove_book,
            commands::get_book_by_path,
            commands::get_progress,
            commands::save_progress,
            commands::get_reader_settings,
            commands::set_reader_settings,
            commands::create_highlight,
            commands::list_highlights_by_chapter,
            commands::list_highlights_by_book,
            commands::list_all_highlights,
            commands::update_highlight,
            commands::delete_highlight,
            ai::chat::ai_chat,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
