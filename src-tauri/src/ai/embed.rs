//! Lazy-loaded local text embedding via fastembed-rs.
//!
//! We use BGE Small (Chinese, v1.5) by default — ~500-dim vectors, well
//! suited for CJK retrieval and small enough to run on CPU. The model
//! files (~120 MB) download on first use into `cache_dir`, which the
//! caller wires to Tauri's `app_data_dir`/embed_cache.
//!
//! ## Mirror fallback strategy
//!
//! `hf-mirror.com` is the default for mainland China users, but it has a
//! known issue: it does not return `Content-Range` headers on HEAD / GET
//! responses, which `hf-hub` requires for its resumable-download logic.
//! When that happens we automatically retry with `hf.steamfor.cn` and
//! finally fall back to the official `huggingface.co` endpoint.
//!
//! Users who set `HF_ENDPOINT` themselves opt out of the fallback chain —
//! we assume they know what they're doing and use their endpoint directly.

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static MODEL: OnceLock<Mutex<Option<TextEmbedding>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<TextEmbedding>> {
    MODEL.get_or_init(|| Mutex::new(None))
}

/// Mirrors tried in order when the user hasn't set a custom `HF_ENDPOINT`.
/// Each entry is (url, human_label).
const MIRRORS: &[(&str, &str)] = &[
    ("https://hf-mirror.com", "hf-mirror.com（默认）"),
    ("https://hf.steamfor.cn", "hf.steamfor.cn（备选 1）"),
    ("https://huggingface.co", "huggingface.co（官方源）"),
];

/// Synchronously initialise the model if it hasn't been already. Calls
/// out to the network on first use to fetch model + tokenizer files,
/// then caches in `cache_dir`. Safe to call repeatedly — no-op on
/// subsequent calls.
///
/// When the user has NOT set `HF_ENDPOINT`, we try a chain of mirrors
/// (see [`MIRRORS`]) so a single broken mirror doesn't brick the app.
/// Users with a custom `HF_ENDPOINT` get a single attempt — if it fails
/// the error suggests checking their configuration.
pub fn ensure_loaded(cache_dir: PathBuf) -> Result<(), String> {
    let mut g = slot().lock().map_err(|e| e.to_string())?;
    if g.is_some() {
        return Ok(());
    }
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("创建缓存目录失败: {e}"))?;

    let user_endpoint = std::env::var_os("HF_ENDPOINT");

    if let Some(ref ep) = user_endpoint {
        // User has a custom endpoint — single attempt, no fallback.
        let ep_str = ep.to_string_lossy();
        std::env::set_var("HF_ENDPOINT", ep_str.as_ref());
        match try_load_model(&cache_dir) {
            Ok(model) => {
                *g = Some(model);
                return Ok(());
            }
            Err(e) => {
                return Err(format!(
                    "加载嵌入模型失败（{ep_str}）：{e}\n\n\
                     BGE-Small-ZH-V1.5（约 120 MB）\n\
                     • 你设置了自定义 HF_ENDPOINT，未尝试其他镜像\n\
                     • 请检查该端点是否可达、是否支持 HuggingFace API\n\
                     • 如需使用自动镜像回退，请删除 HF_ENDPOINT 环境变量后重启\n\
                     • 或运行 scripts/download-embed-model.py 手动下载",
                ));
            }
        }
    }

    // No user override — try the mirror chain.
    let mut errors: Vec<String> = Vec::new();
    let mut last_was_content_range = false;

    for (url, label) in MIRRORS {
        if last_was_content_range {
            // Previous mirror returned Content-Range issue — clean up any
            // .incomplete files that hf-hub may have left behind so the
            // next mirror starts from a clean slate.
            clear_incomplete_files(&cache_dir);
        }

        std::env::set_var("HF_ENDPOINT", *url);
        match try_load_model(&cache_dir) {
            Ok(model) => {
                *g = Some(model);
                return Ok(());
            }
            Err(e) => {
                last_was_content_range = e.contains("Content-Range") || e.contains("content-range");
                let hint = if last_was_content_range {
                    "（该镜像不支持断点续传所需的 Content-Range 头）"
                } else if e.contains("timeout") || e.contains("Timeout") || e.contains("timed out")
                {
                    "（连接超时，镜像可能不可达）"
                } else if e.contains("TLS") || e.contains("certificate") || e.contains("ssl") {
                    "（TLS 握手失败）"
                } else {
                    ""
                };
                errors.push(format!("  • {label}: {e} {hint}"));
            }
        }
    }

    // All mirrors exhausted.
    Err(format!(
        "加载嵌入模型失败：所有镜像源均不可用。\n\
         模型：BGE-Small-ZH-V1.5（约 120 MB）\n\n\
         尝试的镜像源：\n{}\n\n\
         🔧 排查步骤（从易到难）：\n\
         1. 检查网络是否能访问 huggingface.co 或 hf-mirror.com\n\
         2. 如使用代理/VPN，确保已设 HTTPS_PROXY 环境变量\n\
         3. 运行 scripts/download-embed-model.py 手动下载模型\n\
         4. 或在 PowerShell 中设 HF_ENDPOINT 为可用的镜像后重启\n\
         5. 删除 embed_cache 目录后重试（下次启动会自动重建）",
        errors.join("\n")
    ))
}

/// Single attempt to load the model from whatever `HF_ENDPOINT` is
/// currently set to.
fn try_load_model(cache_dir: &Path) -> Result<TextEmbedding, String> {
    TextEmbedding::try_new(
        InitOptions::new(EmbeddingModel::BGESmallZHV15)
            .with_cache_dir(cache_dir.to_path_buf())
            .with_show_download_progress(true),
    )
    .map_err(|e| e.to_string())
}

/// Remove `.incomplete` files left by a failed `hf-hub` download so the
/// next attempt starts fresh instead of trying to resume a broken transfer.
fn clear_incomplete_files(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let remove = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("incomplete"))
            .unwrap_or(false);
        if remove {
            let _ = std::fs::remove_file(&path);
            eprintln!("[embed] cleaned stale file: {}", path.display());
        }
        // Also recurse into subdirectories (hf-hub nests downloads)
        if path.is_dir() {
            clear_incomplete_files(&path);
        }
    }
}

/// Embed a batch of texts and return one vector per input. Call
/// `ensure_loaded` first. Designed to be called from inside
/// `tokio::task::spawn_blocking` so it doesn't stall the async runtime.
pub fn embed_sync(texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let mut g = slot().lock().map_err(|e| e.to_string())?;
    let model = g.as_mut().ok_or_else(|| "嵌入模型尚未加载".to_string())?;
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
