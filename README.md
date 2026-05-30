# AIreader

> 一个本地优先、AI 增强的桌面阅读器。把 EPUB / PDF / TXT / DOCX 摊在书桌上，让大模型替你做笔记、答问、配乐。

AIreader 是一个用 Tauri 2 + React 19 + Rust 写的 Windows 桌面应用。它的目标不是"再造一个 Calibre"，而是把读书这件事里**最割裂的几步**——找书、读、记笔记、查词典、问背景、配氛围——压到同一个窗口里，并且**全部数据放在你自己的硬盘上**。

```
┌──────────────────────────────────────────────────────────────────┐
│ 书架 (LibraryView)                  搜索 / 排序 / 分类 / 帮助 / 评分 │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐                                      │
│ │封面│ │封面│ │封面│ │封面│   ← 真实封面 (EPUB) 或渐变 placeholder │
│ │ A  │ │ B  │ │ C  │ │ D  │                                      │
│ └────┘ └────┘ └────┘ └────┘                                      │
└──────────────────────────────────────────────────────────────────┘
        ↓ 点开一本
┌──────────────────────────────────────────────────────────────────┐
│ 目录 │       正文 (EPUB / PDF / TXT / DOCX)        │ AI 问答     │
│ ├ 1  │   "……陆地纵深万里，海洋无垠……"             │ 选中文字    │
│ ├ 2  │   ↑ 选中可涂高亮、加注释、问 AI、查字典     │ → ✦ 问 AI   │
│ │  …  │                                              │ 流式回答 →  │
│ └ N  │                                              │ 「片段 3」  │
│      │                                              │ 可点跳章   │
└──────────────────────────────────────────────────────────────────┘
                              ↓
                  背景音乐 (HTML5 audio, NCM 自动解密)
```

---

## ✨ 功能一览

### 📚 阅读

- **多格式**：EPUB / PDF / TXT / DOCX / MOBI / AZW / AZW3 统一阅读体验。PDF 走 pdf.js，其余统一抽出 HTML + 文本喂渲染器。加密 Kindle 文件和部分 KF8-only/AZW3 暂不支持，会给出明确提示而不是显示乱码。
- **目录边栏**：自动从 EPUB nav / PDF outline / TXT 章节正则 / DOCX 样式抽 TOC；常驻左侧便于跳章。
- **字号 / 字体 / 行距 / 主题 / 段落缩进 / 列宽**：全部可配置，三套主题（牛皮纸 / 白底 / 深色），衬线 / 无衬线切换。
- **自动续读**：每章节滚动位置 + spine_index 实时写库；重新打开同一本书自动恢复到上次位置。
- **书签入口**：阅读页随时保存当前章节 / 页码和滚动位置；首页顶部打开书签抽屉，可搜索并直接回到那一处。
- **使用帮助**：书架顶部和阅读器顶部都有「使用帮助」入口，右侧抽屉内置导入、阅读、标注、AI、实体和配乐的快速说明。
- **书籍评分**：书架卡片和阅读器顶部都能给当前书打 1–5 星评分，再点当前星级可取消。
- **拖入书架**：把 EPUB / PDF / TXT / DOCX / MOBI / AZW / AZW3 文件拖到书架窗口，会复制到当前书库并自动刷新。
- **真实封面**：扫描 EPUB 时抽取内嵌封面缓存为图片；非 EPUB 用「标题 hash → 渐变色块 + 标题首字」placeholder。
- **自动同步书库**：`notify` 监听书库根目录，新加 / 删 / 改名的书自动出现 / 消失在书架上，不用手点扫描。

### 🖍️ 标注

- 选中正文 → 浮动工具栏 → 涂 5 色高亮 / 加 inline 注释。
- **EPUB / PDF 都支持**。PDF 用 page+rect 锚定，EPUB / TXT / DOCX 用 `prefix + text + suffix` 文本指纹定位。
- 全局笔记视图（`NotesView`）跨书检索 + Markdown 导出。
- **AI 章节汇总**：把当前书的所有高亮喂给 LLM，输出 5–7 条要点 + 1–2 条主线。

### 🤖 AI（OpenAI 兼容接口）

- **三种问答模式**：
  - **当前章节** — 整章正文直接做 system context，不需要索引。
  - **整本书** — 走 RAG：fastembed-rs 本地嵌入（BGE-Small-ZH-V1.5，~120 MB，离线）→ 余弦检索 top-K 片段 → LLM 答。
  - **全书库** — 同 RAG 但不限 book_id，可跨书检索。
- **流式回答**：SSE 一字一字打出来，不再瞪 10 秒空白。
- **引用跳转**：RAG 回答里的「片段 N」自动渲染成可点的小药丸，一点直接跳到对应章节。
- **历史持久化**：按 `(book_id, mode, chapter)` 分会话存 SQLite，下次打开同一本书的同一章接着聊。
- **划词速问**：选中任意文字 → 工具栏「✦ 问 AI」 → 选区旁弹气泡，30–60 字快速解释 / 翻译 / 背景。
- **实体提取**：阅读页可对当前章节提取人名、地名，在正文中加下划线，点击查看简介。
- **AI 自动分类**：扫描书库后一键分类（11 个固定档：文学小说 / 历史 / 哲学 / …）。
- **模型连接测试**：AI 设置页用同一条非流式链路验证 Base URL、Key 和模型名是否可用。
- **AI 推荐**：基于阅读记录 + 内嵌封面相似度返回 top-K 推荐书 + LLM 写的「为什么推荐」。

