import type { Highlight, TocEntry } from "@/lib/ipc";

type BookMeta = { title: string; author: string };

/** Build a Markdown document of all highlights for a single book. */
export function buildBookMarkdown(
  book: BookMeta,
  highlights: Highlight[],
  toc: TocEntry[],
): string {
  const labelByIdx = new Map<number, string>();
  for (const t of toc) {
    if (!labelByIdx.has(t.spine_index)) labelByIdx.set(t.spine_index, t.label);
  }

  // Group by spine_index, preserving order
  const groups = new Map<number, Highlight[]>();
  for (const h of highlights) {
    const list = groups.get(h.spine_index) ?? [];
    list.push(h);
    groups.set(h.spine_index, list);
  }
  const sorted = Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);

  let md = `# ${book.title}\n\n`;
  if (book.author && book.author !== "Unknown" && book.author.trim() !== "") {
    md += `*${book.author}*\n\n`;
  }
  md += `> 共 ${highlights.length} 条标注 · 导出于 ${new Date().toLocaleString("zh-CN")}\n\n---\n\n`;

  if (highlights.length === 0) {
    md += "_（本书暂无标注）_\n";
    return md;
  }

  for (const [spineIdx, hls] of sorted) {
    const label = labelByIdx.get(spineIdx) ?? `第 ${spineIdx + 1} 章`;
    md += `## ${label}\n\n`;
    for (const h of hls) {
      const clean = h.selected_text.replace(/\n+/g, " ").trim();
      md += `> ${clean}\n\n`;
      if (h.note && h.note.trim()) {
        md += `${h.note.trim()}\n\n`;
      }
    }
  }

  return md;
}

/**
 * C10: 把所有书的标注合并成一份 Markdown — 按书分组，每本一个 H1。
 * `highlights` 已含 book_title / book_author，不需要单独传 BookMeta。
 */
export function buildAllBooksMarkdown(
  highlights: Array<
    Highlight & {
      book_title: string;
      book_author: string;
    }
  >,
): string {
  const byBook = new Map<
    number,
    { title: string; author: string; items: Highlight[] }
  >();
  for (const h of highlights) {
    let g = byBook.get(h.book_id);
    if (!g) {
      g = { title: h.book_title, author: h.book_author, items: [] };
      byBook.set(h.book_id, g);
    }
    g.items.push(h);
  }
  const parts: string[] = [];
  parts.push(
    `# AIreader 标注汇总\n\n> 共 ${highlights.length} 条 · 跨 ${byBook.size} 本书 · 导出于 ${new Date().toLocaleString("zh-CN")}\n\n---\n\n`,
  );
  for (const g of byBook.values()) {
    parts.push(buildBookMarkdown({ title: g.title, author: g.author }, g.items, []));
    parts.push("\n---\n\n");
  }
  return parts.join("");
}

/**
 * C10: 高亮导出为 Anki CSV，两列 `front,back`。
 * - front = 原文（高亮文字）
 * - back = 「《书名》— 第 N 章」+ 用户笔记（如果有）
 *
 * Anki 导入设置：分隔符 = 逗号，首行作字段名。
 */
export function buildAnkiCsv(
  highlights: Array<
    Highlight & {
      book_title: string;
      book_author: string;
    }
  >,
): string {
  const rows: string[] = ["front,back"];
  for (const h of highlights) {
    const front = h.selected_text.replace(/\n+/g, " ").trim();
    const note = h.note?.trim() ?? "";
    const backParts: string[] = [
      `《${h.book_title}》— 第 ${h.spine_index + 1} 章`,
    ];
    if (note) backParts.push(note);
    const back = backParts.join("\n\n");
    rows.push(`${csvEscape(front)},${csvEscape(back)}`);
  }
  return rows.join("\n") + "\n";
}

function csvEscape(s: string): string {
  // RFC 4180: 如果含逗号、引号或换行就要包引号 + 把引号 double 转义
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * C10: 在浏览器/WebView 里触发文件下载。Tauri WebView2 也支持 `<a download>`，
 * 文件落入用户的 Downloads 目录。如果以后用户反馈想"另存为"，再换 dialog plugin。
 */
export function downloadTextFile(
  filename: string,
  content: string,
  mime: string = "text/plain;charset=utf-8",
): void {
  // 加 BOM 让 Excel 等老软件按 UTF-8 解 CSV，否则中文乱码
  const blob = mime.includes("csv")
    ? new Blob(["﻿" + content], { type: mime })
    : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 给 webview 一点时间真的把 blob 写到 disk 再撤销
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Try multiple clipboard strategies and return whether copy succeeded. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older webview contexts
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      const ok = document.execCommand("copy");
      return ok;
    } catch {
      return false;
    } finally {
      document.body.removeChild(ta);
    }
  }
}
