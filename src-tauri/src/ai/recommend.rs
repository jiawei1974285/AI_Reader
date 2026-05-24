//! Recommend next book to read by KNN over per-book averaged chunk
//! embeddings. The "anchor" is either an explicit book the caller passes
//! in, or — if absent — the user's most recently read book (by
//! reading_progress.updated_at).

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::ai::chat::{ai_chat, ChatMessage};
use crate::ai::embed;
use crate::db;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct Recommendation {
    pub book: db::Book,
    pub score: f32,
    /// LLM-generated reason. Empty when not yet computed.
    pub reason: String,
}

/// Pull every indexed book and reduce its chunks to an average embedding.
/// Returns (book, avg_vec). Skips books with no chunks.
fn books_with_avg_embedding(conn: &Connection) -> Result<Vec<(db::Book, Vec<f32>)>, String> {
    let books = db::list_books(conn).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for b in books {
        let chunks = db::list_chunks(conn, Some(b.id)).map_err(|e| e.to_string())?;
        if chunks.is_empty() {
            continue;
        }
        let first = embed::blob_to_embedding(&chunks[0].embedding);
        let dim = first.len();
        if dim == 0 {
            continue;
        }
        let mut sum = vec![0.0f32; dim];
        let mut counted = 0usize;
        for c in &chunks {
            let v = embed::blob_to_embedding(&c.embedding);
            if v.len() != dim {
                continue;
            }
            for i in 0..dim {
                sum[i] += v[i];
            }
            counted += 1;
        }
        if counted == 0 {
            continue;
        }
        let n = counted as f32;
        for v in sum.iter_mut() {
            *v /= n;
        }
        out.push((b, sum));
    }
    Ok(out)
}

fn most_recently_read(conn: &Connection) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT book_id FROM reading_progress ORDER BY updated_at DESC LIMIT 1",
        [],
        |row| row.get::<_, i64>(0),
    )
    .optional()
}

pub fn recommend(
    conn: &Connection,
    anchor_book_id: Option<i64>,
    top_k: usize,
) -> Result<Vec<Recommendation>, String> {
    let books = books_with_avg_embedding(conn)?;
    if books.len() < 2 {
        return Err(
            "至少需要索引 2 本以上的书才能推荐。请先在阅读视图里点「索引本书」给几本书做向量索引。"
                .to_string(),
        );
    }

    // Pick the anchor: explicit param > most recently read > first indexed
    let anchor_id = match anchor_book_id {
        Some(id) => id,
        None => most_recently_read(conn)
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| books[0].0.id),
    };

    let anchor_idx = books
        .iter()
        .position(|(b, _)| b.id == anchor_id)
        .ok_or_else(|| "锚定书未索引，无法推荐。先索引这本书。".to_string())?;
    let anchor_vec = books[anchor_idx].1.clone();

    let mut scored: Vec<(usize, f32)> = books
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != anchor_idx)
        .map(|(i, (_, v))| (i, embed::cosine(&anchor_vec, v)))
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    Ok(scored
        .into_iter()
        .take(top_k)
        .map(|(i, score)| Recommendation {
            book: books[i].0.clone(),
            score,
            reason: String::new(),
        })
        .collect())
}

/// Same as `recommend`, but also asks the LLM to write a one-line "why
/// this might suit you" reason for each pick. One batched call covers all
/// recommendations. On any failure (LLM down, malformed JSON, etc.) we
/// gracefully return the recommendations without reasons rather than
/// erroring the whole call.
pub async fn recommend_with_reasons(
    state: State<'_, AppState>,
    anchor_book_id: Option<i64>,
    top_k: usize,
) -> Result<Vec<Recommendation>, String> {
    // Compute the KNN list synchronously while we hold the DB lock briefly.
    let (mut recs, anchor) = {
        let conn = state.db.get().map_err(|e| e.to_string())?;
        let recs = recommend(&conn, anchor_book_id, top_k)?;
        // Find which anchor we ended up using so we can include it in the
        // prompt.
        let anchor_id = anchor_book_id
            .or_else(|| most_recently_read(&conn).ok().flatten())
            .unwrap_or_else(|| {
                // Fall back to first indexed book's id if all else fails
                recs.first().map(|r| r.book.id).unwrap_or(0)
            });
        let anchor = db::list_books(&conn)
            .ok()
            .and_then(|bs| bs.into_iter().find(|b| b.id == anchor_id));
        (recs, anchor)
    };

    if recs.is_empty() {
        return Ok(recs);
    }

    // Try to enrich with reasons; failure here is non-fatal.
    if let Err(_e) = enrich_reasons(state, &anchor, &mut recs).await {
        // Reasons stay empty; frontend handles that.
    }
    Ok(recs)
}

