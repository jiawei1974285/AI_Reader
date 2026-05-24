//! Per-book indexing pipeline: extract chapter text → chunk → embed →
//! store. Designed to run from a `spawn_blocking` task because both the
//! file parsing and the embedding are CPU-bound.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use crate::ai::{chunker, embed};
use crate::db;

#[derive(Debug, Clone)]
pub struct ChapterText {
    pub spine_index: usize,
    pub text: String,
}

/// Extract plain text per chapter/page for any supported format.
pub fn extract_chapters(path: &Path) -> Result<Vec<ChapterText>, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "epub" => extract_epub_chapters(path),
        "txt" => extract_txt_chapters(path),
        "docx" => extract_docx_chapters(path),
        "mobi" | "azw" | "azw3" => extract_mobi_chapters(path),
        "pdf" => extract_pdf_pages(path),
        other => Err(format!("Unsupported format for indexing: {other}")),
    }
}

fn extract_epub_chapters(path: &Path) -> Result<Vec<ChapterText>, String> {
    use ::epub::doc::EpubDoc;
    let mut doc = EpubDoc::new(path).map_err(|e| format!("Failed to open EPUB: {e}"))?;
    let nav_id = doc.get_nav_id();
    let spine = doc.spine.clone();
    let mut chapters = Vec::new();
    for (idx, item) in spine.iter().enumerate() {
        if nav_id.as_deref() == Some(item.idref.as_str()) {
            continue;
        }
        let Some((content, _mime)) = doc.get_resource_str(&item.idref) else {
            continue;
        };
        let text = strip_html_to_text(&content);
        let trimmed = text.trim();
        if trimmed.chars().count() < 30 {
            continue;
        }
        chapters.push(ChapterText {
            spine_index: idx,
            text: trimmed.to_string(),
        });
    }
    Ok(chapters)
}

fn extract_txt_chapters(path: &Path) -> Result<Vec<ChapterText>, String> {
    let text = crate::readers::txt::read_and_decode(path)?;
    let chapters = crate::readers::txt::split_into_chapters(&text);
    Ok(chapters
        .into_iter()
        .enumerate()
        .map(|(idx, ch)| ChapterText {
            spine_index: idx,
            text: ch.content,
        })
        .collect())
}

fn extract_docx_chapters(path: &Path) -> Result<Vec<ChapterText>, String> {
    // B5: 用 readers::docx 的切章逻辑，让索引的 spine_index 和阅读器的对得上。
    // 之前所有 DOCX 都被塞进 spine_index=0 一章，RAG 引用永远跳首页 (评审 P2-12)。
    let (_title, chapters) = crate::readers::docx::parse_docx_chapters(path)?;
    Ok(chapters
        .into_iter()
        .enumerate()
        .filter(|(_, ch)| !ch.text.trim().is_empty())
        .map(|(idx, ch)| ChapterText {
            spine_index: idx,
            text: ch.text,
        })
        .collect())
}

fn extract_mobi_chapters(path: &Path) -> Result<Vec<ChapterText>, String> {
    Ok(crate::readers::mobi::extract_text_chapters(path)?
        .into_iter()
        .map(|(idx, text)| ChapterText {
            spine_index: idx,
            text,
        })
        .collect())
}

fn extract_pdf_pages(path: &Path) -> Result<Vec<ChapterText>, String> {
    let pages = crate::readers::pdf::extract_pages(path)?;
    Ok(pages
        .into_iter()
        .enumerate()
        .map(|(idx, text)| ChapterText {
            spine_index: idx,
            text: text.trim().to_string(),
        })
        .filter(|ch| ch.text.chars().filter(|c| !c.is_whitespace()).count() >= 20)
        .collect())
}

fn strip_html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut prev_was_space = false;
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
            }
            '>' => {
                in_tag = false;
                if !prev_was_space {
                    out.push(' ');
                    prev_was_space = true;
                }
            }
            _ if in_tag => {}
            _ => {
                if c.is_whitespace() {
                    if !prev_was_space {
                        out.push(' ');
                        prev_was_space = true;
                    }
                } else {
                    out.push(c);
                    prev_was_space = false;
                }
            }
        }
    }
    out
}

