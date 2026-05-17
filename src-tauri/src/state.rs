use crate::library::watcher::LibraryDebouncer;
use rusqlite::Connection;
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<Connection>,
    /// Live file-watcher for the library root. `None` until the user
    /// configures (or app startup picks up) a library_root. Replacing
    /// the value drops the old debouncer, which releases the OS handles.
    pub watcher: Mutex<Option<LibraryDebouncer>>,
}
