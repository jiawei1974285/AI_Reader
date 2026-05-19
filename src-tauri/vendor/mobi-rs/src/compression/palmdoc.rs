pub fn decompress(data: &[u8]) -> Vec<u8> {
    let length = data.len();
    let mut pos: usize = 0;
    let mut text_pos: usize = 0;
    let mut text: Vec<u8> = vec![];

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

                // Calculate the position backwards in the decompressed text
                let start = if offset > text_pos {
                    offset % text_pos
                } else {
                    text_pos - offset
                };

                let end = if start + len >= text.len() {
                    text.len()
                } else {
                    start + len
                };

                for i in start..end {
                    text.push(text[i]);
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
                    return text;
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

    text
}