async fn enrich_reasons(
    state: State<'_, AppState>,
    anchor: &Option<db::Book>,
    recs: &mut [Recommendation],
) -> Result<(), String> {
    let anchor_line = match anchor {
        Some(a) => format!(
            "用户最近读完了《{}》（作者：{}）。",
            a.title,
            if a.author.is_empty() {
                "未知"
            } else {
                &a.author
            }
        ),
        None => "用户的阅读历史不详。".to_string(),
    };

    let mut listing = String::new();
    for (i, r) in recs.iter().enumerate() {
        listing.push_str(&format!(
            "{}. 《{}》 / {}\n",
            i + 1,
            r.book.title,
            if r.book.author.is_empty() {
                "未知"
            } else {
                &r.book.author
            }
        ));
    }

    let user_msg = format!(
        "{anchor_line}\n\
         我向他推荐以下 {n} 本他书库里的其他书。\n\
         请为每本写一句 30 字以内、口语化的「为什么可能适合他」的推荐理由。\n\
         只输出 JSON 数组 [\"理由1\", \"理由2\", ...]，顺序与下方列表完全一致，\
         不要任何其他文字。\n\n\
         候选书：\n{listing}",
        n = recs.len(),
    );

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "你是一个简洁、有品味的图书推荐助手。".to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_msg,
        },
    ];

    let reply = ai_chat(messages, state).await?;
    let cleaned = strip_code_fence(&reply);
    let parsed: Vec<String> =
        serde_json::from_str(&cleaned).map_err(|e| format!("LLM 理由 JSON 解析失败: {e}"))?;
    for (i, reason) in parsed.into_iter().enumerate() {
        if let Some(r) = recs.get_mut(i) {
            r.reason = reason;
        }
    }
    Ok(())
}

/// LLMs often wrap JSON in ```json ... ``` despite "don't" instructions.
/// Strip leading/trailing code fence + language tag.
fn strip_code_fence(s: &str) -> String {
    let t = s.trim();
    let t = t.strip_prefix("```json").unwrap_or(t);
    let t = t.strip_prefix("```").unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim().to_string()
}

// ---------- Phase 5.C: chapter → music recommendation ----------

#[derive(Debug, Clone, Serialize)]
pub struct MusicRecommendation {
    pub track_path: String,
    pub filename: String,
    pub mood_tags: Vec<String>, // parsed JSON from track_tags.mood_tags
    pub description: String,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChapterMoodWithRecs {
    pub mood_tags: Vec<String>,
    pub description: String,
    pub recommendations: Vec<MusicRecommendation>,
}

#[derive(Debug, serde::Deserialize)]
struct ChapterMood {
    mood_tags: Vec<String>,
    description: String,
}

const CHAPTER_MOOD_MAX_CHARS: usize = 3000;

/// Given the text of the current chapter, ask the LLM for its mood
/// description, embed that description, and return top-K matching
/// tracks by cosine similarity against pre-tagged `track_tags`.
pub async fn recommend_music_for_chapter(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    chapter_text: String,
    top_k: usize,
) -> Result<ChapterMoodWithRecs, String> {
    // 1. Truncate + LLM extract mood
    let snippet = if chapter_text.chars().count() > CHAPTER_MOOD_MAX_CHARS {
        let s: String = chapter_text.chars().take(CHAPTER_MOOD_MAX_CHARS).collect();
        format!("{s}\n…（后续内容已省略）")
    } else {
        chapter_text.clone()
    };

    let prompt = format!(
        "下面是一段书的章节内容。请提取出适合作为背景音乐参考的「情绪 + 氛围」：\n\
         - mood_tags：2-4 个中文关键词数组（如 [\"紧张\", \"悬疑\", \"夜晚\"]）\n\
         - description：一句不超过 40 字的氛围描述\n\n\
         只输出 JSON 对象，不要任何其他文字：\n\
         {{\"mood_tags\": [...], \"description\": \"...\"}}\n\n\
         章节内容：\n{snippet}"
    );
    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "你是一个能从文字中嗅出氛围、为故事挑选 BGM 的助手。".to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: prompt,
        },
    ];
    let reply = ai_chat(messages, state.clone()).await?;
    let cleaned = strip_code_fence(&reply);
    let mood: ChapterMood = serde_json::from_str(&cleaned)
        .map_err(|e| format!("解析章节情绪失败: {e}; 原文: {cleaned}"))?;

    // 2. Embed description
    use tauri::Manager;
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("embed_cache");
    let desc_clone = mood.description.clone();
    let chapter_emb = tokio::task::spawn_blocking(move || -> Result<Vec<f32>, String> {
        embed::ensure_loaded(cache_dir)?;
        let vs = embed::embed_sync(vec![desc_clone])?;
        vs.into_iter()
            .next()
            .ok_or_else(|| "嵌入返回空".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    // 3. Load all tagged tracks + score
    let candidates = {
        let conn = state.db.get().map_err(|e| e.to_string())?;
        db::list_all_track_tags(&conn).map_err(|e| e.to_string())?
    };
    if candidates.is_empty() {
        return Err("还没有给任何音乐打过标签。请先在音乐视图点「AI 标记情绪」。".to_string());
    }

    let mut scored: Vec<(f32, db::TrackTagWithEmbedding)> = candidates
        .into_iter()
        .map(|t| {
            let v = embed::blob_to_embedding(&t.embedding);
            let s = embed::cosine(&chapter_emb, &v);
            (s, t)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let recommendations: Vec<MusicRecommendation> = scored
        .into_iter()
        .take(top_k)
        .map(|(score, t)| {
            let mood_tags: Vec<String> = serde_json::from_str(&t.mood_tags).unwrap_or_default();
            let filename = std::path::Path::new(&t.track_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            MusicRecommendation {
                track_path: t.track_path,
                filename,
                mood_tags,
                description: t.description,
                score,
            }
        })
        .collect();

    Ok(ChapterMoodWithRecs {
        mood_tags: mood.mood_tags,
        description: mood.description,
        recommendations,
    })
}
