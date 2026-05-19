/// Backward-compatible per-record wrapper. Use [`decompress_into`] when
/// decompressing a multi-record stream so LZ77 references can cross
/// record boundaries.
pub fn decompress(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    decompress_into(data, &mut out);
    out
}

/// [AIreader patch] Stream-aware PalmDOC decompressor: appends this
/// record's decompressed bytes to `text` rather than starting a fresh
/// buffer each call. PalmDOC's LZ77 window (~2 KB) is defined to cross
/// record boundaries; the per-record `decompress(data)` above would
/// fail to resolve any LZ77 reference whose offset reaches into the
/// previous record, producing garbage-text bursts that follow the
/// pattern of a record's first ~2 KB. With a shared `text` buffer the
/// `text_pos - offset` lookup naturally finds the right bytes.
pub fn decompress_into(data: &[u8], text: &mut Vec<u8>) {
    let length = data.len();
    let mut pos: usize = 0;
    // Continue from wherever the shared buffer currently ends.
    let mut text_pos: usize = text.len();

    let mut prev = None;
    while pos < length {
        let byte = data[pos];
        pos += 1;

        match byte {
            new if prev.is_some() => {
                let old = prev.take().unwrap();

                // Combine with previous byte to get a distance-length pair.
                let mut dist_len_bytes = u16::from_be_bytes([old, new]);

                dist_len_bytes &= 0x3fff; // Leftmost two bits are ID bits and need to be dropped
                let offset = (dist_len_bytes >> 3) as usize; // Remaining 11 bits are offset
                let len = ((dist_len_bytes & 0x0007) + 3) as usize; // Length is  rightmost three bits + 3

                // With a stream-wide buffer, `offset > text_pos` only
                // happens for genuinely malformed input. Old code used
                // `offset % text_pos` as a random fallback (the actual
                // cause of mid-paragraph garbage bursts); clamping to 0
                // is at worst a few duplicated bytes from the start of
                // the book, never random noise.
                let start = if offset > text_pos {
                    0
                } else {
                    text_pos - offset
                };

                // [AIreader patch] PalmDOC LZ77 allows self-referencing
                // copy: when offset < len, the source range overlaps the
                // (still-growing) destination, producing RLE expansion
                // (every push makes the next read see the byte we just
                // wrote). Upstream cached `end = min(start + len, text.len())`
                // OUTSIDE the loop, so RLE references were truncated to
                // `offset` bytes — losing `len - offset` bytes per such
                // reference. For CJK MOBIs that hits often (repeated
                // punctuation like "，，" gets RLE-encoded), producing
                // the mid-paragraph garbage bursts users see.
                // Replace with a simple len-bounded loop that reads the
                // index after each push, so growing `text` is visible.
                for k in 0..len {
                    let idx = start + k;
                    if idx >= text.len() {
                        break; // malformed input — bail rather than panic
                    }
                    text.push(text[idx]);
                    text_pos += 1;
                }
            }
            // The first character is a null which are literal
            // Chars from range 0x09..=0x7f are also literal
            0x0 | 0x09..=0x7f => {
                text.push(byte);
                text_pos += 1;
            }
            // next $byte bytes are also literal
            0x1..=0x8 => {
                let b = byte as usize;
                if pos + b <= length {
                    data[pos..(pos + b)].iter().for_each(|ch| {
                        text.push(*ch);
                        text_pos += 1;
                    });
                    pos += b;
                }
            }
            // Data is LZ77-compressed
            0x80..=0xbf => {
                // [AIreader patch] Upstream had `if pos >= text.len()` here
                // — comparing INPUT position against OUTPUT length, which
                // is meaningless and triggers a spurious early return on
                // almost every PalmDOC record. The result was that CJK
                // MOBIs (which lean heavily on LZ77 dictionary references)
                // would silently truncate ~90% of their content after the
                // first back-reference in each record.
                //
                // The correct check is "is there a next byte to pair with?"
                // — `length` is the INPUT (`data`) length declared at the
                // top of this fn. We've already incremented `pos` past the
                // current byte; if pos == length there's no trailing byte
                // to form the LZ77 (distance, length) pair, so we bail.
                if pos >= length {
                    return;
                }

                // Save current byte to combine with the next one to get a distance-length pair
                prev = Some(byte);
            }
            // 0xc0..= 0xff are single charaters XOR 0x80 preceded by a space
            _ => {
                text.push(b' ');
                text.push(byte ^ 0x80);
                text_pos += 2;
            }
        }
    }
}
