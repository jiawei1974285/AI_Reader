use crate::ai::{embed, index, recommend};
use crate::db;
use crate::state::AppState;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Deserialize)]
struct AiConfig {
    base_url: String,
    api_key: String,
    chat_model: String,
    #[serde(default)]
    temperature: Option<f32>,
}

fn load_config(state: &State<'_, AppState>) -> Result<AiConfig, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let raw = db::config_get(&conn, "ai_settings")
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            "AI 设置未配置：请在设置中填入 base_url / api_key / chat_model".to_string()
        })?;
    let cfg: AiConfig = serde_json::from_str(&raw)
        .map_err(|e| format!("AI 设置 JSON 解析失败: {e}"))?;
    if cfg.base_url.trim().is_empty() {
        return Err("base_url 未配置".to_string());
    }
    if cfg.api_key.trim().is_empty() {
        return Err("api_key 未配置".to_string());
    }
    if cfg.chat_model.trim().is_empty() {
        return Err("chat_model 未配置".to_string());
    }
    Ok(cfg)
}

/// Call an OpenAI-compatible chat completion endpoint. The user supplies
/// `base_url` (e.g. https://api.openai.com or https://api.deepseek.com),
/// `api_key`, and `chat_model` via the AI settings panel. We send a
/// standard ChatML body with stream=false and return the assistant text.
#[tauri::command]
pub async fn ai_chat(
    messages: Vec<ChatMessage>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let cfg = load_config(&state)?;

    let url = format!(
        "{}/v1/chat/completions",
        cfg.base_url.trim_end_matches('/')
    );
    let body = ChatRequest {
        model: &cfg.chat_model,
        messages: &messages,
        stream: false,
        temperature: cfg.temperature,
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;

    let resp = client
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("API 错误 {status}: {text}"));
    }

    let parsed: ChatResponse = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| "API 返回空响应".to_string())
}

#[derive(Debug, Serialize, Clone)]
struct StreamingChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
}

