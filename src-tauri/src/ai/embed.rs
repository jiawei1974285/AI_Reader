//! Lazy-loaded local text embedding via fastembed-rs.
//!
//! We use BGE Small (Chinese, v1.5) by default — ~500-dim vectors, well
//! suited for CJK retrieval and small enough to run on CPU. The model
//! files (~120 MB) download on first use into `cache_dir`, which the
//! caller wires to Tauri's `app_data_dir`/embed_cache.

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static MODEL: OnceLock<Mutex<Option<TextEmbedding>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<TextEmbedding>> {
    MODEL.get_or_init(|| Mutex::new(None))
}

/// Synchronously initialise the model if it hasn't been already. Calls
/// out to the network on first use to fetch model + tokenizer files,
/// then caches in `cache_dir`. Safe to call repeatedly — no-op on
/// subsequent calls.
pub fn ensure_loaded(cache_dir: PathBuf) -> Result<(), String> {
    let mut g = slot().lock().map_err(|e| e.to_string())?;
    if g.is_some() {
        return Ok(());
    }
    let _ = std::fs::create_dir_all(&cache_dir);

    // fastembed → hf-hub talks to `huggingface.co` by default, which is
    // effectively unreachable from mainland China (extreme latency / TLS
    // resets) and surfaces as "Failed to retrieve onnx/model.onnx" with
    // no actionable signal in the UI. `hf-hub` honours the `HF_ENDPOINT`
    // env var, so we point it at the public hf-mirror.com proxy unless
    // the user has explicitly configured something else before launch.
    // Power users keep their override; everyone else just works.
    if std::env::var_os("HF_ENDPOINT").is_none() {
        std::env::set_var("HF_ENDPOINT", "https://hf-mirror.com");
    }
    let endpoint = std::env::var("HF_ENDPOINT")
        .unwrap_or_else(|_| "https://huggingface.co".to_string());

    let model = TextEmbedding::try_new(
        InitOptions::new(EmbeddingModel::BGESmallZHV15)
            .with_cache_dir(cache_dir)
            .with_show_download_progress(true),
    )
    .map_err(|e| {
        format!(
            "加载嵌入模型失败（镜像源：{endpoint}）：{e}\n\
             首次使用需要下载 BGE-Small-ZH-V1.5（约 120 MB）。\n\
             • 若下载超时，可设环境变量 HF_ENDPOINT 后重启 \
             （默认已用 https://hf-mirror.com）\n\
             • 或清空 embed_cache 目录后重试"
        )
    })?;
    *g = Some(model);
    Ok(())
}

/// Embed a batch of texts and return one vector per input. Call
/// `ensure_loaded` first. Designed to be called from inside
/// `tokio::task::spawn_blocking` so it doesn't stall the async runtime.
pub fn embed_sync(texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let mut g = slot().lock().map_err(|e| e.to_string())?;
    let model = g
        .as_mut()
        .ok_or_else(|| "嵌入模型尚未加载".to_string())?;
    model
        .embed(texts, None)
        .map_err(|e| format!("嵌入失败：{e}"))
}

/// Convert a float embedding into a compact byte blob for SQLite storage.
pub fn embedding_to_blob(emb: &[f32]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(emb.len() * 4);
    for v in emb {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    buf
}

/// Inverse of `embedding_to_blob`.
pub fn blob_to_embedding(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Cosine similarity between two vectors. Returns 0 for degenerate input.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}
