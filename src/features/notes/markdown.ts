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
