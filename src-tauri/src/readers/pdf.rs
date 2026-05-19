use std::path::Path;

#[tauri::command]
pub fn read_pdf_page_text(path: String, page_index: usize) -> Result<String, String> {
    let pages = extract_pages(Path::new(&path))?;
    pages
        .get(page_index)
        .map(|s| s.trim().to_string())
        .ok_or_else(|| format!("PDF page_index {page_index} out of range"))
}

pub fn extract_pages(path: &Path) -> Result<Vec<String>, String> {
    pdf_extract::extract_text_by_pages(path)
        .map_err(|e| format!("PDF 文本解析失败: {e}"))
}