### 🎵 背景音乐

- **NCM 自动解密**：网易云加密格式 (`*.ncm`) 第一次播放时用 `ncmdump` 解密缓存为 mp3/flac，再走 HTML5 audio。
- **格式覆盖**：mp3 / flac / wav / m4a / ogg / aac / ncm。
- **全局 mini player**：换页、跳书都不打断播放（`<audio>` 在 `App` 根挂载，永不 unmount）。
- **章节配乐**：AI 给当前章节打情绪标签 → 在本地音乐库里语义检索 → 推荐 top-K。
- **批量打标**：一键给所有曲目跑 AI 心情标签 + 描述 + embedding，落 `track_tags` 表。
- **LRC 歌词同步**：同目录下放同名 `.lrc` 文件 → mini player「词」按钮 → 当前行高亮 + 自动滚动 + 点行跳转。

### 📊 阅读统计

- 每打开一本书启动 30s 心跳，clip 单 tick ≤ 1.5× 防 idle / 系统休眠灌水。
- 累计阅读时长 ≥ 1 分钟时在书架卡片右下显示「1h25m」。
- 书籍评分写入本地 `books.user_rating`，用于个人整理，不依赖外部评分源。

---

## 🏗️ 技术栈

| 层     | 选型                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------ |
| 桌面壳 | Tauri 2 (`protocol-asset` enabled, scope `**` for local file serving)                                  |
| 前端   | React 19 + TypeScript 5.8 + Vite 7                                                                     |
| 样式   | Tailwind v4 (`@tailwindcss/vite`) + Noto Serif SC / Inter (`@fontsource/*`)                            |
| 后端   | Rust 2021 edition + Tokio multi-thread runtime                                                         |
| 数据库 | SQLite (rusqlite bundled) + WAL + blind-ALTER migrations                                               |
| 嵌入   | fastembed-rs 4 (ONNX, BGE-Small-ZH-V1.5)，首跑下载~120 MB 后离线                                       |
| LLM    | OpenAI 兼容 ChatCompletions (DeepSeek / OpenAI / 任意自部署 ChatML 网关均可)，SSE 流式                 |
| PDF    | pdfjs-dist via `react-pdf`，CMaps + standard fonts 通过 `scripts/copy-pdfjs-assets.mjs` 拷到 `public/` |
| 音乐   | HTML5 `<audio>` + ncmdump 解密                                                                         |

---

## 🚀 快速开始

### 前置

- Windows 11（其他平台未测试，理论上 Tauri 跨平台）
- Node.js ≥ 20
- Rust ≥ 1.76 (`rustup`)
- WebView2（Win10/11 通常自带）

### 安装

```powershell
git clone <your-fork-url> aireader
cd aireader
npm install
```

### 开发

```powershell
npm run tauri dev
```

第一次启动会下载 fastembed 模型（~120 MB），只发生在你首次使用 AI 索引 / 嵌入功能时，不影响阅读。

### 打包

```powershell
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/` 下。

---

## 📁 文档地图

| 文件                                             | 给谁看                                        |
| ------------------------------------------------ | --------------------------------------------- |
| [`README.md`](./README.md)（本文件）             | 第一次接触项目的人                            |
| [`docs/USAGE.md`](./docs/USAGE.md)               | 终端用户 — 怎么把这个 app 用起来              |
| [`docs/FEATURES.md`](./docs/FEATURES.md)         | 想详细了解功能边界 / 已知限制的人             |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 想改代码 / 添新功能的人 — 整体分层 + 模块职责 |
| [`docs/DATA_MODEL.md`](./docs/DATA_MODEL.md)     | 想看 DB schema、磁盘布局、索引/嵌入文件结构   |
| [`docs/IPC.md`](./docs/IPC.md)                   | 前后端命令 + Tauri 事件全清单                 |
| [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md)   | 跑起来、调试、打包、添加新命令的具体步骤      |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)           | 想提 PR 的人 — 代码风格、提交规范、PR 流程    |

---

## ⚙️ 配置

打开 app → 右上角设置图标 → 填三件事：

```
base_url      e.g. https://api.deepseek.com  (或 OpenAI / 自部署网关)
api_key       sk-xxx
chat_model    deepseek-chat / gpt-4o-mini / 任意 ChatML 兼容模型
temperature   可选，留空走模型默认
```

AI 设置存 SQLite `app_config` 表，**不写明文配置文件，不上传任何地方**。

---

## 🔒 隐私

- 书、笔记、聊天记录、书籍评分、音乐索引**全部存本地**：`%APPDATA%/com.aireader.app/`。
- 唯一一次出网：你主动问 AI 时，prompt + 上下文片段会发到你**自己配的** LLM 网关。
- 嵌入计算 **100% 本地**（fastembed-rs ONNX runtime），书内容不会被发到嵌入服务。

---

## 📜 许可

MIT — 见 [LICENSE](./LICENSE)（如未存在请按需补全）。

---

## 🙏 致谢

- [Tauri](https://tauri.app/) — 让 Rust + Web 的桌面应用真正轻量。
- [fastembed-rs](https://github.com/Anush008/fastembed-rs) — 把 BGE 系列嵌入打包成开箱即用的 ONNX runtime。
- [react-pdf](https://github.com/wojtekmaj/react-pdf) + [pdfjs-dist](https://github.com/mozilla/pdf.js)。
- [ncmdump](https://crates.io/crates/ncmdump) — NCM 解密。
- [@fontsource/noto-serif-sc](https://fontsource.org/) — 让中文阅读体面起来。
