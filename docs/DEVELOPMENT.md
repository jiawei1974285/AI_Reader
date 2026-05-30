# 开发指南

> 本文目标：让你 30 分钟内能把项目跑起来、做改动、看到改动生效、打成 release 包。

---

## 1. 环境

### 必装

| 工具 | 版本 | 说明 |
|---|---|---|
| Windows | 10 / 11 | 主要测试平台 |
| Node.js | ≥ 20 | 推荐 LTS |
| npm | ≥ 10 | 跟 Node 一起来 |
| Rust | ≥ 1.76 | `rustup install stable` |
| WebView2 | 内置 | Win11 自带，Win10 可能需要单独安装 [Evergreen Bootstrapper](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) |
| Visual Studio Build Tools | 2022 | Rust 在 Windows 上需要 MSVC linker |

### 选装

| 工具 | 用途 |
|---|---|
| VS Code + `rust-analyzer` + `tauri-vscode` | 主力 IDE |
| `cargo-watch` | 改 Rust 自动重编 (`cargo install cargo-watch`) |
| `sqlite3` CLI / DB Browser for SQLite | 直接看 / 改 `aireader.db` |

---

## 2. 跑起来

```powershell
git clone <repo-url> aireader
cd aireader
npm install          # 装 npm deps（含拷 pdf.js CMaps 到 public/）
npm run tauri dev    # 第一次会 cargo build 全量编译 Rust，5-10 分钟
```

成功的话浏览器/Tauri 窗口同时打开，访问 `http://localhost:1420` 也能看到前端（但不能调 `invoke`）。

### 端口冲突
默认 Vite dev server 在 `1420`（`vite.config.ts` 写死，Tauri 的 `devUrl` 必须对得上）。如果被占：

```powershell
# 找 PID 然后杀
Get-NetTCPConnection -LocalPort 1420 | Select-Object OwningProcess
Stop-Process -Id <pid>
```

### Tauri 进程残留
有时候 `aireader.exe` 没被 Vite 重启拉走，下次启动会两个窗口并存：

```powershell
Get-Process aireader -ErrorAction SilentlyContinue | Stop-Process
```

---

## 3. 项目布局速查

```
aireader/
├── package.json             # npm scripts + 前端依赖
├── vite.config.ts           # Vite 配置 (端口 1420, 路径别名 @/)
├── tsconfig.json            # strict, "jsx": "react-jsx"
├── tailwind.config.* (无)   # Tailwind v4 用 @tailwindcss/vite plugin 自动发现
├── scripts/
│   └── copy-pdfjs-assets.mjs  # predev/prebuild 钩子，把 CMaps 拷到 public/
├── public/                  # 静态资源，构建时原样复制到 dist/
├── src/                     # 前端（见 ARCHITECTURE.md）
├── src-tauri/               # 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── capabilities/        # Tauri 权限定义（fs scope、dialog 等）
│   ├── icons/               # app 图标
│   ├── gen/                 # 自动生成（schemas 等），不要手改
│   └── src/                 # Rust 源码
└── docs/                    # 本目录
```

---

## 4. 常用 npm scripts

```json
"dev":              "vite",                     // 仅启前端，调 UI 用
"build":            "tsc && vite build",        // 仅出前端 dist/
"preview":          "vite preview",
"tauri":            "tauri",                    // tauri CLI 入口
"copy-pdfjs-assets":"node ./scripts/copy-pdfjs-assets.mjs",
"predev":           "npm run copy-pdfjs-assets",  // dev 前自动跑
"prebuild":         "npm run copy-pdfjs-assets"   // build 前自动跑
```

实际上常用就两条：

```powershell
npm run tauri dev      # 开发
npm run tauri build    # 打包
```

---

## 5. 调试

### 前端
- Tauri dev 窗口右键 → `Inspect Element` 打开 DevTools。
- React 组件树 / Redux 之类的 DevTools 浏览器扩展**不能用**（WebView2 不支持装扩展）。
- `console.log` 一切照常。
- TypeScript 类型检查：`npx tsc --noEmit`。

### 后端
- `println!` / `eprintln!` 会输出到运行 `npm run tauri dev` 的终端。
- 复杂调试：
  ```toml
  # Cargo.toml 加
  [profile.dev]
  debug = true
  ```
  然后用 VS Code + CodeLLDB / `rust-analyzer` debugger 挂 `aireader.exe`。

