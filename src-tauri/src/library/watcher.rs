//! 文件监听 — 用户往 library_root 里扔新书 / 删书 / 改名时，自动跑一次增量
//! 扫描，并 emit `library-changed { ScanReport }` 让前端刷新书架。
//!
//! 策略（按 CLAUDE.md 原则 11「时滞会引起振荡」+ 原则 14「冗余容错」）：
//! - 用 `notify-debouncer-full` 2s 窗口聚合一连串文件操作（用户拷一个目录
//!   过来会产生几十上百个事件，coalesce 后只触发一次 rescan）
//! - 即使 rescan 失败也不 panic — 监听任务是后台尽力服务，错误日志吞掉
//! - 重置 watcher 时，旧的 Debouncer drop 后 OS 资源自动释放，不需要手动 stop

use crate::library::scanner;
use crate::state::AppState;
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Type alias — debouncer-full's parameterised type is mouthful.
pub type LibraryDebouncer = Debouncer<RecommendedWatcher, RecommendedCache>;

const DEBOUNCE_SECS: u64 = 2;

/// Build a watcher rooted at `root_dir`. Returns the live `Debouncer`
/// which the caller must keep alive (storing in AppState) — dropping it
/// stops the watch.
///
/// The watcher fires when any file with a supported book extension is
/// created / modified / deleted / renamed in the watched tree. Each
/// settled batch coalesces into one re-scan, which writes the DB and
/// emits `library-changed`.
pub fn start(app: AppHandle, root_dir: &Path) -> Result<LibraryDebouncer, String> {
    // Forward sync notify callbacks to an async task via mpsc.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    let mut debouncer = new_debouncer(
        Duration::from_secs(DEBOUNCE_SECS),
        None,
        move |res: DebounceEventResult| {
            if let Ok(events) = res {
                // Only trigger rescan if at least one event touches a
                // supported book extension — ignore noise like .tmp / .db-wal.
                let touched_book = events
                    .iter()
                    .any(|ev| ev.paths.iter().any(|p| is_supported_path(p)));
                if touched_book {
                    let _ = tx.send(());
                }
            }
        },
    )
    .map_err(|e| format!("watcher init failed: {e}"))?;

    debouncer
        .watch(root_dir, RecursiveMode::Recursive)
        .map_err(|e| format!("watcher watch failed: {e}"))?;

    let app_async = app.clone();
    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {
            // Coalesce any extra pings that arrived during the previous tick
            // — they'd all trigger the same rescan anyway.
            while rx.try_recv().is_ok() {}

            run_rescan(&app_async);
        }
    });

    Ok(debouncer)
}

fn run_rescan(app: &AppHandle) {
    let state = app.state::<AppState>();

    let app_data = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(_) => return,
    };
    let covers_dir = app_data.join("covers");

    let report = {
        let Ok(conn) = state.db.get() else { return };
        let Some(root) = crate::db::config_get(&conn, "library_root").ok().flatten() else {
            return;
        };
        match scanner::scan(&conn, Path::new(&root), Some(&covers_dir)) {
            Ok(r) => r,
            Err(_) => return,
        }
    };

    let _ = app.emit("library-changed", report);
}

fn is_supported_path(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "epub" | "txt" | "pdf" | "docx" | "mobi" | "azw" | "azw3"
    )
}
