//! Split book chapter text into overlap-friendly chunks for embedding.
//!
//! Strategy: group paragraphs greedily up to a target character count.
//! For Chinese books, 500 characters ≈ 700-900 tokens (depending on model
//! tokenizer), comfortably under a small embedding model's window.

const TARGET_CHARS: usize = 500;
const MIN_CHARS: usize = 80;

pub fn chunk_text(text: &str) -> Vec<String> {
    // Pre-pass: split on blank lines or newlines, drop trivial whitespace
    let paragraphs: Vec<&str> = text
        .split('\n')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();

    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_chars = 0usize;

    for para in paragraphs {
        let para_chars = para.chars().count();

        if current_chars + para_chars > TARGET_CHARS && current_chars >= MIN_CHARS {
            chunks.push(std::mem::take(&mut current));
            current_chars = 0;
        }

        // Handle paragraphs larger than the target window by hard-splitting.
        if para_chars > TARGET_CHARS {
            // Flush whatever was accumulated
            if !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
                current_chars = 0;
            }
            for piece in split_long(para, TARGET_CHARS) {
                chunks.push(piece);
            }
            continue;
        }

        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(para);
        current_chars += para_chars + 1;
    }

    if !current.trim().is_empty() {
        chunks.push(current);
    }

    chunks
}

fn split_long(s: &str, window: usize) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let end = (i + window).min(chars.len());
        out.push(chars[i..end].iter().collect());
        i = end;
    }
    out
}