### 仅编译检查（不跑）
```powershell
cd src-tauri
cargo check          # 快，~3-10s 增量
cargo clippy         # lint
```

### 数据库
```powershell
# 默认数据库位置
$env:APPDATA = $env:APPDATA  # 通常是 C:\Users\<you>\AppData\Roaming
$dbPath = "$env:APPDATA\com.aireader.app\aireader.db"

# 用 sqlite3 CLI
sqlite3 "$dbPath"
sqlite> .schema
sqlite> SELECT id, title, read_time_ms, user_rating FROM books;
```

或者用 [DB Browser for SQLite](https://sqlitebrowser.org/) 图形界面。

---

## 6. 添加新功能的标准流程

### 6.1 新 Tauri command

例子：加一个 `delete_book(book_id)` 命令。

1. **写业务函数** — `src-tauri/src/db.rs`：
   ```rust
   pub fn delete_book(conn: &Connection, book_id: i64) -> rusqlite::Result<()> {
       conn.execute("DELETE FROM books WHERE id = ?", [book_id])?;
       Ok(())
   }
   ```

2. **包成 command** — `src-tauri/src/commands.rs`：
   ```rust
   #[tauri::command]
   pub fn delete_book(book_id: i64, state: State<AppState>) -> Result<(), String> {
       let conn = state.db.lock().map_err(|e| e.to_string())?;
       db::delete_book(&conn, book_id).map_err(|e| e.to_string())
   }
   ```

3. **注册** — `src-tauri/src/lib.rs` 的 `invoke_handler` 里加：
   ```rust
   commands::delete_book,
   ```

4. **前端 wrapper** — `src/lib/ipc.ts`：
   ```ts
   deleteBook: (bookId: number) =>
     invoke<void>("delete_book", { bookId }),
   ```

5. **调用** — 任意组件：
   ```ts
   await ipc.deleteBook(book.id);
   ```

> **注意命名约定**：Rust 端 `book_id`（snake_case），前端 invoke 时也用 snake_case（`bookId` → Tauri 自动转 snake）。返回类型要 `Serialize`。

### 6.2 新 Tauri event（异步推送）

例子：长任务进度通知。

后端：
```rust
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct MyProgress { current: usize, total: usize }

let _ = app.emit("my-progress", MyProgress { current, total });
```

前端：
```ts
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

useEffect(() => {
  let unlisten: UnlistenFn | null = null;
  listen<{ current: number; total: number }>("my-progress", (e) => {
    setProgress(e.payload);
  }).then((fn) => { unlisten = fn; });
  return () => { unlisten?.(); };
}, []);
```

### 6.3 新数据库列

SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，AIreader 用「盲 ALTER + 忽略 duplicate column 错误」模式：

`src-tauri/src/db.rs::open`：
```rust
let _ = conn.execute(
    "ALTER TABLE books ADD COLUMN my_new_col TEXT NOT NULL DEFAULT ''",
    [],
);
```

旧库升级时第一次成功，之后每次启动报 "duplicate column" 被 `let _ =` 吞掉，无害。

新建表则在 `SCHEMA_SQL` 常量里加 `CREATE TABLE IF NOT EXISTS …`。

例子：书籍评分用 `books.user_rating INTEGER` 保存 1–5 星或 `NULL`，通过 `set_book_rating` IPC 写入；这种轻量字段适合走盲 ALTER，不需要新表。

### 6.4 新 reader 格式

例子：加 MOBI 支持。

1. `src-tauri/Cargo.toml` 加 MOBI 解析依赖。
2. 新建 `src-tauri/src/readers/mobi.rs`，实现：
   - `pub fn read_mobi_initial(path) -> Result<EpubPreview, String>`
   - `pub fn read_mobi_chapter(path, spine_index) -> Result<EpubPreview, String>`
   - `pub fn get_mobi_toc(path) -> Result<Vec<TocEntry>, String>`
   - `pub fn extract_metadata(path) -> Result<(title, author)>`
3. 在 `src-tauri/src/readers/mod.rs` 加 `pub mod mobi;`
4. `lib.rs::invoke_handler` 注册三个新 command。
5. `library/scanner.rs::SUPPORTED_EXTS` 加 `"mobi"`；`extract_metadata` 分支调 `mobi::extract_metadata`。
6. `src/lib/ipc.ts`：
   - `Book.format` 加 `"mobi"`
   - `isMobi(path)` helper
   - `readBookInitial / readBookChapter / getBookToc` switch 加 mobi 分支
7. 前端：基本不动（EpubView 已经接受任何 HTML）。

---

## 7. 测试

> **当前状态：已有一组基础自动化测试。** 后端核心路径用 `cargo test --lib` 覆盖 URL 拼接、AI 错误脱敏、实体 JSON、EPUB 图片内联、MOBI/AZW 判码和章节 fallback；前端仍以 `npm run build` 的 TypeScript 检查为主。

人工测试套路（每次改完 AI / 持久化 / reader 之后都跑）：

1. 删 `%APPDATA%\com.aireader.app\` 模拟全新用户。
2. 选一个有 5+ 本 EPUB / PDF / TXT 的目录扫描。
3. 验证：封面、分类、搜索、排序都对。
4. 打开一本书 → 翻页 → 跳目录 → 涂高亮 → 写注释 → 关掉 → 重开 → 进度 + 高亮都在。
5. AI 三模都问一遍，看流式 + 引用跳转。
6. 跑 NCM 解密 + 音乐 mini player 跨页不断流。

常用自动化检查：
```powershell
npm run build
cd src-tauri
cargo test --lib
git diff --check
```

未来想继续补：
- Rust 业务模块（db / chunker / scanner）扩展更多 `cargo test`。
- 前端组件用 Vitest + React Testing Library。
- E2E 用 Playwright + Tauri WebDriver。

---

## 8. 打包

```powershell
npm run tauri build
```

产物：

```
src-tauri/target/release/bundle/
├── msi/           Windows installer (.msi)
├── nsis/          NSIS installer (.exe)
└── …
```

注意：
- 第一次 `release` 构建非常慢（~10 分钟），fastembed / rusqlite / tauri 都要全量优化编译。
- 体积大约 30-50 MB（含 ONNX runtime 但不含 BGE 模型 — 模型在首次使用时下载到用户目录）。
- 如果想把模型也内置（避免首次出网下载），可以预下载到 `embed_cache/` 然后用 Tauri resources 打包。

---

## 9. 常见问题

### Q: `cargo build` 卡在 `fastembed` / `ort`
ONNX runtime 依赖大，第一次 build 慢正常。后续增量构建快很多。

### Q: dev 时改 Rust 不重启
Tauri dev 不自动重编 Rust。改完按 `Ctrl+C` 重跑 `npm run tauri dev`，或者用 `cargo-watch`：
```powershell
cd src-tauri
cargo watch -x check
```

### Q: 前端改了 ipc.ts 类型但组件没自动重编
Vite 热更新通常会处理。如果没有：硬刷新（Ctrl+Shift+R）或重启 `npm run tauri dev`。

### Q: NCM 解密失败
`ncmdump` 对某些 NCM 版本不兼容。可以先用第三方工具转换，或者升级 `ncmdump` crate。

### Q: AI 设置填了但调用 401 / 404
检查 `base_url` 末尾**不要**带 `/v1`，AIreader 自动拼 `/v1/chat/completions`。例：
- ✅ `https://api.deepseek.com`
- ❌ `https://api.deepseek.com/v1`

### Q: 索引一本书报 "嵌入查询失败"
通常是 `embed_cache/` 半下载坏了。删 `%APPDATA%\com.aireader.app\embed_cache\` 重试。

### Q: 想看 fastembed 模型在哪
```
%APPDATA%\com.aireader.app\embed_cache\models--Xenova--bge-small-zh-v1.5\
```

---

## 10. 工程纪律

提到 [`CLAUDE.md`](../.claude/) 全局准则的几条最常用的：

- **抓主要矛盾**（原则 3）：一个 PR 解决一件事，不顺手做。
- **稳定性优先于性能**（原则 12）：不写「理论最快但容易崩」的代码。
- **不优化代理指标**（原则 15）：不要为了「让阅读卡片更花哨」而牺牲扫描性能。
- **冗余与容错**（原则 14）：所有出网调用都要 timeout + 错误回滚。

详见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。
