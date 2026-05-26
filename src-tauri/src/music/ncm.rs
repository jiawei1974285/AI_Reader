//! NCM (网易云加密音乐) 自实现解密器 + on-disk cache.
//!
//! 之前用 `ncmdump` crate 0.7 / 0.8 都有 bug — `get_data()` 对部分新版 NCM
//! 文件返回的是加密字节而非解密后的音频，落盘后 audio 解码全部失败 + 没明确报错.
//!
//! NCM 格式公开 (网上多个 reverse-eng 报告一致), ~150 行可自实现. 不再依赖
//! ncmdump (CLAUDE.md 原则 1 实践检验: 第三方 crate 解错就自己写).
//!
//! ## NCM 文件结构 (LE 字节序)
//!   0..8    magic "CTENFDAM"
//!   8..10   2 bytes pad
//!   10..14  key 长度 (u32)
//!   14..    encrypted key (长度上一字段) — XOR 0x64 → AES-128-ECB(key="hzHRAmso5kInbaxW") → 剥 17 字节前缀 "neteasecloudmusic"
//!   下一段  metadata 长度 (u32) + encrypted metadata — XOR 0x63 → 剥 "163 key(Don't modify):" → base64 → AES-128-ECB(key="#14ljk_!\\]&0U<'(") → JSON
//!   后    4 字节 CRC32 (跳) + 5 字节 pad (跳) + cover 长度 (u32) + cover 数据 (跳)
//!   余    audio 数据 — 用 audio_key 生成 key_box (RC4 变体), 每字节 XOR
//!
//! ## key_box 生成 (audio_key → 256-byte box)
//!   key_box = [0..256]
//!   for i in 0..256:
//!     c = (key_box[i] + last_byte + audio_key[i % key_len]) & 0xff
//!     swap key_box[i] ↔ key_box[c]
//!     last_byte = c
//!
//! ## audio 解密: audio[i] XOR key_box[(box[(i+1)&0xff] + box[(box[(i+1)&0xff]+(i+1))&0xff]) & 0xff]

use aes::cipher::{generic_array::GenericArray, BlockDecrypt, KeyInit};
use aes::Aes128;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};

const NCM_MAGIC: &[u8; 8] = b"CTENFDAM";
const KEY_AES_KEY: &[u8; 16] = b"hzHRAmso5kInbaxW";
const META_AES_KEY: &[u8; 16] = b"#14ljk_!\\]&0U<'(";
const KEY_PREFIX: &[u8; 17] = b"neteasecloudmusic";
const META_PREFIX: &[u8; 22] = b"163 key(Don't modify):";

