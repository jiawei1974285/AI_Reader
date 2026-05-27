use crate::Reader;

use thiserror::Error;

type HuffmanResult<T> = Result<T, HuffmanError>;

#[derive(Debug, Error)]
pub enum HuffmanError {
    #[error(transparent)]
    IoError(#[from] std::io::Error),
    #[error("code len out of bounds")]
    CodeLenOutOfBounds,
    #[error("bad termination code")]
    BadTerm,
    #[error("expected HUFF magic header")]
    InvalidHuffHeader,
    #[error("expected CDIC magic header")]
    InvalidCDICHeader,
    #[error("huffman dictionary index {index} out of bounds (dict_len={dict_len})")]
    InvalidDictionaryIndex { index: usize, dict_len: usize },
    #[error("max huffman recursion depth exceeded ({depth}) — likely self-referencing phrase in corrupt file")]
    HuffDepthExceeded { depth: usize },
}

type HuffmanDictionary = Vec<Option<(Vec<u8>, bool)>>;
type CodeDictionary = [(u8, bool, u32); 256];
type MinCodesMapping = [u32; 33];
type MaxCodesMapping = [u32; 33];

fn read_u64_be_at(data: &[u8], pos: usize) -> HuffmanResult<u64> {
    let end = pos + 8;
    if end > data.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "failed to fill whole buffer",
        )
        .into());
    }

    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&data[pos..end]);
    Ok(u64::from_be_bytes(bytes))
}

fn resolve_python_index(index: isize, len: usize) -> HuffmanResult<usize> {
    if index >= 0 {
        return Ok(index as usize);
    }

    let abs = index.unsigned_abs();
    len.checked_sub(abs)
        .ok_or(HuffmanError::InvalidDictionaryIndex {
            index: len,
            dict_len: len,
        })
}

#[derive(Debug)]
struct HuffmanDecoder {
    dictionary: HuffmanDictionary,
    code_dict: CodeDictionary,
    min_codes: MinCodesMapping,
    max_codes: MaxCodesMapping,
}

impl Default for HuffmanDecoder {
    fn default() -> Self {
        Self {
            dictionary: vec![],
            code_dict: [(0, false, 0); 256],
            min_codes: [0; 33],
            max_codes: [u32::MAX; 33],
        }
    }
}

impl HuffmanDecoder {
    fn load_code_dictionary<R: std::io::Read>(
        &mut self,
        reader: &mut Reader<R>,
        offset: usize,
    ) -> HuffmanResult<()> {
        reader.set_position(offset)?;

        for code in self.code_dict.iter_mut() {
            let v = reader.read_u32_be()?;
            // 0 < code_len <= 32, term is T or F, max_code is u24 pretending to be u32.
            let (code_len, term, mut max_code) = ((v & 0x1F) as u8, (v & 0x80) == 0x80, v >> 8);
            if code_len == 0 {
                return Err(HuffmanError::CodeLenOutOfBounds);
            }
            if code_len <= 8 && !term {
                return Err(HuffmanError::BadTerm);
            }
            max_code = ((max_code + 1) << (32u8.saturating_sub(code_len))).saturating_sub(1);
            *code = (code_len, term, max_code);
        }

        Ok(())
    }

    fn load_min_max_codes<R: std::io::Read>(
        &mut self,
        reader: &mut Reader<R>,
        offset: usize,
    ) -> HuffmanResult<()> {
        reader.set_position(offset)?;

        for code_len in 1..=32 {
            self.min_codes[code_len] = reader.read_u32_be()? << (32 - code_len);
            self.max_codes[code_len] =
                ((reader.read_u32_be()? + 1) << (32 - code_len)).saturating_sub(1);
        }
        Ok(())
    }

    // Loads the code dictionary, min and max code values from the HUFF record
    fn load_huff(&mut self, huff: &[u8]) -> HuffmanResult<()> {
        let mut r = Reader::new(std::io::Cursor::new(huff));

        if &r.read_u32_be()?.to_be_bytes() != b"HUFF" || r.read_u32_be()? != 0x18 {
            return Err(HuffmanError::InvalidHuffHeader);
        }

        let cache_offset = r.read_u32_be()?;
        let base_offset = r.read_u32_be()?;

        self.load_code_dictionary(&mut r, cache_offset as usize)?;
        self.load_min_max_codes(&mut r, base_offset as usize)?;

        Ok(())
    }

    // Loads a CDIC record into the huffman dictionary
    fn load_cdic_record(&mut self, cdic: &[u8]) -> HuffmanResult<()> {
        let mut r = Reader::new(std::io::Cursor::new(cdic));

        if &r.read_u32_be()?.to_be_bytes() != b"CDIC" || r.read_u32_be()? != 0x10 {
            return Err(HuffmanError::InvalidCDICHeader);
        }

        let num_phrases = r.read_u32_be()?;
        let bits = r.read_u32_be()?;

        let n = (1 << bits).min(num_phrases - self.dictionary.len() as u32);

        let mut offsets = Vec::with_capacity(n as usize);
        for _ in 0..n {
            offsets.push(r.read_u16_be()?);
        }

        for offset in offsets {
            r.set_position(16 + offset as usize)?;
            let num_bytes = r.read_u16_be()?;
            let bytes = r.read_vec_header((num_bytes & 0x7FFF) as usize)?;
            self.dictionary
                .push(Some((bytes, (num_bytes & 0x8000) == 0x8000)));
        }

        Ok(())
    }

    fn load_cdic_records(&mut self, records: &[&[u8]]) -> HuffmanResult<()> {
        for cdic in records {
            self.load_cdic_record(cdic)?;
        }
        Ok(())
    }