/// Index a single book end-to-end. Synchronous; intended to run in a
/// `spawn_blocking` task. Returns the number of chunks indexed.
///
/// The `progress` callback receives `(current, total)` chapter counts so
/// the UI can render a bar. It's called once per chapter completed.
pub fn index_book<F>(
    book_id: i64,
    book_path: &str,
    cache_dir: PathBuf,
    db_path: &Path,
    mut progress: F,
) -> Result<usize, String>
where
    F: FnMut(usize, usize),
{
    embed::ensure_loaded(cache_dir)?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    let chapters = extract_chapters(Path::new(book_path))?;
    let total = chapters.len();
    if total == 0 {
        return Err("Book has no extractable text".to_string());
    }

    // Open our own connection so we don't deadlock the main one held by
    // the Tauri state.
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON").ok();
    db::clear_book_chunks(&conn, book_id).map_err(|e| e.to_string())?;
    db::set_index_status(&conn, book_id, "indexing", 0, None, None).map_err(|e| e.to_string())?;

    let mut chunks_count = 0usize;
    for (i, chapter) in chapters.iter().enumerate() {
        let chunks = chunker::chunk_text(&chapter.text);
        if chunks.is_empty() {
            progress(i + 1, total);
            continue;
        }
        let embeddings = embed::embed_sync(chunks.clone())?;
        if embeddings.len() != chunks.len() {
            return Err(format!(
                "Embedding count {} doesn't match chunks {}",
                embeddings.len(),
                chunks.len()
            ));
        }
        for (chunk_idx, (text, emb)) in chunks.iter().zip(embeddings.iter()).enumerate() {
            let blob = embed::embedding_to_blob(emb);
            // B1: 每条 chunk 写入时打上「当前模型 + 维度」的烙印。
            // emb.len() 就是这次嵌入实际产出的维度（理论上等于 CURRENT_EMBEDDING_DIM，
            // 但万一以后 fastembed 版本变了，取实际更鲁棒）。
            db::insert_chunk(
                &conn,
                book_id,
                chapter.spine_index as i64,
                chunk_idx as i64,
                text,
                &blob,
                emb.len() as i64,
                embed::CURRENT_EMBEDDING_MODEL_ID,
                now_ms,
            )
            .map_err(|e| e.to_string())?;
            chunks_count += 1;
        }
        progress(i + 1, total);
    }

    db::set_index_status(
        &conn,
        book_id,
        "ready",
        chunks_count as i64,
        Some(now_ms),
        None,
    )
    .map_err(|e| e.to_string())?;

    Ok(chunks_count)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchHit {
    pub book_id: i64,
    pub spine_index: i64,
    pub text: String,
    pub score: f32,
}

/// Fetch all chunks for a (book or whole-library) search. Owns its result
/// so the caller can release the DB lock before doing the (CPU-bound)
/// scoring step. See `score_chunks` for the compute half.
///
/// 按 CLAUDE.md 原则 11（时滞会引起振荡）：把 IO（持锁）和 CPU（不需锁）
/// 拆成两步，调用方先 fetch 再 drop 锁再 score。这样 RAG 检索（数十~数百 ms
/// 的余弦运算）不再阻塞滚动保存进度、保存高亮等 UI 高频 IPC。
pub fn fetch_chunks_for_search(
    conn: &Connection,
    book_id: Option<i64>,
) -> Result<Vec<db::ChunkRow>, String> {
    db::list_chunks(conn, book_id).map_err(|e| e.to_string())
}

/// Pure-CPU scoring: cosine-rank `rows` against `query_emb` and return
/// top-K hits. Does not touch the DB — safe to call after the lock has
/// been released.
///
/// B1 (CLAUDE.md 原则 16): 默认只对**当前模型**的 chunks 评分。其它
/// (model, dim) 不匹配的 chunk 直接跳过——之前的 `cosine(a, b) if a.len()
/// != b.len()` 返回 0.0 是静默错误，用户察觉不到 RAG 在用过时数据。
/// 现在跳过等于明确告诉用户「这些书需要用新模型重新索引」。
#[allow(dead_code)] // C3 之后 production 路径走 hybrid_score; 保留作 fallback / 测试
pub fn score_chunks(
    rows: &[db::ChunkRow],
    query_emb: &[f32],
    top_k: usize,
) -> Vec<SearchHit> {
    score_chunks_for_model(
        rows,
        query_emb,
        top_k,
        embed::CURRENT_EMBEDDING_MODEL_ID,
        embed::CURRENT_EMBEDDING_DIM,
    )
}

/// 模型 + 维度感知的版本——主要给测试和未来"按模型分桶检索"用。
/// 不匹配的 chunk 不会被算分（也不会被算成 0.0 混进 top-K）。
#[allow(dead_code)] // 同上, 给测试和未来 "按模型分桶检索" 留接口
pub fn score_chunks_for_model(
    rows: &[db::ChunkRow],
    query_emb: &[f32],
    top_k: usize,
    model_id: &str,
    dim: usize,
) -> Vec<SearchHit> {
    let dim_i64 = dim as i64;
    let mut scored: Vec<(f32, &db::ChunkRow)> = rows
        .iter()
        .filter(|r| {
            // 维度必须匹配；model_id 如果 chunk 没记录（NULL）按"老数据"待定，
            // 走维度匹配兜底。新数据（A 阶段以后）model_id 都有，能精确分流。
            let dim_ok = r.embedding_dim.map(|d| d == dim_i64).unwrap_or(true);
            let model_ok = r
                .embedding_model
                .as_deref()
                .map(|m| m == model_id)
                .unwrap_or(true);
            dim_ok && model_ok
        })
        .map(|r| {
            let emb = embed::blob_to_embedding(&r.embedding);
            let s = embed::cosine(query_emb, &emb);
            (s, r)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored
        .into_iter()
        .take(top_k)
        .map(|(score, row)| SearchHit {
            book_id: row.book_id,
            spine_index: row.spine_index,
            text: row.text.clone(),
            score,
        })
        .collect()
}

/// C3 — 二阶段 RAG: cosine（语义）+ BM25（词汇）用 Reciprocal Rank Fusion 融合.
///
/// 评审 P2 指出: 中文短查询纯向量召回不稳——"人间词话"如果嵌入空间里有
/// 别的"哲学诗学"概念离得更近, 纯 cosine 会错排到前面. BM25 用三字 trigram
/// 命中字面词, 纠偏.
///
/// 算法 (RRF, Cormack et al. 2009):
///   score(d) = sum over methods m of 1 / (k + rank_m(d))
///   k = 60 是论文里实测稳健的常数. RRF 对各源 score 绝对尺度不敏感,
///   是 hybrid retrieval 的工业默认 (CLAUDE.md 原则 14 兜底).
///
/// 输入:
///   - rows: 所有候选 chunks (来自 fetch_chunks_for_search)
///   - query_emb: 问题嵌入向量
///   - bm25_hits: FTS5 已经按 bm25 排序的列表 (search_fts 返回值, 前面 rank 越小)
///   - top_k: 最终输出条数
pub fn hybrid_score(
    rows: &[db::ChunkRow],
    query_emb: &[f32],
    bm25_hits: &[db::FtsHit],
    top_k: usize,
) -> Vec<SearchHit> {
    const RRF_K: f32 = 60.0;
    let cosine_pool = (top_k * 4).max(16);
    let dim_i64 = embed::CURRENT_EMBEDDING_DIM as i64;
    let current_model = embed::CURRENT_EMBEDDING_MODEL_ID;

    // 1. cosine 排名 (复用 score_chunks_for_model 的维度/模型过滤)
    let mut cosine: Vec<(f32, &db::ChunkRow)> = rows
        .iter()
        .filter(|r| {
            let dim_ok = r.embedding_dim.map(|d| d == dim_i64).unwrap_or(true);
            let model_ok = r
                .embedding_model
                .as_deref()
                .map(|m| m == current_model)
                .unwrap_or(true);
            dim_ok && model_ok
        })
        .map(|r| {
            let emb = embed::blob_to_embedding(&r.embedding);
            (embed::cosine(query_emb, &emb), r)
        })
        .collect();
    cosine.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    cosine.truncate(cosine_pool);

    // 2. RRF 累加: 任何 chunk 出现在任一池子就贡献
    use std::collections::HashMap;
    let mut rrf: HashMap<i64, f32> = HashMap::new();
    for (idx, (_score, row)) in cosine.iter().enumerate() {
        let rank = idx as f32 + 1.0;
        *rrf.entry(row.id).or_insert(0.0) += 1.0 / (RRF_K + rank);
    }
    for (idx, hit) in bm25_hits.iter().enumerate() {
        let rank = idx as f32 + 1.0;
        *rrf.entry(hit.chunk_id).or_insert(0.0) += 1.0 / (RRF_K + rank);
    }

    // 3. 按融合分数取 top_k; 用 chunk_id 反查 ChunkRow 拿 text/spine_index
    let by_id: HashMap<i64, &db::ChunkRow> =
        rows.iter().map(|r| (r.id, r)).collect();
    let mut ranked: Vec<(f32, i64)> = rrf.into_iter().map(|(id, s)| (s, id)).collect();
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut out: Vec<SearchHit> = Vec::with_capacity(top_k);
    for (score, id) in ranked.into_iter().take(top_k) {
        if let Some(row) = by_id.get(&id) {
            out.push(SearchHit {
                book_id: row.book_id,
                spine_index: row.spine_index,
                text: row.text.clone(),
                score,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::embed;

    fn make_row(id: i64, model: Option<&str>, dim: Option<i64>, emb: Vec<f32>) -> db::ChunkRow {
        db::ChunkRow {
            id,
            book_id: 1,
            spine_index: 0,
            text: format!("chunk{id}"),
            embedding: embed::embedding_to_blob(&emb),
            embedding_dim: dim,
            embedding_model: model.map(|s| s.to_string()),
        }
    }

    #[test]
    fn score_filters_out_mismatched_model() {
        // Two chunks with current model + dim, one with a "future" model.
        let query = vec![1.0f32, 0.0, 0.0];
        let rows = vec![
            make_row(1, Some(embed::CURRENT_EMBEDDING_MODEL_ID), Some(3), vec![1.0, 0.0, 0.0]),
            make_row(2, Some(embed::CURRENT_EMBEDDING_MODEL_ID), Some(3), vec![0.9, 0.1, 0.0]),
            // 不同模型的 chunk —— 必须被跳过，不能进 top-K
            make_row(3, Some("OTHER/model-v2"), Some(3), vec![1.0, 0.0, 0.0]),
        ];
        let hits = score_chunks_for_model(&rows, &query, 5, embed::CURRENT_EMBEDDING_MODEL_ID, 3);
        let ids: Vec<i64> = hits.iter().map(|h| h.book_id).collect();
        // book_id 在 make_row 里都是 1，区分要看返回数量
        assert_eq!(hits.len(), 2, "third chunk with foreign model should be skipped");
        assert!(ids.iter().all(|&id| id == 1));
    }

    #[test]
    fn score_filters_out_mismatched_dim() {
        let query = vec![1.0f32, 0.0, 0.0];
        let rows = vec![
            make_row(1, Some(embed::CURRENT_EMBEDDING_MODEL_ID), Some(3), vec![1.0, 0.0, 0.0]),
            // 同模型但维度不对 —— 跳过
            make_row(2, Some(embed::CURRENT_EMBEDDING_MODEL_ID), Some(4), vec![1.0, 0.0, 0.0, 0.0]),
        ];
        let hits = score_chunks_for_model(&rows, &query, 5, embed::CURRENT_EMBEDDING_MODEL_ID, 3);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn score_keeps_legacy_null_metadata_chunks() {
        // 老数据 NULL 的 chunk 默认按维度兜底（迁移已经回填 512 / model 名，但
        // 测试这条逻辑保证哪怕未来某条没回填上，行为仍可预期：跟当前维度匹配
        // 就当能算）。
        let query = vec![1.0f32, 0.0, 0.0];
        let rows = vec![
            make_row(1, None, None, vec![1.0, 0.0, 0.0]),
        ];
        let hits = score_chunks_for_model(&rows, &query, 5, embed::CURRENT_EMBEDDING_MODEL_ID, 3);
        assert_eq!(hits.len(), 1);
    }
}

/// Convenience wrapper for tests and code paths that don't care about the
/// fetch/score split. Holds the conn for the duration — do not use from
/// command handlers where UI IPC could be blocked.
#[cfg(test)]
pub fn search_chunks(
    conn: &Connection,
    query_emb: &[f32],
    book_id: Option<i64>,
    top_k: usize,
) -> Result<Vec<SearchHit>, String> {
    let rows = fetch_chunks_for_search(conn, book_id)?;
    Ok(score_chunks(&rows, query_emb, top_k))
}
