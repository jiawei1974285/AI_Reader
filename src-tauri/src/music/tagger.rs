//! Batch-tag local music tracks with LLM-inferred moods + scene descriptions.
//! The description is then embedded so we can do vector retrieval at
//! music-recommendation time against a chapter's mood vector.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::ai::chat::{ai_chat, ChatMessage};
use crate::ai::embed;
use crate::db;
use crate::music::scanner::{self, Track};
use crate::state::AppState;

const BATCH_SIZE: usize = 20;

#[derive(Debug, Clone, Serialize)]
pub struct TagReport {
    pub total: usize,
    pub tagged: usize,
    pub skipped: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct TagProgress {
    pub current: usize,
    pub total: usize,
}

#[derive(Debug, Deserialize)]
struct TagItem {
    mood_tags: Vec<String>,
    description: String,
}

/// Tag every track in the configured music library that hasn't already
/// been tagged (or whose source file has changed). Emits `tag-progress`
/// after each batch.
pub async fn tag_all_tracks(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<TagReport, String> {
    // Load tracks from current music_root
    let tracks: Vec<Track> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let root = db::config_get(&conn, "music_root")
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "音乐目录未配置".to_string())?;
        scanner::scan(std::path::Path::new(&root))
    };
    let total = tracks.len();
    if total == 0 {
        return Ok(TagReport {
            total: 0,
            tagged: 0,
            skipped: 0,
            failed: 0,
        });
    }

    // Filter out tracks already tagged with matching mtime
    let pending: Vec<&Track> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        tracks
            .iter()
            .filter(|t| {
                match db::get_track_tag(&conn, &t.path).ok().flatten() {
                    Some(tag) => tag.file_mtime != t.modified_at,
                    None => true,
                }
            })
            .collect()
    };

    let skipped = total - pending.len();
    let mut tagged = 0usize;
    let mut failed = 0usize;
    let mut processed = skipped;

    // Initial progress event so the UI shows the skipped count immediately
    let _ = app.emit(
        "tag-progress",
        TagProgress {
            current: processed,
            total,
        },
    );

    // Make sure embedding model is loaded before the batch loop
    let cache_dir = {
        use tauri::Manager;
        let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        app_data.join("embed_cache")
    };
    let cache_dir_for_load = cache_dir.clone();
    tokio::task::spawn_blocking(move || embed::ensure_loaded(cache_dir_for_load))
        .await
        .map_err(|e| e.to_string())??;

    for batch in pending.chunks(BATCH_SIZE) {
        match tag_batch(&state, batch).await {
            Ok(items) => {
                // Embed descriptions in one batch
                let descs: Vec<String> =
                    items.iter().map(|i| i.description.clone()).collect();
                let embeddings = tokio::task::spawn_blocking(move || {
                    embed::embed_sync(descs)
                })
                .await
                .map_err(|e| e.to_string())??;

                let now_ms = chrono_now_ms();
                let conn = state.db.lock().map_err(|e| e.to_string())?;
                for (i, item) in items.iter().enumerate() {
                    let Some(track) = batch.get(i) else { break };
                    let emb = embeddings
                        .get(i)
                        .map(|v| embed::embedding_to_blob(v))
                        .unwrap_or_default();
                    let mood_json = serde_json::to_string(&item.mood_tags)
                        .unwrap_or_else(|_| "[]".to_string());
                    if let Err(_e) = db::upsert_track_tag(
                        &conn,
                        &track.path,
                        track.modified_at,
                        &mood_json,
                        &item.description,
                        &emb,
                        now_ms,
                    ) {
                        failed += 1;
                    } else {
                        tagged += 1;
                    }
                }
                drop(conn);
            }
            Err(_e) => {
                // Whole batch failed (LLM error / parse error) — count as failed
                failed += batch.len();
            }
        }

        processed += batch.len();
        let _ = app.emit(
            "tag-progress",
            TagProgress {
                current: processed,
                total,
            },
        );
    }

    Ok(TagReport {
        total,
        tagged,
        skipped,
        failed,
    })
}

async fn tag_batch(
    state: &State<'_, AppState>,
    batch: &[&Track],
) -> Result<Vec<TagItem>, String> {
    let mut listing = String::new();
    for (i, t) in batch.iter().enumerate() {
        listing.push_str(&format!("{}. {}\n", i + 1, t.filename));
    }
    let prompt = format!(
        "以下是 {n} 个本地音乐文件的文件名。请基于歌名（可能包含歌手、专辑、风格信息）\
         推测每首歌的情绪和适合场景。为每首给出：\n\
         - mood_tags：2-4 个情绪/风格中文关键词数组（如 [\"柔和\", \"忧郁\", \"钢琴\"]）\n\
         - description：一句不超过 30 字的氛围描述（中文，描述适合什么心情或场景）\n\n\
         只输出 JSON 数组，顺序与下方列表完全一致，不要任何其他文字：\n\
         [{{\"mood_tags\": [...], \"description\": \"...\"}}, ...]\n\n\
         文件名列表：\n{listing}",
        n = batch.len()
    );
    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "你是一个简洁、有品味的音乐情绪标记助手。".to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: prompt,
        },
    ];
    let reply = ai_chat(messages, state.clone()).await?;
    let cleaned = strip_code_fence(&reply);
    let items: Vec<TagItem> = serde_json::from_str(&cleaned)
        .map_err(|e| format!("解析 LLM 响应失败: {e}; 原文: {cleaned}"))?;
    Ok(items)
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn strip_code_fence(s: &str) -> String {
    let t = s.trim();
    let t = t.strip_prefix("```json").unwrap_or(t);
    let t = t.strip_prefix("```").unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim().to_string()
}