    // Unpacks data of a section. [AIreader patch] entry point delegates
    // to `unpack_with_depth` so recursive expansion of dictionary phrases
    // can bound stack depth (defense against self-referencing entries in
    // corrupt files).
    fn unpack(&mut self, data: &[u8]) -> HuffmanResult<Vec<u8>> {
        self.unpack_with_stack(data, &mut Vec::new())
    }

    fn unpack_with_stack(&mut self, data: &[u8], stack: &mut Vec<usize>) -> HuffmanResult<Vec<u8>> {
        // [AIreader patch] 防自引用 phrase 死循环 / 栈溢出.
        // 合法 huff/cdic 字典 phrase 引用是 DAG, 深度通常 ≤ 5;
        // 32 远超合法上限, 偏向接受边缘情况而非误拒.
        if stack.len() > 512 {
            return Err(HuffmanError::HuffDepthExceeded { depth: stack.len() });
        }
        let mut bits_left = (data.len() * 8) as isize;
        let mut padded = data.to_vec();
        padded.extend_from_slice(&[0; 8]);

        // X is a sliding window of 64 bits from data. KindleUnpack pads the
        // section with 8 zero bytes and reloads a 64-bit window every 32 bits;
        // doing the same avoids EOF on short trailing sections and prevents
        // padding bits from being resolved as dictionary entries.
        let mut pos = 0usize;
        let mut x = read_u64_be_at(&padded, pos)?;
        // -32 < n <= 32
        let mut n = 32i8;
        let mut unpacked = vec![];

        loop {
            // The top 32 bits are now stale, read next 32 bits.
            if n <= 0 {
                pos += 4;
                x = read_u64_be_at(&padded, pos)?;
                n += 32;
            }

            // Read maximum of 32 bits from x.
            let code = ((x >> n) & 0xFFFF_FFFF) as u32;
            // Get value from dict1.
            let (code_len, term, mut max_code) = self.code_dict[(code >> 24) as usize];

            // 32 > code_len > 0.
            let mut code_len = code_len as usize;
            if !term {
                while code_len <= 32 && code < self.min_codes[code_len] {
                    code_len += 1;
                }
                if code_len > 32 {
                    return Err(HuffmanError::CodeLenOutOfBounds);
                }
                max_code = self.max_codes[code_len];
            }

            n -= code_len as i8;
            bits_left -= code_len as isize;
            if bits_left < 0 {
                break;
            }

            let raw_index = ((max_code as i64 - code as i64) >> (32 - code_len)) as isize;
            // [AIreader patch] 关键修复: 原实现用 std::mem::take 把 entry 置 None
            // → 递归 unpack 同一 phrase 时报 InvalidDictionaryIndex.
            // (实测: 多本中文 AZW3 Huff 解码全挂在这里, 用户报"0 字节正文".)
            //
            // 改用 clone-then-resolve:
            //   1. 读 entry (不 take, 保留供同层后续 / 递归层访问)
            //   2. flag=false → 递归 unpack raw bytes → 写回 cached + flag=true
            //   3. flag=true → 直接用 cached
            let (index, raw, flag) = {
                let dict_len = self.dictionary.len();
                let index = resolve_python_index(raw_index, dict_len)?;
                let entry_opt = self
                    .dictionary
                    .get(index)
                    .ok_or(HuffmanError::InvalidDictionaryIndex { index, dict_len })?;
                let entry = entry_opt
                    .as_ref()
                    .ok_or(HuffmanError::InvalidDictionaryIndex { index, dict_len })?;
                (index, entry.0.clone(), entry.1)
            };
            let resolved = if !flag {
                if stack.contains(&index) {
                    // [AIreader patch] 循环引用兜底: 用 raw 字节
                    // 但**不要 cache** — raw 是未解码的 huff bits, cache 成
                    // (raw, flag=true) 会让下次合法访问吐出未解码字节, 表现为
                    // 整本书出现"幻读" phrase 反复插入 (用户实测 3 本均触发).
                    // 不 cache 时下次访问会再走解码路径 (此时 stack 可能已弹空,
                    // 能正常解), 即使再 hit cycle 也仅这一次 phrase 错, 不污染.
                    raw.clone()
                } else {
                    stack.push(index);
                    let decoded = self.unpack_with_stack(&raw, stack)?;
                    stack.pop();
                    // 只有真正解码出来的才 cache
                    self.dictionary[index] = Some((decoded.clone(), true));
                    decoded
                }
            } else {
                raw
            };
            unpacked.extend_from_slice(&resolved);
        }

        Ok(unpacked)
    }

    fn unpack_sections(&mut self, sections: &[&[u8]]) -> HuffmanResult<Vec<Vec<u8>>> {
        let mut output = vec![];
        for section in sections {
            output.push(self.unpack(section)?);
        }
        Ok(output)
    }

    fn init(huffs: &[&[u8]]) -> HuffmanResult<Self> {
        let mut decoder = Self::default();
        decoder.load_huff(huffs[0])?;
        decoder.load_cdic_records(&huffs[1..])?;
        // [AIreader patch] removed eprintln! that dumped entire decoder
        // (huge dictionary) to stderr on every AZW3 open.
        Ok(decoder)
    }
}

pub fn decompress(huffs: &[&[u8]], sections: &[&[u8]]) -> HuffmanResult<Vec<Vec<u8>>> {
    let mut decoder = HuffmanDecoder::init(huffs)?;
    decoder.unpack_sections(sections)
}