#[derive(Debug, Deserialize, Default)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ChatDelta {
    pub session_id: String,
    pub delta: String,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ChatHit {
    pub spine_index: i64,
    pub text: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ChatContext {
    pub session_id: String,
    pub hits: Vec<ChatHit>,
}

/// Streaming variant of `ai_chat`. Returns immediately; the response is
/// delivered to the frontend as a sequence of `chat-delta` events tagged
/// with `session_id`. The frontend filters by session_id (it knows which
/// id it requested) so concurrent streams don't cross-pollute. When the
/// stream ends, a final event with `done: true` is emitted.
#[tauri::command]
pub async fn ai_chat_stream(
    messages: Vec<ChatMessage>,
    session_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let cfg = load_config(&state)?;
    stream_chat_to_events(&cfg, &messages, &session_id, app).await
}

/// RAG-augmented streaming chat. Mirrors `ai_chat_rag` but emits chunks
/// instead of returning the full text.
#[tauri::command]
pub async fn ai_chat_rag_stream(
    question: String,
    book_id: Option<i64>,
    history: Vec<ChatMessage>,
    session_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let cfg = load_config(&state)?;
    let (cache_dir, _) = cache_and_db_paths(&app)?;

    // Embed query (same as ai_chat_rag)
    let q = question.clone();
    let q_embs = tokio::task::spawn_blocking(move || {
        embed::ensure_loaded(cache_dir)?;
        embed::embed_sync(vec![q])
    })
    .await
    .map_err(|e| e.to_string())??;
    let q_emb = q_embs
        .into_iter()
        .next()
        .ok_or_else(|| "嵌入查询失败".to_string())?;

    // Retrieve top-K chunks
    let hits = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        index::search_chunks(&conn, &q_emb, book_id, 8)?
    };
    if hits.is_empty() {
        return Err(
            "未找到相关内容。请先对本书进行索引（点击 AI 面板中的「索引本书」）。".to_string(),
        );
    }

    let context_block = hits
        .iter()
        .enumerate()
        .map(|(i, h)| {
            format!(
                "【片段 {}】（第 {} 章）\n{}",
                i + 1,
                h.spine_index + 1,
                h.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    // Emit the hits BEFORE streaming begins so the UI can attach them to
    // the pending assistant message and render「片段 N」as clickable spans.
    let context_hits: Vec<ChatHit> = hits
        .iter()
        .map(|h| ChatHit {
            spine_index: h.spine_index,
            text: h.text.clone(),
        })
        .collect();
    let _ = app.emit(
        "chat-context",
        ChatContext {
            session_id: session_id.clone(),
            hits: context_hits,
        },
    );

    let scope = if book_id.is_some() {
        "本书"
    } else {
        "你的书库"
    };
    let system = format!(
        "你是一个阅读助手。下面是从用户{scope}里检索出来的相关片段，请基于它们回答问题。\
         如果片段不足以回答，请明确说明。回答中请引用具体片段编号（例如「根据片段 2」）。\
         回答用中文。\n\n{context_block}"
    );

    let mut messages: Vec<ChatMessage> = vec![ChatMessage {
        role: "system".to_string(),
        content: system,
    }];
    messages.extend(history);
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: question,
    });

    stream_chat_to_events(&cfg, &messages, &session_id, app).await
}

/// Shared streaming worker used by both ai_chat_stream and
/// ai_chat_rag_stream. Sets `stream: true` on the request, reads the SSE
/// response chunk-by-chunk, parses `delta.content`, and emits Tauri
/// events.
async fn stream_chat_to_events(
    cfg: &AiConfig,
    messages: &[ChatMessage],
    session_id: &str,
    app: AppHandle,
) -> Result<(), String> {
    let url = format!(
        "{}/v1/chat/completions",
        cfg.base_url.trim_end_matches('/')
    );
    let body = StreamingChatRequest {
        model: &cfg.chat_model,
        messages,
        stream: true,
        temperature: cfg.temperature,
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;

    let resp = client
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = format!("API 错误 {status}: {text}");
        let _ = app.emit(
            "chat-delta",
            ChatDelta {
                session_id: session_id.to_string(),
                delta: String::new(),
                done: true,
                error: Some(msg.clone()),
            },
        );
        return Err(msg);
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let bytes = match chunk_result {
            Ok(b) => b,
            Err(e) => {
                let msg = format!("流读取失败: {e}");
                let _ = app.emit(
                    "chat-delta",
                    ChatDelta {
                        session_id: session_id.to_string(),
                        delta: String::new(),
                        done: true,
                        error: Some(msg.clone()),
                    },
                );
                return Err(msg);
            }
        };
        let text = String::from_utf8_lossy(&bytes);
        buffer.push_str(&text);

        // SSE messages are separated by blank lines (\n\n).
        while let Some(idx) = buffer.find("\n\n") {
            let message = buffer[..idx].to_string();
            buffer = buffer[idx + 2..].to_string();
            for line in message.lines() {
                let line = line.trim();
                let Some(payload) = line.strip_prefix("data:") else {
                    continue;
                };
                let payload = payload.trim();
                if payload == "[DONE]" {
                    let _ = app.emit(
                        "chat-delta",
                        ChatDelta {
                            session_id: session_id.to_string(),
                            delta: String::new(),
                            done: true,
                            error: None,
                        },
                    );
                    return Ok(());
                }
                if let Ok(parsed) = serde_json::from_str::<StreamChunk>(payload) {
                    for choice in parsed.choices {
                        if let Some(content) = choice.delta.content {
                            if !content.is_empty() {
                                let _ = app.emit(
                                    "chat-delta",
                                    ChatDelta {
                                        session_id: session_id.to_string(),
                                        delta: content,
                                        done: false,
                                        error: None,
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // Stream ended without [DONE] — emit done anyway
    let _ = app.emit(
        "chat-delta",
        ChatDelta {
            session_id: session_id.to_string(),
            delta: String::new(),
            done: true,
            error: None,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn get_ai_settings(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::config_get(&conn, "ai_settings").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_ai_settings(value: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::config_set(&conn, "ai_settings", &value).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
struct IndexProgress {
    book_id: i64,
    current: usize,
    total: usize,
}

fn cache_and_db_paths(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data).ok();
    let cache = data.join("embed_cache");
    let db_path = data.join("aireader.db");
    Ok((cache, db_path))
}

/// Index a book: extract chapter text → chunk → embed → store. The embed
/// model loads on first call (downloads ~120 MB from HuggingFace) and is
/// then cached. Emits `index-progress` events keyed on book_id so the UI
/// can render a progress bar.
#[tauri::command]
pub async fn ai_index_book(
    book_id: i64,
    book_path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<usize, String> {
    let _ = state;
    let (cache_dir, db_path) = cache_and_db_paths(&app)?;
    let app_emit = app.clone();
    let bid = book_id;

    let result = tokio::task::spawn_blocking(move || {
        index::index_book(book_id, &book_path, cache_dir, &db_path, |current, total| {
            let _ = app_emit.emit(
                "index-progress",
                IndexProgress {
                    book_id: bid,
                    current,
                    total,
                },
            );
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(n) => {
            let _ = app.emit(
                "index-progress",
                IndexProgress {
                    book_id: bid,
                    current: 1,
                    total: 1,
                },
            );
            Ok(n)
        }
        Err(e) => {
            // Record error state
            if let Ok((_, db_path)) = cache_and_db_paths(&app) {
                if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                    let _ = db::set_index_status(
                        &conn,
                        book_id,
                        "error",
                        0,
                        None,
                        Some(&e),
                    );
                }
            }
            Err(e)
        }
    }
}

/// Take all the user's highlights for a book and ask the LLM to weave
/// them into a short "key takeaways" summary. Useful for a quick recap
/// after you've collected a bunch of clippings.
#[tauri::command]
pub async fn ai_summarize_highlights(
    book_id: i64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Gather highlights + book metadata in one DB session
    let (title, author, highlights) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let books = db::list_books(&conn).map_err(|e| e.to_string())?;
        let book = books
            .into_iter()
            .find(|b| b.id == book_id)
            .ok_or_else(|| "找不到这本书".to_string())?;
        let hs = db::list_highlights_by_book(&conn, book_id)
            .map_err(|e| e.to_string())?;
        (book.title, book.author, hs)
    };

    if highlights.is_empty() {
        return Err("还没有标注可以汇总。先涂几条高亮再来。".to_string());
    }

    let mut clippings = String::new();
    for (i, h) in highlights.iter().enumerate() {
        let chapter_label = format!("第 {} 章", h.spine_index + 1);
        clippings.push_str(&format!(
            "{}. [{}]「{}」",
            i + 1,
            chapter_label,
            h.selected_text.replace('\n', " ")
        ));
        if !h.note.is_empty() {
            clippings.push_str(&format!(" — 我的笔记：{}", h.note));
        }
        clippings.push('\n');
    }

    let author_line = if author.is_empty() || author == "Unknown" {
        String::new()
    } else {
        format!("（{}）", author)
    };

    let user_prompt = format!(
        "下面是用户在《{title}》{author_line}里涂的所有高亮和写的笔记。\n\
         请基于这些标注内容做两件事：\n\
         1. **5-7 条要点**：提炼出用户关注的核心观点 / 情节 / 论据；\n\
         2. **1-2 条主线**：归纳用户在这本书里反复回到的主题或问题。\n\n\
         用 Markdown 输出（标题 + 列表），中文，不要客套话，不要重复原文，要有洞察。\n\n\
         标注内容：\n{clippings}"
    );

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "你是一个善于提炼读书笔记的助手。".to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_prompt,
        },
    ];

    ai_chat(messages, state).await
}

#[tauri::command]
pub fn ai_get_index_status(
    book_id: i64,
    state: State<'_, AppState>,
) -> Result<Option<db::BookIndexStatus>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::get_index_status(&conn, book_id).map_err(|e| e.to_string())
}

// ---------- Phase 7.B: AI book classification ----------

#[derive(Debug, Clone, Serialize)]
pub struct ClassifyReport {
    pub total: usize,
    pub classified: usize,
    pub skipped: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClassifyProgress {
    pub current: usize,
    pub total: usize,
}

const BOOK_CATEGORIES: &[&str] = &[
    "文学小说",
    "历史",
    "哲学",
    "科技",
    "经管",
    "心理",
    "艺术",
    "诗歌散文",
    "教材工具书",
    "传记",
    "其他",
];

/// Batch-classify every book in the library that doesn't yet have a
/// category. Sends 20 at a time to the LLM and asks for a category from a
/// fixed list. Emits `classify-progress` events.
#[tauri::command]
pub async fn ai_classify_books(
    force: Option<bool>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ClassifyReport, String> {
    let force = force.unwrap_or(false);

    let all_books: Vec<db::Book> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::list_books(&conn).map_err(|e| e.to_string())?
    };
    let total = all_books.len();
    if total == 0 {
        return Ok(ClassifyReport {
            total: 0,
            classified: 0,
            skipped: 0,
            failed: 0,
        });
    }

    let pending: Vec<&db::Book> = all_books
        .iter()
        .filter(|b| force || b.category.trim().is_empty())
        .collect();
    let skipped = total - pending.len();
    let mut classified = 0usize;
    let mut failed = 0usize;
    let mut processed = skipped;

    let _ = app.emit(
        "classify-progress",
        ClassifyProgress {
            current: processed,
            total,
        },
    );

    let allowed_list = BOOK_CATEGORIES.join(", ");

    for batch in pending.chunks(20) {
        let mut listing = String::new();
        for (i, b) in batch.iter().enumerate() {
            let author = if b.author.trim().is_empty() {
                "未知"
            } else {
                &b.author
            };
            listing.push_str(&format!("{}. 《{}》/ {}\n", i + 1, b.title, author));
        }
        let prompt = format!(
            "请为以下 {n} 本书各分配一个最合适的分类。\n\
             分类必须从这个列表里选一个（不要其他选项，不要解释）：\n[{allowed}]\n\n\
             只输出 JSON 数组 [\"分类1\", \"分类2\", ...]，顺序与下方列表完全一致。\n\n\
             书目：\n{listing}",
            n = batch.len(),
            allowed = allowed_list,
        );
        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: "你是一个图书分类员。".to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: prompt,
            },
        ];

        let result: Result<Vec<String>, String> = (async {
            let reply = ai_chat(messages, state.clone()).await?;
            let cleaned = strip_code_fence(&reply);
            serde_json::from_str::<Vec<String>>(&cleaned)
                .map_err(|e| format!("解析失败: {e}; 原文: {cleaned}"))
        })
        .await;

        match result {
            Ok(cats) => {
                let conn = state.db.lock().map_err(|e| e.to_string())?;
                for (i, cat) in cats.iter().enumerate() {
                    if let Some(b) = batch.get(i) {
                        let normalized = normalize_category(cat);
                        if let Err(_e) =
                            db::set_book_category(&conn, b.id, &normalized)
                        {
                            failed += 1;
                        } else {
                            classified += 1;
                        }
                    }
                }
            }
            Err(_e) => {
                failed += batch.len();
            }
        }

        processed += batch.len();
        let _ = app.emit(
            "classify-progress",
            ClassifyProgress {
                current: processed,
                total,
            },
        );
    }

    Ok(ClassifyReport {
        total,
        classified,
        skipped,
        failed,
    })
}

/// Snap whatever the LLM said back to our known category list. If the
/// reply is a near-match (contains one of our categories as substring),
/// pick that; otherwise fall back to "其他".
fn normalize_category(raw: &str) -> String {
    let t = raw.trim();
    for c in BOOK_CATEGORIES {
        if t == *c {
            return c.to_string();
        }
    }
    for c in BOOK_CATEGORIES {
        if t.contains(c) {
            return c.to_string();
        }
    }
    "其他".to_string()
}

fn strip_code_fence(s: &str) -> String {
    let t = s.trim();
    let t = t.strip_prefix("```json").unwrap_or(t);
    let t = t.strip_prefix("```").unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim().to_string()
}

// ---------- Phase 5.C: music tagging + chapter-aware recommendations ----------

#[tauri::command]
pub async fn ai_tag_music_tracks(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::music::tagger::TagReport, String> {
    crate::music::tagger::tag_all_tracks(state, app).await
}

#[tauri::command]
pub async fn ai_recommend_music(
    chapter_text: String,
    top_k: usize,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<recommend::ChapterMoodWithRecs, String> {
    recommend::recommend_music_for_chapter(state, app, chapter_text, top_k).await
}

#[tauri::command]
pub async fn ai_recommend_books(
    anchor_book_id: Option<i64>,
    top_k: usize,
    with_reasons: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<recommend::Recommendation>, String> {
    if with_reasons.unwrap_or(true) {
        // Try LLM-enriched version; falls back to bare recs if LLM fails
        match recommend::recommend_with_reasons(state.clone(), anchor_book_id, top_k).await {
            Ok(recs) => Ok(recs),
            Err(e) => {
                // If reasons step itself errored (e.g. AI unconfigured),
                // fall back to bare recommendations so the panel still
                // shows something useful.
                let conn = state.db.lock().map_err(|err| err.to_string())?;
                recommend::recommend(&conn, anchor_book_id, top_k)
                    .map_err(|_| e)
            }
        }
    } else {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        recommend::recommend(&conn, anchor_book_id, top_k)
    }
}

/// RAG-augmented chat. Embeds the question, retrieves top-K chunks
/// (optionally scoped to `book_id`), prepends them as system context, and
/// runs the standard chat completion. The caller's existing chat history
/// is preserved between question and assistant turns.
#[tauri::command]
pub async fn ai_chat_rag(
    question: String,
    book_id: Option<i64>,
    history: Vec<ChatMessage>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let cfg = load_config(&state)?;
    let (cache_dir, _) = cache_and_db_paths(&app)?;

    // Embed query
    let q = question.clone();
    let q_embs = tokio::task::spawn_blocking(move || {
        embed::ensure_loaded(cache_dir)?;
        embed::embed_sync(vec![q])
    })
    .await
    .map_err(|e| e.to_string())??;
    let q_emb = q_embs
        .into_iter()
        .next()
        .ok_or_else(|| "嵌入查询失败".to_string())?;

    // Retrieve top-K chunks
    let hits = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        index::search_chunks(&conn, &q_emb, book_id, 8)?
    };
    if hits.is_empty() {
        return Err(
            "未找到相关内容。请先对本书进行索引（点击 AI 面板中的「索引本书」）。".to_string(),
        );
    }

    let context_block = hits
        .iter()
        .enumerate()
        .map(|(i, h)| {
            format!(
                "【片段 {}】（第 {} 章）\n{}",
                i + 1,
                h.spine_index + 1,
                h.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    let scope = if book_id.is_some() {
        "本书"
    } else {
        "你的书库"
    };
    let system = format!(
        "你是一个阅读助手。下面是从用户{scope}里检索出来的相关片段，请基于它们回答问题。\
         如果片段不足以回答，请明确说明。回答中请引用具体片段编号（例如「根据片段 2」）。\
         回答用中文。\n\n{context_block}"
    );

    let mut messages: Vec<ChatMessage> = vec![ChatMessage {
        role: "system".to_string(),
        content: system,
    }];
    messages.extend(history);
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: question,
    });

    let url = format!(
        "{}/v1/chat/completions",
        cfg.base_url.trim_end_matches('/')
    );
    let body = ChatRequest {
        model: &cfg.chat_model,
        messages: &messages,
        stream: false,
        temperature: cfg.temperature,
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("API 错误 {status}: {text}"));
    }
    let parsed: ChatResponse = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| "API 返回空响应".to_string())
}
