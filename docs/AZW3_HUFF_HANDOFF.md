# AZW3 Huff/CDIC 解码 — 交接给下一个 AI

## TL;DR

EPUB 图片已修好（实测）。AZW3 PalmDoc 压缩的能开。**AZW3 Huff/CDIC 压缩的某些书仍打不开**，需要继续 debug。

## 用户原话

> "我觉得你解决不了这个问题了 我让其他 AI 试试吧"

公允的判断。我做了以下尝试都没把那本特定的 Huff AZW3 修好。

## 现状

### 已确认修好

- **EPUB 图片不显示**：`src/readers/epub.rs::normalize()` 在 Windows 用 `PathBuf::push` 插了 `\`，ZIP 内部路径是 `/` 不匹配。改用 String 拼 `/`。多本插图本验证 `inlined=N/load_failed=0`。
- **`range()` off-by-one**：vendored `mobi-rs/src/record.rs::RawRecords::range` 把 Rust `..` 的 exclusive end 当 inclusive 再减 1。修后日志显示 dict_len 从 1024 → 应该到 2048，但下一个错误暴露了（见下）。

### 修了但不确定生效

- `huff.rs` 把 `std::mem::take` 改成 clone-then-resolve（防递归冲突 + 加 depth limit 防自引用栈溢出）。
- `huff.rs` 删掉两处遗留 `println!`/`eprintln!`（每个 codeword 一次，会刷屏并卡死大文件）。
- `lib.rs` 加 `trim_record_trailer`，在 huff_data 前剥 MOBI record 末尾的 trailer 字节（multibyte char overlap + trailer entries）。
- `mobih.rs` `extra_record_data_flags` 改 pub，供上面 trim 用。

### 仍未修好的报错

用户最新实测，一本 Huff AZW3 (例如 `史记研究.azw3`) 报：
```
HuffmanError(IoError(UnexpectedEof, "failed to fill whole buffer"))
```

发生在 `huff.rs::unpack_with_depth` 里读 `r.read_u32_be()` 或 `r.read_u64_be()` 时。

## 关键日志诊断（已收集）

```
path: 史记研究.azw3
compression: Huff
encryption: No
text_encoding: UTF8
readable_range: 0..418
first_huff_record: 429
huff_record_count: 3          (1 HUFF + 2 CDIC)
first_image_index: 432
first_content_record: 0
first_non_book_index: 418
total_raw_records: 633
content_bytes: 0
```

前一次同类报错（修 range off-by-one 之前）：
```
InvalidDictionaryIndex { index: 1393, dict_len: 1024 }
```

## 可能的根因方向（按优先级）

### 方向 1：trim_record_trailer 实现不对（最有可能）

我写的 `trim_record_trailer` 是按 MOBI spec 自己实现的，没用任何参考实现做对照测试。`extra_data_flags` 的具体语义和 varint 解码方向可能写错了。

**对照标准**：
- KindleUnpack 的 Python 实现：[`mobi_split.py` / `mobi_uncompress.py`](https://github.com/kevinhendricks/KindleUnpack/tree/master/lib)
- mobileread wiki：https://wiki.mobileread.com/wiki/MOBI

具体看 KindleUnpack 的 `mobi_uncompress.py::readsection` 怎么 trim trailer，对比我在 `src-tauri/vendor/mobi-rs/src/lib.rs::trim_record_trailer` 的实现。

### 方向 2：KF8 vs MOBI 6 legacy 部分混淆

AZW3 文件可能是 "combo"（MOBI 6 legacy + KF8）或纯 KF8：
- combo：开头是 MOBI 6 头 + 老 PalmDoc/Huff，EXTH 头 type 121 之后是 KF8 boundary，后面是新 KF8 头 + KF8 records
- 纯 KF8：直接 KF8 头

当前 vendored mobi-rs **不识别 KF8 boundary**，永远读老 MOBI 6 部分的数据。如果文件是纯 KF8，`first_huff_record` 等字段就指向 KF8 部分（正常）。如果是 combo，就指向**老 MOBI 6 退化版**（数据残缺）。

**判断方法**：检查 EXTH 头 type 121 是否存在。代码：
```rust
m.metadata.exth.get_record(ExthRecord::Kf8BoundaryOffset)
```

如果 type 121 存在，跳到 KF8 部分（offset 在该 record 的 u32 值）重新 parse 一次 MOBI header。

### 方向 3：Huff 算法本身有 bug

vendored mobi-rs 的 `huff.rs` 是早期 fork，可能 Huff/CDIC 算法实现本身有 bug，不只是 trailer 问题。

**对照标准**：
- KindleUnpack `mobi_uncompress.py::huffcdicReader`
- Calibre `src/calibre/ebooks/mobi/reader/huffcdic.py`

### 方向 4：直接放弃 Huff，转用 Calibre CLI

最务实的方案：检测到 Huff AZW3 时直接 fork `ebook-convert input.azw3 output.epub`，然后读 epub。
- 优点：算法保证正确（Calibre 是事实标准）
- 缺点：用户必须装 Calibre

用户当前**没装 Calibre**。可以加 detect + 提示用户安装 + 路径配置。或者更进一步打包一个 portable kindleunpack-rust（如果有 mature crate）。

## 推荐给下一个 AI 的开干顺序

1. **方向 2 优先**（KF8 boundary 检测）—— 这是 AZW3 spec 上最 likely 的原因，且现有诊断日志已经显示 first_huff_record=429 看起来"合理"但 total_raw_records=633 意味着有大量 records 在 huff 之后（KF8 部分？）
2. **方向 1 验证**——把 `trim_record_trailer` 跟 KindleUnpack Python 实现逐行对比
3. **方向 3 重写 Huff/CDIC**——如果前两个都不是根因，就照搬 KindleUnpack 算法
4. **方向 4 calibre fallback**——作为最稳的兜底（用户体验差但能用）

## 测试用例

用户书库里 Huff 压缩 AZW3：
- `E:\books\电子书分类\文学小说\AZW3\大家小书：读史有学问.azw3`
- `E:\books\电子书分类\历史\AZW3\史记研究.azw3`
- `E:\books\电子书分类\传记人物\AZW3\《毛泽东传》第4册.azw3`
- `E:\books\电子书分类\传记人物\AZW3\一个瑜伽行者的自传(略长名).azw3`
- `E:\books\电子书分类\历史\AZW3\凤凰周刊文丛·微史记合集：222个你不知道的历史秘密.azw3`

PalmDoc 压缩 AZW3（**能开**，作 control）：
- `E:\books\电子书分类\文学小说\AZW3\一个一个人 - 申赋渔.azw3`
- `E:\books\电子书分类\历史\AZW3\史记(精注全译)(套装共6册)-.azw3`

## 怎么看诊断日志

```powershell
# 实时
Get-Content "$env:APPDATA\com.aireader.app\logs\aireader.log.$(Get-Date -Format yyyy-MM-dd)" -Wait -Tail 20

# 全文 grep huff
Select-String -Path "$env:APPDATA\com.aireader.app\logs\*.log*" -Pattern "huff" | Select-Object -Last 30
```

日志是 JSON 格式（A5 阶段引入的 tracing）。关键字段：`compression`、`huff_error`、`first_huff_record`、`huff_record_count`、`content_bytes`。

## 相关提交

最后几个有关 commit：

```
4bc2f5d wip: EPUB 图片修复 + AZW3 Huff/CDIC 部分修复 (未完工)  ← 本次留下
a582362 fix 问题 1: MOBI/AZW 日韩书不再被错判 garbage
458e2c1 fix(ncm)!: 自实现 NCM 解密 (NCM 也是 ncmdump crate 解错, 自写后好了 — 可作 AZW3 启发: 库不能信)
```

祝下一位 AI 好运。
