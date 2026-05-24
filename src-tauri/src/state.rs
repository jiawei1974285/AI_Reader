use crate::library::watcher::LibraryDebouncer;
use std::sync::Mutex;

/// B3: r2d2 连接池别名。每个 `state.db.get()` 拿到的 `DbConn` 实现了
/// `Deref<Target=Connection>`，传给 `db::xxx(&conn, ...)` 的所有函数无需改签名。
pub type DbPool = r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>;
pub type DbConn = r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>;

pub struct AppState {
    /// B3: 从全局 `Mutex<Connection>` 改为 r2d2 池。
    ///
    /// 接口契约保持「一个不可变引用 + `.get()` 返回 `Result<DbConn, _>`」，
    /// 调用方只需把原来的 `state.db.lock().map_err(...)` 改成
    /// `state.db.get().map_err(...)`，下游 db 函数无变化。
    pub db: DbPool,
    /// Live file-watcher for the library root. `None` until the user
    /// configures (or app startup picks up) a library_root. Replacing
    /// the value drops the old debouncer, which releases the OS handles.
    pub watcher: Mutex<Option<LibraryDebouncer>>,
}