/// Decrypt an `.ncm` file at `src` into `cache_dir`. Returns the absolute
/// path of the decrypted file. Re-uses the existing cached file if the
/// source path + mtime match what we cached previously.
#[tracing::instrument(skip(cache_dir), fields(src = %src.display()))]
pub fn decrypt_to_cache(src: &Path, cache_dir: &Path) -> Result<String, String> {
    if !src.exists() {
        return Err(format!("Source file not found: {}", src.display()));
    }
    fs::create_dir_all(cache_dir).map_err(|e| format!("Failed to create cache dir: {e}"))?;

    let mtime = src
        .metadata()
        .and_then(|m| m.modified())
        .map_err(|e| format!("Failed to stat: {e}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let key = cache_key(src, mtime);

    // Probe known extensions before doing expensive decrypt
    for ext in ["mp3", "flac", "wav", "m4a", "ogg", "aac"] {
        let candidate = cache_dir.join(format!("{key}.{ext}"));
        if candidate.exists() {
            tracing::debug!(cached = %candidate.display(), "ncm cache hit");
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    let raw = fs::read(src).map_err(|e| format!("Failed to read NCM: {e}"))?;
    let decrypted =
        decrypt_ncm_bytes(&raw).map_err(|e| format!("NCM decrypt failed: {e}"))?;
    if decrypted.audio.is_empty() {
        return Err("NCM decrypt produced 0 audio bytes".to_string());
    }

    // 用 magic byte 检测真实音频格式;fallback 用 metadata 里 declared format
    let detected = detect_audio_format(&decrypted.audio);
    let format = detected.unwrap_or(match decrypted.declared_format.to_ascii_lowercase().as_str() {
        "flac" => "flac",
        "wav" => "wav",
        "m4a" => "m4a",
        "ogg" => "ogg",
        "aac" => "aac",
        _ => "mp3",
    });
    tracing::info!(
        bytes = decrypted.audio.len(),
        declared_format = %decrypted.declared_format,
        detected_format = ?detected,
        chosen_format = format,
        "NCM decrypt complete (hand-rolled)"
    );

    let out_path: PathBuf = cache_dir.join(format!("{key}.{format}"));
    fs::write(&out_path, &decrypted.audio)
        .map_err(|e| format!("Failed to write decrypted: {e}"))?;
    Ok(out_path.to_string_lossy().to_string())
}

struct DecryptedNcm {
    audio: Vec<u8>,
    declared_format: String,
}

fn decrypt_ncm_bytes(raw: &[u8]) -> Result<DecryptedNcm, String> {
    let mut cur = Cursor::new(raw);

    // magic
    let magic = cur.take(8)?;
    if magic != NCM_MAGIC {
        return Err(format!(
            "Bad NCM magic: {:02x?} (expected CTENFDAM)",
            &magic[..magic.len().min(8)]
        ));
    }
    // 2 bytes pad
    cur.skip(2)?;

    // key
    let key_len = cur.read_u32_le()? as usize;
    let mut key_enc = cur.take(key_len)?.to_vec();
    for b in key_enc.iter_mut() {
        *b ^= 0x64;
    }
    let key_dec = aes128_ecb_decrypt(&key_enc, KEY_AES_KEY)?;
    if !key_dec.starts_with(KEY_PREFIX) {
        return Err("audio key prefix mismatch".to_string());
    }
    let audio_key = &key_dec[KEY_PREFIX.len()..];

    // metadata
    let meta_len = cur.read_u32_le()? as usize;
    let declared_format = if meta_len == 0 {
        String::new()
    } else {
        let mut meta_enc = cur.take(meta_len)?.to_vec();
        for b in meta_enc.iter_mut() {
            *b ^= 0x63;
        }
        if !meta_enc.starts_with(META_PREFIX) {
            // 没有标准 prefix → metadata 可能损坏, 不致命, audio 仍可解
            tracing::warn!("NCM metadata prefix mismatch — skipping format hint");
            String::new()
        } else {
            let meta_b64 = &meta_enc[META_PREFIX.len()..];
            let meta_bytes = base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                meta_b64,
            )
            .map_err(|e| format!("metadata base64 decode: {e}"))?;
            let meta_json_bytes = aes128_ecb_decrypt(&meta_bytes, META_AES_KEY)?;
            // metadata JSON 起头是 "music:" 字面前缀
            let meta_str = String::from_utf8_lossy(&meta_json_bytes);
            let json_start = meta_str.find('{').unwrap_or(0);
            let json_part = &meta_str[json_start..];
            parse_format_from_json(json_part)
        }
    };

    // CRC32 + pad + cover
    cur.skip(4)?; // CRC32 of audio
    cur.skip(5)?; // pad
    let cover_len = cur.read_u32_le()? as usize;
    cur.skip(cover_len)?;

    // audio: build key box, XOR every byte
    let box_arr = build_key_box(audio_key);
    let mut audio = cur.rest()?.to_vec();
    decrypt_audio(&mut audio, &box_arr);

    Ok(DecryptedNcm {
        audio,
        declared_format,
    })
}

/// build the 256-byte key box (RC4-like) from the audio key
fn build_key_box(audio_key: &[u8]) -> [u8; 256] {
    let mut key_box = [0u8; 256];
    for i in 0..256 {
        key_box[i] = i as u8;
    }
    let key_len = audio_key.len();
    if key_len == 0 {
        return key_box;
    }
    let mut last_byte: u8 = 0;
    let mut key_offset: usize = 0;
    for i in 0..256 {
        let swap = key_box[i];
        let c = swap
            .wrapping_add(last_byte)
            .wrapping_add(audio_key[key_offset]);
        key_box[i] = key_box[c as usize];
        key_box[c as usize] = swap;
        last_byte = c;
        key_offset = (key_offset + 1) % key_len;
    }
    key_box
}

/// XOR-decrypt audio bytes in-place using the prepared key box.
fn decrypt_audio(audio: &mut [u8], key_box: &[u8; 256]) {
    for (i, b) in audio.iter_mut().enumerate() {
        let j = ((i + 1) & 0xff) as usize;
        let a = key_box[j];
        let mask = key_box[(a as usize + key_box[(a as usize + j) & 0xff] as usize) & 0xff];
        *b ^= mask;
    }
}

fn aes128_ecb_decrypt(data: &[u8], key: &[u8; 16]) -> Result<Vec<u8>, String> {
    if data.is_empty() || data.len() % 16 != 0 {
        return Err(format!(
            "AES input length {} not multiple of 16",
            data.len()
        ));
    }
    let cipher = Aes128::new(GenericArray::from_slice(key));
    let mut out = data.to_vec();
    for chunk in out.chunks_exact_mut(16) {
        let block = GenericArray::from_mut_slice(chunk);
        cipher.decrypt_block(block);
    }
    // strip PKCS#7 padding
    if let Some(&pad) = out.last() {
        if pad >= 1 && pad <= 16 && (out.len() as u8) >= pad {
            let pad = pad as usize;
            // 验证 padding 字节全相同
            if out[out.len() - pad..].iter().all(|&b| b == pad as u8) {
                out.truncate(out.len() - pad);
            }
        }
    }
    Ok(out)
}

fn parse_format_from_json(s: &str) -> String {
    // 简化: 找 "format":"xxx" 模式
    let needle = "\"format\":";
    let Some(start) = s.find(needle) else {
        return String::new();
    };
    let after = &s[start + needle.len()..];
    let trimmed = after.trim_start();
    if let Some(rest) = trimmed.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return rest[..end].to_string();
        }
    }
    String::new()
}

/// 根据音频文件头 magic bytes 检测真实格式.
fn detect_audio_format(data: &[u8]) -> Option<&'static str> {
    if data.len() < 12 {
        return None;
    }
    if &data[..4] == b"fLaC" {
        return Some("flac");
    }
    if &data[..4] == b"OggS" {
        return Some("ogg");
    }
    if &data[..4] == b"RIFF" && &data[8..12] == b"WAVE" {
        return Some("wav");
    }
    if &data[4..8] == b"ftyp" {
        return Some("m4a");
    }
    if &data[..3] == b"ID3" {
        return Some("mp3");
    }
    if data[0] == 0xFF && (data[1] & 0xE0) == 0xE0 {
        return Some("mp3");
    }
    if data[0] == 0xFF && (data[1] & 0xF0) == 0xF0 {
        return Some("aac");
    }
    None
}

