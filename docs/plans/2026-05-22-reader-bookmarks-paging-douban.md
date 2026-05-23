# Reader Bookmarks, Paging, Douban Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-book bookmark navigation, two reader modes, and background Douban metadata enrichment without blocking the UI.

**Architecture:** Extend the existing SQLite-backed IPC layer for per-book bookmarks and cached Douban metadata. Keep reader mode in `reader_settings`, with continuous scroll as the default and horizontal paging as an alternate layout for text-based readers. Run Douban enrichment as a best-effort background command from app startup and cache results for hover cards.

**Tech Stack:** Tauri 2, Rust, rusqlite, reqwest, React 19, TypeScript, Tailwind v4.

---

### Task 1: Per-Book Bookmark List

**Files:**
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/ipc.ts`
- Modify: `src/features/reader/EpubView.tsx`
- Modify: `src/features/reader/PdfView.tsx`

**Steps:**
1. Add DB functions to list bookmarks by `book_id` and delete bookmark by `id`.
2. Register `list_bookmarks_by_book` and `delete_bookmark` Tauri commands.
3. Add IPC types and wrappers.
4. Add a right-side reader bookmark panel showing only current-book bookmarks.
5. Wire bookmark click to jump to `spine_index + scroll_y`.

### Task 2: Reader Mode Selection

**Files:**
- Modify: `src/lib/ipc.ts`
- Modify: `src/features/reader/ReaderSettings.tsx`
- Modify: `src/features/reader/EpubView.tsx`
- Modify: `src/index.css`

**Steps:**
1. Add `reading_mode: "scroll" | "paged"` to `ReaderSettings`.
2. Add a segmented control in reader settings.
3. Keep existing infinite scroll for `scroll`.
4. Add horizontal paging for text-based readers using a single-chapter paged layout with prev/next controls.
5. Keep PDF on its existing page/text behavior for now.

### Task 3: Background Douban Metadata

**Files:**
- Create: `src-tauri/src/library/douban.rs`
- Modify: `src-tauri/src/library/mod.rs`
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/ipc.ts`
- Modify: `src/App.tsx`
- Modify: `src/features/library/BookCard.tsx`

**Steps:**
1. Add `book_metadata` cache table keyed by `book_id`.
2. Add best-effort Douban search/fetch parser with graceful failure.
3. Add `refresh_douban_metadata` command that skips cached fresh rows unless forced.
4. Start refresh in the background after library load/app startup.
5. Add hover card on book cover that reads cached metadata and displays rating, rating count, summary, and source link.

### Task 4: Verification And Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/FEATURES.md`
- Modify: `docs/DATA_MODEL.md`
- Modify: `docs/IPC.md`

**Steps:**
1. Document new bookmark list, reader mode, and Douban cache behavior.
2. Run `npm run build`.
3. Run `cargo test --lib`.
4. Run `git diff --check`.
