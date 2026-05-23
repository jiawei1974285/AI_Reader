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
    /// DeepSeek / Qwen 等支持「关闭思考链」的兼容字段。
    /// 部分 OpenAI-compatible gateway 会拒绝未知字段，所以只在确认支持时发送。
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_thinking: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChapterEntity {
    pub name: String,
    pub kind: String,
    pub summary: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AiConfig {
    base_url: String,
    api_key: String,
    chat_model: String,
    #[serde(default)]
    temperature: Option<f32>,
    /// 用户在 AI 设置面板里勾「快速模式」(无思考链) 时为 true。
    #[serde(default = "default_fast_mode")]
    fast_mode: bool,
}

fn default_fast_mode() -> bool {
    true
}

fn thinking_toggle_for(cfg: &AiConfig) -> Option<bool> {
    if !cfg.fast_mode {
        return None;
    }

    let base_url = cfg.base_url.to_ascii_lowercase();
    let model = cfg.chat_model.to_ascii_lowercase();
    let supported = base_url.contains("deepseek")
        || base_url.contains("dashscope")
        || base_url.contains("aliyuncs")
        || base_url.contains("siliconflow")
        || model.contains("deepseek")
        || model.contains("qwen");

    if supported {
        Some(false)
    } else {
        None
    }
}

fn validate_ai_config_fields(cfg: &AiConfig) -> Result<(), String> {
    if cfg.base_url.trim().is_empty() {
        return Err("base_url 未配置".to_string());
    }
    if cfg.api_key.trim().is_empty() {
        return Err("api_key 未配置".to_string());
    }
    if cfg.chat_model.trim().is_empty() {
        return Err("chat_model 未配置".to_string());
    }
    Ok(())
}

fn chat_completions_url(base_url: &str) -> String {
    format!(
        "{}/v1/chat/completions",
        base_url.trim().trim_end_matches('/')
    )
}

fn format_api_error(status: reqwest::StatusCode, body: &str) -> String {
    let hint = match status.as_u16() {
        401 => "请检查 API Key 是否正确、是否已启用、是否复制完整。",
        403 => "请检查当前 API Key 是否有访问该模型的权限。",
        404 => "请检查 Base URL 和模型名称是否正确。",
        429 => "请求过于频繁或额度不足，请稍后再试或检查账户额度。",
        _ => "请检查接口配置和网络状态。",
    };
    let short = sanitize_api_error_body(body);
    if short.is_empty() {
        format!("API 错误 {status}: {hint}")
    } else {
        format!("API 错误 {status}: {hint}\n{short}")
    }
}

fn sanitize_api_error_body(body: &str) -> String {
    let mut text = body.replace('\n', " ").replace('\r', " ");
    while let Some(start) = text.find("sk-") {
        let tail = text[start..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .map(|len| start + len)
            .unwrap_or_else(|| text.len());
        text.replace_range(start..tail, "[API_KEY]");
    }
    text = text.replace("Your api key", "API Key");
    text.chars().take(500).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_chat_completions_url_without_duplicate_slashes() {
        assert_eq!(
            chat_completions_url("https://api.deepseek.com/"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn validates_model_test_config_before_network_request() {
        let cfg = AiConfig {
            base_url: "https://api.deepseek.com".to_string(),
            api_key: "sk-test".to_string(),
            chat_model: "deepseek-chat".to_string(),
            temperature: None,
            fast_mode: true,
        };

        assert!(validate_ai_config_fields(&cfg).is_ok());

        let missing_model = AiConfig {
            chat_model: "  ".to_string(),
            ..cfg
        };
        assert!(validate_ai_config_fields(&missing_model)
            .unwrap_err()
            .contains("chat_model"));
    }

    #[test]
    fn thinking_toggle_only_serializes_for_known_supported_models() {
        let deepseek = AiConfig {
            base_url: "https://api.deepseek.com".to_string(),
            api_key: "sk-test".to_string(),
            chat_model: "deepseek-chat".to_string(),
            temperature: None,
            fast_mode: true,
        };
        assert_eq!(thinking_toggle_for(&deepseek), Some(false));

        let openai = AiConfig {
            base_url: "https://api.openai.com".to_string(),
            chat_model: "gpt-4o-mini".to_string(),
            ..deepseek.clone()
        };
        assert_eq!(thinking_toggle_for(&openai), None);

        let disabled = AiConfig {
            fast_mode: false,
            ..deepseek
        };
        assert_eq!(thinking_toggle_for(&disabled), None);
    }

    #[test]
    fn formats_api_errors_without_leaking_api_key() {
        let body = r#"{"error":{"message":"Authentication Fails, Your api key: sk-secret-tail is invalid!","type":"authentication_error"}}"#;

        let formatted = format_api_error(reqwest::StatusCode::UNAUTHORIZED, body);

        assert!(formatted.contains("API 错误 401 Unauthorized"));
        assert!(formatted.contains("请检查 API Key"));
        assert!(!formatted.contains("sk-secret-tail"));
        assert!(!formatted.contains("Your api key"));
    }

    #[test]
    fn parses_entities_from_fenced_json_reply() {
        let reply = r#"```json
[
  {"name":"叶文洁","kind":"person","summary":"天体物理学家，与红岸基地有关。"},
  {"name":"红岸基地","kind":"place","summary":"位于山区的秘密工程基地。"}
]
```"#;

        let entities = parse_entity_reply(reply).expect("entity JSON should parse");

        assert_eq!(entities.len(), 2);
        assert_eq!(entities[0].name, "叶文洁");
        assert_eq!(entities[0].kind, "person");
        assert_eq!(entities[1].name, "红岸基地");
        assert_eq!(entities[1].kind, "place");
    }
}

fn load_config(state: &State<'_, AppState>) -> Result<AiConfig, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let raw = db::config_get(&conn, "ai_settings")
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            "AI 设置未配置：请在设置中填入 base_url / api_key / chat_model".to_string()
        })?;
    let cfg: AiConfig =
        serde_json::from_str(&raw).map_err(|e| format!("AI 设置 JSON 解析失败: {e}"))?;
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

    let url = format!("{}/v1/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = ChatRequest {
        model: &cfg.chat_model,
        messages: &messages,
        stream: false,
        temperature: cfg.temperature,
        enable_thinking: thinking_toggle_for(&cfg),
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
        return Err(format_api_error(status, &text));
    }

    let parsed: ChatResponse = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| strip_thinking(&c.message.content))
        .ok_or_else(|| "API 返回空响应".to_string())
}

#[tauri::command]
pub async fn test_ai_model(
    base_url: String,
    api_key: String,
    chat_model: String,
    temperature: Option<f32>,
    fast_mode: Option<bool>,
) -> Result<String, String> {
    let cfg = AiConfig {
        base_url,
        api_key,
        chat_model,
        temperature,
        fast_mode: fast_mode.unwrap_or_else(default_fast_mode),
    };
    validate_ai_config_fields(&cfg)?;

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "You are a connection tester. Reply with exactly OK.".to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: "Reply OK to confirm this model is reachable.".to_string(),
        },
    ];
    let body = ChatRequest {
        model: cfg.chat_model.trim(),
        messages: &messages,
        stream: false,
        temperature: cfg.temperature,
        enable_thinking: thinking_toggle_for(&cfg),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;

    let resp = client
        .post(chat_completions_url(&cfg.base_url))
        .bearer_auth(cfg.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format_api_error(status, &text));
    }

    let parsed: ChatResponse = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;
    let reply = parsed
        .choices
        .into_iter()
        .next()
        .map(|c| strip_thinking(&c.message.content))
        .unwrap_or_default();

    if reply.trim().is_empty() {
        return Err("模型已连接，但返回了空响应".to_string());
    }
    Ok(format!("连接成功：{} 已响应", cfg.chat_model.trim()))
}

#[tauri::command]
pub async fn ai_extract_entities(
    chapter_label: String,
    chapter_text: String,
    state: State<'_, AppState>,
) -> Result<Vec<ChapterEntity>, String> {
    let text = chapter_text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let clipped = truncate_chars(text, 12_000);
    let prompt = format!(
        "请从下面章节中提取重要的人名和地名。\n\
         只返回 JSON 数组，不要 Markdown，不要解释。\n\
         每一项格式必须是：{{\"name\":\"名称\",\"kind\":\"person 或 place\",\"summary\":\"30-80字中文简介，说明本章中它是谁/是什么/在哪里/为何重要\"}}\n\
         规则：\n\
         - 只提取本章真实出现过的名称。\n\
         - 人名包含角色、作者明显提到的人物；地名包含国家、城市、建筑、机构、基地、星球等地点或地点性组织。\n\
         - 合并同一实体的别名，name 用正文里最常见的写法。\n\
         - 最多返回 24 项，按重要性排序。\n\n\
         章节：{chapter_label}\n\n\
         正文：\n{clipped}"
    );

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "你是一个严谨的文学阅读助手，擅长从章节中抽取人物和地点。".to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: prompt,
        },
    ];
    let reply = ai_chat(messages, state).await?;
    parse_entity_reply(&reply)
}

fn parse_entity_reply(reply: &str) -> Result<Vec<ChapterEntity>, String> {
    let json = extract_json_array(reply).ok_or_else(|| {
        format!(
            "AI 没有返回可解析的实体 JSON：{}",
            reply.chars().take(300).collect::<String>()
        )
    })?;
    let mut entities: Vec<ChapterEntity> = serde_json::from_str(&json).map_err(|e| {
        format!(
            "实体 JSON 解析失败: {e}; 原文: {}",
            json.chars().take(500).collect::<String>()
        )
    })?;
    for e in &mut entities {
        e.name = e.name.trim().to_string();
        e.summary = e.summary.trim().to_string();
        e.kind = match e.kind.trim().to_ascii_lowercase().as_str() {
            "person" | "人物" | "人名" => "person".to_string(),
            "place" | "location" | "地名" | "地点" => "place".to_string(),
            _ => "place".to_string(),
        };
    }
    entities.retain(|e| !e.name.is_empty() && !e.summary.is_empty());
    entities.sort_by(|a, b| a.name.cmp(&b.name));
    entities.dedup_by(|a, b| a.name == b.name && a.kind == b.kind);
    entities.truncate(24);
    Ok(entities)
}

fn extract_json_array(reply: &str) -> Option<String> {
    let trimmed = reply.trim();
    let unfenced = strip_json_code_fence(trimmed);
    if unfenced.starts_with('[') && unfenced.ends_with(']') {
        return Some(unfenced);
    }
    let start = trimmed.find('[')?;
    let end = trimmed.rfind(']')?;
    if end <= start {
        return None;
    }
    Some(trimmed[start..=end].trim().to_string())
}

fn strip_json_code_fence(s: &str) -> String {
    let t = s.trim();
    let t = t.strip_prefix("```json").unwrap_or(t);
    let t = t.strip_prefix("```").unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim().to_string()
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    s.chars().take(max_chars).collect::<String>()
}

#[derive(Debug, Serialize, Clone)]
struct StreamingChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_thinking: Option<bool>,
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

/// Streaming filter that strips `<think>...</think>` blocks from a token
/// stream. Some reasoning models (DeepSeek-Reasoner, Qwen-QwQ, etc.) emit
/// their chain-of-thought wrapped in `<think>` tags even when we ask for
/// fast mode — the tags may also straddle SSE chunks. This filter
/// maintains a small pending buffer so a `<think>` opener split across
/// two chunks is still caught.
///
/// We only hold back the tail of `pending` long enough to confirm
/// whether it's the start of a tag — at most 8 ASCII bytes, since both
/// `<think>` (7) and `</think>` (8) fit there.
struct ThinkStripper {
    in_think: bool,
    pending: String,
}

impl ThinkStripper {
    fn new() -> Self {
        Self {
            in_think: false,
            pending: String::new(),
        }
    }

    /// Append `chunk` to the internal buffer and return whatever can
    /// safely be emitted now (i.e. characters that we've confirmed are
    /// not the start of a `<think>` tag).
    fn feed(&mut self, chunk: &str) -> String {
        self.pending.push_str(chunk);
        let mut out = String::new();
        loop {
            if self.in_think {
                if let Some(end) = self.pending.find("</think>") {
                    self.pending.drain(..end + "</think>".len());
                    self.in_think = false;
                    continue;
                }
                // Hold back the tail (could contain a partial `</think>`)
                // and drop the rest.
                let cutoff = self.pending.len().saturating_sub(8);
                if cutoff > 0 {
                    self.pending.drain(..cutoff);
                }
                return out;
            } else {
                if let Some(start) = self.pending.find("<think>") {
                    out.push_str(&self.pending[..start]);
                    self.pending.drain(..start + "<think>".len());
                    self.in_think = true;
                    continue;
                }
                // Hold back last 7 bytes (could be the start of `<think>`).
                let cutoff = self.pending.len().saturating_sub(7);
                if cutoff > 0 {
                    // Tags are ASCII so cutoff is always at a char
                    // boundary; the bytes before it are safe to emit.
                    let head: String = self.pending.drain(..cutoff).collect();
                    out.push_str(&head);
                }
                return out;
            }
        }
    }

    /// Drain the remaining buffer at end-of-stream.
    fn flush(&mut self) -> String {
        if self.in_think {
            self.pending.clear();
            String::new()
        } else {
            std::mem::take(&mut self.pending)
        }
    }
}

/// Non-streaming sibling — strips `<think>...</think>` (and the legacy
/// `<thinking>` variant) from a completed assistant message.
fn strip_thinking(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let Some(open) = rest.find("<think>").or_else(|| rest.find("<thinking>")) else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..open]);
        let after_open = if rest[open..].starts_with("<thinking>") {
            open + "<thinking>".len()
        } else {
            open + "<think>".len()
        };
        let close = rest[after_open..]
            .find("</think>")
            .or_else(|| rest[after_open..].find("</thinking>"));
        match close {
            Some(rel) => {
                let after_close = after_open
                    + rel
                    + if rest[after_open + rel..].starts_with("</thinking>") {
                        "</thinking>".len()
                    } else {
                        "</think>".len()
                    };
                rest = &rest[after_close..];
            }
            None => {
                // Unterminated — drop the rest.
                return out;
            }
        }
    }
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
    let url = format!("{}/v1/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = StreamingChatRequest {
        model: &cfg.chat_model,
        messages,
        stream: true,
        temperature: cfg.temperature,
        enable_thinking: thinking_toggle_for(cfg),
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
        let msg = format_api_error(status, &text);
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
    let mut stripper = ThinkStripper::new();

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
                    // Flush any trailing non-think content held in the
                    // stripper's pending buffer.
                    let tail = stripper.flush();
                    if !tail.is_empty() {
                        let _ = app.emit(
                            "chat-delta",
                            ChatDelta {
                                session_id: session_id.to_string(),
                                delta: tail,
                                done: false,
                                error: None,
                            },
                        );
                    }
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
                                let visible = stripper.feed(&content);
                                if !visible.is_empty() {
                                    let _ = app.emit(
                                        "chat-delta",
                                        ChatDelta {
                                            session_id: session_id.to_string(),
                                            delta: visible,
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
    }

    // Stream ended without [DONE] — flush + emit done.
    let tail = stripper.flush();
    if !tail.is_empty() {
        let _ = app.emit(
            "chat-delta",
            ChatDelta {
                session_id: session_id.to_string(),
                delta: tail,
                done: false,
                error: None,
            },
        );
    }
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
        index::index_book(
            book_id,
            &book_path,
            cache_dir,
            &db_path,
            |current, total| {
                let _ = app_emit.emit(
                    "index-progress",
                    IndexProgress {
                        book_id: bid,
                        current,
                        total,
                    },
                );
            },
        )
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
                    let _ = db::set_index_status(&conn, book_id, "error", 0, None, Some(&e));
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
        let hs = db::list_highlights_by_book(&conn, book_id).map_err(|e| e.to_string())?;
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
                        if let Err(_e) = db::set_book_category(&conn, b.id, &normalized) {
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
                recommend::recommend(&conn, anchor_book_id, top_k).map_err(|_| e)
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

    let url = format!("{}/v1/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = ChatRequest {
        model: &cfg.chat_model,
        messages: &messages,
        stream: false,
        temperature: cfg.temperature,
        enable_thinking: thinking_toggle_for(&cfg),
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
        return Err(format_api_error(status, &text));
    }
    let parsed: ChatResponse = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| strip_thinking(&c.message.content))
        .ok_or_else(|| "API 返回空响应".to_string())
}