fn cache_key(src: &Path, mtime: u64) -> String {
    let mut hasher = DefaultHasher::new();
    src.to_string_lossy().as_bytes().hash(&mut hasher);
    mtime.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

// ---- tiny cursor for byte stream ----

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.pos + n > self.buf.len() {
            return Err(format!(
                "unexpected EOF at offset {} (want {} bytes, have {})",
                self.pos,
                n,
                self.buf.len() - self.pos
            ));
        }
        let out = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(out)
    }
    fn skip(&mut self, n: usize) -> Result<(), String> {
        if self.pos + n > self.buf.len() {
            return Err(format!("unexpected EOF skipping {n} at {}", self.pos));
        }
        self.pos += n;
        Ok(())
    }
    fn read_u32_le(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn rest(&mut self) -> Result<&'a [u8], String> {
        let out = &self.buf[self.pos..];
        self.pos = self.buf.len();
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_flac() {
        let mut buf = b"fLaC".to_vec();
        buf.extend_from_slice(&[0u8; 20]);
        assert_eq!(detect_audio_format(&buf), Some("flac"));
    }

    #[test]
    fn detect_mp3_id3() {
        let mut buf = b"ID3".to_vec();
        buf.extend_from_slice(&[0u8; 20]);
        assert_eq!(detect_audio_format(&buf), Some("mp3"));
    }

    #[test]
    fn detect_mp3_sync_byte() {
        let buf = vec![0xFFu8, 0xFB, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(detect_audio_format(&buf), Some("mp3"));
    }

    #[test]
    fn detect_m4a() {
        let buf = vec![0u8, 0, 0, 0x20, b'f', b't', b'y', b'p', 0, 0, 0, 0];
        assert_eq!(detect_audio_format(&buf), Some("m4a"));
    }

    #[test]
    fn detect_wav() {
        let buf = vec![b'R', b'I', b'F', b'F', 0, 0, 0, 0, b'W', b'A', b'V', b'E'];
        assert_eq!(detect_audio_format(&buf), Some("wav"));
    }

    #[test]
    fn key_box_is_permutation_of_0_to_255() {
        // 任意 audio_key, build_key_box 输出必须是 0..256 的排列
        let key = b"any-audio-key-bytes-here";
        let kb = build_key_box(key);
        let mut sorted: Vec<u8> = kb.to_vec();
        sorted.sort();
        for (i, v) in sorted.iter().enumerate() {
            assert_eq!(*v as usize, i, "key_box missing byte {}", i);
        }
    }

    #[test]
    fn aes_round_trip_pkcs7() {
        // 已知 AES-128-ECB 明文 + key, 检验 decrypt 后能还原 + 剥 PKCS7
        // 这里直接给一段已加密 16 字节 (单 block) 和对应明文测.
        // 简化: 我们只确保 decrypt 不 panic, 且 strip padding 不会误删非 padding 字节
        let key: &[u8; 16] = b"0123456789abcdef";
        // 加密一段 "hello" + PKCS7 padding (11 bytes of 0x0B)
        let mut block = b"hello\x0b\x0b\x0b\x0b\x0b\x0b\x0b\x0b\x0b\x0b\x0b".to_vec();
        let cipher = Aes128::new(GenericArray::from_slice(key));
        let arr = GenericArray::from_mut_slice(&mut block);
        cipher.encrypt_block(arr);

        let plain = aes128_ecb_decrypt(&block, key).unwrap();
        assert_eq!(plain, b"hello");
    }

    #[test]
    fn parse_format_from_json_works() {
        let s = r#"{"musicId":12345,"format":"flac","artist":[["a",1]]}"#;
        assert_eq!(parse_format_from_json(s), "flac");
        assert_eq!(parse_format_from_json("not json"), "");
    }
}

// aes 需要 BlockEncrypt trait for test (在 aes::cipher 下面)
#[cfg(test)]
use aes::cipher::BlockEncrypt;
